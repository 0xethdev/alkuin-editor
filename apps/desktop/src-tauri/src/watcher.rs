use crate::ignore::{is_gitignore_path, WorkspaceIgnore};
use crate::state::{
    self, AppState, FileSignature, IndexWalk, IndexedFile, RecentFilesCache, SelfWrite,
    WorkspaceState,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const SELF_WRITE_TTL: Duration = Duration::from_secs(2);
const DEBOUNCE_MS: u64 = 300;
/// A batch flushes after this much quiet...
const BATCH_QUIET: Duration = Duration::from_millis(DEBOUNCE_MS);
/// ...or this long after its first event, whichever comes first, so a steady
/// stream (a large copy) still reaches the sidebar.
const BATCH_MAX_WAIT: Duration = Duration::from_millis(1500);

/// Runtime-gated diagnostic logging. Set `WRITER_WATCHER_LOG=1` before
/// launching to dump every event, filter decision, and emit to stderr —
/// the SPEC's investigation plan for residual "external change missed"
/// reports. No-op (single atomic-bool read) when the env var is unset, so
/// it's safe to leave the call sites in release builds.
fn watcher_log_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("WRITER_WATCHER_LOG").is_some())
}

macro_rules! wlog {
    ($($arg:tt)*) => {
        if watcher_log_enabled() {
            eprintln!("[watcher] {}", format!($($arg)*));
        }
    };
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEvent {
    pub path: String,
    pub kind: String,
    pub workspace: Option<WorkspaceIdentity>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentity {
    pub root: String,
    pub epoch: u64,
}

/// True if `path` should be dropped before any further processing.
///
/// Only the *relative* path (inside the workspace root) is inspected — a
/// workspace at `~/.notes/` must keep firing events even though `.notes` is a
/// dotdir. Paths outside the root are kept; the recursive watch already
/// scopes things, and bailing out here would silently drop legitimate events
/// that happen to share a prefix with the canonical root via macOS aliasing.
/// `write_file_expecting` saves through a `.~<uuid>` temp file in the document's
/// folder and renames it onto the document. That rename is a save, not a
/// move.
fn is_autosave_temp(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".~"))
}

fn should_ignore(path: &Path, workspace_root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(workspace_root) else {
        return false;
    };
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if name == ".git" || name == "node_modules" || name == ".DS_Store" {
            return true;
        }
        // Allow .writer directory (workspace config) and .gitignore files —
        // both must be watchable: settings reload on the former, matcher
        // rebuild on the latter.
        if name == ".writer" || name == ".gitignore" {
            continue;
        }
        if name.starts_with('.') && name.len() > 1 {
            return true;
        }
    }
    false
}

/// Check the workspace ignore matcher, if any. Returns `false` when no
/// matcher is loaded yet so events are never silently dropped.
fn is_workspace_ignored(state: &WorkspaceState, path: &Path, is_dir: bool) -> bool {
    let guard = state.workspace_ignore.read();
    guard
        .as_ref()
        .map(|ignore| ignore.is_ignored(path, is_dir))
        .unwrap_or(false)
}

/// Check if a path is a config file that should trigger settings reload.
fn is_config_file(path: &Path) -> bool {
    // Workspace config: .writer/config
    if path.file_name().and_then(|n| n.to_str()) == Some("config") {
        if let Some(parent) = path.parent() {
            if parent.file_name().and_then(|n| n.to_str()) == Some(".writer") {
                return true;
            }
        }
    }
    false
}

/// True if the current state of `path` is this window's own write.
///
/// A single save fans out into several watcher records (Create,
/// Modify(Metadata), Modify(Data) on macOS); all of them are suppressed so the
/// frontend does not reload the file and clobber keystrokes. The marker is not
/// consumed on match. While the write runs every event is suppressed; once it
/// has landed only events whose file still has the landed modified time and
/// length are, so an external edit right after a save still comes through.
/// Nothing is suppressed past `SELF_WRITE_TTL`, counted from the landing.
fn self_write_hit(state: &WorkspaceState, path: &Path) -> bool {
    let Some(marker) = state.recent_writes.read().get(path).copied() else {
        return false;
    };
    let age = marker.started().elapsed();
    if age >= SELF_WRITE_TTL {
        return false;
    }
    let hit = match marker {
        SelfWrite::InFlight { .. } => true,
        SelfWrite::Landed { signature, .. } => FileSignature::of(path) == Some(signature),
    };
    wlog!(
        "filter[self_write]: {} hit={hit} age_ms={} marker={marker:?}",
        path.display(),
        age.as_millis()
    );
    hit
}

/// Self-write suppression for the workspace watcher. A membership event for a
/// markdown path the index does not hold yet is never suppressed: a file this
/// window created (duplicate, Office import) has to enter the index, and the
/// watcher is the only thing that adds it.
fn suppress_as_self_write(state: &WorkspaceState, path: &Path, kind: &EventKind) -> bool {
    // The marker lookup comes first so the index scan only runs for paths
    // this window actually wrote.
    if !self_write_hit(state, path) {
        return false;
    }
    let not_indexed = is_membership_change(kind)
        && is_markdown(path)
        && !state.file_index.read().iter().any(|file| file.path == path);
    if not_indexed {
        wlog!(
            "filter[self_write]: {} kept, not indexed yet",
            path.display()
        );
    }
    !not_indexed
}

fn is_markdown(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("md")
}

static NEXT_SELF_WRITE_ID: AtomicU64 = AtomicU64::new(1);

/// Mark `path` as being written by this window. Pass the returned id to
/// [`finish_self_write`] once the write has finished, whether or not it
/// succeeded.
pub fn begin_self_write(state: &WorkspaceState, path: &Path) -> u64 {
    let id = NEXT_SELF_WRITE_ID.fetch_add(1, Ordering::Relaxed);
    let mut writes = state.recent_writes.write();
    writes.retain(|_, marker| marker.started().elapsed() < SELF_WRITE_TTL);
    writes.insert(
        path.to_path_buf(),
        SelfWrite::InFlight {
            id,
            since: Instant::now(),
        },
    );
    wlog!(
        "begin_self_write: {} id={id} retained={}",
        path.display(),
        writes.len()
    );
    id
}

/// Settle write `id`. A landed write records what is on disk now; a failed one
/// drops its marker so nothing stays suppressed. A newer write to the same
/// path owns the marker and is left alone.
pub fn finish_self_write(state: &WorkspaceState, path: &Path, id: u64, landed: bool) {
    let mut writes = state.recent_writes.write();
    if writes.get(path).map(SelfWrite::id) != Some(id) {
        return;
    }
    match FileSignature::of(path).filter(|_| landed) {
        Some(signature) => {
            writes.insert(
                path.to_path_buf(),
                SelfWrite::Landed {
                    id,
                    at: Instant::now(),
                    signature,
                },
            );
        }
        None => {
            writes.remove(path);
        }
    }
    wlog!(
        "finish_self_write: {} id={id} landed={landed}",
        path.display()
    );
}

/// Push `path` into the file index if not already present, then refresh the
/// `dirs_with_markdown` ancestry so the sidebar's "directory contains
/// markdown" check returns true for newly-populated subtrees.
#[cfg(test)]
fn add_to_index(state: &WorkspaceState, path: &Path, root: &Path) {
    let modified_at = crate::commands::fs::modified_time(path);
    add_to_index_with_modified(state, path, root, modified_at);
}

#[cfg(test)]
fn add_to_index_with_modified(state: &WorkspaceState, path: &Path, root: &Path, modified_at: u64) {
    let mut index = state.file_index.write();
    if let Some(file) = index.iter_mut().find(|f| f.path == path) {
        if file.modified_at != modified_at {
            file.modified_at = modified_at;
            drop(index);
            state.invalidate_recent_files_cache();
        }
        return;
    }
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    index.push(crate::state::IndexedFile {
        path: path.to_path_buf(),
        relative_path: rel,
        name,
        modified_at,
    });
    state.file_index_revision.fetch_add(1, Ordering::SeqCst);
    drop(index);
    state.invalidate_recent_files_cache();

    state::register_ancestors(&mut state.dirs_with_markdown.write(), path, root);
}

/// Drop every indexed path under `dir` (a removed folder) and rebuild
/// `dirs_with_markdown`. Needed because FSEvents may report a single
/// `Remove(Folder)` without per-child Remove events.
#[cfg(test)]
fn remove_subtree_from_index(state: &WorkspaceState, dir: &Path, root: &Path) {
    let dir_with_sep = {
        let mut s = dir.to_path_buf();
        s.push("");
        s
    };
    let removed = {
        let mut index = state.file_index.write();
        let before = index.len();
        index.retain(|f| !f.path.starts_with(&dir_with_sep) && f.path != dir);
        let removed = before != index.len();
        if removed {
            state.file_index_revision.fetch_add(1, Ordering::SeqCst);
        }
        removed
    };
    if removed {
        state.invalidate_recent_files_cache();
    }
    let index = state.file_index.read();
    *state.dirs_with_markdown.write() = state::rebuild_dirs_from_index(&index, root);
}

/// Walk `dir` and merge every `.md` descendant into the file index.
///
/// Required for membership-change events that introduce a populated folder
/// — Create(Folder) of a folder copied from outside the workspace, or
/// Modify(Name) when a folder is renamed into place. macOS FSEvents does
/// not re-emit per-child Create events for a renamed inode, so without
/// this walk every file under the new directory would silently disappear
/// from search results until the workspace is reopened.
fn discover_subtree(dir: &Path) -> Vec<crate::state::IndexedFile> {
    let cancel = Arc::new(AtomicBool::new(false));
    let (found, _) = crate::commands::search::index_workspace_impl(dir, cancel);
    found
}

struct PreparedIndexUpdate {
    revision: u64,
    index: Vec<crate::state::IndexedFile>,
    dirs: std::collections::HashSet<std::path::PathBuf>,
    changed: bool,
}

struct DeferredIndexDrop {
    _index: Vec<crate::state::IndexedFile>,
    _dirs: std::collections::HashSet<std::path::PathBuf>,
    _recent_cache: RecentFilesCache,
}

fn prepare_index_removal(
    state: &WorkspaceState,
    root: &Path,
    mut remove: impl FnMut(&crate::state::IndexedFile) -> bool,
) -> PreparedIndexUpdate {
    let revision = state.file_index_revision.load(Ordering::SeqCst);
    let mut index = state.file_index.read().clone();
    let before = index.len();
    index.retain(|file| !remove(file));
    let changed = index.len() != before;
    let dirs = state::rebuild_dirs_from_index(&index, root);
    PreparedIndexUpdate {
        revision,
        index,
        dirs,
        changed,
    }
}

fn prepare_mtime_update(
    state: &WorkspaceState,
    root: &Path,
    path: &Path,
    modified_at: u64,
) -> PreparedIndexUpdate {
    let revision = state.file_index_revision.load(Ordering::SeqCst);
    let mut index = state.file_index.read().clone();
    let changed = index
        .iter_mut()
        .find(|file| file.path == path)
        .is_some_and(|file| {
            if file.modified_at == modified_at {
                return false;
            }
            file.modified_at = modified_at;
            true
        });
    let dirs = state::rebuild_dirs_from_index(&index, root);
    PreparedIndexUpdate {
        revision,
        index,
        dirs,
        changed,
    }
}

fn discovered_file(path: &Path, modified_at: u64) -> crate::state::IndexedFile {
    crate::state::IndexedFile {
        path: path.to_path_buf(),
        relative_path: String::new(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        modified_at,
    }
}

fn prepare_subtree_merge(
    state: &WorkspaceState,
    found: Vec<crate::state::IndexedFile>,
    root: &Path,
) -> PreparedIndexUpdate {
    let revision = state.file_index_revision.load(Ordering::SeqCst);
    let mut index = state.file_index.read().clone();
    let mut paths = index
        .iter()
        .map(|file| file.path.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut changed = false;
    for file in found {
        if !paths.insert(file.path.clone()) {
            continue;
        }
        let relative_path = file
            .path
            .strip_prefix(root)
            .unwrap_or(&file.path)
            .to_string_lossy()
            .to_string();
        index.push(crate::state::IndexedFile {
            path: file.path,
            relative_path,
            name: file.name,
            modified_at: file.modified_at,
        });
        changed = true;
    }
    let dirs = state::rebuild_dirs_from_index(&index, root);
    PreparedIndexUpdate {
        revision,
        index,
        dirs,
        changed,
    }
}

fn publish_index_update(
    state: &WorkspaceState,
    prepared: PreparedIndexUpdate,
) -> Result<DeferredIndexDrop, PreparedIndexUpdate> {
    let mut index = state.file_index.write();
    if state.file_index_revision.load(Ordering::SeqCst) != prepared.revision {
        return Err(prepared);
    }
    if prepared.changed {
        let old_index = std::mem::replace(&mut *index, prepared.index);
        let old_dirs = std::mem::replace(&mut *state.dirs_with_markdown.write(), prepared.dirs);
        let old_recent_cache = state.recent_files_cache.write().take();
        state.file_index_revision.fetch_add(1, Ordering::SeqCst);
        return Ok(DeferredIndexDrop {
            _index: old_index,
            _dirs: old_dirs,
            _recent_cache: old_recent_cache,
        });
    }
    Ok(DeferredIndexDrop {
        _index: prepared.index,
        _dirs: prepared.dirs,
        _recent_cache: None,
    })
}

fn publish_prepared_index_for_snapshot(
    state: &WorkspaceState,
    root: &Path,
    epoch: u64,
    mut prepare: impl FnMut() -> PreparedIndexUpdate,
) {
    loop {
        let prepared = prepare();
        match state.with_workspace_snapshot(root, epoch, || publish_index_update(state, prepared)) {
            Some(Err(stale)) => {
                drop(stale);
                continue;
            }
            Some(Ok(displaced)) => drop(displaced),
            None => {}
        }
        break;
    }
}

/// Publish a full walk's result. Every path the watcher (or a write) changed
/// while the walk ran is first re-read from disk and merged in, so a file
/// created mid-walk is not lost and a file deleted mid-walk does not come back.
/// Retries until no delta arrived between the replay and the swap. Returns the
/// published file count, or `None` when the workspace moved on.
pub(crate) fn publish_full_index(
    state: &WorkspaceState,
    root: &Path,
    epoch: u64,
    mut walk: IndexWalk<'_>,
    mut index: Vec<IndexedFile>,
    mut dirs: HashSet<PathBuf>,
) -> Option<usize> {
    loop {
        let deltas = walk.take_deltas();
        if !deltas.is_empty() {
            wlog!("full index: replaying {} delta(s)", deltas.len());
            replay_deltas(&mut index, root, &deltas);
            dirs = state::rebuild_dirs_from_index(&index, root);
        }
        let outcome = state.with_workspace_snapshot(root, epoch, || {
            let mut guard = state.file_index.write();
            if !walk.caught_up() {
                return Err((index, dirs));
            }
            let count = index.len();
            let old_index = std::mem::replace(&mut *guard, index);
            state.file_index_revision.fetch_add(1, Ordering::SeqCst);
            let old_dirs = std::mem::replace(&mut *state.dirs_with_markdown.write(), dirs);
            let old_cache = state.recent_files_cache.write().take();
            state.index_ready.store(true, Ordering::SeqCst);
            drop(guard);
            Ok((
                count,
                DeferredIndexDrop {
                    _index: old_index,
                    _dirs: old_dirs,
                    _recent_cache: old_cache,
                },
            ))
        });
        match outcome {
            None => return None,
            Some(Err((retry_index, retry_dirs))) => {
                index = retry_index;
                dirs = retry_dirs;
            }
            Some(Ok((count, displaced))) => {
                drop(displaced);
                return Some(count);
            }
        }
    }
}

/// Re-read each logged path and make `index` match disk for it: a folder
/// merges its markdown descendants, a markdown file is upserted with its
/// current mtime, and a vanished path drops itself and everything under it.
fn replay_deltas(index: &mut Vec<IndexedFile>, root: &Path, deltas: &[PathBuf]) {
    let mut seen: HashSet<&Path> = HashSet::new();
    let mut gone: HashSet<&Path> = HashSet::new();
    let mut present: Vec<IndexedFile> = Vec::new();
    for path in deltas {
        if !seen.insert(path.as_path()) {
            continue;
        }
        if path.is_dir() {
            present.extend(discover_subtree(path));
        } else if path.is_file() {
            if is_markdown(path) {
                present.push(discovered_file(
                    path,
                    crate::commands::fs::modified_time(path),
                ));
            }
        } else {
            gone.insert(path.as_path());
        }
    }
    if !gone.is_empty() {
        index.retain(|file| !file.path.ancestors().any(|dir| gone.contains(dir)));
    }
    let mut at: HashMap<PathBuf, usize> = index
        .iter()
        .enumerate()
        .map(|(position, file)| (file.path.clone(), position))
        .collect();
    for file in present {
        if let Some(&position) = at.get(&file.path) {
            index[position].modified_at = file.modified_at;
            continue;
        }
        let relative_path = file
            .path
            .strip_prefix(root)
            .unwrap_or(&file.path)
            .to_string_lossy()
            .to_string();
        at.insert(file.path.clone(), index.len());
        index.push(IndexedFile {
            path: file.path,
            relative_path,
            name: file.name,
            modified_at: file.modified_at,
        });
    }
}

#[cfg(test)]
fn add_subtree_to_index(state: &WorkspaceState, dir: &Path, root: &Path) {
    let prepared = prepare_subtree_merge(state, discover_subtree(dir), root);
    assert!(publish_index_update(state, prepared).is_ok());
}

fn event_kind_str(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Modify(_) => Some("modified"),
        EventKind::Remove(_) => Some("deleted"),
        _ => None,
    }
}

/// Create, Remove, and rename (`Modify(Name)`) change directory membership.
/// Finder "Move to Trash" and `mv` arrive as `Modify(Name)` on macOS, not Remove.
fn is_membership_change(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(notify::event::ModifyKind::Name(_))
    )
}

/// Debounce phase of a watcher loop. Trailing-edge: a batch flushes after
/// `quiet` without events, or `max_wait` after its first event. The old loop
/// flushed the first event after a quiet spell on its own, which split a
/// rename's two halves into separate batches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BatchPhase {
    /// Nothing pending.
    Idle,
    /// Collecting since `first`; the latest event arrived at `last`.
    Collecting { first: Instant, last: Instant },
}

impl BatchPhase {
    fn on_event(self, now: Instant) -> Self {
        match self {
            Self::Idle => Self::Collecting {
                first: now,
                last: now,
            },
            Self::Collecting { first, .. } => Self::Collecting { first, last: now },
        }
    }

    fn flush_at(self, quiet: Duration, max_wait: Duration) -> Option<Instant> {
        match self {
            Self::Idle => None,
            Self::Collecting { first, last } => Some((last + quiet).min(first + max_wait)),
        }
    }
}

/// Block until the next batch is due and return it. While idle, waits for the
/// first event or until `idle_until` (then returns an empty batch, so removals
/// held from the previous batch can expire). Every wake drains whatever is
/// already queued before it decides whether to flush. `None` once the
/// watcher, and with it the sender, is gone.
fn next_batch<T>(
    rx: &Receiver<T>,
    quiet: Duration,
    max_wait: Duration,
    idle_until: Option<Instant>,
) -> Option<Vec<T>> {
    let first = match idle_until {
        None => rx.recv().ok()?,
        Some(deadline) => {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(item) => item,
                Err(RecvTimeoutError::Timeout) => return Some(Vec::new()),
                Err(RecvTimeoutError::Disconnected) => return None,
            }
        }
    };
    let mut batch = vec![first];
    let mut phase = BatchPhase::Idle.on_event(Instant::now());
    loop {
        let before = batch.len();
        batch.extend(rx.try_iter());
        if batch.len() != before {
            phase = phase.on_event(Instant::now());
        }
        let due = phase.flush_at(quiet, max_wait)?;
        let now = Instant::now();
        if now >= due {
            return Some(batch);
        }
        match rx.recv_timeout(due - now) {
            Ok(item) => {
                batch.push(item);
                phase = phase.on_event(Instant::now());
            }
            // A disconnect hands over what was collected; the next call
            // returns `None`. The caller's epoch check drops a stale batch.
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return Some(batch),
        }
    }
}

/// One half of a rename as the backend reported it. inotify tags both halves
/// with the same `tracker` (the kernel cookie); FSEvents reports neither half.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RenameHalf {
    path: PathBuf,
    tracker: Option<usize>,
}

/// The rename halves of one batch, before pairing.
#[derive(Debug, Default)]
struct RenameHalves {
    both: Vec<(PathBuf, PathBuf)>,
    froms: Vec<RenameHalf>,
    tos: Vec<RenameHalf>,
    /// Paths that left through a rename event: `From`, or FSEvents' unpaired
    /// `Any`.
    renamed_away: HashSet<PathBuf>,
    /// Trackers of `From` halves dropped because their source is filtered.
    skipped_trackers: HashSet<usize>,
    /// The previous event was an untagged `From` that was dropped. Windows
    /// tags neither half but reports them back to back.
    skipped_untagged_from: bool,
}

impl RenameHalves {
    /// Record `event`'s rename halves. A rename whose source the watcher
    /// filters (`filtered_source`) is not a document move, and neither half of
    /// it is kept: `write_file_expecting` saves through a `.~<uuid>` temp file
    /// renamed onto the document. Pairing that rename rewrote the document's
    /// share id to the temp file's on every save.
    fn add(&mut self, event: &Event, filtered_source: &dyn Fn(&Path) -> bool) {
        use notify::event::{ModifyKind, RenameMode};
        let skipped_untagged_from = std::mem::take(&mut self.skipped_untagged_from);
        let EventKind::Modify(ModifyKind::Name(mode)) = event.kind else {
            return;
        };
        let tracker = event.tracker();
        match mode {
            RenameMode::Both if event.paths.len() >= 2 => {
                if filtered_source(&event.paths[0]) {
                    wlog!(
                        "rename: dropped, filtered source {}",
                        event.paths[0].display()
                    );
                    return;
                }
                self.both
                    .push((event.paths[0].clone(), event.paths[1].clone()));
            }
            RenameMode::From => {
                for path in &event.paths {
                    if filtered_source(path) {
                        match tracker {
                            Some(tracker) => {
                                self.skipped_trackers.insert(tracker);
                            }
                            None => self.skipped_untagged_from = true,
                        }
                        continue;
                    }
                    self.renamed_away.insert(path.clone());
                    self.froms.push(RenameHalf {
                        path: path.clone(),
                        tracker,
                    });
                }
            }
            RenameMode::To => {
                let partner_skipped = match tracker {
                    Some(tracker) => self.skipped_trackers.contains(&tracker),
                    None => skipped_untagged_from,
                };
                if partner_skipped {
                    return;
                }
                self.tos.extend(event.paths.iter().map(|path| RenameHalf {
                    path: path.clone(),
                    tracker,
                }));
            }
            // FSEvents reports both sides of a rename (and a move to Trash)
            // like this, with no pairing.
            _ => {
                self.renamed_away.extend(
                    event
                        .paths
                        .iter()
                        .filter(|path| !filtered_source(path))
                        .cloned(),
                );
            }
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct RenamePlan {
    /// Distinct `(from, to)` moves.
    pairs: Vec<(PathBuf, PathBuf)>,
    /// `From` halves whose `To` has not been seen.
    unmatched_froms: Vec<RenameHalf>,
}

/// Pair rename halves into moves. Linux reports one rename as From, To and
/// Both; the old code paired From+To again on top of Both, and the second
/// `note_moved` clobbered the id the first had carried. Pairs are deduped,
/// and halves already covered by a Both are dropped. Remaining halves pair by
/// tracker, then (when exactly one of each is left and they are not tagged
/// with different trackers) with each other.
fn pair_renames(
    both: Vec<(PathBuf, PathBuf)>,
    froms: Vec<RenameHalf>,
    tos: Vec<RenameHalf>,
) -> RenamePlan {
    let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
    let push = |pairs: &mut Vec<(PathBuf, PathBuf)>, from: PathBuf, to: PathBuf| {
        if !pairs.iter().any(|(f, t)| f == &from && t == &to) {
            pairs.push((from, to));
        }
    };
    for (from, to) in both {
        push(&mut pairs, from, to);
    }
    let distinct = |halves: Vec<RenameHalf>, covered: &dyn Fn(&RenameHalf) -> bool| {
        let mut kept: Vec<RenameHalf> = Vec::new();
        for half in halves {
            if !covered(&half) && !kept.contains(&half) {
                kept.push(half);
            }
        }
        kept
    };
    let froms = distinct(froms, &|half| {
        pairs.iter().any(|(from, _)| from == &half.path)
    });
    let mut tos = distinct(tos, &|half| pairs.iter().any(|(_, to)| to == &half.path));

    let mut unmatched_froms = Vec::new();
    for from in froms {
        let partner = from.tracker.and_then(|tracker| {
            tos.iter()
                .position(|to| to.tracker == Some(tracker))
                .map(|position| tos.remove(position))
        });
        match partner {
            Some(to) => push(&mut pairs, from.path, to.path),
            None => unmatched_froms.push(from),
        }
    }
    if unmatched_froms.len() == 1 && tos.len() == 1 {
        let tagged_apart = matches!(
            (unmatched_froms[0].tracker, tos[0].tracker),
            (Some(a), Some(b)) if a != b
        );
        if !tagged_apart {
            let from = unmatched_froms.remove(0);
            let to = tos.remove(0);
            push(&mut pairs, from.path, to.path);
        }
    }
    RenamePlan {
        pairs,
        unmatched_froms,
    }
}

/// Carry "Keep on this Mac only" across moves that rename pairing did not
/// see. FSEvents reports a Finder rename as two unrelated `Name(Any)` paths,
/// so `pair_renames` never sees the move, and the mark would stay on the old
/// path, leaving the renamed document free to be uploaded. The kept list
/// stores a fingerprint of each kept file (inode and content hash, refreshed
/// on every save), so a vanished kept path moves to the one appeared path
/// that matches it; see [`crate::mac_only::follow_unpaired_moves`]. `gone`
/// and `held` are the vanished markdown paths of this batch and of the held
/// window; `appeared` the paths that arrived in both.
fn follow_kept_moves(home: &Path, gone: &[PathBuf], held: &[PathBuf], appeared: &[PathBuf]) {
    let mut vanished: Vec<PathBuf> = Vec::new();
    for path in gone.iter().chain(held) {
        if !path.exists() && !vanished.contains(path) {
            vanished.push(path.clone());
        }
    }
    if vanished.is_empty() || appeared.is_empty() {
        return;
    }
    crate::mac_only::follow_unpaired_moves(home, &vanished, appeared);
}

/// Record a markdown path that left or arrived, for the kept setting only.
/// Runs before the watcher's ignore filters: a private note renamed from a
/// hidden or gitignored name must still be found by its fingerprint. Only
/// Alkuin's own autosave temp is left out.
fn note_kept_candidate(
    kind: &EventKind,
    path: &Path,
    gone: &mut Vec<PathBuf>,
    appeared: &mut Vec<PathBuf>,
) {
    if !is_membership_change(kind) || !is_markdown(path) || is_autosave_temp(path) {
        return;
    }
    let list = if path.exists() { appeared } else { gone };
    if !list.iter().any(|known| known == path) {
        list.push(path.to_path_buf());
    }
}

/// Carry "Keep on this Mac only" along a batch's rename pairs. A note can be
/// renamed more than once in one batch (A to B, then B to C), and its
/// intermediate name is already gone by then, so every pair is applied, and
/// the pairs are applied again until none adds anything: the order the
/// halves arrived in does not decide whether C is kept.
fn carry_kept_marks(home: &Path, pairs: &[(PathBuf, PathBuf)]) {
    for _ in 0..pairs.len() {
        let mut changed = false;
        for (from, to) in pairs {
            // A path that is gone may have been a folder; one that exists says.
            match crate::mac_only::try_retarget(home, from, to, to.is_dir()) {
                Ok(added) => changed |= added,
                Err(err) => eprintln!("[mac-only] the setting did not follow a rename: {err}"),
            }
        }
        if !changed {
            return;
        }
    }
}

/// Removals waiting one more window before they count as deletes, because
/// the other half of a rename may still arrive.
#[derive(Debug, Default)]
struct HeldRemovals {
    /// Vanished markdown paths that left through a rename event.
    paths: Vec<PathBuf>,
    /// The unmatched `From` halves among them, for pairing with a late `To`.
    froms: Vec<RenameHalf>,
    /// Paths that appeared in the batch that held them. Still candidates
    /// for the fingerprint match in `classify_absence`.
    appeared: Vec<PathBuf>,
    /// When the hold expires if no further event arrives.
    until: Option<Instant>,
}

/// Decide what each vanished markdown path means for its share row. A path
/// moved to somewhere inside the workspace needs nothing. A path that left
/// through a rename event with no partner yet is held for one more window.
/// Everything else, including paths held last time, is classified now.
/// Returns `(hold, classify)`.
fn sort_absences(
    gone: &[PathBuf],
    renamed_away: &HashSet<PathBuf>,
    held: &[PathBuf],
    pairs: &[(PathBuf, PathBuf)],
    root: &Path,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let moved = |path: &PathBuf| {
        pairs
            .iter()
            .any(|(from, to)| from == path && to.starts_with(root))
    };
    let mut seen: HashSet<&PathBuf> = HashSet::new();
    let mut hold = Vec::new();
    let mut classify = Vec::new();
    for path in held {
        if seen.insert(path) && !moved(path) {
            classify.push(path.clone());
        }
    }
    for path in gone {
        if !seen.insert(path) || moved(path) {
            continue;
        }
        if renamed_away.contains(path) {
            hold.push(path.clone());
        } else {
            classify.push(path.clone());
        }
    }
    (hold, classify)
}

/// Emitted when a window's file watcher could not start. The index walk still
/// runs, but external changes will not reach the window until it reopens.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherFailedEvent {
    pub path: String,
    pub message: String,
    pub workspace: Option<WorkspaceIdentity>,
}

/// One reindex at a time per watcher. A rescan request while one runs queues
/// exactly one more pass, because the running walk may already have passed
/// the folders that changed.
#[derive(Debug, Default)]
struct ReindexSlot {
    running: bool,
    again: bool,
}

/// What one workspace watcher loop is bound to.
struct TreeWatch {
    handle: AppHandle,
    label: String,
    root: PathBuf,
    epoch: u64,
    reindex: Arc<Mutex<ReindexSlot>>,
}

impl TreeWatch {
    fn identity(&self) -> WorkspaceIdentity {
        WorkspaceIdentity {
            root: self.root.to_string_lossy().into_owned(),
            epoch: self.epoch,
        }
    }

    fn emit_root_changed(&self) {
        let _ = self.handle.emit_to(
            self.label.clone(),
            "fs:directory-changed",
            FileChangeEvent {
                path: self.root.to_string_lossy().into_owned(),
                kind: "modified".to_string(),
                workspace: Some(self.identity()),
            },
        );
    }
}

/// Start a file watcher targeted at a specific window. All emitted events
/// are routed via `emit_to(&window_label, ...)` so two windows hosting
/// different workspaces don't cross-talk on file events. The watcher
/// captures the window label plus the workspace epoch; when the epoch
/// moves on (workspace switch inside the same window) the debounced event
/// loop drops the batch.
pub fn start_watcher(
    app_handle: AppHandle,
    window_label: String,
    root: &Path,
    epoch: u64,
) -> Result<RecommendedWatcher, notify::Error> {
    let root_path = root.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        notify::Config::default().with_poll_interval(Duration::from_millis(DEBOUNCE_MS)),
    )?;

    watcher.watch(&root_path, RecursiveMode::Recursive)?;

    let watch = TreeWatch {
        handle: app_handle,
        label: window_label,
        root: root_path,
        epoch,
        reindex: Arc::new(Mutex::new(ReindexSlot::default())),
    };
    std::thread::spawn(move || {
        let mut held = HeldRemovals::default();
        while let Some(batch) = next_batch(&rx, BATCH_QUIET, BATCH_MAX_WAIT, held.until) {
            // Look up this window's state. If the window has already been
            // closed (its WorkspaceState removed from the registry) the
            // watcher has nothing to drive; stop the event loop so the
            // thread exits cleanly.
            let Some(state) = watch.handle.state::<AppState>().get(&watch.label) else {
                break;
            };
            if state.workspace_snapshot().as_ref() != Some(&(watch.root.clone(), watch.epoch)) {
                held = HeldRemovals::default();
                continue;
            }
            held = process_tree_batch(&watch, &state, batch, std::mem::take(&mut held));
        }
    });

    Ok(watcher)
}

/// Apply one debounced batch: maintain the index, emit frontend events, carry
/// share ids and "keep on this Mac" across detected renames, and decide which
/// vanished files are deletes. Returns the removals held for the next batch.
fn process_tree_batch(
    watch: &TreeWatch,
    state: &WorkspaceState,
    batch: Vec<notify::Result<Event>>,
    held: HeldRemovals,
) -> HeldRemovals {
    let handle = &watch.handle;
    let label = &watch.label;
    let watched_root = &watch.root;
    let captured_epoch = watch.epoch;
    let home = handle.path().app_data_dir().ok();

    let mut desynced = false;
    let mut rebuild_ignore = false;
    let mut gone: Vec<PathBuf> = Vec::new();
    let mut appeared: Vec<PathBuf> = Vec::new();
    // The same, before the ignore filters, for the kept setting only: a
    // private note renamed from or to a hidden or gitignored name is still
    // that note. Alkuin's own autosave temp is not a note.
    let mut kept_gone: Vec<PathBuf> = Vec::new();
    let mut kept_appeared: Vec<PathBuf> = Vec::new();
    let mut renames = RenameHalves::default();
    // Only Alkuin's own autosave rename is not a document move. A note
    // renamed from a hidden or gitignored name is still that note, and its
    // Keep on this Mac only mark must follow it.
    let filtered_source = |path: &Path| is_autosave_temp(path);

    for result in batch {
        let event = match result {
            Ok(event) => event,
            Err(err) => {
                // A backend error means events may have been lost.
                wlog!("recv err: {err:?}");
                desynced = true;
                continue;
            }
        };
        wlog!(
            "recv: kind={:?} flag={:?} paths={:?}",
            event.kind,
            event.flag(),
            event
                .paths
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
        );
        // inotify queue overflow and FSEvents MustScanSubDirs: the events
        // received so far no longer describe the tree.
        if event.need_rescan() {
            desynced = true;
        }
        renames.add(&event, &filtered_source);
        for path in &event.paths {
            note_kept_candidate(&event.kind, path, &mut kept_gone, &mut kept_appeared);
            if should_ignore(path, watched_root) {
                wlog!("filter[should_ignore]: {}", path.display());
                continue;
            }

            // `.gitignore` changes defer to a background rebuild.
            if is_gitignore_path(path) {
                wlog!("filter[gitignore-change]: {}", path.display());
                rebuild_ignore = true;
                continue;
            }

            // FSEvents reports the path as it was at event time; by
            // the time we read it the file may already be gone, so
            // `path.is_dir()` is unreliable. Trust the event kind
            // first, fall back to the live stat. Computed up here
            // because `is_workspace_ignored` needs an accurate
            // is_dir to match dir-only gitignore rules (e.g. `dist/`)
            // against deleted directories.
            let is_folder_event = matches!(
                event.kind,
                EventKind::Remove(notify::event::RemoveKind::Folder)
            ) || matches!(
                event.kind,
                EventKind::Create(notify::event::CreateKind::Folder)
            );
            let is_dir = is_folder_event || path.is_dir();

            if is_workspace_ignored(state, path, is_dir) {
                wlog!("filter[workspace_ignore]: {}", path.display());
                continue;
            }

            if suppress_as_self_write(state, path, &event.kind) {
                continue;
            }

            // Logged before the delta lands, so a full walk that publishes
            // in between re-reads this path (see `publish_full_index`).
            state.note_index_delta(path);

            if !is_dir && is_markdown(path) && path.exists() {
                let modified_at = crate::commands::fs::modified_time(path);
                publish_prepared_index_for_snapshot(state, watched_root, captured_epoch, || {
                    prepare_mtime_update(state, watched_root, path, modified_at)
                });
            }

            let kind_str = match event_kind_str(&event.kind) {
                Some(k) => k,
                None => {
                    wlog!("filter[unmapped_kind]: {:?} {}", event.kind, path.display());
                    continue;
                }
            };

            let payload = FileChangeEvent {
                path: path.to_string_lossy().to_string(),
                kind: kind_str.to_string(),
                workspace: Some(watch.identity()),
            };

            if is_dir {
                wlog!(
                    "emit fs:directory-changed kind={kind_str} {}",
                    path.display()
                );
                let _ = handle.emit_to(label.clone(), "fs:directory-changed", &payload);
            } else {
                // `.writer/config` changes reload settings instead.
                if is_config_file(path) {
                    wlog!("emit settings:changed {}", path.display());
                    let loader = state
                        .settings
                        .read()
                        .as_ref()
                        .map(|settings| settings.workspace_loader());
                    let layer = loader.map(|loader| loader.read(watched_root));
                    let _ = state.with_workspace_snapshot(watched_root, captured_epoch, || {
                        if let (Some(settings), Some(layer)) =
                            (state.settings.write().as_mut(), layer)
                        {
                            settings.install_workspace_layer(layer);
                        }
                    });
                    let _ = handle.emit_to(label.clone(), "settings:changed", watch.identity());
                    continue;
                }

                wlog!("emit fs:file-changed kind={kind_str} {}", path.display());
                let _ = handle.emit_to(label.clone(), "fs:file-changed", &payload);
            }

            if !is_membership_change(&event.kind) {
                continue;
            }

            // Maintain the file index by reading current ground truth
            // (`path.exists()`) instead of trusting the event kind.
            // FSEvents coalesces Create+Remove for the same path
            // within one watch window, and Modify(Name) doesn't tell
            // us which side of the rename this path is.
            let is_md = is_markdown(path);
            let path_exists = path.exists();
            if is_md {
                if path_exists {
                    appeared.push(path.clone());
                } else {
                    gone.push(path.clone());
                }
            }
            if is_md {
                if path_exists {
                    let modified_at = crate::commands::fs::modified_time(path);
                    let found = vec![discovered_file(path, modified_at)];
                    publish_prepared_index_for_snapshot(
                        state,
                        watched_root,
                        captured_epoch,
                        || prepare_subtree_merge(state, found.clone(), watched_root),
                    );
                } else {
                    publish_prepared_index_for_snapshot(
                        state,
                        watched_root,
                        captured_epoch,
                        || {
                            prepare_index_removal(state, watched_root, |file| {
                                file.path.as_path() == path.as_path()
                            })
                        },
                    );
                }
            } else if path_exists && is_dir {
                // A folder entered the watched tree (Create or
                // rename-in). FSEvents won't re-emit Create events
                // for descendants, so walk now to keep the index
                // in sync.
                let found = discover_subtree(path);
                publish_prepared_index_for_snapshot(state, watched_root, captured_epoch, || {
                    prepare_subtree_merge(state, found.clone(), watched_root)
                });
            } else if !path_exists {
                // A vanished non-`.md` path could be a renamed-
                // away folder; FSEvents may not emit per-child
                // events for the descendants, so prune anything
                // the index still holds under it.
                publish_prepared_index_for_snapshot(state, watched_root, captured_epoch, || {
                    prepare_index_removal(state, watched_root, |file| {
                        file.path.as_path() == path.as_path() || file.path.starts_with(path)
                    })
                });
            }

            // Refresh the parent directory's listing. Without this,
            // non-`.md` file changes, folder deletes, and Finder
            // moves never trigger a sidebar refresh.
            if !is_dir {
                if let Some(parent) = path.parent() {
                    wlog!("emit fs:directory-changed (parent) {}", parent.display());
                    let parent_payload = FileChangeEvent {
                        path: parent.to_string_lossy().to_string(),
                        kind: "modified".to_string(),
                        workspace: Some(watch.identity()),
                    };
                    let _ = handle.emit_to(label.clone(), "fs:directory-changed", &parent_payload);
                }
            }
        }
    }

    let mut next_held = HeldRemovals::default();
    if let Some(home) = home {
        // Halves held from the last batch can still meet their partner here.
        let RenameHalves {
            both,
            froms,
            tos,
            renamed_away,
            ..
        } = renames;
        let mut all_froms = held.froms;
        all_froms.extend(froms);
        let plan = pair_renames(both, all_froms, tos);
        // A move that stays inside the folder keeps the share id and the
        // "keep on this Mac" protection. A move into Trash leaves the watched
        // folder; that is a delete, decided below.
        // The kept setting follows the file wherever it went; the old path
        // stays marked too.
        carry_kept_marks(&home, &plan.pairs);
        for (from, to) in &plan.pairs {
            if to.starts_with(watched_root) {
                wlog!("moved: {} -> {}", from.display(), to.display());
                crate::share_paths::note_moved(&home, from, to);
            }
        }
        let mut candidates = appeared.clone();
        candidates.extend(held.appeared);
        let mut kept_candidates = candidates.clone();
        kept_candidates.extend(kept_appeared);
        kept_candidates.sort();
        kept_candidates.dedup();
        let mut kept_vanished = gone.clone();
        kept_vanished.extend(kept_gone);
        follow_kept_moves(&home, &kept_vanished, &held.paths, &kept_candidates);
        let (hold, classify) =
            sort_absences(&gone, &renamed_away, &held.paths, &plan.pairs, watched_root);
        for path in classify {
            let crate::share_paths::Absence::SoftDelete(id) =
                crate::share_paths::classify_absence(&home, &path, &candidates)
            else {
                continue;
            };
            wlog!("soft delete: {}", path.display());
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let home = app.path().app_data_dir().ok();
                // Only a share the list (or this Mac's map) confirms is posted;
                // an unconfirmed id waits in the pending file.
                crate::commands::removal::soft_delete_if_listed(&app, home.as_deref(), &id).await;
            });
        }
        if !hold.is_empty() {
            wlog!("hold {} removal(s) for one more window", hold.len());
            next_held = HeldRemovals {
                froms: plan
                    .unmatched_froms
                    .into_iter()
                    .filter(|half| hold.contains(&half.path))
                    .collect(),
                paths: hold,
                appeared,
                until: Some(Instant::now() + BATCH_QUIET),
            };
        }
    }

    if desynced {
        // Events were dropped somewhere. Refresh the whole sidebar now and
        // rebuild the index and the ignore matcher from disk.
        wlog!("desynced: rescanning {}", watched_root.display());
        watch.emit_root_changed();
        request_reindex(watch);
        rebuild_ignore = true;
    }

    if rebuild_ignore {
        spawn_ignore_rebuild(
            handle.clone(),
            label.clone(),
            watched_root.clone(),
            captured_epoch,
        );
    }

    next_held
}

/// Walk the workspace again after the watcher lost events, then publish it
/// through the same replaying path as the first index.
fn request_reindex(watch: &TreeWatch) {
    {
        let mut slot = watch.reindex.lock();
        if slot.running {
            slot.again = true;
            return;
        }
        slot.running = true;
    }
    let slot = Arc::clone(&watch.reindex);
    let handle = watch.handle.clone();
    let label = watch.label.clone();
    let root = watch.root.clone();
    let epoch = watch.epoch;
    std::thread::spawn(move || loop {
        reindex_once(&handle, &label, &root, epoch);
        let mut slot = slot.lock();
        if slot.again {
            slot.again = false;
            continue;
        }
        slot.running = false;
        break;
    });
}

fn reindex_once(handle: &AppHandle, label: &str, root: &Path, epoch: u64) {
    let Some(state) = handle.state::<AppState>().get(label) else {
        return;
    };
    if state.workspace_snapshot() != Some((root.to_path_buf(), epoch)) {
        return;
    }
    let cancel = Arc::clone(&state.cancel_index.read());
    let walk = state.begin_index_walk();
    let (indexed, dirs) = crate::commands::search::index_workspace_impl(root, Arc::clone(&cancel));
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    let Some(count) = publish_full_index(&state, root, epoch, walk, indexed, dirs) else {
        return;
    };
    wlog!("rescan published {count} file(s)");
    let _ = handle.emit_to(
        label,
        "fs:directory-changed",
        FileChangeEvent {
            path: root.to_string_lossy().into_owned(),
            kind: "modified".to_string(),
            workspace: Some(WorkspaceIdentity {
                root: root.to_string_lossy().into_owned(),
                epoch,
            }),
        },
    );
}

/// Start a lightweight watcher for a single standalone file (compact mode,
/// no workspace). Watches the file's *parent directory* non-recursively:
/// watching the file inode directly would break on atomic temp+rename saves
/// — Writer's own `write_file_expecting` and most editors replace the inode, and
/// the watch would die with the old one. Only events whose path matches the
/// watched file are forwarded; there is no index maintenance, no ignore
/// matching, and no directory-change fan-out.
pub fn start_file_watcher(
    app_handle: AppHandle,
    window_label: String,
    file: &Path,
    epoch: u64,
) -> Result<RecommendedWatcher, notify::Error> {
    let file_path = file.to_path_buf();
    let parent = file_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| notify::Error::generic("standalone file has no parent directory"))?;
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        notify::Config::default().with_poll_interval(Duration::from_millis(DEBOUNCE_MS)),
    )?;

    watcher.watch(&parent, RecursiveMode::NonRecursive)?;
    wlog!(
        "file watcher started for {} (watching {})",
        file_path.display(),
        parent.display()
    );

    let handle = app_handle;
    let label = window_label;
    std::thread::spawn(move || {
        while let Some(batch) = next_batch(&rx, BATCH_QUIET, BATCH_MAX_WAIT, None) {
            let Some(state) = handle.state::<AppState>().get(&label) else {
                break;
            };

            // Drop the batch if the window has moved on to another file or
            // a workspace (epoch bump on every watch target switch).
            if state.workspace_epoch.load(Ordering::SeqCst) != epoch {
                continue;
            }

            let emit = |kind: &str| {
                wlog!(
                    "emit fs:file-changed (standalone) kind={kind} {}",
                    file_path.display()
                );
                let _ = handle.emit_to(
                    label.clone(),
                    "fs:file-changed",
                    &FileChangeEvent {
                        path: file_path.to_string_lossy().to_string(),
                        kind: kind.to_string(),
                        workspace: None,
                    },
                );
            };

            let mut desynced = false;
            for result in batch {
                let event = match result {
                    Ok(event) => event,
                    Err(err) => {
                        wlog!("file watcher recv err: {err:?}");
                        desynced = true;
                        continue;
                    }
                };
                if event.need_rescan() {
                    desynced = true;
                }
                let Some(kind_str) = event_kind_str(&event.kind) else {
                    continue;
                };
                for path in &event.paths {
                    if *path != file_path {
                        continue;
                    }
                    if self_write_hit(&state, path) {
                        continue;
                    }
                    emit(kind_str);
                }
            }
            // Lost events may have hidden an edit. The frontend re-reads and
            // compares, so a spurious "modified" costs one read.
            if desynced {
                emit("modified");
            }
        }
    });

    Ok(watcher)
}

/// Rebuild the workspace gitignore matcher on a one-shot background thread,
/// then swap it in and nudge the sidebar to re-read. Keeps the watcher's
/// event loop free while the tree walk runs. Each load takes a generation
/// before it walks, so a slow earlier load cannot replace a newer matcher.
fn spawn_ignore_rebuild(
    handle: AppHandle,
    window_label: String,
    root: std::path::PathBuf,
    captured_epoch: u64,
) {
    std::thread::spawn(move || {
        let Some(generation) = handle
            .state::<AppState>()
            .get(&window_label)
            .map(|state| state.begin_ignore_load())
        else {
            return;
        };
        let new_matcher = Arc::new(WorkspaceIgnore::load(&root));
        let Some(state) = handle.state::<AppState>().get(&window_label) else {
            return;
        };

        let installed = state.with_workspace_snapshot(&root, captured_epoch, || {
            state.install_ignore(generation, new_matcher)
        });
        if installed != Some(true) {
            return;
        }
        let _ = handle.emit_to(
            window_label,
            "fs:directory-changed",
            FileChangeEvent {
                path: root.to_string_lossy().to_string(),
                kind: "modified".to_string(),
                workspace: Some(WorkspaceIdentity {
                    root: root.to_string_lossy().into_owned(),
                    epoch: captured_epoch,
                }),
            },
        );
    });
}

/// Drop a `RecommendedWatcher` on a detached thread. `notify`'s `Drop` impl
/// can briefly block on FSEvents unregistration (macOS) or inotify watch
/// removal (Linux); off-loading keeps the IPC thread responsive when the
/// user rapidly switches workspaces.
pub fn drop_watcher_off_thread(watcher: Option<RecommendedWatcher>) {
    let Some(watcher) = watcher else {
        return;
    };
    std::thread::spawn(move || drop(watcher));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ROOT: &str = "/workspace";

    #[test]
    fn test_ignores_git_directory() {
        let root = Path::new(ROOT);
        assert!(should_ignore(Path::new("/workspace/.git/config"), root));
        assert!(should_ignore(
            Path::new("/workspace/.git/refs/heads/main"),
            root
        ));
    }

    #[test]
    fn test_ignores_hidden_files() {
        let root = Path::new(ROOT);
        assert!(should_ignore(Path::new("/workspace/.DS_Store"), root));
        assert!(should_ignore(Path::new("/workspace/.hidden/file.md"), root));
    }

    #[test]
    fn test_does_not_ignore_normal_files() {
        let root = Path::new(ROOT);
        assert!(!should_ignore(Path::new("/workspace/notes/hello.md"), root));
        assert!(!should_ignore(Path::new("/workspace/readme.md"), root));
    }

    #[test]
    fn dotdir_workspace_root_does_not_filter_its_own_paths() {
        // Regression: a workspace at `~/.notes/` must keep firing events even
        // though `.notes` is a dotdir.
        let root = Path::new("/Users/joel/.notes");
        assert!(!should_ignore(&root.join("foo.md"), root));
        assert!(!should_ignore(&root.join("docs/bar.md"), root));
        // Hidden subdirs inside the dotdir root are still filtered.
        assert!(should_ignore(&root.join(".cache/x"), root));
        assert!(should_ignore(&root.join(".git/HEAD"), root));
    }

    #[test]
    fn paths_outside_root_are_not_filtered_here() {
        // `should_ignore` only applies to paths inside the root; the recursive
        // watch and `is_workspace_ignored` handle anything else.
        let root = Path::new("/workspace");
        assert!(!should_ignore(Path::new("/elsewhere/.cache/file"), root));
    }

    /// Write `body` to `path` the way `write_file` does: marker, write, settle.
    fn self_write(state: &WorkspaceState, path: &Path, body: &str) {
        let id = begin_self_write(state, path);
        std::fs::write(path, body).unwrap();
        finish_self_write(state, path, id, true);
    }

    fn modify_data() -> EventKind {
        EventKind::Modify(notify::event::ModifyKind::Data(
            notify::event::DataChange::Any,
        ))
    }

    fn create_file() -> EventKind {
        EventKind::Create(notify::event::CreateKind::File)
    }

    #[test]
    fn test_self_write_detection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.md");
        let state = WorkspaceState::default();

        assert!(!self_write_hit(&state, &path));
        self_write(&state, &path, "# saved");

        // A single save produces multiple FSEvents (Create + Modify(Metadata)
        // + Modify(Data)); every match within the TTL window must be
        // suppressed, not just the first.
        assert!(self_write_hit(&state, &path));
        assert!(self_write_hit(&state, &path));
        assert!(self_write_hit(&state, &path));
    }

    #[test]
    fn self_write_entry_is_not_consumed_on_match() {
        // Regression: an earlier implementation removed the entry on first
        // match, which dropped the second and third events from the same
        // save's fan-out and let the frontend reload the file from disk
        // mid-keystroke.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.md");
        let state = WorkspaceState::default();

        self_write(&state, &path, "# saved");
        assert!(self_write_hit(&state, &path));
        assert_eq!(
            state.recent_writes.read().len(),
            1,
            "entry must survive the lookup so subsequent FSEvent fan-out is also suppressed"
        );
        assert!(self_write_hit(&state, &path));
        assert_eq!(state.recent_writes.read().len(), 1);
    }

    #[test]
    fn self_write_expires_after_ttl() {
        // The TTL window is what bounds suppression — past it, legitimate
        // external edits to the same path must be reflected in the editor.
        let state = WorkspaceState::default();
        let path = PathBuf::from("/test/file.md");

        // Insert a stale entry directly so the test doesn't have to sleep
        // through the real TTL.
        state.recent_writes.write().insert(
            path.clone(),
            SelfWrite::InFlight {
                id: 1,
                since: Instant::now() - SELF_WRITE_TTL - Duration::from_millis(50),
            },
        );

        assert!(!self_write_hit(&state, &path));
    }

    #[test]
    fn an_external_edit_after_a_save_is_not_suppressed() {
        // Suppression used to cover every event for 2s after the IPC
        // arrived. Now it covers only the bytes this window wrote.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.md");
        let state = WorkspaceState::default();

        self_write(&state, &path, "# saved");
        assert!(self_write_hit(&state, &path));

        std::fs::write(&path, "# saved, then edited elsewhere").unwrap();
        assert!(!self_write_hit(&state, &path));
    }

    #[test]
    fn a_failed_write_leaves_no_suppression() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.md");
        let state = WorkspaceState::default();

        let id = begin_self_write(&state, &path);
        assert!(
            self_write_hit(&state, &path),
            "events during the write are ours"
        );
        finish_self_write(&state, &path, id, false);
        assert!(state.recent_writes.read().is_empty());

        std::fs::write(&path, "# written by someone else").unwrap();
        assert!(!self_write_hit(&state, &path));
    }

    #[test]
    fn an_older_write_settling_late_does_not_touch_a_newer_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.md");
        let state = WorkspaceState::default();

        let older = begin_self_write(&state, &path);
        let newer = begin_self_write(&state, &path);
        finish_self_write(&state, &path, older, false);
        assert_eq!(
            state.recent_writes.read().get(&path).map(SelfWrite::id),
            Some(newer)
        );
        std::fs::write(&path, "# newer").unwrap();
        finish_self_write(&state, &path, newer, true);
        assert!(self_write_hit(&state, &path));
    }

    #[test]
    fn a_created_file_that_is_not_indexed_is_never_suppressed() {
        // Duplicate and Office import write a new file through
        // `write_file`. Suppressing its Create kept it out of the index.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.md");
        let state = WorkspaceState::default();

        self_write(&state, &path, "# copy");
        assert!(!suppress_as_self_write(&state, &path, &create_file()));
        assert!(suppress_as_self_write(&state, &path, &modify_data()));

        state.file_index.write().push(discovered_file(&path, 1));
        assert!(suppress_as_self_write(&state, &path, &create_file()));
    }

    #[test]
    fn add_to_index_is_idempotent() {
        let state = WorkspaceState::default();
        let root = PathBuf::from("/ws");
        let path = root.join("note.md");

        add_to_index(&state, &path, &root);
        add_to_index(&state, &path, &root);

        assert_eq!(state.file_index.read().len(), 1);
        assert!(state.dirs_with_markdown.read().contains(&root));
    }

    #[test]
    fn add_subtree_walks_real_directory_and_indexes_md_files() {
        // Regression: a folder rename within the watch tree (`Modify(Name)`
        // with `path_exists`) must populate the index for every `.md`
        // descendant. Before this test existed, the appearing side of a
        // rename was silently no-op'd and search/sidebar drifted from disk.
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let nested = root.join("nested");
        std::fs::create_dir_all(nested.join("deeper")).unwrap();
        std::fs::write(nested.join("a.md"), "# a").unwrap();
        std::fs::write(nested.join("deeper/b.md"), "# b").unwrap();
        std::fs::write(nested.join("ignored.txt"), "x").unwrap();

        let state = WorkspaceState::default();
        add_subtree_to_index(&state, &nested, &root);

        let paths: Vec<_> = state
            .file_index
            .read()
            .iter()
            .map(|f| f.path.clone())
            .collect();
        assert!(paths.contains(&nested.join("a.md")));
        assert!(paths.contains(&nested.join("deeper/b.md")));
        assert_eq!(paths.len(), 2, "non-md files must not be indexed");

        let dirs = state.dirs_with_markdown.read();
        assert!(dirs.contains(&nested));
        assert!(dirs.contains(&nested.join("deeper")));
        assert!(dirs.contains(&root), "ancestors register up to the root");
    }

    #[test]
    fn add_subtree_is_idempotent_against_existing_entries() {
        // Re-running over the same directory must not duplicate indexed paths.
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.md"), "# a").unwrap();

        let state = WorkspaceState::default();
        add_subtree_to_index(&state, &root, &root);
        add_subtree_to_index(&state, &root, &root);
        assert_eq!(state.file_index.read().len(), 1);
    }

    #[test]
    fn prepared_index_publication_rejects_a_changed_revision() {
        let state = WorkspaceState::default();
        let root = PathBuf::from("/ws");
        let found = vec![discovered_file(&root.join("new.md"), 1)];
        let prepared = prepare_subtree_merge(&state, found, &root);

        state.file_index_revision.fetch_add(1, Ordering::SeqCst);

        assert!(publish_index_update(&state, prepared).is_err());
        assert!(state.file_index.read().is_empty());
    }

    #[test]
    fn workspace_identity_serialization_matches_the_shared_contract() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../shared/workspace-identity.contract.json"
        ))
        .unwrap();
        let actual = serde_json::to_value(WorkspaceIdentity {
            root: "/workspace".to_string(),
            epoch: 7,
        })
        .unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn remove_subtree_drops_only_matching_descendants() {
        let state = WorkspaceState::default();
        let root = PathBuf::from("/ws");
        let kept = root.join("kept.md");
        let inside = root.join("sub/inside.md");
        let inside2 = root.join("sub/nested/x.md");
        let sibling = root.join("submarine/y.md");

        add_to_index(&state, &kept, &root);
        add_to_index(&state, &inside, &root);
        add_to_index(&state, &inside2, &root);
        add_to_index(&state, &sibling, &root);

        remove_subtree_from_index(&state, &root.join("sub"), &root);

        let paths: Vec<_> = state
            .file_index
            .read()
            .iter()
            .map(|f| f.path.clone())
            .collect();
        assert!(paths.contains(&kept));
        assert!(paths.contains(&sibling), "prefix-named sibling kept");
        assert!(!paths.contains(&inside), "direct child removed");
        assert!(!paths.contains(&inside2), "nested child removed");

        let dirs = state.dirs_with_markdown.read();
        assert!(dirs.contains(&root));
        assert!(dirs.contains(&root.join("submarine")));
        assert!(!dirs.contains(&root.join("sub")));
        assert!(!dirs.contains(&root.join("sub/nested")));
    }

    fn stale(age: Duration) -> Instant {
        Instant::now()
            .checked_sub(age)
            .unwrap_or_else(|| Instant::now() - (SELF_WRITE_TTL + Duration::from_millis(1)))
    }

    #[test]
    fn delayed_echo_outside_ttl_is_not_suppressed() {
        // Hypothesis A (a same-content echo 5–30s later, from iCloud / Dropbox /
        // SMB) is not implemented. Suppression is the 2s timestamp window.
        // A late echo falls through even when the bytes never changed.
        assert!(SELF_WRITE_TTL < Duration::from_secs(30));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.md");
        std::fs::write(&path, "# saved").unwrap();
        let state = WorkspaceState::default();
        state.recent_writes.write().insert(
            path.clone(),
            SelfWrite::Landed {
                id: 1,
                at: stale(Duration::from_secs(30)),
                signature: FileSignature::of(&path).unwrap(),
            },
        );

        assert!(!self_write_hit(&state, &path));
    }

    #[test]
    fn self_write_compares_metadata_not_bytes() {
        // Suppression compares modified time and length, never a content
        // hash. Do not add a hash until a Mac delayed-echo repro confirms
        // hypothesis A. While the write runs nothing is read at all.
        let state = WorkspaceState::default();
        let path = PathBuf::from("/test/missing.md");
        begin_self_write(&state, &path);

        assert!(self_write_hit(&state, &path));
        assert!(!path.exists());
    }

    #[test]
    fn self_write_does_not_suppress_a_different_path() {
        let state = WorkspaceState::default();
        begin_self_write(&state, Path::new("/test/a.md"));
        assert!(!self_write_hit(&state, Path::new("/test/b.md")));
    }

    #[test]
    fn begin_self_write_drops_entries_older_than_ttl() {
        let state = WorkspaceState::default();
        let stale_path = PathBuf::from("/test/stale.md");
        let fresh = PathBuf::from("/test/fresh.md");
        state.recent_writes.write().insert(
            stale_path.clone(),
            SelfWrite::InFlight {
                id: 1,
                since: stale(SELF_WRITE_TTL + Duration::from_millis(50)),
            },
        );

        begin_self_write(&state, &fresh);

        let writes = state.recent_writes.read();
        assert!(!writes.contains_key(&stale_path));
        assert!(writes.contains_key(&fresh));
        assert_eq!(writes.len(), 1);
    }

    #[test]
    fn vim_rename_is_a_modified_membership_change() {
        // Residual mode E: vim `:w` is tempfile + rename. The target arrives as
        // Modify(Name), which must stay a "modified" file event and a
        // membership change so the index follows `path.exists()`.
        let kind = EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Any,
        ));
        assert_eq!(event_kind_str(&kind), Some("modified"));
        assert!(is_membership_change(&kind));
    }

    #[test]
    fn metadata_modify_is_not_a_membership_change() {
        let kind = EventKind::Modify(notify::event::ModifyKind::Metadata(
            notify::event::MetadataKind::Any,
        ));
        assert_eq!(event_kind_str(&kind), Some("modified"));
        assert!(!is_membership_change(&kind));
    }

    #[test]
    fn unmapped_event_kinds_do_not_emit() {
        assert_eq!(event_kind_str(&EventKind::Any), None);
        assert_eq!(event_kind_str(&EventKind::Other), None);
        assert!(!is_membership_change(&EventKind::Any));
        assert!(is_membership_change(&EventKind::Create(
            notify::event::CreateKind::File
        )));
        assert!(is_membership_change(&EventKind::Remove(
            notify::event::RemoveKind::File
        )));
    }

    #[test]
    fn a_batch_flushes_after_quiet_or_at_the_max_wait() {
        let quiet = Duration::from_millis(300);
        let max_wait = Duration::from_millis(1500);
        let t0 = Instant::now();
        assert_eq!(BatchPhase::Idle.flush_at(quiet, max_wait), None);

        let collecting = BatchPhase::Idle.on_event(t0);
        assert_eq!(collecting.flush_at(quiet, max_wait), Some(t0 + quiet));

        // Each event pushes the flush out...
        let later = collecting.on_event(t0 + Duration::from_millis(200));
        assert_eq!(
            later.flush_at(quiet, max_wait),
            Some(t0 + Duration::from_millis(500))
        );
        // ...but never past the max wait from the first event.
        let streaming = later.on_event(t0 + Duration::from_millis(1400));
        assert_eq!(streaming.flush_at(quiet, max_wait), Some(t0 + max_wait));
    }

    #[test]
    fn the_first_event_after_a_quiet_spell_waits_for_its_partner() {
        // The old leading-edge loop flushed the first event after
        // 300ms of quiet on its own, so a rename's "from" half was processed
        // (and soft-deleted) before its "to" half arrived.
        let (tx, rx) = std::sync::mpsc::channel();
        let sender = std::thread::spawn(move || {
            tx.send("from").unwrap();
            std::thread::sleep(Duration::from_millis(30));
            tx.send("to").unwrap();
            std::thread::sleep(Duration::from_millis(1500));
            tx.send("later").unwrap();
        });
        let quiet = Duration::from_millis(500);
        let max_wait = Duration::from_millis(5000);
        assert_eq!(
            next_batch(&rx, quiet, max_wait, None),
            Some(vec!["from", "to"])
        );
        assert_eq!(next_batch(&rx, quiet, max_wait, None), Some(vec!["later"]));
        sender.join().unwrap();
        assert_eq!(next_batch(&rx, quiet, max_wait, None), None);
    }

    #[test]
    fn an_idle_deadline_returns_an_empty_batch() {
        let (_tx, rx) = std::sync::mpsc::channel::<()>();
        let deadline = Instant::now() + Duration::from_millis(20);
        assert_eq!(
            next_batch(
                &rx,
                Duration::from_millis(300),
                Duration::from_secs(1),
                Some(deadline)
            ),
            Some(Vec::new())
        );
    }

    fn half(path: &str, tracker: Option<usize>) -> RenameHalf {
        RenameHalf {
            path: PathBuf::from(path),
            tracker,
        }
    }

    #[test]
    fn linux_from_to_both_is_one_move() {
        // Inotify reports From, To and Both for one rename. The old
        // code paired From+To on top of Both, and the second `note_moved`
        // replaced the carried share id with a path-derived one.
        let plan = pair_renames(
            vec![(PathBuf::from("/ws/a.md"), PathBuf::from("/ws/b.md"))],
            vec![half("/ws/a.md", Some(7))],
            vec![half("/ws/b.md", Some(7))],
        );
        assert_eq!(
            plan.pairs,
            vec![(PathBuf::from("/ws/a.md"), PathBuf::from("/ws/b.md"))]
        );
        assert!(plan.unmatched_froms.is_empty());
    }

    fn rename_event(
        mode: notify::event::RenameMode,
        paths: &[&str],
        tracker: Option<usize>,
    ) -> Event {
        let mut event = Event::new(EventKind::Modify(notify::event::ModifyKind::Name(mode)));
        for path in paths {
            event = event.add_path(PathBuf::from(path));
        }
        match tracker {
            Some(tracker) => event.set_tracker(tracker),
            None => event,
        }
    }

    fn halves_of(events: &[Event]) -> RenameHalves {
        let filtered = |path: &Path| is_autosave_temp(path);
        let mut halves = RenameHalves::default();
        for event in events {
            halves.add(event, &filtered);
        }
        halves
    }

    #[test]
    fn alkuins_own_temp_file_save_is_not_a_move() {
        // `write_file_expecting` writes `.~<uuid>` and renames it onto the
        // document. inotify reports From, To and Both with one cookie. Pairing
        // that called `note_moved` on every save and replaced the document's
        // share id with the temp file's.
        use notify::event::RenameMode;
        let temp = "/ws/.~0b9c2f1e-1111-4222-8333-944455556666";
        let linux = halves_of(&[
            rename_event(RenameMode::From, &[temp], Some(5)),
            rename_event(RenameMode::To, &["/ws/target.md"], Some(5)),
            rename_event(RenameMode::Both, &[temp, "/ws/target.md"], Some(5)),
        ]);
        assert!(linux.renamed_away.is_empty());
        let plan = pair_renames(linux.both, linux.froms, linux.tos);
        assert!(plan.pairs.is_empty(), "no pair, so no note_moved");
        assert!(plan.unmatched_froms.is_empty());

        // Windows tags neither half. The save must not pair with a real,
        // untagged rename in the same batch either.
        let windows = halves_of(&[
            rename_event(RenameMode::From, &[temp], None),
            rename_event(RenameMode::To, &["/ws/target.md"], None),
            rename_event(RenameMode::From, &["/ws/old.md"], None),
            rename_event(RenameMode::To, &["/ws/new.md"], None),
        ]);
        let plan = pair_renames(windows.both, windows.froms, windows.tos);
        assert_eq!(
            plan.pairs,
            vec![(PathBuf::from("/ws/old.md"), PathBuf::from("/ws/new.md"))]
        );

        // FSEvents: the temp side is not a path that left the folder.
        let mac = halves_of(&[
            rename_event(RenameMode::Any, &[temp], None),
            rename_event(RenameMode::Any, &["/ws/target.md"], None),
        ]);
        assert_eq!(
            mac.renamed_away,
            [PathBuf::from("/ws/target.md")].into_iter().collect()
        );
    }

    /// What `process_tree_batch` does with a batch's rename pairs for the
    /// kept setting.
    fn follow_pairs(home: &Path, events: &[Event]) -> Vec<(PathBuf, PathBuf)> {
        let halves = halves_of(events);
        let plan = pair_renames(halves.both, halves.froms, halves.tos);
        carry_kept_marks(home, &plan.pairs);
        plan.pairs
    }

    #[test]
    fn a_kept_note_renamed_from_a_hidden_or_ignored_name_keeps_its_mark() {
        // Every rename whose source the watcher ignores was
        // dropped, not only the autosave temp, so a private note renamed
        // from a hidden or gitignored name lost its mark and could upload.
        use notify::event::RenameMode;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("notes");
        let home = dir.path().join("app-data");
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let root = root.canonicalize().unwrap();
        let hidden = root.join(".draft.md");
        let ignored = root.join("build/scratch.md");
        let first = root.join("journal.md");
        let second = root.join("letters.md");
        std::fs::write(&hidden, "private one").unwrap();
        std::fs::write(&ignored, "private two").unwrap();
        crate::mac_only::set_kept(&home, &hidden, true).unwrap();
        crate::mac_only::set_kept(&home, &ignored, true).unwrap();
        std::fs::rename(&hidden, &first).unwrap();
        std::fs::rename(&ignored, &second).unwrap();
        let h = hidden.to_str().unwrap();
        let i = ignored.to_str().unwrap();
        let f = first.to_str().unwrap();
        let l = second.to_str().unwrap();
        let pairs = follow_pairs(
            &home,
            &[
                rename_event(RenameMode::From, &[h], Some(7)),
                rename_event(RenameMode::To, &[f], Some(7)),
                rename_event(RenameMode::Both, &[i, l], Some(8)),
            ],
        );
        assert_eq!(pairs.len(), 2, "{pairs:?}");
        let set = crate::mac_only::MacOnlySet::load(&home);
        assert!(set.blocks(&first), "renamed from a hidden name");
        assert!(set.blocks(&second), "renamed from an ignored folder");
        assert!(set.blocks(&hidden) && set.blocks(&ignored));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_left_at_the_old_path_keeps_the_other_notes_mark() {
        // The watcher's retarget resolved the old path
        // through a symlink. A co-writer's symlink at the old path to another
        // private note moved that note's mark away from it.
        use notify::event::RenameMode;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("notes");
        let home = dir.path().join("app-data");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let root = root.canonicalize().unwrap();
        let private = root.join("private.md");
        let old = root.join("old.md");
        let new = root.join("new.md");
        std::fs::write(&private, "only on this Mac").unwrap();
        std::fs::write(&old, "a public note").unwrap();
        crate::mac_only::set_kept(&home, &private, true).unwrap();
        std::fs::rename(&old, &new).unwrap();
        std::os::unix::fs::symlink(&private, &old).unwrap();
        let o = old.to_str().unwrap();
        let n = new.to_str().unwrap();
        follow_pairs(&home, &[rename_event(RenameMode::Both, &[o, n], Some(9))]);
        let set = crate::mac_only::MacOnlySet::load(&home);
        assert!(set.blocks(&private), "the private note lost its mark");
        assert!(
            !set.blocks(&new),
            "the public note took a mark it never had"
        );
    }

    #[test]
    fn a_watcher_replay_of_an_in_app_rename_keeps_the_fingerprint_a_save_stored() {
        // Carry_kept_marks replays renames the app already
        // applied. try_retarget copied the source's fingerprint onto the
        // already-marked destination, over the fresh one a save stored there,
        // so a later unpaired move no longer matched and the note uploaded.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("notes");
        let home = dir.path().join("app-data");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let root = root.canonicalize().unwrap();
        let a = root.join("a.md");
        let b = root.join("b.md");
        let c = root.join("c.md");
        std::fs::write(&a, "private, first words").unwrap();
        crate::mac_only::set_kept(&home, &a, true).unwrap();
        crate::mac_only::remember_print(&home, &a);

        // In-app rename: the file moves, then the mark follows.
        std::fs::rename(&a, &b).unwrap();
        assert!(crate::mac_only::try_retarget(&home, &a, &b, false).unwrap());
        // A save writes a temp file and renames it onto the note (new inode,
        // new text), then stores the fresh fingerprint.
        let temp = root.join(".~0b9c2f1e-1111-4222-8333-944455556666");
        std::fs::write(&temp, "private, saved again with other words").unwrap();
        std::fs::rename(&temp, &b).unwrap();
        crate::mac_only::remember_print(&home, &b);
        // The debounced watcher batch replays the same rename.
        carry_kept_marks(&home, &[(a.clone(), b.clone())]);
        // Later, a Finder rename arrives unpaired.
        std::fs::rename(&b, &c).unwrap();
        follow_kept_moves(
            &home,
            std::slice::from_ref(&b),
            &[],
            std::slice::from_ref(&c),
        );
        assert!(
            crate::mac_only::MacOnlySet::load(&home).blocks(&c),
            "the replay put an old fingerprint over the saved one"
        );
    }

    #[test]
    fn a_kept_note_renamed_twice_in_one_batch_keeps_its_mark() {
        // The watcher skipped a pair whose destination was
        // already gone, so A -> B -> C in one batch left C unmarked. The
        // pairs are applied until none adds anything, in either order.
        use notify::event::RenameMode;
        for reversed in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("notes");
            let home = dir.path().join("app-data");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::create_dir_all(&home).unwrap();
            let root = root.canonicalize().unwrap();
            let a = root.join("a.md");
            let b = root.join("b.md");
            let c = root.join("c.md");
            std::fs::write(&a, "private").unwrap();
            crate::mac_only::set_kept(&home, &a, true).unwrap();
            std::fs::rename(&a, &b).unwrap();
            std::fs::rename(&b, &c).unwrap();
            let (a_s, b_s, c_s) = (
                a.to_str().unwrap(),
                b.to_str().unwrap(),
                c.to_str().unwrap(),
            );
            let mut events = vec![
                rename_event(RenameMode::Both, &[a_s, b_s], Some(1)),
                rename_event(RenameMode::Both, &[b_s, c_s], Some(2)),
            ];
            if reversed {
                events.reverse();
            }
            let pairs = follow_pairs(&home, &events);
            assert_eq!(pairs.len(), 2, "{pairs:?}");
            let set = crate::mac_only::MacOnlySet::load(&home);
            assert!(
                set.blocks(&c),
                "reversed={reversed}: the final name lost the mark"
            );
            assert!(set.blocks(&a) && set.blocks(&b));
        }
    }

    #[test]
    fn a_hidden_or_ignored_note_is_a_kept_candidate_but_the_autosave_temp_is_not() {
        // The fingerprint fallback only saw paths that passed
        // the ignore filters, so an unpaired rename from a hidden or ignored
        // name could not carry the mark.
        use notify::event::{ModifyKind, RemoveKind, RenameMode};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let hidden = root.join(".draft.md");
        let note = root.join("note.md");
        std::fs::write(&note, "private").unwrap();
        let rename = EventKind::Modify(ModifyKind::Name(RenameMode::Any));
        let (mut gone, mut appeared) = (Vec::new(), Vec::new());
        note_kept_candidate(&rename, &hidden, &mut gone, &mut appeared);
        note_kept_candidate(&rename, &note, &mut gone, &mut appeared);
        note_kept_candidate(&rename, &note, &mut gone, &mut appeared);
        let temp = root.join(".~0b9c2f1e-1111-4222-8333-944455556666");
        note_kept_candidate(
            &EventKind::Remove(RemoveKind::File),
            &temp,
            &mut gone,
            &mut appeared,
        );
        note_kept_candidate(&rename, &root.join("image.png"), &mut gone, &mut appeared);
        assert_eq!(gone, vec![hidden.clone()]);
        assert_eq!(appeared, vec![note.clone()], "reported twice, kept once");

        // Fed to the fallback, the mark follows the note.
        let home = dir.path().join("app-data");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(&hidden, "private").unwrap();
        std::fs::remove_file(&note).unwrap();
        crate::mac_only::set_kept(&home, &hidden, true).unwrap();
        std::fs::rename(&hidden, &note).unwrap();
        follow_kept_moves(&home, &gone, &[], &appeared);
        assert!(crate::mac_only::MacOnlySet::load(&home).blocks(&note));
    }

    #[test]
    fn a_kept_document_renamed_without_a_pair_keeps_its_mark() {
        // FSEvents reports a Finder rename as two unpaired `Name(Any)`
        // paths. The mark stayed on the old path, so the renamed document
        // was no longer blocked from leaving the Mac.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("notes");
        let home = dir.path().join("app-data");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let root = root.canonicalize().unwrap();
        let diary = root.join("diary.md");
        let journal = root.join("journal.md");
        let other = root.join("other.md");
        std::fs::write(&diary, "# Private").unwrap();
        std::fs::write(&other, "# Public").unwrap();
        // Marking it kept records its fingerprint; no batch has run yet.
        crate::mac_only::set_kept(&home, &diary, true).unwrap();
        std::fs::rename(&diary, &journal).unwrap();

        // The vanished half was held from the last window.
        follow_kept_moves(
            &home,
            &[],
            std::slice::from_ref(&diary),
            &[other.clone(), journal.clone()],
        );

        let set = crate::mac_only::MacOnlySet::load(&home);
        assert!(set.blocks(&journal));
        // The old path stays marked, as on main: a file written back there
        // is still kept.
        assert!(set.paths().contains(&diary));
        assert!(!set.blocks(&other));
    }

    #[test]
    fn a_kept_document_moved_to_the_trash_keeps_its_mark_where_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("notes");
        let home = dir.path().join("app-data");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let root = root.canonicalize().unwrap();
        let diary = root.join("diary.md");
        let fresh = root.join("fresh.md");
        std::fs::write(&diary, "# Private").unwrap();
        crate::mac_only::set_kept(&home, &diary, true).unwrap();
        // Written first so it cannot reuse the kept file's inode. (A reused
        // inode would carry the mark to the new file: over-protection, the
        // safe side.)
        std::fs::write(&fresh, "# Something else").unwrap();
        std::fs::remove_file(&diary).unwrap();
        // No appeared file matches its fingerprint: no guessing.
        follow_kept_moves(
            &home,
            std::slice::from_ref(&diary),
            &[],
            std::slice::from_ref(&fresh),
        );
        let set = crate::mac_only::MacOnlySet::load(&home);
        assert!(set.paths().contains(&diary));
        assert!(!set.blocks(&fresh));
    }

    #[test]
    fn halves_pair_by_tracker_and_strangers_stay_apart() {
        let plan = pair_renames(
            Vec::new(),
            vec![half("/ws/a.md", Some(1)), half("/ws/c.md", Some(2))],
            vec![half("/ws/d.md", Some(2)), half("/ws/b.md", Some(1))],
        );
        assert_eq!(
            plan.pairs,
            vec![
                (PathBuf::from("/ws/a.md"), PathBuf::from("/ws/b.md")),
                (PathBuf::from("/ws/c.md"), PathBuf::from("/ws/d.md")),
            ]
        );

        // One left of each but tagged with different cookies: two renames
        // whose other halves fell outside the watch, not one move.
        let apart = pair_renames(
            Vec::new(),
            vec![half("/ws/a.md", Some(1))],
            vec![half("/ws/z.md", Some(9))],
        );
        assert!(apart.pairs.is_empty());
        assert_eq!(apart.unmatched_froms, vec![half("/ws/a.md", Some(1))]);

        // Untagged halves keep the old one-to-one rule.
        let untagged = pair_renames(
            Vec::new(),
            vec![half("/ws/a.md", None)],
            vec![half("/ws/b.md", None)],
        );
        assert_eq!(
            untagged.pairs,
            vec![(PathBuf::from("/ws/a.md"), PathBuf::from("/ws/b.md"))]
        );
    }

    #[test]
    fn a_lone_rename_half_is_held_then_classified() {
        let root = PathBuf::from("/ws");
        let renamed = PathBuf::from("/ws/a.md");
        let deleted = PathBuf::from("/ws/gone.md");
        let away: HashSet<PathBuf> = [renamed.clone()].into_iter().collect();

        // First batch: the rename half waits, a plain Remove is classified.
        let (hold, classify) =
            sort_absences(&[renamed.clone(), deleted.clone()], &away, &[], &[], &root);
        assert_eq!(hold, vec![renamed.clone()]);
        assert_eq!(classify, vec![deleted]);

        // Next batch, the partner arrived: nothing to classify.
        let pairs = vec![(renamed.clone(), PathBuf::from("/ws/b.md"))];
        let (hold, classify) = sort_absences(
            &[],
            &HashSet::new(),
            std::slice::from_ref(&renamed),
            &pairs,
            &root,
        );
        assert!(hold.is_empty());
        assert!(classify.is_empty());

        // Next batch, still alone (moved to Trash): now it is classified.
        let (hold, classify) = sort_absences(
            &[],
            &HashSet::new(),
            std::slice::from_ref(&renamed),
            &[],
            &root,
        );
        assert!(hold.is_empty());
        assert_eq!(classify, vec![renamed]);
    }

    #[test]
    fn a_move_out_of_the_workspace_is_not_a_carry() {
        let root = PathBuf::from("/ws");
        let from = PathBuf::from("/ws/a.md");
        let pairs = vec![(from.clone(), PathBuf::from("/elsewhere/a.md"))];
        let (hold, classify) = sort_absences(
            std::slice::from_ref(&from),
            &HashSet::new(),
            &[],
            &pairs,
            &root,
        );
        assert!(hold.is_empty());
        assert_eq!(classify, vec![from]);
    }

    #[test]
    fn a_full_publish_keeps_changes_made_during_the_walk() {
        // The walk result used to replace the index wholesale, so a
        // file created mid-walk vanished from search and a file deleted
        // mid-walk came back.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("kept.md"), "# kept").unwrap();
        std::fs::write(root.join("doomed.md"), "# doomed").unwrap();
        let state = WorkspaceState::default();
        let (epoch, _, _) = state.transition_to_workspace(root.clone());

        let walk = state.begin_index_walk();
        let (indexed, dirs) =
            crate::commands::search::index_workspace_impl(&root, Arc::new(AtomicBool::new(false)));
        assert_eq!(indexed.len(), 2);

        // The watcher sees these while the walk is "still running".
        std::fs::remove_file(root.join("doomed.md")).unwrap();
        state.note_index_delta(&root.join("doomed.md"));
        std::fs::create_dir(root.join("new")).unwrap();
        std::fs::write(root.join("new/born.md"), "# born").unwrap();
        state.note_index_delta(&root.join("new"));

        assert_eq!(
            publish_full_index(&state, &root, epoch, walk, indexed, dirs),
            Some(2)
        );
        let mut paths: Vec<PathBuf> = state
            .file_index
            .read()
            .iter()
            .map(|file| file.path.clone())
            .collect();
        paths.sort();
        assert_eq!(paths, vec![root.join("kept.md"), root.join("new/born.md")]);
        let born = state
            .file_index
            .read()
            .iter()
            .find(|file| file.path == root.join("new/born.md"))
            .map(|file| file.relative_path.clone());
        assert_eq!(born.as_deref(), Some("new/born.md"));
        assert!(state.dirs_with_markdown.read().contains(&root.join("new")));
        assert!(state.index_ready.load(Ordering::SeqCst));
    }

    #[test]
    fn a_full_publish_for_a_closed_workspace_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = WorkspaceState::default();
        let (epoch, _, _) = state.transition_to_workspace(root.clone());
        let walk = state.begin_index_walk();
        state.clear_workspace_if_current(&root).unwrap();
        assert_eq!(
            publish_full_index(
                &state,
                &root,
                epoch,
                walk,
                vec![discovered_file(&root.join("a.md"), 1)],
                HashSet::new()
            ),
            None
        );
        assert!(state.file_index.read().is_empty());
    }
}
