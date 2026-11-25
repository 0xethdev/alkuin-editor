//! Per-document "Keep on this Mac only".
//!
//! Every byte of a document that can leave this Mac goes through [`depart`].
//! Share, writing help, the history upload, and backup all call it, and
//! it is the only place that decides. A kept document never reaches the send
//! closure.
//!
//! The list lives in app data (`mac-only.json`), not in the document, so the
//! setting itself is not part of the file that might be shared. Every plan
//! uses the same list. This module does not read the account.

use crate::error::AppError;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

#[cfg(test)]
pub const LABEL: &str = "Keep on this Mac only";
#[cfg(test)]
pub const TURNED_ON: &str = "This document stays on this Mac.";
#[cfg(test)]
pub const TURNED_OFF: &str = "This document can leave this Mac again.";
pub const ASSISTANT_LINE: &str =
    "This document stays on this Mac, so Alkuin can't send it for writing help.";
pub const SHARE_LINE: &str = "This document stays on this Mac, so Alkuin didn't share it.";
pub const FOLDER_LINE: &str =
    "A document in this folder stays on this Mac, so Alkuin didn't send anything.";
pub const BACKUP_LINE: &str = "This document stays on this Mac, so Alkuin didn't back it up.";
pub const UNREADABLE_LINE: &str =
    "Alkuin couldn't read which documents stay on this Mac, so it didn't send this one.";
#[cfg(test)]
pub const DELETE_TITLE: &str = "Delete the online copy?";
#[cfg(test)]
pub const DELETE_BODY: &str = "This document is also saved online. Delete that copy? It will stay on this Mac either way, and nothing new will be sent. Copies saved earlier can remain.";
#[cfg(test)]
pub const DELETE_CONFIRM: &str = "Delete the online copy";
#[cfg(test)]
pub const DELETE_CANCEL: &str = "Leave the online copy";
#[cfg(test)]
pub const LEFT_ONLINE: &str = "The online copy is still there. Nothing new will be sent.";
pub const DELETE_DONE: &str = "The online copy was deleted. This document stays on this Mac.";
pub const DELETE_NONE: &str = "There's no online copy. This document stays on this Mac.";
pub const DELETE_FAILED: &str = "Alkuin couldn't delete the online copy. Nothing new was sent.";
pub const SETTING_FAILED: &str = "Alkuin couldn't change this setting.";
pub const DELETE_COMMIT_MESSAGE: &str = "Remove a document that stays on this Mac.";

const STORE_FILE: &str = "mac-only.json";
/// The unreadable list, set aside when the switch rewrites it.
const UNREADABLE_COPY: &str = "mac-only.unreadable.json";
/// Content fingerprints of kept files, so a Finder rename the watcher could
/// not pair still carries the setting (see [`follow_unpaired_moves`]).
const PRINTS_FILE: &str = "mac-only-prints.json";
/// Whole-file scan floor. A shorter note can match an ordinary sentence.
/// The path check is the real gate. Upgrade is a hash of the asked span.
const CARRY_FLOOR: usize = 12;

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
const USER_LINES: &[&str] = &[
    LABEL,
    TURNED_ON,
    TURNED_OFF,
    ASSISTANT_LINE,
    SHARE_LINE,
    FOLDER_LINE,
    BACKUP_LINE,
    UNREADABLE_LINE,
    DELETE_TITLE,
    DELETE_BODY,
    DELETE_CONFIRM,
    DELETE_CANCEL,
    LEFT_ONLINE,
    DELETE_DONE,
    DELETE_NONE,
    DELETE_FAILED,
    SETTING_FAILED,
    DELETE_COMMIT_MESSAGE,
];

#[cfg(test)]
const BANNED_WORDS: &[&str] = &[
    "commit",
    "branch",
    "merge",
    "repo",
    "repository",
    "push",
    "pull",
    "diff",
    "checkout",
    "rebase",
    "fetch",
    "clone",
    "stash",
    "git",
    "remote",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Share,
    Assistant,
    Learn,
    /// History upload and any other backup copy.
    Backup,
}

#[derive(Clone, Debug)]
pub struct MacOnlySet {
    paths: Vec<PathBuf>,
    unreadable: bool,
}

impl MacOnlySet {
    pub fn open() -> Self {
        Self {
            paths: Vec::new(),
            unreadable: false,
        }
    }

    pub fn unreadable() -> Self {
        Self {
            paths: Vec::new(),
            unreadable: true,
        }
    }

    /// Test and command helper. `None` means app data could not be found,
    /// which blocks every send.
    pub fn load_or_block(dir: Option<&Path>) -> Self {
        match dir {
            Some(dir) => Self::load(dir),
            None => Self::unreadable(),
        }
    }

    pub fn load(dir: &Path) -> Self {
        match read_paths(dir) {
            Ok(paths) => Self {
                paths,
                unreadable: false,
            },
            Err(ReadErr::Missing) => Self::open(),
            Err(ReadErr::Bad | ReadErr::Pending) => Self::unreadable(),
        }
    }

    #[cfg(test)]
    pub fn holding(paths: Vec<PathBuf>) -> Self {
        Self {
            paths: paths.into_iter().map(|path| canon(&path)).collect(),
            unreadable: false,
        }
    }

    pub fn is_unreadable(&self) -> bool {
        self.unreadable
    }

    pub fn blocks(&self, path: &Path) -> bool {
        if self.unreadable {
            return true;
        }
        let path = canon(path);
        self.paths.iter().any(|kept| kept == &path)
    }

    /// True when `body` contains the full text of a kept document.
    pub fn carries(&self, body: &str) -> bool {
        if self.unreadable {
            return !body.is_empty();
        }
        self.paths.iter().any(|path| file_is_inside(path, body))
    }

    pub fn affects(&self, root: &Path) -> bool {
        if self.unreadable {
            return true;
        }
        let root = canon(root);
        self.paths.iter().any(|path| path.starts_with(&root))
    }

    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }
}

#[derive(Debug, Serialize)]
pub struct MacOnlyView {
    pub kept: bool,
    pub online: bool,
}

#[derive(Debug, Serialize)]
pub struct OnlineDeleteView {
    pub deleted: bool,
    pub missing: bool,
    pub message: String,
}

enum ReadErr {
    Missing,
    Bad,
    /// No list here yet, and the copy from an earlier bundle id's folder has
    /// not finished. The list may still be there, so this is not "nothing kept".
    Pending,
}

/// The physical path, also for a file that is already gone. Compare paths in
/// this form: git, `canonicalize` and the OS report the physical path, while a
/// caller may hold one behind a symlink (macOS `/var` -> `/private/var`).
pub(crate) fn canon(path: &Path) -> PathBuf {
    if let Ok(resolved) = path.canonicalize() {
        return resolved;
    }
    // The file is already gone (rename or delete). Resolve the folder so the
    // stored path still matches.
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(parent) = parent.canonicalize() {
            return parent.join(name);
        }
    }
    path.to_path_buf()
}

/// Like [`canon`] for the folders only: the parent is resolved and the last
/// component is kept as given, so a note that is itself a symlink keeps its
/// own path (it may point outside the folder it lives in).
pub(crate) fn canon_parent(path: &Path) -> PathBuf {
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(parent) = parent.canonicalize() {
            return parent.join(name);
        }
    }
    canon(path)
}

fn store_path(dir: &Path) -> PathBuf {
    dir.join(STORE_FILE)
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(|err| err.into_inner())
}

fn read_paths(dir: &Path) -> Result<Vec<PathBuf>, ReadErr> {
    let path = store_path(dir);
    if !path.exists() {
        if crate::identifier_migration::copy_unfinished(dir) {
            return Err(ReadErr::Pending);
        }
        return Err(ReadErr::Missing);
    }
    let text = fs::read_to_string(&path).map_err(|_| ReadErr::Bad)?;
    let list: Vec<String> = serde_json::from_str(&text).map_err(|_| ReadErr::Bad)?;
    Ok(list.into_iter().map(PathBuf::from).collect())
}

/// Temp file and rename: a reader sees the old list or the new one, never a
/// torn one that would block every send.
fn write_paths(dir: &Path, paths: &[PathBuf]) -> Result<(), AppError> {
    let list: Vec<&str> = paths.iter().filter_map(|path| path.to_str()).collect();
    let body = serde_json::to_string_pretty(&list).map_err(|err| AppError::Io(err.to_string()))?;
    crate::commands::fs::write_atomic(&store_path(dir), body.as_bytes())
}

/// Entries still readable in a list that is not valid JSON: each complete
/// quoted path on its own line, the way `write_paths` lays them out.
fn salvage(text: &str) -> Vec<PathBuf> {
    text.lines()
        .filter_map(|line| serde_json::from_str::<String>(line.trim().trim_end_matches(',')).ok())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// The switch was used while the list could not be read. Every send stayed
/// blocked until now. The readable entries are kept, the unreadable file is
/// copied aside, and the caller's write makes the list readable again. An
/// entry that could not be read is lost: that document can leave this Mac
/// again until its switch is turned back on.
fn reset_unreadable(dir: &Path) -> Vec<PathBuf> {
    let store = store_path(dir);
    let text = fs::read(&store)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    let kept = salvage(&text);
    if let Err(err) = fs::copy(&store, dir.join(UNREADABLE_COPY)) {
        eprintln!("[mac-only] the unreadable list could not be copied aside: {err}");
    }
    eprintln!(
        "[mac-only] the list could not be read; rewriting it with {} readable entries",
        kept.len()
    );
    kept
}

/// What a write does with a list that cannot be read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Unreadable {
    /// The person used the switch: rewrite it (see [`reset_unreadable`]).
    Reset,
    /// Anything else: leave it, so every send stays blocked.
    Refuse,
}

fn update_kept(dir: &Path, path: &Path, on: bool, unreadable: Unreadable) -> Result<(), AppError> {
    let _guard = lock();
    let mut paths = match read_paths(dir) {
        Ok(paths) => paths,
        Err(ReadErr::Missing) => Vec::new(),
        Err(ReadErr::Bad) if unreadable == Unreadable::Reset => reset_unreadable(dir),
        // Pending: the earlier list is not here yet. A new one would hide it.
        Err(ReadErr::Bad | ReadErr::Pending) => {
            return Err(AppError::Gateway(SETTING_FAILED.into()))
        }
    };
    let path = canon(path);
    paths.retain(|kept| kept != &path);
    if on {
        paths.push(path.clone());
    }
    paths.sort();
    paths.dedup();
    write_paths(dir, &paths).map_err(|err| {
        eprintln!("[mac-only] the list was not written: {err}");
        AppError::Gateway(SETTING_FAILED.into())
    })?;
    if on {
        remember_print_locked(dir, &path, &paths);
    } else {
        let mut prints = read_prints(dir);
        if prints.remove(&print_key(&path)).is_some() {
            write_prints(dir, &prints);
        }
    }
    Ok(())
}

/// History's switch writes this same file. There is no second list.
pub fn set_stays_on_this_mac(dir: &Path, path: &Path, stays: bool) -> Result<(), AppError> {
    set_kept(dir, path, stays)
}

/// The switch. It also rewrites a list that cannot be read.
pub fn set_kept(dir: &Path, path: &Path, on: bool) -> Result<(), AppError> {
    update_kept(dir, path, on, Unreadable::Reset)
}

/// Keep a document without the person asking (a removed share copy). A
/// list that cannot be read is left alone: it already blocks every send.
pub(crate) fn keep_without_switch(dir: &Path, path: &Path) -> Result<(), AppError> {
    update_kept(dir, path, true, Unreadable::Refuse)
}

/// Keep the setting when a document moves, as main does: the new path is
/// added and the old path stays marked. An editor still holding the old path,
/// or any tool that writes the file back there, must not find it unmarked
/// and send it. A folder move (`was_dir`) adds every kept document inside it.
/// Fingerprints are copied to the new path. Safe to call twice for one move.
/// A failure is logged; [`try_retarget`] returns it. The in-app rename uses
/// `try_retarget`; this is the entry point for moves seen by the watcher.
pub fn retarget(dir: &Path, from: &Path, to: &Path, was_dir: bool) {
    if let Err(err) = try_retarget(dir, from, to, was_dir) {
        eprintln!("[mac-only] the setting did not follow a rename: {err}");
    }
}

/// The stored forms of a document's old name. The folders are resolved and
/// the last component is kept, so a symlink that now sits at the old path is
/// not followed: it may point at another document, and that document's mark
/// is not this move's to carry. When the old path is not a symlink, the fully
/// resolved spelling is matched too: after a case-only rename on a
/// case-insensitive volume the old name resolves to the new spelling.
fn old_name_forms(from: &Path) -> Vec<PathBuf> {
    let mut forms = vec![canon_parent(from)];
    let is_link = fs::symlink_metadata(from)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if !is_link {
        let resolved = canon(from);
        if !forms.contains(&resolved) {
            forms.push(resolved);
        }
    }
    forms
}

/// `Ok(false)`: nothing to add, or the list cannot be read and is left as it
/// is (every send stays blocked). `Err`: the new marks were not written.
pub(crate) fn try_retarget(
    dir: &Path,
    from: &Path,
    to: &Path,
    was_dir: bool,
) -> Result<bool, AppError> {
    let _guard = lock();
    let mut paths = match read_paths(dir) {
        Ok(paths) => paths,
        Err(ReadErr::Missing) => return Ok(false),
        Err(ReadErr::Bad | ReadErr::Pending) => {
            eprintln!("[mac-only] a rename was not recorded: the list cannot be read");
            return Ok(false);
        }
    };
    let froms = old_name_forms(from);
    let to = canon(to);
    let mut carried: Vec<(PathBuf, PathBuf)> = Vec::new();
    for path in &paths {
        let target = if froms.contains(path) {
            to.clone()
        } else if was_dir {
            // `strip_prefix` compares whole components, so `drafts-old/x.md`
            // does not move with `drafts`.
            match froms.iter().find_map(|from| path.strip_prefix(from).ok()) {
                Some(rest) => to.join(rest),
                None => continue,
            }
        } else {
            continue;
        };
        if target != *path {
            carried.push((path.clone(), target));
        }
    }
    carried.sort_by(|a, b| a.1.cmp(&b.1));
    carried.dedup_by(|a, b| a.1 == b.1);
    if carried.is_empty() {
        return Ok(false);
    }
    let fresh: Vec<PathBuf> = carried
        .iter()
        .map(|(_, target)| target.clone())
        .filter(|target| !paths.contains(target))
        .collect();
    let added = !fresh.is_empty();
    if added {
        paths.extend(fresh);
        paths.sort();
        paths.dedup();
        write_paths(dir, &paths)?;
    }
    // A destination's fingerprint describes the file that is there now. When
    // that file exists it is read from the file, the way a save records it:
    // - renaming B to A, saving at A and renaming back to B leaves B with the
    //   fingerprint of the text it now holds;
    // - the watcher replaying a rename the app already applied never puts
    //   the source's older fingerprint over the one a later save stored.
    // Either way a later unpaired Finder rename can still be followed. A
    // destination that is already gone again (one step of a quick A -> B ->
    // C) takes the source's fingerprint, and only when it has none.
    let mut prints = read_prints(dir);
    let mut printed = false;
    for (old, new) in &carried {
        let key = print_key(new);
        let next = match crate::share_paths::fingerprint(new) {
            Some(current) => Some(current),
            None if !prints.contains_key(&key) => prints.get(&print_key(old)).cloned(),
            None => None,
        };
        if let Some(print) = next {
            if prints.get(&key) != Some(&print) {
                prints.insert(key, print);
                printed = true;
            }
        }
    }
    if printed {
        write_prints(dir, &prints);
    }
    Ok(added || printed)
}

/// Delete drops the setting. A failure is logged.
pub fn forget(dir: &Path, path: &Path) {
    let _guard = lock();
    let mut paths = match read_paths(dir) {
        Ok(paths) => paths,
        Err(ReadErr::Missing) => return,
        Err(ReadErr::Bad | ReadErr::Pending) => {
            eprintln!("[mac-only] a delete was not recorded: the list cannot be read");
            return;
        }
    };
    let path = canon(path);
    let before = paths.len();
    paths.retain(|kept| kept != &path);
    if paths.len() != before {
        if let Err(err) = write_paths(dir, &paths) {
            eprintln!("[mac-only] a delete was not recorded: {err}");
            return;
        }
        let mut prints = read_prints(dir);
        if prints.remove(&print_key(&path)).is_some() {
            write_prints(dir, &prints);
        }
    }
}

fn prints_path(dir: &Path) -> PathBuf {
    dir.join(PRINTS_FILE)
}

fn print_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Best-effort. A missing or corrupt sidecar means no fingerprints: an
/// unpaired rename then leaves the mark where it was, and the old path
/// stays blocked.
fn read_prints(dir: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(prints_path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Best-effort, written like the list (temp file and rename) so a reader
/// never sees a torn sidecar.
fn write_prints(dir: &Path, prints: &BTreeMap<String, String>) {
    let written = serde_json::to_string_pretty(prints)
        .map_err(|err| AppError::Io(err.to_string()))
        .and_then(|body| crate::commands::fs::write_atomic(&prints_path(dir), body.as_bytes()));
    if let Err(err) = written {
        eprintln!("[mac-only] the fingerprints were not written: {err}");
    }
}

fn remember_print_locked(dir: &Path, path: &Path, kept: &[PathBuf]) {
    let path = canon(path);
    if !kept.iter().any(|entry| entry == &path) {
        return;
    }
    let Some(print) = crate::share_paths::fingerprint(&path) else {
        return;
    };
    let mut prints = read_prints(dir);
    let key = print_key(&path);
    if prints.get(&key) == Some(&print) {
        return;
    }
    prints.insert(key, print);
    write_prints(dir, &prints);
}

/// Refresh the stored fingerprint of a kept file. Call it after the app
/// writes the file, because a save replaces the inode.
pub fn remember_print(dir: &Path, path: &Path) {
    let _guard = lock();
    let Ok(kept) = read_paths(dir) else {
        return;
    };
    remember_print_locked(dir, path, &kept);
}

/// A kept file that vanished and one file that appeared with its fingerprint is a move.
/// More than one match, or none, leaves the kept entry where it is.
pub fn follow_unpaired_moves(dir: &Path, gone: &[PathBuf], appeared: &[PathBuf]) {
    if gone.is_empty() || appeared.is_empty() {
        return;
    }
    let moves: Vec<(PathBuf, PathBuf)> = {
        let _guard = lock();
        let Ok(kept) = read_paths(dir) else {
            return;
        };
        let prints = read_prints(dir);
        gone.iter()
            .filter_map(|path| {
                let key = canon(path);
                if !kept.iter().any(|entry| entry == &key) {
                    return None;
                }
                let print = prints.get(&print_key(&key))?;
                let matches = appeared.iter().filter(|candidate| {
                    candidate.extension().and_then(|ext| ext.to_str()) == Some("md")
                        && candidate.is_file()
                        && crate::share_paths::same_fingerprint(print, candidate)
                });
                // One file reported twice (inotify's To and Both for the same
                // rename) is one match. Two different files are no guess.
                let mut found: Option<&PathBuf> = None;
                for candidate in matches {
                    match found {
                        None => found = Some(candidate),
                        Some(previous) if canon(previous) == canon(candidate) => {}
                        Some(_) => return None,
                    }
                }
                Some((path.clone(), found?.clone()))
            })
            .collect()
    };
    for (from, to) in moves {
        retarget(dir, &from, &to, false);
    }
}

fn file_is_inside(path: &Path, body: &str) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let trimmed = text.trim();
    if trimmed.chars().count() < CARRY_FLOOR {
        return false;
    }
    body.contains(&text) || body.contains(trimmed)
}

#[cfg(test)]
fn contains_word(line: &str, word: &str) -> bool {
    line.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| part == word)
}

fn refusal(channel: Channel, requested_is_blocked: bool) -> &'static str {
    match channel {
        Channel::Share if !requested_is_blocked => FOLDER_LINE,
        Channel::Share => SHARE_LINE,
        Channel::Backup => BACKUP_LINE,
        Channel::Assistant | Channel::Learn => ASSISTANT_LINE,
    }
}

/// Release document text to `send`. `send` runs only when every body is allowed
/// to leave. Callers put the socket or the upload inside `send`.
pub fn depart<T>(
    set: &MacOnlySet,
    requested: &Path,
    channel: Channel,
    bodies: &[(&Path, &str)],
    send: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if set.is_unreadable() {
        return Err(UNREADABLE_LINE.to_string());
    }
    let mut other = false;
    for (path, body) in bodies {
        let blocked = set.blocks(path) || set.carries(body);
        if !blocked {
            continue;
        }
        if set.blocks(path) && same_file(path, requested) {
            return Err(refusal(channel, true).to_string());
        }
        other = true;
    }
    if other {
        return Err(refusal(channel, false).to_string());
    }
    send()
}

fn same_file(left: &Path, right: &Path) -> bool {
    canon(left) == canon(right)
}

fn app_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

#[tauri::command]
pub async fn mac_only_get(app: tauri::AppHandle, path: String) -> Result<bool, AppError> {
    let set = MacOnlySet::load_or_block(app_dir(&app).as_deref());
    if set.is_unreadable() {
        return Err(AppError::Gateway(SETTING_FAILED.into()));
    }
    Ok(set.blocks(Path::new(&path)))
}

#[tauri::command]
pub async fn mac_only_set(
    app: tauri::AppHandle,
    path: String,
    kept: bool,
) -> Result<MacOnlyView, AppError> {
    let Some(dir) = app_dir(&app) else {
        return Err(AppError::Gateway(SETTING_FAILED.into()));
    };
    let file = PathBuf::from(&path);
    set_kept(&dir, &file, kept)?;
    let online = kept && crate::commands::git::online_copy_exists(&file);
    Ok(MacOnlyView { kept, online })
}

#[tauri::command]
pub async fn mac_only_delete_online(path: String) -> Result<OnlineDeleteView, AppError> {
    let report = crate::commands::git::delete_online_copy(Path::new(&path))?;
    Ok(OnlineDeleteView {
        deleted: report.deleted,
        missing: report.missing,
        message: report.message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn a_folder_rename_carries_every_kept_child() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("drafts/sub")).unwrap();
        let a = root.path().join("drafts/a.md");
        let b = root.path().join("drafts/sub/b.md");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        fs::write(root.path().join("other.md"), "o").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &a, true).unwrap();
        set_kept(store.path(), &b, true).unwrap();
        fs::rename(root.path().join("drafts"), root.path().join("essays")).unwrap();
        retarget(
            store.path(),
            &root.path().join("drafts"),
            &root.path().join("essays"),
            true,
        );
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&root.path().join("essays/a.md")));
        assert!(set.blocks(&root.path().join("essays/sub/b.md")));
        assert!(!set.blocks(&root.path().join("other.md")));
    }

    #[test]
    fn a_file_rename_still_carries_the_setting() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.md");
        fs::write(&a, "a").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &a, true).unwrap();
        let b = root.path().join("b.md");
        fs::rename(&a, &b).unwrap();
        retarget(store.path(), &a, &b, false);
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&b));
    }

    #[test]
    fn a_sibling_with_a_shared_prefix_is_not_moved() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("drafts")).unwrap();
        fs::create_dir_all(root.path().join("drafts-old")).unwrap();
        let top = root.path().join("draft.md");
        let old = root.path().join("drafts-old/x.md");
        fs::write(&top, "t").unwrap();
        fs::write(&old, "x").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &top, true).unwrap();
        set_kept(store.path(), &old, true).unwrap();
        fs::rename(root.path().join("drafts"), root.path().join("essays")).unwrap();
        retarget(
            store.path(),
            &root.path().join("drafts"),
            &root.path().join("essays"),
            true,
        );
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&top));
        assert!(set.blocks(&old));
    }

    #[test]
    fn an_unpaired_finder_rename_is_followed_by_fingerprint() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.md");
        fs::write(&a, "kept words").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &a, true).unwrap();
        remember_print(store.path(), &a);
        let b = root.path().join("b.md");
        fs::rename(&a, &b).unwrap();
        follow_unpaired_moves(
            store.path(),
            std::slice::from_ref(&a),
            std::slice::from_ref(&b),
        );
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&b));
    }

    #[test]
    fn two_identical_candidates_move_nothing() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.md");
        let b = root.path().join("b.md");
        let c = root.path().join("c.md");
        for file in [&a, &b, &c] {
            fs::write(file, "same words").unwrap();
        }
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &a, true).unwrap();
        remember_print(store.path(), &a);
        fs::remove_file(&a).unwrap();
        follow_unpaired_moves(
            store.path(),
            std::slice::from_ref(&a),
            &[b.clone(), c.clone()],
        );
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&a));
        assert!(!set.blocks(&b));
        assert!(!set.blocks(&c));
    }

    #[test]
    fn a_save_refreshes_the_print() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.md");
        fs::write(&a, "first draft").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &a, true).unwrap();
        remember_print(store.path(), &a);
        // The app's save writes a temp file and renames it over the original.
        let temp = root.path().join("a.md.tmp");
        fs::write(&temp, "second draft").unwrap();
        fs::rename(&temp, &a).unwrap();
        remember_print(store.path(), &a);
        let c = root.path().join("c.md");
        fs::rename(&a, &c).unwrap();
        follow_unpaired_moves(
            store.path(),
            std::slice::from_ref(&a),
            std::slice::from_ref(&c),
        );
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&c));
    }

    #[test]
    fn user_lines_have_no_git_words_or_em_dashes() {
        for line in USER_LINES {
            assert!(!line.contains('\u{2014}'), "{line}");
            assert!(!line.contains('\u{2013}'), "{line}");
            let lowered = line.to_ascii_lowercase();
            for word in BANNED_WORDS {
                assert!(!contains_word(&lowered, word), "{word} in {line}");
            }
        }
    }

    #[test]
    fn a_kept_document_is_not_handed_to_send() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        let secret = "This sentence stays on this Mac.";
        fs::write(&file, secret).unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &file, true).unwrap();
        let set = MacOnlySet::load(store.path());
        let sent = AtomicBool::new(false);
        let error = depart(&set, &file, Channel::Assistant, &[(&file, secret)], || {
            sent.store(true, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err();
        assert_eq!(error, ASSISTANT_LINE);
        assert!(!sent.load(Ordering::SeqCst));
        assert!(!error.contains(secret));
    }

    #[test]
    fn backup_share_and_learn_stop_before_send() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        let secret = "Backup must not carry this sentence.";
        fs::write(&file, secret).unwrap();
        let set = MacOnlySet::holding(vec![file.clone()]);
        for channel in [Channel::Backup, Channel::Share, Channel::Learn] {
            let sent = AtomicBool::new(false);
            let error = depart(&set, &file, channel, &[(&file, secret)], || {
                sent.store(true, Ordering::SeqCst);
                Ok(secret)
            })
            .unwrap_err();
            assert!(!sent.load(Ordering::SeqCst), "{channel:?}");
            assert!(!error.contains(secret), "{error}");
        }
    }

    #[test]
    fn a_document_that_may_leave_is_sent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, "This one may leave.\n").unwrap();
        let set = MacOnlySet::open();
        let mut seen = String::new();
        depart(
            &set,
            &file,
            Channel::Assistant,
            &[(&file, "This one may leave.")],
            || {
                seen = "This one may leave.".to_string();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(seen, "This one may leave.");
    }

    #[test]
    fn full_text_is_stopped_even_when_the_path_is_wrong() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        let secret = "The whole note is the thing that must not travel.";
        fs::write(&file, secret).unwrap();
        let set = MacOnlySet::holding(vec![file.clone()]);
        let other = dir.path().join("other.md");
        fs::write(&other, "other\n").unwrap();
        let sent = AtomicBool::new(false);
        let error = depart(
            &set,
            &other,
            Channel::Assistant,
            &[(&other, secret)],
            || {
                sent.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error, ASSISTANT_LINE);
        assert!(!sent.load(Ordering::SeqCst));
    }

    #[test]
    fn an_unreadable_list_sends_nothing() {
        let set = MacOnlySet::unreadable();
        let path = Path::new("/tmp/note.md");
        let sent = AtomicBool::new(false);
        let error = depart(&set, path, Channel::Share, &[], || {
            sent.store(true, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err();
        assert_eq!(error, UNREADABLE_LINE);
        assert!(!sent.load(Ordering::SeqCst));
    }

    #[test]
    fn a_list_still_in_the_earlier_folder_sends_nothing_and_is_not_replaced() {
        // After a bundle id change the list is copied on first launch. If that
        // copy did not finish, "no list here" must not read as "nothing kept".
        let root = tempfile::tempdir().unwrap();
        let earlier = root.path().join("com.antonelli.desk");
        let store = root.path().join("app.alkuin.desktop");
        fs::create_dir_all(&earlier).unwrap();
        fs::create_dir_all(&store).unwrap();
        let file = root.path().join("note.md");
        fs::write(&file, "kept on this mac\n").unwrap();
        set_kept(&earlier, &file, true).unwrap();

        let set = MacOnlySet::load(&store);
        assert!(set.is_unreadable());
        assert!(set.blocks(&file));
        // The switch cannot start a fresh list over the one that has not arrived.
        assert!(set_kept(&store, &file, true).is_err());
        assert!(!store_path(&store).exists());

        // The copy finishes on the next launch, and the list is the earlier one.
        fs::copy(store_path(&earlier), store_path(&store)).unwrap();
        fs::write(store.join(".identifier-migrated"), "com.antonelli.desk").unwrap();
        let set = MacOnlySet::load(&store);
        assert!(!set.is_unreadable());
        assert!(set.blocks(&file));

        // A first install, with no earlier folder, starts with nothing kept.
        let fresh = tempfile::tempdir().unwrap();
        assert!(!MacOnlySet::load(fresh.path()).is_unreadable());
    }

    #[test]
    fn turning_the_setting_off_removes_the_block() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, "hello from this mac\n").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &file, true).unwrap();
        assert!(MacOnlySet::load(store.path()).blocks(&file));
        set_kept(store.path(), &file, false).unwrap();
        assert!(!MacOnlySet::load(store.path()).blocks(&file));
    }

    #[test]
    fn a_torn_list_blocks_sends_until_the_switch_rewrites_it() {
        let dir = tempfile::tempdir().unwrap();
        let kept = dir.path().join("kept.md");
        let other = dir.path().join("other.md");
        let fresh = dir.path().join("fresh.md");
        for file in [&kept, &other, &fresh] {
            fs::write(file, "words\n").unwrap();
        }
        let store = tempfile::tempdir().unwrap();
        let torn = format!(
            "[\n  {},\n  \"{}",
            serde_json::to_string(&canon(&kept)).unwrap(),
            canon(&other).to_string_lossy()
        );
        fs::write(store_path(store.path()), &torn).unwrap();
        let set = MacOnlySet::load(store.path());
        assert!(set.is_unreadable());
        assert!(set.blocks(&fresh));

        // Nothing but the switch rewrites it, so every send stays blocked.
        retarget(store.path(), &kept, &fresh, false);
        forget(store.path(), &kept);
        assert!(keep_without_switch(store.path(), &fresh).is_err());
        assert_eq!(fs::read_to_string(store_path(store.path())).unwrap(), torn);

        set_kept(store.path(), &fresh, true).unwrap();
        let set = MacOnlySet::load(store.path());
        assert!(!set.is_unreadable());
        assert!(set.blocks(&kept), "a readable entry was lost");
        assert!(set.blocks(&fresh));
        assert_eq!(
            fs::read_to_string(store.path().join(UNREADABLE_COPY)).unwrap(),
            torn
        );
        let leftovers: Vec<_> = fs::read_dir(store.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != STORE_FILE && name != UNREADABLE_COPY && name != PRINTS_FILE)
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_second_retarget_for_the_same_move_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("old.md");
        let to = dir.path().join("new.md");
        fs::write(&from, "same words\n").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &from, true).unwrap();
        fs::rename(&from, &to).unwrap();
        assert!(try_retarget(store.path(), &from, &to, false).unwrap());
        assert!(!try_retarget(store.path(), &from, &to, false).unwrap());
        assert!(MacOnlySet::load(store.path()).blocks(&to));
    }

    #[test]
    fn a_folder_rename_keeps_the_documents_inside_kept() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Diary");
        fs::create_dir_all(&folder).unwrap();
        let note = folder.join("entry.md");
        fs::write(&note, "private\n").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &note, true).unwrap();
        let renamed = dir.path().join("Journal");
        fs::rename(&folder, &renamed).unwrap();
        assert!(try_retarget(store.path(), &folder, &renamed, true).unwrap());
        assert!(MacOnlySet::load(store.path()).blocks(&renamed.join("entry.md")));
    }

    #[test]
    fn rename_follows_the_document() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("old.md");
        let to = dir.path().join("new.md");
        fs::write(&from, "same words\n").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &from, true).unwrap();
        fs::rename(&from, &to).unwrap();
        retarget(store.path(), &from, &to, false);
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&from));
        assert!(set.blocks(&to));
    }

    #[test]
    fn a_rename_keeps_the_old_path_and_a_file_recreated_there() {
        // A rename dropped the old path's mark, so an editor
        // that recreated the file there uploaded it.
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.md");
        let b = root.path().join("b.md");
        fs::write(&a, "kept words").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &a, true).unwrap();
        remember_print(store.path(), &a);
        fs::rename(&a, &b).unwrap();
        assert!(try_retarget(store.path(), &a, &b, false).unwrap());
        // An open buffer saves to the old path and recreates the file.
        fs::write(&a, "kept words, edited").unwrap();
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&a));
        assert!(set.blocks(&b));
        // A second call for the same move adds nothing.
        assert!(!try_retarget(store.path(), &a, &b, false).unwrap());
    }

    #[test]
    fn a_renamed_documents_print_is_copied_so_an_unpaired_move_still_follows_it() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.md");
        let b = root.path().join("b.md");
        let c = root.path().join("c.md");
        fs::write(&a, "kept words").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &a, true).unwrap();
        remember_print(store.path(), &a);
        fs::rename(&a, &b).unwrap();
        retarget(store.path(), &a, &b, false);
        fs::rename(&b, &c).unwrap();
        follow_unpaired_moves(
            store.path(),
            std::slice::from_ref(&b),
            std::slice::from_ref(&c),
        );
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&a));
        assert!(set.blocks(&b));
        assert!(set.blocks(&c));
    }

    #[test]
    fn a_folder_rename_keeps_both_prefixes() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("drafts/sub")).unwrap();
        let child = root.path().join("drafts/sub/b.md");
        fs::write(&child, "b").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &child, true).unwrap();
        fs::rename(root.path().join("drafts"), root.path().join("essays")).unwrap();
        retarget(
            store.path(),
            &root.path().join("drafts"),
            &root.path().join("essays"),
            true,
        );
        // A note written under the old folder name is still kept.
        fs::create_dir_all(root.path().join("drafts/sub")).unwrap();
        fs::write(&child, "again").unwrap();
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&child));
        assert!(set.blocks(&root.path().join("essays/sub/b.md")));
    }

    #[test]
    fn renaming_back_to_a_kept_name_carries_the_fresh_fingerprint() {
        // A rename to a path that was already marked kept its
        // old fingerprint. B -> A, save at A, A -> B left B with B's old print,
        // so a later unpaired Finder rename of B lost the mark.
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.md");
        let b = root.path().join("b.md");
        let c = root.path().join("c.md");
        fs::write(&b, "first words").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &b, true).unwrap();
        remember_print(store.path(), &b);
        fs::rename(&b, &a).unwrap();
        retarget(store.path(), &b, &a, false);
        fs::write(&a, "different words, saved at a").unwrap();
        remember_print(store.path(), &a);
        fs::rename(&a, &b).unwrap();
        assert!(
            try_retarget(store.path(), &a, &b, false).unwrap(),
            "the fresh print was not carried back"
        );
        fs::rename(&b, &c).unwrap();
        follow_unpaired_moves(
            store.path(),
            std::slice::from_ref(&b),
            std::slice::from_ref(&c),
        );
        assert!(MacOnlySet::load(store.path()).blocks(&c));
    }

    #[test]
    fn one_file_reported_twice_is_one_fingerprint_match() {
        // Inotify reports a rename's destination as To and
        // Both. Listed twice, it counted as two matches and was not followed.
        let root = tempfile::tempdir().unwrap();
        let b = root.path().join("b.md");
        let c = root.path().join("c.md");
        let other = root.path().join("other.md");
        fs::write(&b, "kept words").unwrap();
        fs::write(&other, "something else").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &b, true).unwrap();
        remember_print(store.path(), &b);
        fs::rename(&b, &c).unwrap();
        follow_unpaired_moves(
            store.path(),
            std::slice::from_ref(&b),
            &[c.clone(), other.clone(), c.clone()],
        );
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&c));
        assert!(!set.blocks(&other));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_at_the_old_path_does_not_carry_another_documents_mark() {
        // The old name was resolved through `canon`, which
        // follows a symlink. A co-writer's symlink at the old path to another
        // private note made the move act on that note's mark.
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("private.md");
        let old = root.path().join("old.md");
        let new = root.path().join("new.md");
        fs::write(&private, "only on this Mac").unwrap();
        fs::write(&new, "a public note").unwrap();
        let store = tempfile::tempdir().unwrap();
        set_kept(store.path(), &private, true).unwrap();
        std::os::unix::fs::symlink(&private, &old).unwrap();
        retarget(store.path(), &old, &new, false);
        let set = MacOnlySet::load(store.path());
        assert!(set.blocks(&private), "the private note lost its mark");
        assert!(
            !set.blocks(&new),
            "the move carried a mark the old path never had"
        );
        assert_eq!(set.paths(), &[canon(&private)]);
    }
}
