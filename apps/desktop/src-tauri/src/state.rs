use crate::config::Settings;
use crate::ignore::WorkspaceIgnore;
use crate::open_target::PendingOpenPayload;
use notify::RecommendedWatcher;
use parking_lot::{Mutex, RwLock};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime};

/// Per-window workspace state. Every open window has exactly one
/// `WorkspaceState`, keyed by the window's Tauri label inside [`AppState`].
/// All workspace-bound runtime data — the loaded file index, the file
/// watcher, the gitignore matcher, the per-window settings layer — lives
/// here so multiple windows can host different workspaces simultaneously
/// without clobbering each other.
pub struct WorkspaceState {
    pub workspace_root: RwLock<Option<PathBuf>>,
    pub file_index: RwLock<Vec<IndexedFile>>,
    /// Bumped, while `file_index` is write-locked, on every change to the
    /// index. Readers that copy the index read it under the same lock.
    pub file_index_revision: AtomicU64,
    /// Recent-files order for one index revision. A copy whose revision is
    /// not the current one is never served, so a sort that raced an index
    /// change cannot install stale order.
    pub recent_files_cache: RwLock<RecentFilesCache>,
    pub dirs_with_markdown: RwLock<HashSet<PathBuf>>,
    /// Set to `true` after the first full index completes.
    /// When `false`, `dir_contains_markdown` falls back to recursive check.
    pub index_ready: AtomicBool,
    pub watcher_handle: RwLock<Option<RecommendedWatcher>>,
    /// What this window wrote recently, so the watcher can tell its own echo
    /// from an external edit. See [`SelfWrite`].
    pub recent_writes: RwLock<HashMap<PathBuf, SelfWrite>>,
    /// Paths the watcher (or a write) changed while a full index walk was
    /// running. The walk replays them before it publishes. See [`IndexWalk`].
    pub index_journal: Mutex<IndexJournal>,
    /// Gitignore matcher for the current workspace. Rebuilt when any
    /// `.gitignore` file changes. `None` until the first workspace is opened.
    pub workspace_ignore: RwLock<Option<Arc<WorkspaceIgnore>>>,
    /// Generation handed to each full matcher load when it starts. A load
    /// installs only when no later-started load has installed already, so a
    /// slow old walk cannot replace a newer matcher.
    ignore_loads_started: AtomicU64,
    /// Generation of the installed full matcher. Unchanged by a workspace
    /// switch: loads started after the switch get higher generations, and
    /// loads started before it fail the epoch check.
    ignore_installed: AtomicU64,
    /// Monotonic counter incremented on every workspace switch inside this
    /// window. Background tasks capture it at launch and re-check before
    /// writing; stale results are dropped. Watcher closures capture it too
    /// so events queued against a prior workspace never mutate the new
    /// workspace's state.
    pub workspace_epoch: AtomicU64,
    /// Cancellation flag threaded through the active index walker. On
    /// workspace switch the outgoing flag is flipped to `true` so the old
    /// walker exits within a directory boundary instead of running to
    /// completion; a fresh flag is installed for the new workspace.
    pub cancel_index: RwLock<Arc<AtomicBool>>,
    /// Per-window settings: global layer is loaded from the app data dir
    /// (shared by all windows) but the workspace layer reflects *this*
    /// window's workspace. Two windows with different workspaces therefore
    /// carry different merged settings without clobbering each other.
    pub settings: RwLock<Option<Settings>>,
    /// Open target set before this window's `get_startup_state` has read the
    /// startup slot. Usually seeded during window creation (CLI args or
    /// `open_new_workspace_window`); macOS `RunEvent::Opened` can also seed
    /// the hidden main window before React asks for startup state.
    pub startup_open: Mutex<Option<PendingOpenPayload>>,
    /// Flips to `true` once `get_startup_state` has attempted to read
    /// `startup_open`. After this point, open events must use `pending_open`
    /// because the startup slot will not be read again.
    pub startup_open_taken: AtomicBool,
    /// Runtime-only queue for drag-drop / dock-drop events after the startup
    /// slot has been read. Drained by the frontend once startup hydration
    /// completes. Never read by `get_startup_state`.
    pub pending_open: Mutex<VecDeque<PendingOpenPayload>>,
    /// The single file hosted by this window when it runs in standalone
    /// compact mode (no workspace root). Used to dedupe repeat opens of the
    /// same file onto the existing window and as the target of the
    /// single-file watcher.
    pub standalone_file: RwLock<Option<PathBuf>>,
}

/// One window-owned write the watcher should not echo back.
///
/// The marker is keyed by write id so an older write that finishes late, or
/// fails, cannot overwrite or remove the marker of a newer one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfWrite {
    /// The write is running. Events are suppressed until it lands or the TTL
    /// runs out.
    InFlight { id: u64, since: Instant },
    /// The write landed and the file then had `signature`. Only events whose
    /// current stat still matches it are suppressed.
    Landed {
        id: u64,
        at: Instant,
        signature: FileSignature,
    },
}

impl SelfWrite {
    pub fn id(&self) -> u64 {
        match self {
            Self::InFlight { id, .. } | Self::Landed { id, .. } => *id,
        }
    }

    /// When the suppression window started: write start while in flight,
    /// landing time after.
    pub fn started(&self) -> Instant {
        match self {
            Self::InFlight { since, .. } => *since,
            Self::Landed { at, .. } => *at,
        }
    }
}

/// Modified time and length, as read from the file's metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileSignature {
    pub modified: Option<SystemTime>,
    pub len: u64,
}

impl FileSignature {
    pub fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        Some(Self {
            modified: meta.modified().ok(),
            len: meta.len(),
        })
    }
}

/// Recent-files order together with the index revision it was sorted from.
pub type RecentFilesCache = Option<(u64, Vec<IndexedFile>)>;

/// Paths changed under a running full index walk.
///
/// A walk reads the tree over seconds while the watcher keeps applying deltas
/// to the live index. Publishing the walk result as-is would drop those
/// deltas (a file created mid-walk in a folder the walk already passed) or
/// bring back a file deleted after the walk saw it. So while any walk is in
/// flight every path the watcher touches is logged here, and the walk
/// re-reads those paths from disk before it publishes.
///
/// Sequence numbers are monotonic: `paths[i]` has sequence `base + i`. The
/// log is emptied when the last walk ends. Lock order: this mutex is always
/// the innermost lock.
#[derive(Debug, Default)]
pub struct IndexJournal {
    walks: usize,
    base: u64,
    paths: Vec<PathBuf>,
}

impl IndexJournal {
    fn end(&self) -> u64 {
        self.base + self.paths.len() as u64
    }

    fn note(&mut self, path: &Path) {
        if self.walks > 0 {
            self.paths.push(path.to_path_buf());
        }
    }

    fn since(&self, start: u64) -> (Vec<PathBuf>, u64) {
        let offset = start.saturating_sub(self.base) as usize;
        let paths = self.paths.get(offset..).unwrap_or_default().to_vec();
        (paths, self.end())
    }

    fn finish_walk(&mut self) {
        self.walks = self.walks.saturating_sub(1);
        if self.walks == 0 {
            self.base = self.end();
            self.paths = Vec::new();
        }
    }
}

/// One full index walk in flight. Create it before the walk reads the tree;
/// dropping it (published, cancelled or stale) ends the walk.
pub struct IndexWalk<'a> {
    state: &'a WorkspaceState,
    replayed: u64,
}

impl IndexWalk<'_> {
    /// Paths logged since the last call, or since the walk began.
    pub fn take_deltas(&mut self) -> Vec<PathBuf> {
        let (paths, end) = self.state.index_journal.lock().since(self.replayed);
        self.replayed = end;
        paths
    }

    /// True when nothing was logged after the last `take_deltas`. Call it
    /// with `file_index` write-locked, so no delta can slip in between this
    /// check and the publish.
    pub fn caught_up(&self) -> bool {
        self.state.index_journal.lock().end() == self.replayed
    }
}

impl Drop for IndexWalk<'_> {
    fn drop(&mut self) {
        self.state.index_journal.lock().finish_walk();
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct IndexedFile {
    pub path: PathBuf,
    pub relative_path: String,
    pub name: String,
    pub modified_at: u64,
}

pub type WorkspaceRuntimeDrop = (
    Option<RecommendedWatcher>,
    Vec<IndexedFile>,
    RecentFilesCache,
    HashSet<PathBuf>,
    HashMap<PathBuf, SelfWrite>,
    Option<Arc<WorkspaceIgnore>>,
);

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            workspace_root: RwLock::new(None),
            file_index: RwLock::new(Vec::new()),
            file_index_revision: AtomicU64::new(0),
            recent_files_cache: RwLock::new(None),
            dirs_with_markdown: RwLock::new(HashSet::new()),
            index_ready: AtomicBool::new(false),
            watcher_handle: RwLock::new(None),
            recent_writes: RwLock::new(HashMap::new()),
            index_journal: Mutex::new(IndexJournal::default()),
            workspace_ignore: RwLock::new(None),
            ignore_loads_started: AtomicU64::new(0),
            ignore_installed: AtomicU64::new(0),
            workspace_epoch: AtomicU64::new(0),
            cancel_index: RwLock::new(Arc::new(AtomicBool::new(false))),
            settings: RwLock::new(None),
            startup_open: Mutex::new(None),
            startup_open_taken: AtomicBool::new(false),
            pending_open: Mutex::new(VecDeque::new()),
            standalone_file: RwLock::new(None),
        }
    }
}

impl WorkspaceState {
    fn reset_workspace_runtime(&self) -> WorkspaceRuntimeDrop {
        self.cancel_index.read().store(true, Ordering::SeqCst);
        *self.standalone_file.write() = None;
        let file_index = {
            let mut index = self.file_index.write();
            self.file_index_revision.fetch_add(1, Ordering::SeqCst);
            std::mem::take(&mut *index)
        };
        let recent_cache = self.recent_files_cache.write().take();
        let dirs = std::mem::take(&mut *self.dirs_with_markdown.write());
        self.index_ready.store(false, Ordering::SeqCst);
        let recent_writes = std::mem::take(&mut *self.recent_writes.write());
        let ignore = self.workspace_ignore.write().take();
        if let Some(settings) = self.settings.write().as_mut() {
            settings.clear_workspace();
        }
        (
            self.watcher_handle.write().take(),
            file_index,
            recent_cache,
            dirs,
            recent_writes,
            ignore,
        )
    }

    /// Transition to a workspace under the same root write guard used by
    /// close. This is the single reset funnel for all workspace-owned runtime
    /// state, so open and close cannot drift into different cleanup rules.
    pub fn transition_to_workspace(
        &self,
        root: PathBuf,
    ) -> (u64, Arc<AtomicBool>, WorkspaceRuntimeDrop) {
        let workspace_loader = self
            .settings
            .read()
            .as_ref()
            .map(|settings| settings.workspace_loader());
        let workspace_settings = workspace_loader.map(|loader| loader.read(&root));
        let mut root_guard = self.workspace_root.write();
        let old_watcher = self.reset_workspace_runtime();
        let epoch = self.workspace_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *root_guard = Some(root.clone());

        let cancel = Arc::new(AtomicBool::new(false));
        *self.cancel_index.write() = Arc::clone(&cancel);
        *self.workspace_ignore.write() = Some(Arc::new(WorkspaceIgnore::bootstrap()));
        if let (Some(settings), Some(layer)) = (self.settings.write().as_mut(), workspace_settings)
        {
            settings.install_workspace_layer(layer);
        }

        (epoch, cancel, old_watcher)
    }

    /// Point this window at one standalone file (compact mode, no workspace),
    /// under the same root write guard as [`Self::transition_to_workspace`].
    /// Refuses while a workspace is hosted: a late standalone request must
    /// never bump the epoch under a workspace that is still bootstrapping.
    /// A window that really switches closes its workspace first.
    pub fn transition_to_standalone(
        &self,
        file: PathBuf,
    ) -> Result<(u64, WorkspaceRuntimeDrop), ()> {
        let root_guard = self.workspace_root.write();
        if root_guard.is_some() {
            return Err(());
        }
        let old_runtime = self.reset_workspace_runtime();
        let epoch = self.workspace_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *self.standalone_file.write() = Some(file);
        drop(root_guard);
        Ok((epoch, old_runtime))
    }

    /// Run `f` only while this window still hosts exactly `file` at `epoch`,
    /// holding the root read guard so no transition can land in between.
    pub fn with_standalone_snapshot<T>(
        &self,
        file: &Path,
        epoch: u64,
        f: impl FnOnce() -> T,
    ) -> Option<T> {
        let root_guard = self.workspace_root.read();
        if root_guard.is_some()
            || self.workspace_epoch.load(Ordering::SeqCst) != epoch
            || self.standalone_file.read().as_deref() != Some(file)
        {
            return None;
        }
        Some(f())
    }

    /// Start a full index walk. See [`IndexJournal`].
    pub fn begin_index_walk(&self) -> IndexWalk<'_> {
        let mut journal = self.index_journal.lock();
        journal.walks += 1;
        let replayed = journal.end();
        drop(journal);
        IndexWalk {
            state: self,
            replayed,
        }
    }

    /// Log a path whose index entry may have changed, for any walk in flight.
    /// A no-op while no walk runs.
    pub fn note_index_delta(&self, path: &Path) {
        self.index_journal.lock().note(path);
    }

    /// Hand out the generation for a full matcher load that is about to start.
    pub fn begin_ignore_load(&self) -> u64 {
        self.ignore_loads_started.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Install a full matcher unless a later-started load already installed
    /// one. Call it inside the workspace snapshot guard. Returns whether it
    /// installed.
    pub fn install_ignore(&self, generation: u64, matcher: Arc<WorkspaceIgnore>) -> bool {
        let mut slot = self.workspace_ignore.write();
        if self.ignore_installed.load(Ordering::SeqCst) >= generation {
            return false;
        }
        self.ignore_installed.store(generation, Ordering::SeqCst);
        *slot = Some(matcher);
        true
    }

    /// Atomically publish a workspace root together with its new epoch.
    /// Readers that need both values must use [`Self::workspace_snapshot`]
    /// so they cannot observe a new epoch paired with the outgoing root.
    #[cfg(test)]
    pub fn replace_workspace_root(&self, root: PathBuf) -> u64 {
        let mut root_guard = self.workspace_root.write();
        let epoch = self.workspace_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *root_guard = Some(root);
        epoch
    }

    pub fn workspace_snapshot(&self) -> Option<(PathBuf, u64)> {
        let root_guard = self.workspace_root.read();
        let epoch = self.workspace_epoch.load(Ordering::SeqCst);
        root_guard.clone().map(|root| (root, epoch))
    }

    /// Run one immediate workspace-bound side effect only while a captured
    /// root/epoch pair is still current. The root read guard remains held for
    /// the callback, preventing a workspace switch from being published
    /// between final validation and the side effect itself.
    pub fn with_workspace_snapshot<T>(
        &self,
        captured_root: &Path,
        captured_epoch: u64,
        f: impl FnOnce() -> T,
    ) -> Option<T> {
        let root_guard = self.workspace_root.read();
        let epoch = self.workspace_epoch.load(Ordering::SeqCst);
        if root_guard.as_deref() != Some(captured_root) || epoch != captured_epoch {
            return None;
        }
        Some(f())
    }

    /// Atomically invalidate and clear the currently hosted workspace. The
    /// root write guard stays held while workspace-owned state is reset so a
    /// concurrent open cannot publish its new root before cleanup finishes.
    pub fn clear_workspace_if_current(
        &self,
        expected_root: &Path,
    ) -> Result<WorkspaceRuntimeDrop, ()> {
        let mut root_guard = self.workspace_root.write();
        if root_guard.as_deref() != Some(expected_root) {
            return Err(());
        }

        self.workspace_epoch.fetch_add(1, Ordering::SeqCst);
        *root_guard = None;
        Ok(self.reset_workspace_runtime())
    }

    pub fn set_startup_open(&self, payload: PendingOpenPayload) {
        debug_assert!(
            !self.startup_open_taken.load(Ordering::Acquire),
            "startup_open was set after get_startup_state consumed it"
        );
        *self.startup_open.lock() = Some(payload);
    }

    pub fn try_set_startup_open(
        &self,
        payload: PendingOpenPayload,
    ) -> Result<(), PendingOpenPayload> {
        let mut startup_open = self.startup_open.lock();
        if self.startup_open_taken.load(Ordering::Acquire) || startup_open.is_some() {
            return Err(payload);
        }
        *startup_open = Some(payload);
        Ok(())
    }

    pub fn take_startup_open(&self) -> Option<PendingOpenPayload> {
        let mut startup_open = self.startup_open.lock();
        let payload = startup_open.take();
        self.startup_open_taken.store(true, Ordering::Release);
        payload
    }

    pub fn push_pending_open(&self, payload: PendingOpenPayload) {
        let mut pending = self.pending_open.lock();
        if pending.back() == Some(&payload) {
            return;
        }
        pending.push_back(payload);
    }

    pub fn pop_pending_open(&self) -> Option<PendingOpenPayload> {
        self.pending_open.lock().pop_front()
    }

    pub fn invalidate_recent_files_cache(&self) {
        *self.recent_files_cache.write() = None;
    }

    pub fn recent_files_slice(&self, offset: usize, limit: usize) -> Vec<IndexedFile> {
        let page = |files: &[IndexedFile]| -> Vec<IndexedFile> {
            files.iter().skip(offset).take(limit).cloned().collect()
        };
        if let Some((revision, files)) = self.recent_files_cache.read().as_ref() {
            if *revision == self.file_index_revision.load(Ordering::SeqCst) {
                return page(files);
            }
        }

        // Every writer bumps the revision while it holds the index write
        // lock, so a copy taken under the read lock agrees with its revision.
        let (revision, mut files) = {
            let index = self.file_index.read();
            (
                self.file_index_revision.load(Ordering::SeqCst),
                index.clone(),
            )
        };
        files.sort_by(|a, b| {
            b.modified_at
                .cmp(&a.modified_at)
                .then_with(|| a.relative_path.cmp(&b.relative_path))
        });
        let result = page(&files);
        let mut cache = self.recent_files_cache.write();
        if self.file_index_revision.load(Ordering::SeqCst) == revision {
            *cache = Some((revision, files));
        }
        result
    }

    pub fn update_index_modified_at(&self, path: &Path, modified_at: u64) {
        let mut changed = false;
        {
            let mut index = self.file_index.write();
            // Logged whether or not the entry exists yet: a walk in flight
            // may publish this path and must then carry the new mtime.
            self.note_index_delta(path);
            if let Some(file) = index.iter_mut().find(|file| file.path == path) {
                if file.modified_at != modified_at {
                    file.modified_at = modified_at;
                    changed = true;
                    self.file_index_revision.fetch_add(1, Ordering::SeqCst);
                }
            }
        }

        if changed {
            self.invalidate_recent_files_cache();
        }
    }

    pub fn has_pending_workspace(&self, path: &Path) -> bool {
        let matches = |payload: &PendingOpenPayload| {
            payload
                .workspace
                .as_deref()
                .is_some_and(|workspace| Path::new(workspace) == path)
        };
        if self.startup_open.lock().as_ref().is_some_and(matches) {
            return true;
        }
        self.pending_open.lock().iter().any(matches)
    }

    /// Whether an open this window is waiting on reaches into `folder`: a
    /// workspace inside it or around it, or a file inside it.
    pub fn has_pending_under(&self, folder: &Path) -> bool {
        let reaches = |payload: &PendingOpenPayload| {
            payload
                .workspace
                .as_deref()
                .map(Path::new)
                .is_some_and(|root| root.starts_with(folder) || folder.starts_with(root))
                || payload
                    .file
                    .as_deref()
                    .map(Path::new)
                    .is_some_and(|file| file.starts_with(folder))
        };
        if self.startup_open.lock().as_ref().is_some_and(reaches) {
            return true;
        }
        self.pending_open.lock().iter().any(reaches)
    }

    pub fn has_pending_file(&self, path: &Path) -> bool {
        let matches = |payload: &PendingOpenPayload| {
            payload.workspace.is_none()
                && payload
                    .file
                    .as_deref()
                    .is_some_and(|file| Path::new(file) == path)
        };
        if self.startup_open.lock().as_ref().is_some_and(matches) {
            return true;
        }
        self.pending_open.lock().iter().any(matches)
    }
}

/// Process-wide registry of per-window `WorkspaceState`, keyed by Tauri
/// window label. The main window uses the label `"main"`; secondary
/// windows get uuid-based labels assigned by
/// `commands::workspace::open_workspace_in_new_window`.
pub struct AppState {
    windows: RwLock<HashMap<String, Arc<WorkspaceState>>>,
    /// Serializes initialization, migrations, and read-modify-write mutations
    /// of the global config shared by every window. Lock order is this mutex
    /// first, then an individual window's `settings` lock.
    pub global_settings_file_lock: Mutex<()>,
    /// Serializes read-modify-write on the shared `sessions.json` file so
    /// two windows can't clobber each other's tab state under the 500 ms
    /// debounce. Held only for the load→save span.
    pub sessions_file_lock: Mutex<()>,
    /// Serializes read-modify-write on the shared `recent_files.json` file
    /// so concurrent recents updates from multiple windows don't drop each
    /// other's entries. Held only for the load→save span.
    pub recent_files_lock: Mutex<()>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            windows: RwLock::new(HashMap::new()),
            global_settings_file_lock: Mutex::new(()),
            sessions_file_lock: Mutex::new(()),
            recent_files_lock: Mutex::new(()),
        }
    }

    /// Return the window's state, creating a fresh `WorkspaceState` if this
    /// label is unknown. Called by every Tauri command at the top of its
    /// body after deriving the window label from the invoking webview.
    pub fn get_or_create(&self, label: &str) -> Arc<WorkspaceState> {
        {
            let map = self.windows.read();
            if let Some(state) = map.get(label) {
                return state.clone();
            }
        }
        let mut map = self.windows.write();
        map.entry(label.to_string())
            .or_insert_with(|| Arc::new(WorkspaceState::default()))
            .clone()
    }

    pub fn get(&self, label: &str) -> Option<Arc<WorkspaceState>> {
        self.windows.read().get(label).cloned()
    }

    /// The state of an open window, for IPC commands and routing. Every
    /// window's state is created before its webview loads (in `setup` for the
    /// main window, before `build` for the others), so a missing entry means
    /// the window was destroyed. Unlike [`Self::get_or_create`] this never
    /// brings the slot back, which would leave an orphan that open routing can
    /// pick and that holds a watcher nobody drops.
    pub fn window(&self, label: &str) -> Result<Arc<WorkspaceState>, crate::error::AppError> {
        self.get(label)
            .ok_or_else(|| crate::error::AppError::Io(format!("Window {label} is closed")))
    }

    /// Remove and return a window's state. Called from the window-close
    /// event handler so the watcher's `Drop` runs (stopping FSEvents /
    /// inotify subscriptions) and the index memory is reclaimed.
    pub fn remove(&self, label: &str) -> Option<Arc<WorkspaceState>> {
        self.windows.write().remove(label)
    }

    /// Find an existing window already hosting or opening `path`. Used to
    /// focus rather than duplicate when the user opens a workspace that's
    /// already open in another window. Pending opens are included so two
    /// quick requests for the same workspace do not race before the new
    /// window hydrates and publishes `workspace_root`.
    pub fn find_by_workspace(&self, path: &Path) -> Option<String> {
        let map = self.windows.read();
        for (label, state) in map.iter() {
            let guard = state.workspace_root.read();
            if let Some(root) = guard.as_deref() {
                if root == path {
                    return Some(label.clone());
                }
            }
            drop(guard);

            if state.has_pending_workspace(path) {
                return Some(label.clone());
            }
        }
        None
    }

    /// Whether any window would lose files if `folder` went away: it has, or
    /// is opening, the folder, a workspace inside it or around it, or a single
    /// file from inside it. The recent list's Move to Trash refuses such a
    /// folder.
    pub fn uses_folder(&self, folder: &Path) -> bool {
        let overlaps = |root: &Path| root.starts_with(folder) || folder.starts_with(root);
        let map = self.windows.read();
        map.values().any(|state| {
            state.workspace_root.read().as_deref().is_some_and(overlaps)
                || state
                    .standalone_file
                    .read()
                    .as_deref()
                    .is_some_and(|file| file.starts_with(folder))
                || state.has_pending_under(folder)
        })
    }

    /// Find an existing standalone window already hosting (or about to
    /// host) `path`. Mirrors `find_by_workspace` so repeat opens of the
    /// same file focus the existing compact window instead of duplicating.
    pub fn find_by_standalone_file(&self, path: &Path) -> Option<String> {
        let map = self.windows.read();
        for (label, state) in map.iter() {
            let guard = state.standalone_file.read();
            if guard.as_deref() == Some(path) {
                return Some(label.clone());
            }
            drop(guard);

            if state.has_pending_file(path) {
                return Some(label.clone());
            }
        }
        None
    }

    /// Snapshot of all known window labels. Used by startup code to emit
    /// broadcast-style events without hard-coding labels.
    pub fn labels(&self) -> Vec<String> {
        self.windows.read().keys().cloned().collect()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Registers all ancestor directories of a file path into the set.
/// Short-circuits when hitting a directory already in the set (its ancestors are too).
pub fn register_ancestors(dirs: &mut HashSet<PathBuf>, file_path: &Path, root: &Path) {
    let mut dir = file_path.parent();
    while let Some(d) = dir {
        if !dirs.insert(d.to_path_buf()) {
            break;
        }
        if d == root {
            break;
        }
        dir = d.parent();
    }
}

/// Rebuild dirs_with_markdown from the full file index.
pub fn rebuild_dirs_from_index(files: &[IndexedFile], root: &Path) -> HashSet<PathBuf> {
    let mut dirs = HashSet::with_capacity(files.len());
    for file in files {
        register_ancestors(&mut dirs, &file.path, root);
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_is_in_use_when_a_window_reaches_into_it() {
        let app_state = AppState::new();
        let folder = Path::new("/tmp/notes");
        assert!(!app_state.uses_folder(folder));

        let window = app_state.get_or_create("main");
        window.replace_workspace_root(PathBuf::from("/tmp/notes-old"));
        assert!(
            !app_state.uses_folder(folder),
            "a name that starts the same is not inside"
        );
        window.replace_workspace_root(PathBuf::from("/tmp/notes"));
        assert!(app_state.uses_folder(folder));
        window.replace_workspace_root(PathBuf::from("/tmp/notes/drafts"));
        assert!(app_state.uses_folder(folder), "a workspace inside it");
        window.replace_workspace_root(PathBuf::from("/tmp"));
        assert!(app_state.uses_folder(folder), "a workspace around it");

        let other = AppState::new();
        let compact = other.get_or_create("compact");
        *compact.standalone_file.write() = Some(PathBuf::from("/tmp/notes/a.md"));
        assert!(other.uses_folder(folder), "a single file from inside it");
        *compact.standalone_file.write() = Some(PathBuf::from("/tmp/elsewhere/a.md"));
        assert!(!other.uses_folder(folder));

        // Opens a window is still waiting on count too.
        let opening = AppState::new();
        let window = opening.get_or_create("opening");
        let pending = |workspace: Option<&str>, file: Option<&str>| PendingOpenPayload {
            workspace: workspace.map(str::to_string),
            file: file.map(str::to_string),
        };
        window.push_pending_open(pending(Some("/tmp/notes/drafts"), None));
        assert!(opening.uses_folder(folder), "a pending workspace inside it");
        window.pop_pending_open();
        window.set_startup_open(pending(Some("/tmp"), None));
        assert!(
            opening.uses_folder(folder),
            "a starting workspace around it"
        );
        window.take_startup_open();
        window.push_pending_open(pending(None, Some("/tmp/notes/a.md")));
        assert!(opening.uses_folder(folder), "a pending file inside it");
        window.pop_pending_open();
        window.push_pending_open(pending(Some("/tmp/notes-old"), Some("/tmp/notes-old/a.md")));
        assert!(
            !opening.uses_folder(folder),
            "a name that starts the same is not inside"
        );
    }

    #[test]
    fn find_by_workspace_matches_startup_open() {
        let app_state = AppState::new();
        let window_state = app_state.get_or_create("startup-window");
        window_state.set_startup_open(PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: None,
        });

        assert_eq!(
            app_state.find_by_workspace(Path::new("/tmp/workspace")),
            Some("startup-window".to_string())
        );
    }

    #[test]
    fn find_by_workspace_matches_pending_open() {
        let app_state = AppState::new();
        let window_state = app_state.get_or_create("pending-window");
        window_state.push_pending_open(PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: None,
        });

        assert_eq!(
            app_state.find_by_workspace(Path::new("/tmp/workspace")),
            Some("pending-window".to_string())
        );
    }

    #[test]
    fn find_by_standalone_file_matches_hosted_and_pending_files() {
        let app_state = AppState::new();
        let hosting = app_state.get_or_create("hosting-window");
        *hosting.standalone_file.write() = Some(PathBuf::from("/tmp/hosted.md"));

        let pending = app_state.get_or_create("pending-window");
        pending.set_startup_open(PendingOpenPayload {
            workspace: None,
            file: Some("/tmp/pending.md".to_string()),
        });

        assert_eq!(
            app_state.find_by_standalone_file(Path::new("/tmp/hosted.md")),
            Some("hosting-window".to_string())
        );
        assert_eq!(
            app_state.find_by_standalone_file(Path::new("/tmp/pending.md")),
            Some("pending-window".to_string())
        );
        assert_eq!(
            app_state.find_by_standalone_file(Path::new("/tmp/other.md")),
            None
        );
    }

    #[test]
    fn workspace_plus_file_payload_does_not_match_standalone_lookup() {
        // A file opened *into a workspace window* must not be claimed by the
        // standalone dedupe — only file-only payloads host standalone files.
        let app_state = AppState::new();
        let state = app_state.get_or_create("workspace-window");
        state.push_pending_open(PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: Some("/tmp/workspace/a.md".to_string()),
        });

        assert_eq!(
            app_state.find_by_standalone_file(Path::new("/tmp/workspace/a.md")),
            None
        );
    }

    #[test]
    fn pending_open_preserves_distinct_payloads_in_order() {
        let window_state = WorkspaceState::default();
        let first = PendingOpenPayload {
            workspace: Some("/tmp/workspace-a".to_string()),
            file: Some("/tmp/workspace-a/a.md".to_string()),
        };
        let second = PendingOpenPayload {
            workspace: Some("/tmp/workspace-b".to_string()),
            file: Some("/tmp/workspace-b/b.md".to_string()),
        };

        window_state.push_pending_open(first.clone());
        window_state.push_pending_open(second.clone());

        assert_eq!(window_state.pop_pending_open(), Some(first));
        assert_eq!(window_state.pop_pending_open(), Some(second));
        assert_eq!(window_state.pop_pending_open(), None);
    }

    #[test]
    fn pending_open_dedupes_repeated_tail_payload() {
        let window_state = WorkspaceState::default();
        let payload = PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: Some("/tmp/workspace/a.md".to_string()),
        };

        window_state.push_pending_open(payload.clone());
        window_state.push_pending_open(payload.clone());

        assert_eq!(window_state.pop_pending_open(), Some(payload));
        assert_eq!(window_state.pop_pending_open(), None);
    }

    #[test]
    fn startup_open_cannot_be_seeded_after_take() {
        let window_state = WorkspaceState::default();
        assert_eq!(window_state.take_startup_open(), None);

        let payload = PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: None,
        };

        assert_eq!(
            window_state.try_set_startup_open(payload.clone()),
            Err(payload)
        );
    }

    #[test]
    fn startup_open_try_seed_preserves_existing_payload() {
        let window_state = WorkspaceState::default();
        let first = PendingOpenPayload {
            workspace: Some("/tmp/workspace-a".to_string()),
            file: None,
        };
        let second = PendingOpenPayload {
            workspace: Some("/tmp/workspace-b".to_string()),
            file: None,
        };

        window_state.set_startup_open(first.clone());

        assert_eq!(
            window_state.try_set_startup_open(second.clone()),
            Err(second)
        );
        assert_eq!(window_state.take_startup_open(), Some(first));
    }

    #[test]
    fn guarded_workspace_snapshot_rejects_stale_callbacks_and_holds_read_guard() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = WorkspaceState::default();
        let first_root = first.path().canonicalize().unwrap();
        let first_epoch = state.replace_workspace_root(first_root.clone());

        let ran = std::cell::Cell::new(false);
        let result = state.with_workspace_snapshot(&first_root, first_epoch, || {
            ran.set(true);
            assert!(state.workspace_root.try_write().is_none());
            42
        });
        assert_eq!(result, Some(42));
        assert!(ran.get());

        state.replace_workspace_root(second.path().canonicalize().unwrap());
        ran.set(false);
        assert_eq!(
            state.with_workspace_snapshot(&first_root, first_epoch, || ran.set(true)),
            None
        );
        assert!(!ran.get());

        state.replace_workspace_root(first_root.clone());
        assert_eq!(
            state.with_workspace_snapshot(&first_root, first_epoch, || ran.set(true)),
            None
        );
        assert!(!ran.get());
    }

    #[test]
    fn close_workspace_invalidates_the_snapshot_and_rejects_stale_roots() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_root = first.path().canonicalize().unwrap();
        let second_root = second.path().canonicalize().unwrap();
        let state = WorkspaceState::default();
        let (first_epoch, _, _) = state.transition_to_workspace(first_root.clone());
        state.dirs_with_markdown.write().insert(first_root.clone());
        state.index_ready.store(true, Ordering::SeqCst);
        state.recent_writes.write().insert(
            first_root.join("old.md"),
            SelfWrite::InFlight {
                id: 1,
                since: Instant::now(),
            },
        );

        state.clear_workspace_if_current(&first_root).unwrap();
        assert!(state.workspace_snapshot().is_none());
        assert!(state.dirs_with_markdown.read().is_empty());
        assert!(!state.index_ready.load(Ordering::SeqCst));
        assert!(state.recent_writes.read().is_empty());
        assert!(state.workspace_ignore.read().is_none());
        assert!(state
            .with_workspace_snapshot(&first_root, first_epoch, || ())
            .is_none());

        state.transition_to_workspace(second_root.clone());
        assert!(state.workspace_ignore.read().is_some());
        assert!(state.clear_workspace_if_current(&first_root).is_err());
        assert_eq!(
            state.workspace_snapshot().map(|(root, _)| root),
            Some(second_root)
        );
    }

    fn indexed(path: &str, modified_at: u64) -> IndexedFile {
        IndexedFile {
            path: PathBuf::from(path),
            relative_path: path.trim_start_matches('/').to_string(),
            name: Path::new(path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            modified_at,
        }
    }

    #[test]
    fn standalone_watch_refuses_a_hosted_workspace() {
        // A late standalone request used to bump the epoch under a
        // workspace that was still bootstrapping, so its watcher and index
        // never landed. It now refuses and leaves the workspace untouched.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = WorkspaceState::default();
        let (epoch, _, _) = state.transition_to_workspace(root.clone());

        assert!(state
            .transition_to_standalone(root.join("loose.md"))
            .is_err());
        assert_eq!(state.workspace_snapshot(), Some((root.clone(), epoch)));
        assert!(state.standalone_file.read().is_none());

        state.clear_workspace_if_current(&root).unwrap();
        let file = root.join("loose.md");
        let (standalone_epoch, _) = state.transition_to_standalone(file.clone()).unwrap();
        assert!(standalone_epoch > epoch);
        assert_eq!(
            state.standalone_file.read().as_deref(),
            Some(file.as_path())
        );
        assert_eq!(
            state.with_standalone_snapshot(&file, standalone_epoch, || 7),
            Some(7)
        );
        assert_eq!(
            state.with_standalone_snapshot(&root.join("other.md"), standalone_epoch, || 7),
            None
        );

        // Opening a workspace afterwards clears the standalone target.
        state.transition_to_workspace(root.clone());
        assert!(state.standalone_file.read().is_none());
        assert_eq!(
            state.with_standalone_snapshot(&file, standalone_epoch, || 7),
            None
        );
    }

    #[test]
    fn recent_files_cache_is_never_served_for_a_stale_revision() {
        // The sorted copy used to be installed after an unlocked sort,
        // so an index change in between left stale order cached.
        let state = WorkspaceState::default();
        *state.file_index.write() = vec![indexed("/ws/a.md", 1), indexed("/ws/b.md", 2)];
        let first = state.recent_files_slice(0, 10);
        assert_eq!(first[0].path, PathBuf::from("/ws/b.md"));

        // A writer that changes the index and bumps the revision without
        // touching the cache must still be honoured on the next read.
        {
            let mut index = state.file_index.write();
            index[0].modified_at = 9;
            state.file_index_revision.fetch_add(1, Ordering::SeqCst);
        }
        let second = state.recent_files_slice(0, 10);
        assert_eq!(second[0].path, PathBuf::from("/ws/a.md"));
        assert_eq!(
            state
                .recent_files_cache
                .read()
                .as_ref()
                .map(|(rev, _)| *rev),
            Some(state.file_index_revision.load(Ordering::SeqCst))
        );
    }

    #[test]
    fn the_index_journal_logs_only_while_a_walk_runs() {
        let state = WorkspaceState::default();
        state.note_index_delta(Path::new("/ws/before.md"));

        let mut walk = state.begin_index_walk();
        assert!(walk.caught_up());
        state.note_index_delta(Path::new("/ws/a.md"));
        assert!(!walk.caught_up());
        assert_eq!(walk.take_deltas(), vec![PathBuf::from("/ws/a.md")]);
        assert!(walk.caught_up());

        // A second walk that starts later sees only what came after it.
        let mut later = state.begin_index_walk();
        state.note_index_delta(Path::new("/ws/b.md"));
        assert_eq!(later.take_deltas(), vec![PathBuf::from("/ws/b.md")]);
        assert_eq!(walk.take_deltas(), vec![PathBuf::from("/ws/b.md")]);
        drop(walk);
        drop(later);

        assert!(state.index_journal.lock().paths.is_empty());
        state.note_index_delta(Path::new("/ws/after.md"));
        assert!(state.index_journal.lock().paths.is_empty());
    }

    #[test]
    fn a_closed_window_is_not_brought_back_by_a_lookup() {
        // `get_or_create` recreated a destroyed window's slot, which
        // open routing could then pick and nothing would ever read.
        let app_state = AppState::new();
        app_state.get_or_create("w-1");
        assert!(app_state.window("w-1").is_ok());
        app_state.remove("w-1");
        assert!(app_state.window("w-1").is_err());
        assert!(app_state.get("w-1").is_none());
        assert!(app_state.labels().is_empty());
    }

    #[test]
    fn an_older_ignore_load_cannot_replace_a_newer_one() {
        // Two loads race; the one that started later wins even when
        // the earlier one finishes last.
        let state = WorkspaceState::default();
        let slow = state.begin_ignore_load();
        let fast = state.begin_ignore_load();
        let newer = Arc::new(WorkspaceIgnore::bootstrap());
        assert!(state.install_ignore(fast, Arc::clone(&newer)));
        assert!(!state.install_ignore(slow, Arc::new(WorkspaceIgnore::bootstrap())));
        assert!(Arc::ptr_eq(
            state.workspace_ignore.read().as_ref().unwrap(),
            &newer
        ));
    }
}
