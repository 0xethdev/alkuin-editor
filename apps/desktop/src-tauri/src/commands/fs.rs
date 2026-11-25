use crate::error::AppError;
use crate::ignore::WorkspaceIgnore;
use crate::state::{AppState, WorkspaceState};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_markdown: bool,
    pub modified_at: u64,
    /// Creation time in seconds since the epoch. Falls back to the modified
    /// time on filesystems without a birth time (many Linux mounts).
    pub created_at: u64,
    /// Document title extracted from frontmatter `title:` or leading `# ` heading.
    /// `None` for directories or files without a recognizable title.
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub modified_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteResult {
    pub path: String,
    pub modified_at: u64,
    /// The save found the file changed on disk. That version is in this file, beside it.
    /// The newest one, when the file changed again while it was copied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_copy: Option<String>,
    /// Every copy this save made, oldest first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub other_copies: Vec<String>,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

/// Extract a document title from a markdown file by reading its first few KB.
/// Priority: YAML frontmatter `title:` field, then leading `# ` heading.
fn extract_title(path: &Path) -> Option<String> {
    use std::io::Read;

    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 4096];
    let n = file.read(&mut buf).ok()?;
    let text = std::str::from_utf8(&buf[..n]).ok()?;

    // Check for YAML frontmatter (--- delimited)
    if let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    {
        // Find the closing ---
        if let Some(end_pos) = rest.find("\n---\n").or_else(|| rest.find("\n---\r\n")) {
            let yaml_block = &rest[..end_pos];
            // Look for title: in the YAML
            for line in yaml_block.lines() {
                let trimmed = line.trim();
                if let Some(value) = trimmed.strip_prefix("title:") {
                    let value = value.trim();
                    // Strip surrounding quotes
                    let title = value
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                        .unwrap_or(value);
                    if !title.is_empty() {
                        return Some(title.to_string());
                    }
                }
            }
            // No frontmatter title — check for H1 in the body after frontmatter
            let body_start = end_pos + "\n---\n".len();
            return extract_leading_h1(&rest[body_start..]);
        }
    }

    // No frontmatter — check for H1 heading
    extract_leading_h1(text)
}

/// Paired `code`, `**bold**`, `*italic*`, and `_italic_` so a heading title
/// matches the sidebar. `_` only counts at a whitespace boundary (`snake_case` stays).
fn strip_inline_title_marks(title: &str) -> String {
    let mut current = title.to_string();
    for _ in 0..4 {
        let next = strip_underscore_italic(&strip_marker(
            &strip_marker(&strip_marker(&current, "`"), "**"),
            "*",
        ));
        if next == current {
            break;
        }
        current = next;
    }
    current.trim().to_string()
}

fn strip_marker(input: &str, marker: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while !rest.is_empty() {
        let Some(start) = rest.find(marker) else {
            out.push_str(rest);
            break;
        };
        let after = &rest[start + marker.len()..];
        if let Some(end) = after.find(marker) {
            let inner = &after[..end];
            if !inner.is_empty() && !inner.contains(marker) && !inner.contains('\n') {
                out.push_str(&rest[..start]);
                out.push_str(inner);
                rest = &after[end + marker.len()..];
                continue;
            }
        }
        out.push_str(&rest[..start + marker.len()]);
        rest = after;
    }
    out
}

fn strip_underscore_italic(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while let Some(start) = rest.find('_') {
        let prev_ok = start == 0
            || rest[..start]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        let after = &rest[start + 1..];
        if prev_ok {
            if let Some(end) = after.find('_') {
                let inner = &after[..end];
                let next = after[end + 1..].chars().next();
                let next_ok = next.is_none_or(char::is_whitespace);
                if !inner.is_empty() && next_ok && !inner.contains('\n') {
                    out.push_str(&rest[..start]);
                    out.push_str(inner);
                    rest = &after[end + 1..];
                    continue;
                }
            }
        }
        out.push_str(&rest[..start + 1]);
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Extract a title from the first `# ` heading, which must be the first
/// non-blank line in the text.
fn extract_leading_h1(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let title = strip_inline_title_marks(heading.trim());
            if !title.is_empty() {
                return Some(title);
            }
        }
        // First non-blank line is not an H1
        return None;
    }
    None
}

fn epoch_secs(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok().map(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    })
}

pub(crate) fn modified_time(path: &std::path::Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| epoch_secs(m.modified()))
        .unwrap_or(0)
}

/// Creation time, falling back to the modified time where the platform or
/// filesystem exposes none, so created-time sorting degrades to modified-time
/// sorting instead of collapsing to zero.
pub(crate) fn created_time(path: &std::path::Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| epoch_secs(m.created()).or_else(|| epoch_secs(m.modified())))
        .unwrap_or(0)
}

/// Recursively checks if a directory contains at least one visible .md file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DirectoryContent {
    Markdown,
    Empty,
    Other,
}

fn visible_fs_entry(
    entry: Result<std::fs::DirEntry, std::io::Error>,
    ignore: Option<&WorkspaceIgnore>,
) -> Result<Option<(PathBuf, std::fs::FileType)>, AppError> {
    let entry = entry?;
    let file_type = entry.file_type()?;
    let path = entry.path();
    if entry.file_name().to_string_lossy().starts_with('.')
        || ignore.is_some_and(|matcher| matcher.is_ignored(&path, file_type.is_dir()))
    {
        return Ok(None);
    }
    Ok(Some((path, file_type)))
}

/// Classify a directory tree through the same visible/ignored lens as the
/// sidebar. Folder-only trees count as empty so a newly created folder stays
/// available for authoring; a visible non-Markdown file makes the tree
/// `Other`. A Markdown file wins immediately.
fn classify_directory_content(
    path: &Path,
    ignore: Option<&WorkspaceIgnore>,
) -> Result<DirectoryContent, AppError> {
    let mut content = DirectoryContent::Empty;
    for entry in fs::read_dir(path)? {
        let Some((entry_path, file_type)) = visible_fs_entry(entry, ignore)? else {
            continue;
        };
        if file_type.is_file() {
            if entry_path.extension().and_then(|e| e.to_str()) == Some("md") {
                return Ok(DirectoryContent::Markdown);
            }
            content = DirectoryContent::Other;
        } else if file_type.is_dir() {
            match classify_directory_content(&entry_path, ignore)? {
                DirectoryContent::Markdown => return Ok(DirectoryContent::Markdown),
                DirectoryContent::Other => content = DirectoryContent::Other,
                DirectoryContent::Empty => {}
            }
        }
    }
    Ok(content)
}

/// Fast indexed-path check for a folder-only tree. Once the Markdown index is
/// ready we already know this subtree has no Markdown, so the first visible
/// file proves it is not empty and lets us stop without walking the remainder.
fn directory_tree_is_empty(
    path: &Path,
    ignore: Option<&WorkspaceIgnore>,
) -> Result<bool, AppError> {
    for entry in fs::read_dir(path)? {
        let Some((entry_path, file_type)) = visible_fs_entry(entry, ignore)? else {
            continue;
        };
        if file_type.is_file()
            || (file_type.is_dir() && !directory_tree_is_empty(&entry_path, ignore)?)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// O(1) Markdown check via the pre-built set once available. Directories not
/// in that set still need a recursive classification to distinguish durable
/// empty folder trees from trees containing only non-Markdown files.
fn directory_is_sidebar_visible(
    path: &Path,
    state: Option<&WorkspaceState>,
) -> Result<bool, AppError> {
    if let Some(state) = state {
        let index_ready = state.index_ready.load(Ordering::Relaxed);
        if index_ready && state.dirs_with_markdown.read().contains(path) {
            return Ok(true);
        }
        // Snapshot the `Arc<WorkspaceIgnore>` under a brief read lock and
        // release immediately — the recursive fallback below does file I/O
        // and must not hold the RwLock across syscalls (it would block a
        // concurrent workspace switch's `workspace_ignore.write()`).
        let ignore_arc: Option<Arc<WorkspaceIgnore>> =
            state.workspace_ignore.read().as_ref().map(Arc::clone);
        if index_ready {
            return directory_tree_is_empty(path, ignore_arc.as_deref());
        }
        return Ok(matches!(
            classify_directory_content(path, ignore_arc.as_deref())?,
            DirectoryContent::Markdown | DirectoryContent::Empty
        ));
    }
    Ok(matches!(
        classify_directory_content(path, None)?,
        DirectoryContent::Markdown | DirectoryContent::Empty
    ))
}

pub fn read_directory_impl(
    path: &str,
    state: Option<&WorkspaceState>,
) -> Result<Vec<DirEntry>, AppError> {
    let dir_path = PathBuf::from(path);
    if !dir_path.exists() {
        return Err(AppError::NotFound(path.to_string()));
    }

    // Snapshot the `Arc<WorkspaceIgnore>` under a brief read lock and release
    // immediately — we must NOT hold the RwLock across the per-file I/O
    // below. `extract_title` can block for seconds on iCloud placeholders or
    // slow disks; if the guard were still held, a concurrent workspace
    // switch's `workspace_ignore.write()` in `prepare_workspace_state` would
    // be blocked, freezing the switch IPC.
    let ignore_arc: Option<Arc<WorkspaceIgnore>> =
        state.and_then(|s| s.workspace_ignore.read().as_ref().map(Arc::clone));
    let ignore_matcher: Option<&WorkspaceIgnore> = ignore_arc.as_deref();

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry in fs::read_dir(&dir_path)?.flatten() {
        let file_type = entry.file_type()?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs (the workspace `.gitignore` stays available
        // because `read_directory` only surfaces markdown files and
        // directories, never dotfiles — see the sidebar spec).
        if name.starts_with('.') {
            continue;
        }

        if let Some(ignore) = ignore_matcher {
            if ignore.is_ignored(&entry_path, file_type.is_dir()) {
                continue;
            }
        }

        if file_type.is_dir() {
            if directory_is_sidebar_visible(&entry_path, state)? {
                dirs.push(DirEntry {
                    name,
                    path: entry_path.to_string_lossy().to_string(),
                    is_dir: true,
                    is_markdown: false,
                    modified_at: modified_time(&entry_path),
                    created_at: created_time(&entry_path),
                    title: None,
                });
            }
        } else if file_type.is_file() {
            let is_markdown = entry_path.extension().and_then(|e| e.to_str()) == Some("md");
            if is_markdown {
                let title = extract_title(&entry_path);
                files.push(DirEntry {
                    name,
                    path: entry_path.to_string_lossy().to_string(),
                    is_dir: false,
                    is_markdown: true,
                    modified_at: modified_time(&entry_path),
                    created_at: created_time(&entry_path),
                    title,
                });
            }
        }
    }

    // Sort dirs-first, then alphabetical by filename within each group. This is
    // a stable baseline for every consumer; the sidebar tree re-sorts by its
    // visible label (title or stem) in `flatten-tree.ts`.
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
pub async fn read_directory(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<DirEntry>, AppError> {
    // `get`, not `get_or_create`: a late call from a closed window must not
    // rebuild its state. Without one, the listing has no ignore rules.
    let state = app.state::<AppState>().get(webview.label());
    blocking(move || read_directory_impl(&path, state.as_deref())).await
}

pub fn read_file_impl(path: &str) -> Result<FileContent, AppError> {
    let file_path = PathBuf::from(path);
    if !file_path.exists() {
        return Err(AppError::NotFound(path.to_string()));
    }
    let content = fs::read_to_string(&file_path)?;
    Ok(FileContent {
        path: path.to_string(),
        content,
        modified_at: modified_time(&file_path),
    })
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<FileContent, AppError> {
    blocking(move || read_file_impl(&path)).await
}

const LINK_OUTSIDE_FOLDER: &str =
    "This note is a link to a file outside its folder, so Alkuin won't save through it.";

/// The longest file name APFS and most other disks take, in bytes.
const NAME_MAX_BYTES: usize = 255;

/// How many times a save copies a file that keeps changing under it before it gives up.
const SETTLE_ROUNDS: usize = 3;

/// The save's error when the file changed again every time it was copied. The retry
/// that follows a failed save tries again; nothing was replaced.
const KEPT_CHANGING: &str = "This document kept changing outside Alkuin, so it couldn't be saved yet. Alkuin will try again.";

/// The same failure, when the outside versions are in copies: they are named, so the
/// writer knows where they went. `{copies}` is their file names.
const KEPT_CHANGING_SAVED: &str = "This document kept changing outside Alkuin, so it couldn't be saved yet. The outside changes are saved as {copies}. Alkuin will try again.";

/// How many of a file's copies this run remembers. The newest are kept; an older copy
/// with the same bytes would only mean one more copy, never a loss.
const KEPT_COPIES_PER_FILE: usize = 20;

/// The other copies a save kept beside each file in this run of the app. A save that
/// finds the same outside bytes again (a formatter that writes the same text after every
/// save) does not make another copy of them. A copy deleted since does not count.
static KEPT_COPIES: std::sync::Mutex<std::collections::BTreeMap<PathBuf, Vec<PathBuf>>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

fn kept_copies() -> std::sync::MutexGuard<'static, std::collections::BTreeMap<PathBuf, Vec<PathBuf>>>
{
    KEPT_COPIES
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn remember_copy(file: &Path, copy: &Path) {
    let mut kept = kept_copies();
    let copies = kept.entry(file.to_path_buf()).or_default();
    copies.push(copy.to_path_buf());
    let over = copies.len().saturating_sub(KEPT_COPIES_PER_FILE);
    copies.drain(..over);
}

/// A copy this run kept beside `file` still holds exactly `disk`. The copies are read
/// with no lock held; one that no longer exists is forgotten.
fn already_kept(file: &Path, disk: &[u8]) -> bool {
    let listed = kept_copies().get(file).cloned().unwrap_or_default();
    if listed.is_empty() {
        return false;
    }
    let mut gone = Vec::new();
    let mut found = false;
    for copy in &listed {
        match fs::read(copy) {
            Ok(bytes) if bytes == disk => {
                found = true;
                break;
            }
            Ok(_) => {}
            Err(_) => gone.push(copy.clone()),
        }
    }
    if !gone.is_empty() {
        if let Some(copies) = kept_copies().get_mut(file) {
            copies.retain(|copy| !gone.contains(copy));
        }
    }
    found
}

/// Create a new file with the original's mode from the start (not chmod after the write),
/// so a private (0600) note's text is never readable by others, not even for a moment.
/// Used for other copies here and for a pull's staged copy in `history.rs`.
pub(crate) fn create_copy_file(
    candidate: &Path,
    permissions: Option<&fs::Permissions>,
) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if let Some(permissions) = permissions {
            options.mode(permissions.mode() & 0o777);
        }
    }
    options.open(candidate)
}

/// How many random names a save tries once every numbered name is taken.
const SPARE_NAME_TRIES: usize = 16;

/// The labels a copy's name may carry, in order: `other copy`, `other copy 2` … `other
/// copy 99`, then `other copy <8 hex>`. Every numbered name taken (a program that writes
/// new bytes after every save, copies from earlier runs) never means writing over the
/// changed file without its copy: a random name is found instead.
fn copy_labels() -> impl Iterator<Item = String> {
    (1..=99)
        .map(|count| {
            if count == 1 {
                "other copy".to_string()
            } else {
                format!("other copy {count}")
            }
        })
        .chain((0..SPARE_NAME_TRIES).map(|_| {
            let id = uuid::Uuid::new_v4().simple().to_string();
            format!("other copy {}", &id[..8])
        }))
}

/// The version a save found on disk, kept beside the file before the save replaces it:
/// `notes.md` becomes `notes (other copy).md`, then `(other copy 2)`, then a random name
/// (`copy_labels`). Never over a file. When no name can be had at all, the save stops
/// with the file untouched.
fn keep_other_copy(
    file: &Path,
    disk: &[u8],
    permissions: Option<&fs::Permissions>,
) -> Result<PathBuf, AppError> {
    use std::io::Write;
    let dir = file
        .parent()
        .ok_or_else(|| AppError::Io("No parent directory".into()))?;
    let stem = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = file
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    for label in copy_labels() {
        let suffix = format!(" ({label}){extension}");
        // A name longer than the disk takes loses the end of its stem, on a character
        // boundary, so a long file name does not stop the save.
        let mut keep = stem.len().min(NAME_MAX_BYTES.saturating_sub(suffix.len()));
        while !stem.is_char_boundary(keep) {
            keep -= 1;
        }
        let candidate = dir.join(format!("{}{suffix}", &stem[..keep]));
        let mut out = match create_copy_file(&candidate, permissions) {
            Ok(out) => out,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        };
        let written = (|| -> std::io::Result<()> {
            // The mode given at creation is narrowed by the umask. Match the original exactly.
            if let Some(permissions) = permissions {
                fs::set_permissions(&candidate, permissions.clone())?;
            }
            out.write_all(disk)?;
            out.sync_all()
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(&candidate);
            return Err(error.into());
        }
        return Ok(candidate);
    }
    Err(AppError::Io(format!(
        "No free name beside {} for its other copy",
        file.display()
    )))
}

/// Keep every outside version of `file` that the save is about to replace, in `made`.
/// Returns when the file reads as the editor expects, as these words, as a copy already
/// kept, or as it did right after its copy and mark were written. The copy and the mark
/// take time, so the file is read again after them: a version written meanwhile is
/// copied in the next round, and a file that changes every round fails the save.
fn keep_outside_versions(
    file: &Path,
    content: &str,
    expected: &str,
    kept_in: Option<&Path>,
    permissions: Option<&fs::Permissions>,
    made: &mut Vec<PathBuf>,
    after_copy: &dyn Fn(),
) -> Result<(), AppError> {
    for _ in 0..SETTLE_ROUNDS {
        let disk = match fs::read(file) {
            Ok(disk) => disk,
            // Deleted or moved away. The save writes it back, as before.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            // Unreadable is not absent. Do not write over what cannot be kept.
            Err(error) => return Err(error.into()),
        };
        // What the editor last saw, already these words, or a version already kept.
        if disk == expected.as_bytes() || disk == content.as_bytes() || already_kept(file, &disk) {
            return Ok(());
        }
        let copy = keep_other_copy(file, &disk, permissions)?;
        made.push(copy.clone());
        remember_copy(file, &copy);
        // The other version of a document kept on this Mac is kept on this Mac too.
        if let Some(dir) = kept_in {
            crate::mac_only::keep_without_switch(dir, &copy)?;
        }
        after_copy();
        match fs::read(file) {
            Ok(now) if now == disk => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Ok(_) => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(AppError::Message(KEPT_CHANGING.into()))
}

/// The save did not happen. A copy it made is removed again while the file itself still
/// holds those bytes, with its kept mark: nothing is lost, and a retry does not leave one
/// more copy each time. A copy whose bytes the file no longer holds is the only record of
/// that version, so it stays.
fn undo_copies(file: &Path, made: &[PathBuf], kept_in: Option<&Path>) {
    for copy in made {
        // Read the file right before each delete: one written meanwhile must not cost the
        // only copy of a version it no longer holds.
        let same = fs::read(file)
            .ok()
            .is_some_and(|now| fs::read(copy).is_ok_and(|bytes| bytes == now));
        if !same {
            continue;
        }
        let _ = fs::remove_file(copy);
        if let Some(dir) = kept_in {
            crate::mac_only::forget(dir, copy);
        }
        if let Some(copies) = kept_copies().get_mut(file) {
            copies.retain(|kept| kept != copy);
        }
    }
}

/// A write that does not check the file first. The app always saves through
/// [`write_file_expecting`]; the tests of the atomic write call this.
#[cfg(test)]
pub fn write_file_impl(path: &str, content: &str) -> Result<WriteResult, AppError> {
    write_file_expecting(path, content, None, None)
}

/// Write `content`. `expected` is the text the editor last read or wrote at this path.
/// When the file holds something else, another program, another Mac, or another window
/// wrote it since, and that version is kept beside the file before this save replaces
/// it: the writer's words go in the file, the outside words in the copy.
/// `kept_in` is the app folder when this document is kept on this Mac only. Its other
/// version is then kept on this Mac too, before anything is replaced, and a mark that
/// cannot be written stops the save with the file untouched.
/// shortcut: the previous text rides along with every save. Upgrade is a hash of it when documents get large.
pub fn write_file_expecting(
    path: &str,
    content: &str,
    expected: Option<&str>,
    kept_in: Option<&Path>,
) -> Result<WriteResult, AppError> {
    write_file_with(
        path,
        content,
        expected,
        kept_in,
        &|from, to| fs::rename(from, to),
        &|| {},
    )
}

/// [`write_file_expecting`] with its last step and the moment after a copy as
/// arguments, so a test can make the replace fail or the file change mid-save.
fn write_file_with(
    path: &str,
    content: &str,
    expected: Option<&str>,
    kept_in: Option<&Path>,
    replace: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
    after_copy: &dyn Fn(),
) -> Result<WriteResult, AppError> {
    let requested = PathBuf::from(path);
    // A symlinked note is written at its target, so the link keeps pointing at the edited file.
    // Only when that target is in the link's own folder or below. A link that leaves the
    // folder (a pull can create one) is refused, never replaced, so autosave cannot overwrite
    // an unrelated file.
    let file_path = match fs::symlink_metadata(&requested) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let target = fs::canonicalize(&requested)?;
            let home = requested
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            if !target.starts_with(fs::canonicalize(home)?) {
                return Err(AppError::Message(LINK_OUTSIDE_FOLDER.into()));
            }
            target
        }
        _ => requested.clone(),
    };

    // Atomic write: write to a temp file, then rename. The temp file is written first, so
    // the time between the last look at the file and the rename is as short as it can be.
    let dir = file_path
        .parent()
        .ok_or_else(|| AppError::Io("No parent directory".into()))?;
    let temp_path = dir.join(format!(".~{}", uuid::Uuid::new_v4()));
    // The new file and any other copy keep the old one's mode, so a private (0600) note
    // stays private.
    let permissions = fs::metadata(&file_path)
        .ok()
        .map(|existing| existing.permissions());
    let staged = (|| -> std::io::Result<()> {
        fs::write(&temp_path, content)?;
        if let Some(permissions) = &permissions {
            fs::set_permissions(&temp_path, permissions.clone())?;
        }
        Ok(())
    })();
    if let Err(error) = staged {
        let _ = fs::remove_file(&temp_path);
        return Err(error.into());
    }

    let mut made = Vec::new();
    let saved = (|| -> Result<(), AppError> {
        if let Some(expected) = expected {
            keep_outside_versions(
                &file_path,
                content,
                expected,
                kept_in,
                permissions.as_ref(),
                &mut made,
                after_copy,
            )?;
        }
        replace(&temp_path, &file_path)?;
        Ok(())
    })();
    if let Err(error) = saved {
        let _ = fs::remove_file(&temp_path);
        undo_copies(&file_path, &made, kept_in);
        return Err(name_kept_copies(error, &made));
    }

    let copies: Vec<String> = made
        .iter()
        .map(|copy| copy.to_string_lossy().into_owned())
        .collect();
    Ok(WriteResult {
        path: path.to_string(),
        modified_at: modified_time(&file_path),
        // The newest copy this save made. One save makes more than one only when the
        // file changed again while it was being copied; all of them are in `other_copies`.
        other_copy: copies.last().cloned(),
        other_copies: copies,
    })
}

/// A save that gave up because the file kept changing names the copies it left, so the
/// writer knows where those outside versions are. Any other error is returned as it is.
fn name_kept_copies(error: AppError, made: &[PathBuf]) -> AppError {
    let kept_changing = matches!(&error, AppError::Message(line) if line == KEPT_CHANGING);
    let left: Vec<String> = made
        .iter()
        .filter(|copy| copy.exists())
        .filter_map(|copy| copy.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .collect();
    if !kept_changing || left.is_empty() {
        return error;
    }
    AppError::Message(KEPT_CHANGING_SAVED.replace("{copies}", &left.join(", ")))
}

/// `expected` is the text this app last read or wrote at `path` (`save.ts` sends it).
/// None writes without looking, as every other writer of a new file does.
#[tauri::command]
pub async fn write_file(
    path: String,
    content: String,
    expected: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<WriteResult, AppError> {
    // Mark the write in flight, then settle the marker with what landed.
    // The marker is per-window so only this window's watcher suppresses
    // the echo — if another window is watching the same workspace it
    // still sees a genuine file-changed event. A failed write drops the
    // marker, so it suppresses nothing.
    let state = app.state::<AppState>().window(webview.label())?;
    let label = webview.label().to_string();
    let write_path = PathBuf::from(&path);
    let home = app.path().app_data_dir().ok();
    // The other version of a document kept on this Mac is kept on this Mac too. A list
    // that cannot be read counts as kept, so such a save stops rather than leave a copy
    // that could be sent.
    let kept_in = home
        .clone()
        .filter(|dir| crate::mac_only::MacOnlySet::load_or_block(Some(dir)).blocks(&write_path));
    let write_id = crate::watcher::begin_self_write(&state, &write_path);

    let result = blocking(move || {
        let written =
            write_file_expecting(&path, &content, expected.as_deref(), kept_in.as_deref())?;
        // A save replaces the inode, so a kept file's fingerprint is refreshed.
        if let Some(home) = home {
            crate::mac_only::remember_print(&home, Path::new(&path));
        }
        Ok(written)
    })
    .await;
    crate::watcher::finish_self_write(&state, &write_path, write_id, result.is_ok());
    let result = result?;
    state.update_index_modified_at(&write_path, result.modified_at);
    let _ = app.emit_to(label, "sidebar:metadata-changed", &result);
    Ok(result)
}

pub(crate) fn markdown_file_entry(path: &Path) -> Option<DirEntry> {
    if !path.is_file()
        || !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
    {
        return None;
    }

    let name = path.file_name()?.to_string_lossy().to_string();
    Some(DirEntry {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: false,
        is_markdown: true,
        modified_at: modified_time(path),
        created_at: created_time(path),
        title: extract_title(path),
    })
}

pub fn read_recent_files_impl(
    state: &WorkspaceState,
    limit: usize,
    offset: usize,
) -> Vec<DirEntry> {
    state
        .recent_files_slice(offset, limit)
        .into_iter()
        .filter_map(|file| markdown_file_entry(&file.path))
        .collect()
}

#[tauri::command]
pub async fn read_recent_files(
    limit: Option<u32>,
    offset: Option<u32>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<DirEntry>, AppError> {
    let state = app.state::<AppState>().window(webview.label())?;
    if state.workspace_root.read().is_none() {
        return Err(AppError::NoWorkspace);
    }

    let limit = limit.unwrap_or(8).clamp(1, 100) as usize;
    let offset = offset.unwrap_or(0) as usize;
    blocking(move || Ok(read_recent_files_impl(&state, limit, offset))).await
}

pub fn read_file_entries_impl(paths: Vec<String>, root: &Path) -> Vec<DirEntry> {
    paths
        .into_iter()
        .filter_map(|path| {
            let path = PathBuf::from(path);
            if !path.starts_with(root) {
                return None;
            }
            markdown_file_entry(&path)
        })
        .collect()
}

#[tauri::command]
pub async fn read_file_entries(
    paths: Vec<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<DirEntry>, AppError> {
    let state = app.state::<AppState>().window(webview.label())?;
    let root = state
        .workspace_root
        .read()
        .clone()
        .ok_or(AppError::NoWorkspace)?;
    blocking(move || Ok(read_file_entries_impl(paths, &root))).await
}

pub fn create_file_impl(path: &str) -> Result<FileContent, AppError> {
    let file_path = PathBuf::from(path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let default_content = "# ";
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::AlreadyExists(path.to_string())
            } else {
                AppError::Io(error.to_string())
            }
        })?;
    if let Err(error) = file.write_all(default_content.as_bytes()) {
        let _ = fs::remove_file(&file_path);
        return Err(AppError::Io(error.to_string()));
    }
    crate::telemetry::track("file_created");
    Ok(FileContent {
        path: path.to_string(),
        content: default_content.to_string(),
        modified_at: modified_time(&file_path),
    })
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<FileContent, AppError> {
    blocking(move || create_file_impl(&path)).await
}

pub fn create_directory_impl(path: &str) -> Result<DirEntry, AppError> {
    let dir_path = PathBuf::from(path);
    if let Some(parent) = dir_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(&dir_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::AlreadyExists(path.to_string())
        } else {
            AppError::Io(error.to_string())
        }
    })?;
    let name = dir_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    crate::telemetry::track("folder_created");
    Ok(DirEntry {
        name,
        path: path.to_string(),
        is_dir: true,
        is_markdown: false,
        modified_at: modified_time(&dir_path),
        created_at: created_time(&dir_path),
        title: None,
    })
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<DirEntry, AppError> {
    blocking(move || create_directory_impl(&path)).await
}

macro_rules! sidebar_entry_kinds {
    ($( $variant:ident => $wire:literal ),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Deserialize, Serialize)]
        pub enum SidebarEntryKind {
            $(#[serde(rename = $wire)] $variant),+
        }

        impl SidebarEntryKind {
            #[cfg(test)]
            const ALL: &'static [Self] = &[$(Self::$variant),+];
        }
    };
}

sidebar_entry_kinds!(File => "file", Folder => "folder");

fn create_sidebar_candidate(
    candidate: &Path,
    kind: SidebarEntryKind,
) -> Result<DirEntry, AppError> {
    match kind {
        SidebarEntryKind::File => create_file_impl(&candidate.to_string_lossy()).and_then(|_| {
            markdown_file_entry(candidate)
                .ok_or_else(|| AppError::Io("Created Markdown file is unreadable".into()))
        }),
        SidebarEntryKind::Folder => create_directory_impl(&candidate.to_string_lossy()),
    }
}

fn create_sidebar_entry_with(
    parent_path: &Path,
    workspace_root: &Path,
    kind: SidebarEntryKind,
    mut create_candidate: impl FnMut(&Path, SidebarEntryKind) -> Result<DirEntry, AppError>,
) -> Result<DirEntry, AppError> {
    let root = workspace_root
        .canonicalize()
        .map_err(|error| AppError::Io(error.to_string()))?;
    let parent = parent_path
        .canonicalize()
        .map_err(|_| AppError::NotFound(parent_path.to_string_lossy().to_string()))?;
    if !parent.is_dir() || !parent.starts_with(&root) {
        return Err(AppError::InvalidPath(
            parent_path.to_string_lossy().to_string(),
        ));
    }

    let mut suffix = 1_u64;
    loop {
        let numbered = |base: &str| {
            if suffix == 1 {
                base.to_string()
            } else {
                format!("{base} {suffix}")
            }
        };
        let candidate = match kind {
            SidebarEntryKind::File => parent.join(format!("{}.md", numbered("Untitled"))),
            SidebarEntryKind::Folder => parent.join(numbered("Untitled Folder")),
        };
        let result = create_candidate(&candidate, kind);
        match result {
            Ok(entry) => return Ok(entry),
            Err(AppError::AlreadyExists(_)) => {
                suffix = suffix
                    .checked_add(1)
                    .ok_or_else(|| AppError::Io("Untitled name counter overflowed".into()))?;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
pub fn create_sidebar_entry_impl(
    parent_path: &Path,
    workspace_root: &Path,
    kind: SidebarEntryKind,
) -> Result<DirEntry, AppError> {
    create_sidebar_entry_with(parent_path, workspace_root, kind, create_sidebar_candidate)
}

fn create_sidebar_entry_for_snapshot(
    state: &WorkspaceState,
    parent_path: &Path,
    workspace_root: &Path,
    workspace_epoch: u64,
    kind: SidebarEntryKind,
) -> Result<DirEntry, AppError> {
    create_sidebar_entry_with(parent_path, workspace_root, kind, |candidate, kind| {
        state
            .with_workspace_snapshot(workspace_root, workspace_epoch, || {
                let live_root = workspace_root
                    .canonicalize()
                    .map_err(|error| AppError::Io(error.to_string()))?;
                if live_root != workspace_root {
                    return Err(AppError::InvalidPath(
                        "Workspace folder changed before the sidebar entry could be created".into(),
                    ));
                }
                let live_parent = parent_path
                    .canonicalize()
                    .map_err(|_| AppError::NotFound(parent_path.to_string_lossy().into_owned()))?;
                if !live_parent.is_dir() || !live_parent.starts_with(&live_root) {
                    return Err(AppError::InvalidPath(
                        parent_path.to_string_lossy().into_owned(),
                    ));
                }
                let file_name = candidate.file_name().ok_or_else(|| {
                    AppError::InvalidPath(candidate.to_string_lossy().into_owned())
                })?;
                create_sidebar_candidate(&live_parent.join(file_name), kind)
            })
            .ok_or_else(|| {
                AppError::InvalidPath(
                    "Workspace changed before the sidebar entry could be created".into(),
                )
            })?
    })
}

#[tauri::command]
pub async fn create_sidebar_entry(
    parent_path: String,
    kind: SidebarEntryKind,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<DirEntry, AppError> {
    let state = app.state::<AppState>().window(webview.label())?;
    let (root, epoch) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    blocking(move || {
        create_sidebar_entry_for_snapshot(&state, Path::new(&parent_path), &root, epoch, kind)
    })
    .await
}

/// Temp file in the same folder, flushed to disk, then renamed over
/// `target`. The temp name is unique, so two writers never rename each
/// other's half-written file into place. The data is synced before the
/// rename, so after a crash or power loss a reader sees the old file or the
/// complete new one, never an empty or torn one. The folder is synced after
/// the rename where the platform allows it, so the rename itself survives.
/// App-data stores (sync notes, queues, `mac-only.json`, `share-paths.json`)
/// and the hosted share copy write through this.
pub(crate) fn write_atomic(target: &Path, body: &[u8]) -> Result<(), AppError> {
    let dir = target
        .parent()
        .ok_or_else(|| AppError::InvalidPath(target.to_string_lossy().into_owned()))?;
    fs::create_dir_all(dir).map_err(|error| AppError::Io(error.to_string()))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        name.trim_start_matches('.'),
        uuid::Uuid::new_v4()
    ));
    let written = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(body)?;
        file.sync_all()?;
        fs::rename(&tmp, target)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Io(error.to_string()));
    }
    // Best effort: some filesystems refuse to sync a directory handle.
    #[cfg(unix)]
    if let Ok(folder) = fs::File::open(dir) {
        let _ = folder.sync_all();
    }
    Ok(())
}

/// Two paths that name one file on disk (a case-only rename on a case-insensitive volume).
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (a, b);
        false
    }
}

pub fn rename_entry_impl(old_path: &str, new_path: &str) -> Result<(), AppError> {
    let old = PathBuf::from(old_path);
    if !old.exists() {
        return Err(AppError::NotFound(old_path.to_string()));
    }
    let new = PathBuf::from(new_path);
    if new.exists() && !same_file(&old, &new) {
        return Err(AppError::AlreadyExists(new_path.to_string()));
    }
    fs::rename(old, new)?;
    Ok(())
}

#[tauri::command]
pub async fn rename_entry(
    app: tauri::AppHandle,
    old_path: String,
    new_path: String,
) -> Result<(), AppError> {
    let dir = app.path().app_data_dir().ok();
    let old = PathBuf::from(&old_path);
    let workspace = crate::commands::history::workspace_for(&app, &old);
    blocking(move || rename_carrying(dir.as_deref(), &old_path, &new_path, workspace.as_deref()))
        .await
}

/// Rename and carry the document's identity in all three stores.
/// - The share map is read first; one that cannot be read refuses the rename.
/// - "Keep on this Mac only" moves with the file. If that write fails, the
///   file moves back: a renamed kept document must not lose its protection.
/// - The sync id follows; a failure there is logged and the next save sends
///   the file as a new document.
///
/// A case-only rename (`notes.md` to `Notes.md` on a case-insensitive
/// volume) names the same file twice; `rename_entry_impl` allows it.
fn rename_carrying(
    home: Option<&Path>,
    old_path: &str,
    new_path: &str,
    workspace: Option<&Path>,
) -> Result<(), AppError> {
    let old = Path::new(old_path);
    let new = Path::new(new_path);
    let was_dir = old.is_dir();
    match home {
        Some(home) => crate::commands::shares::carry_share_rename(home, old, new, was_dir, || {
            rename_entry_impl(old_path, new_path)?;
            if let Err(err) = crate::mac_only::try_retarget(home, old, new, was_dir) {
                return Err(match fs::rename(new, old) {
                    Ok(()) => err,
                    Err(back) => {
                        AppError::Io(format!("{err}; the file stayed at the new name: {back}"))
                    }
                });
            }
            Ok(())
        })?,
        None => rename_entry_impl(old_path, new_path)?,
    }
    crate::commands::history::retarget_sync(old, new, workspace, was_dir);
    Ok(())
}

pub fn delete_entry_impl(path: &str) -> Result<(), AppError> {
    let entry_path = PathBuf::from(path);
    if !entry_path.exists() {
        return Err(AppError::NotFound(path.to_string()));
    }
    trash::delete(&entry_path).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

/// Local first, then online. A Trash that fails changes nothing online. The
/// shared-copy erase is queued when it fails and is replayed on the next desk
/// read. The history delete is queued before it is tried, signed in or not.
/// A shared-copy error after the Trash is still returned as the error.
#[tauri::command]
pub async fn delete_entry(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    match trash_then_erase(&app, path).await? {
        Some(cloud_error) => Err(cloud_error),
        None => Ok(()),
    }
}

/// What [`delete_entry_report`] did. An `Err` from it means the Trash failed
/// and nothing else ran, so `trashed` is always true here.
// Registered in `lib.rs`'s invoke handler by the rust-core package.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct DeleteReport {
    pub trashed: bool,
    /// The shared-copy erase failed after the Trash. It is queued and tried
    /// again on the next desk read.
    pub cloud_error: Option<String>,
}

/// Same steps as [`delete_entry`], with the two outcomes told apart.
#[allow(dead_code)]
#[tauri::command]
pub async fn delete_entry_report(
    app: tauri::AppHandle,
    path: String,
) -> Result<DeleteReport, AppError> {
    let cloud_error = trash_then_erase(&app, path).await?;
    Ok(DeleteReport {
        trashed: true,
        cloud_error: cloud_error.map(|error| error.to_string()),
    })
}

/// `Err`: the Trash failed and nothing else ran. `Ok(Some)`: the file is in
/// the Trash and the shared-copy erase failed (it is queued).
async fn trash_then_erase(
    app: &tauri::AppHandle,
    path: String,
) -> Result<Option<AppError>, AppError> {
    let workspace = crate::commands::history::workspace_for(app, Path::new(&path));
    trash_then_erase_in(app, path, workspace).await
}

/// [`trash_then_erase`] for a path whose workspace is known: a whole workspace
/// folder that no window has open is its own workspace.
pub(crate) async fn trash_then_erase_in(
    app: &tauri::AppHandle,
    path: String,
    workspace: Option<PathBuf>,
) -> Result<Option<AppError>, AppError> {
    let dir = app.path().app_data_dir().ok();
    let was_dir = Path::new(&path).is_dir();
    // Planned before the Trash, while the files are still there to list.
    let cloud = crate::share_paths::plan_cloud_delete(dir.as_deref(), Path::new(&path));
    let file = PathBuf::from(&path);
    let plan = crate::commands::history::deletion_plan(&file, workspace.as_deref());
    let home = dir.clone();
    let local_plan = plan.clone();
    let cloud = blocking(move || {
        trash_and_record(dir.as_deref(), &path, was_dir, &cloud, local_plan.as_ref())
    })
    .await?;
    let cloud_result =
        crate::commands::removal::apply_cloud_delete(app, home.as_deref(), &cloud).await;
    if let Some(plan) = plan {
        crate::commands::history::delete_from_history(app, home.as_deref(), &plan).await;
    }
    Ok(cloud_result.err())
}

/// The local half of a delete. After the Trash, and before any network wait,
/// both remote halves are written to their queues: the shared-copy erase
/// (`share-removal.txt`) and the history delete (`history-deletes`). A crash
/// or a quit during the requests then finishes them on the next desk read and
/// pull, instead of turning the erase into a soft-delete with a restore offer.
/// Each queue line is removed once its request lands.
///
/// Only an id this Mac stored for a real share is a confirmed erase. Any other
/// id may be a note that was never shared: it waits in the pending file
/// (`share-removal-pending.txt`) and is posted only once the share list names
/// it. The known ids are read after the Trash and before
/// `share_paths::forget` drops this document's record; no network read
/// happens before the Trash.
fn trash_and_record(
    home: Option<&Path>,
    path: &str,
    was_dir: bool,
    cloud: &crate::share_paths::CloudPlan,
    plan: Option<&crate::commands::history::DeletePlan>,
) -> Result<crate::commands::removal::CloudDelete, AppError> {
    delete_entry_impl(path)?;
    let Some(home) = home else {
        eprintln!("[delete] no app folder: the online copies are not queued");
        return Ok(crate::commands::removal::split_cloud_delete(
            cloud,
            &std::collections::HashSet::new(),
        ));
    };
    let known = crate::share_paths::known_share_ids(home);
    let cloud = crate::commands::removal::split_cloud_delete(cloud, &known);
    if let Err(err) = crate::commands::removal::record_cloud_delete(home, &cloud) {
        eprintln!("[delete] the shared-copy erase was not queued: {err}");
    }
    if let Some(plan) = plan {
        if let Err(err) = crate::commands::history::queue_delete_plan(home, plan) {
            eprintln!("[delete] the history delete was not queued: {err}");
        }
    }
    crate::mac_only::forget(home, Path::new(path));
    crate::share_paths::forget(home, Path::new(path), was_dir);
    Ok(cloud)
}

#[tauri::command]
pub async fn file_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || PathBuf::from(&path).exists())
        .await
        .unwrap_or(false)
}

pub fn reveal_in_file_manager_impl(path: &str) -> Result<(), AppError> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(AppError::NotFound(path.to_string()));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|e| AppError::Io(e.to_string()))?;
    }

    #[cfg(target_os = "windows")]
    {
        // `explorer /select,<path>` selects the file inside its parent. The
        // comma must be part of the same argument or Windows parses it as a
        // separator.
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map_err(|e| AppError::Io(e.to_string()))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux: just open the parent directory with xdg-open. There is no
        // portable way to select the target file.
        let parent = target.parent().unwrap_or(&target);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| AppError::Io(e.to_string()))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), AppError> {
    blocking(move || reveal_in_file_manager_impl(&path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        // Create some markdown files
        fs::write(dir.path().join("hello.md"), "# Hello").unwrap();
        fs::write(dir.path().join("world.md"), "# World").unwrap();
        // Create a non-markdown file (should be filtered)
        fs::write(dir.path().join("readme.txt"), "text").unwrap();
        // Create a subdirectory with markdown
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes").join("note.md"), "# Note").unwrap();
        // Create a subdirectory without markdown (should be filtered)
        fs::create_dir(dir.path().join("empty")).unwrap();
        fs::write(dir.path().join("empty").join("data.txt"), "data").unwrap();
        dir
    }

    #[test]
    fn test_read_directory_sorts_dirs_first() {
        let dir = setup_test_dir();
        let result = read_directory_impl(&dir.path().to_string_lossy(), None).unwrap();

        // First entry should be the dir (notes), then files
        assert!(result[0].is_dir);
        assert_eq!(result[0].name, "notes");
        assert!(result[0].title.is_none());
        // Remaining should be files, sorted alphabetically
        assert!(!result[1].is_dir);
        assert_eq!(result[1].name, "hello.md");
        assert_eq!(result[1].title.as_deref(), Some("Hello"));
        assert!(!result[2].is_dir);
        assert_eq!(result[2].name, "world.md");
        assert_eq!(result[2].title.as_deref(), Some("World"));
    }

    #[test]
    fn test_read_directory_includes_empty_folder_trees_but_filters_non_markdown_content() {
        let dir = setup_test_dir();
        fs::create_dir_all(dir.path().join("drafts").join("nested")).unwrap();
        fs::write(dir.path().join("drafts").join(".DS_Store"), "hidden").unwrap();
        let result = read_directory_impl(&dir.path().to_string_lossy(), None).unwrap();

        // `drafts/` is an empty folder tree and stays available for authoring.
        // `empty/` contains only a visible non-Markdown file and remains hidden.
        assert_eq!(result.len(), 4);
        assert!(result
            .iter()
            .any(|entry| entry.name == "drafts" && entry.is_dir));
        assert!(!result.iter().any(|entry| entry.name == "empty"));
        for entry in &result {
            assert!(entry.is_dir || entry.is_markdown);
        }
    }

    #[test]
    fn test_read_directory_uses_index_when_ready() {
        let dir = setup_test_dir();
        fs::create_dir_all(dir.path().join("drafts").join("nested")).unwrap();
        let state = WorkspaceState::default();

        // Build index
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (indexed, dirs) = crate::commands::search::index_workspace_impl(dir.path(), cancel);
        *state.file_index.write() = indexed;
        *state.dirs_with_markdown.write() = dirs;
        state.index_ready.store(true, Ordering::Relaxed);

        let result = read_directory_impl(&dir.path().to_string_lossy(), Some(&state)).unwrap();

        assert_eq!(result.len(), 4);
        assert!(result
            .iter()
            .any(|entry| entry.name == "drafts" && entry.is_dir));
        assert!(!result.iter().any(|entry| entry.name == "empty"));
        assert!(result[0].is_dir);
    }

    #[test]
    fn test_directory_visibility_surfaces_read_errors() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("missing");

        assert!(matches!(
            directory_is_sidebar_visible(&missing, None).unwrap_err(),
            AppError::Io(_)
        ));
    }

    fn indexed_file(root: &Path, name: &str, modified_at: u64) -> crate::state::IndexedFile {
        let path = root.join(name);
        crate::state::IndexedFile {
            path,
            relative_path: name.to_string(),
            name: name.to_string(),
            modified_at,
        }
    }

    #[test]
    fn test_read_recent_files_sorts_by_index_mtime_and_pages() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("old.md"), "# Old").unwrap();
        fs::write(dir.path().join("new.md"), "# New").unwrap();
        fs::write(dir.path().join("middle.md"), "# Middle").unwrap();
        let state = WorkspaceState::default();
        *state.file_index.write() = vec![
            indexed_file(dir.path(), "old.md", 1),
            indexed_file(dir.path(), "new.md", 3),
            indexed_file(dir.path(), "middle.md", 2),
        ];

        let first_page = read_recent_files_impl(&state, 2, 0);
        assert_eq!(
            first_page
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["new.md", "middle.md"]
        );

        let second_page = read_recent_files_impl(&state, 2, 2);
        assert_eq!(
            second_page
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["old.md"]
        );
    }

    #[test]
    fn test_read_recent_files_cache_invalidates_on_mtime_update() {
        let dir = TempDir::new().unwrap();
        let old_path = dir.path().join("old.md");
        fs::write(&old_path, "# Old").unwrap();
        fs::write(dir.path().join("new.md"), "# New").unwrap();
        let state = WorkspaceState::default();
        *state.file_index.write() = vec![
            indexed_file(dir.path(), "old.md", 1),
            indexed_file(dir.path(), "new.md", 2),
        ];

        let before = read_recent_files_impl(&state, 1, 0);
        assert_eq!(before[0].name, "new.md");

        state.update_index_modified_at(&old_path, 5);

        let after = read_recent_files_impl(&state, 1, 0);
        assert_eq!(after[0].name, "old.md");
    }

    #[test]
    fn test_read_file_entries_filters_missing_non_markdown_and_outside_root() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let kept = dir.path().join("kept.md");
        fs::write(&kept, "# Kept").unwrap();
        fs::write(dir.path().join("note.txt"), "not markdown").unwrap();
        fs::write(outside.path().join("outside.md"), "# Outside").unwrap();

        let entries = read_file_entries_impl(
            vec![
                kept.to_string_lossy().to_string(),
                dir.path().join("missing.md").to_string_lossy().to_string(),
                dir.path().join("note.txt").to_string_lossy().to_string(),
                outside
                    .path()
                    .join("outside.md")
                    .to_string_lossy()
                    .to_string(),
            ],
            dir.path(),
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "kept.md");
    }

    #[test]
    fn test_read_file_returns_content() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.md");
        fs::write(&path, "# Test Content").unwrap();

        let result = read_file_impl(&path.to_string_lossy()).unwrap();
        assert_eq!(result.content, "# Test Content");
    }

    #[test]
    fn test_read_file_not_found() {
        let result = read_file_impl("/nonexistent/file.md");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    #[test]
    fn test_write_file_atomic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("output.md");
        fs::write(&path, "old").unwrap();

        let result = write_file_impl(&path.to_string_lossy(), "new content").unwrap();
        assert_eq!(result.path, path.to_string_lossy().to_string());

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "new content");
    }

    #[cfg(unix)]
    #[test]
    fn a_save_keeps_the_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("private.md");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        write_file_impl(&path.to_string_lossy(), "new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_save_writes_through_a_symlink() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new().unwrap();
        let real = dir.path().join("real.md");
        let link = dir.path().join("link.md");
        fs::write(&real, "old").unwrap();
        symlink(&real, &link).unwrap();

        write_file_impl(&link.to_string_lossy(), "new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn a_save_does_not_follow_a_link_out_of_its_folder() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new().unwrap();
        let notes = dir.path().join("notes");
        fs::create_dir(&notes).unwrap();
        let outside = dir.path().join("outside.md");
        fs::write(&outside, "keep me").unwrap();
        let link = notes.join("link.md");
        symlink("../outside.md", &link).unwrap();

        let err = write_file_impl(&link.to_string_lossy(), "new").unwrap_err();

        assert_eq!(
            err.to_string(),
            "This note is a link to a file outside its folder, so Alkuin won't save through it."
        );
        assert_eq!(fs::read_to_string(&outside).unwrap(), "keep me");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn a_save_writes_through_a_link_to_a_file_below_its_folder() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let real = dir.path().join("sub/real.md");
        fs::write(&real, "old").unwrap();
        let link = dir.path().join("link.md");
        symlink("sub/real.md", &link).unwrap();

        write_file_impl(&link.to_string_lossy(), "new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_save_leaves_no_temp_file() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("target.md");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("child.md"), "x").unwrap();

        let result = write_file_impl(&target.to_string_lossy(), "new");

        assert!(result.is_err());
        let leaked: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".~"))
            .collect();
        assert!(leaked.is_empty(), "leaked temp files: {leaked:?}");
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_save_over_the_text_the_editor_last_saw_writes_no_other_copy() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "first").unwrap();

        let result =
            write_file_expecting(&path.to_string_lossy(), "second", Some("first"), None).unwrap();

        assert_eq!(result.other_copy, None);
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(names_in(dir.path()), ["notes.md"]);
    }

    #[test]
    fn a_save_over_a_file_that_changed_keeps_the_writers_words_and_the_other_version_beside_it() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "first").unwrap();
        // Another Mac, another window, or another program wrote the file while the
        // editor still held "first" plus the writer's typing.
        fs::write(&path, "from the other Mac").unwrap();

        let result = write_file_expecting(
            &path.to_string_lossy(),
            "first, typed on",
            Some("first"),
            None,
        )
        .unwrap();

        let copy = dir.path().join("notes (other copy).md");
        assert_eq!(result.other_copy.as_deref(), copy.to_str());
        assert_eq!(fs::read_to_string(&copy).unwrap(), "from the other Mac");
        assert_eq!(fs::read_to_string(&path).unwrap(), "first, typed on");

        // The next save knows what it wrote, so there is no second copy.
        let next = write_file_expecting(
            &path.to_string_lossy(),
            "first, typed on, and on",
            Some("first, typed on"),
            None,
        )
        .unwrap();
        assert_eq!(next.other_copy, None);
        assert_eq!(names_in(dir.path()), ["notes (other copy).md", "notes.md"]);
    }

    #[test]
    fn a_second_changed_version_does_not_replace_the_first_other_copy() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "one outside edit").unwrap();
        write_file_expecting(&path.to_string_lossy(), "mine", Some("base"), None).unwrap();
        fs::write(&path, "another outside edit").unwrap();

        let result =
            write_file_expecting(&path.to_string_lossy(), "mine again", Some("mine"), None)
                .unwrap();

        let second = dir.path().join("notes (other copy 2).md");
        assert_eq!(result.other_copy.as_deref(), second.to_str());
        assert_eq!(
            fs::read_to_string(dir.path().join("notes (other copy).md")).unwrap(),
            "one outside edit"
        );
        assert_eq!(fs::read_to_string(&second).unwrap(), "another outside edit");
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine again");
    }

    #[test]
    fn a_save_that_finds_its_own_words_or_no_file_writes_no_other_copy() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        // Deleted outside. The save writes it back, as before.
        let result =
            write_file_expecting(&path.to_string_lossy(), "words", Some("old"), None).unwrap();
        assert_eq!(result.other_copy, None);
        // The file already holds exactly what is being saved.
        let again =
            write_file_expecting(&path.to_string_lossy(), "words", Some("old"), None).unwrap();
        assert_eq!(again.other_copy, None);
        assert_eq!(names_in(dir.path()), ["notes.md"]);
    }

    #[test]
    fn a_write_with_no_expected_text_does_not_look() {
        // Writers of a new file (duplicate, import) send no `expected`. A save always does.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "from somewhere else").unwrap();

        let result = write_file_impl(&path.to_string_lossy(), "new").unwrap();

        assert_eq!(result.other_copy, None);
        assert_eq!(names_in(dir.path()), ["notes.md"]);
    }

    #[test]
    fn every_different_outside_edit_gets_its_own_copy_and_a_repeated_one_does_not() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        let file = path.to_string_lossy().into_owned();
        // Each save sends what the previous one wrote, as `save.ts` does.
        fs::write(&path, "dropbox").unwrap();
        let first = write_file_expecting(&file, "mine 1", Some("base"), None).unwrap();
        fs::write(&path, "git").unwrap();
        let second = write_file_expecting(&file, "mine 2", Some("mine 1"), None).unwrap();
        // A formatter that writes the same bytes after every save.
        fs::write(&path, "formatted").unwrap();
        let third = write_file_expecting(&file, "mine 3", Some("mine 2"), None).unwrap();
        fs::write(&path, "formatted").unwrap();
        let fourth = write_file_expecting(&file, "mine 4", Some("mine 3"), None).unwrap();

        let copy = |name: &str| dir.path().join(name);
        assert_eq!(
            first.other_copy.as_deref(),
            copy("notes (other copy).md").to_str()
        );
        assert_eq!(
            second.other_copy.as_deref(),
            copy("notes (other copy 2).md").to_str()
        );
        assert_eq!(
            third.other_copy.as_deref(),
            copy("notes (other copy 3).md").to_str()
        );
        // Those bytes are already kept beside the file, so no fourth copy.
        assert_eq!(fourth.other_copy, None);
        assert_eq!(
            [
                "notes (other copy).md",
                "notes (other copy 2).md",
                "notes (other copy 3).md"
            ]
            .map(|name| fs::read_to_string(copy(name)).unwrap()),
            ["dropbox", "git", "formatted"]
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine 4");
        assert_eq!(
            names_in(dir.path()),
            [
                "notes (other copy 2).md",
                "notes (other copy 3).md",
                "notes (other copy).md",
                "notes.md"
            ]
        );
    }

    #[test]
    fn a_copy_deleted_since_does_not_count_as_kept() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        let file = path.to_string_lossy().into_owned();
        fs::write(&path, "outside").unwrap();
        let first = write_file_expecting(&file, "mine", Some("base"), None).unwrap();
        fs::remove_file(first.other_copy.unwrap()).unwrap();
        fs::write(&path, "outside").unwrap();

        let again = write_file_expecting(&file, "mine again", Some("mine"), None).unwrap();

        let copy = PathBuf::from(again.other_copy.unwrap());
        assert_eq!(fs::read_to_string(copy).unwrap(), "outside");
    }

    #[test]
    fn a_replace_that_fails_leaves_no_copy_however_often_it_is_retried() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("locked.md");
        let file = path.to_string_lossy().into_owned();
        fs::write(&path, "outside").unwrap();
        let refuse = |_: &Path, _: &Path| -> std::io::Result<()> {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        };

        for _ in 0..3 {
            let result = write_file_with(&file, "mine", Some("base"), None, &refuse, &|| {});
            assert!(result.is_err());
        }

        // The file still holds the outside words, and nothing else was left behind.
        assert_eq!(fs::read_to_string(&path).unwrap(), "outside");
        assert_eq!(names_in(dir.path()), ["locked.md"]);
    }

    #[test]
    fn a_failed_replace_takes_back_the_kept_mark_of_its_copy() {
        let home = TempDir::new().unwrap();
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("private.md");
        fs::write(&path, "outside").unwrap();
        crate::mac_only::set_stays_on_this_mac(home.path(), &path, true).unwrap();
        let refuse = |_: &Path, _: &Path| -> std::io::Result<()> {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        };

        let result = write_file_with(
            &path.to_string_lossy(),
            "mine",
            Some("base"),
            Some(home.path()),
            &refuse,
            &|| {},
        );

        assert!(result.is_err());
        assert_eq!(names_in(dir.path()), ["private.md"]);
        let kept = crate::mac_only::MacOnlySet::load(home.path());
        assert_eq!(kept.paths().len(), 1, "{:?}", kept.paths());
        assert!(kept.blocks(&path));
    }

    #[test]
    fn a_version_written_while_the_copy_is_made_gets_its_own_copy() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "outside 1").unwrap();
        let rounds = std::cell::Cell::new(0);
        let during_copy = || {
            rounds.set(rounds.get() + 1);
            if rounds.get() == 1 {
                fs::write(&path, "outside 2").unwrap();
            }
        };

        let result = write_file_with(
            &path.to_string_lossy(),
            "mine",
            Some("base"),
            None,
            &|from, to| fs::rename(from, to),
            &during_copy,
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
        let second = dir.path().join("notes (other copy 2).md");
        assert_eq!(result.other_copy.as_deref(), second.to_str());
        assert_eq!(
            fs::read_to_string(dir.path().join("notes (other copy).md")).unwrap(),
            "outside 1"
        );
        assert_eq!(fs::read_to_string(&second).unwrap(), "outside 2");
    }

    #[test]
    fn a_file_that_changes_every_round_is_not_replaced_and_keeps_every_version() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "outside 0").unwrap();
        let rounds = std::cell::Cell::new(0);
        let always = || {
            rounds.set(rounds.get() + 1);
            fs::write(&path, format!("outside {}", rounds.get())).unwrap();
        };

        let result = write_file_with(
            &path.to_string_lossy(),
            "mine",
            Some("base"),
            None,
            &|from, to| fs::rename(from, to),
            &always,
        );

        assert!(result.is_err());
        // The newest outside words are still in the file, and each earlier version is in
        // a copy, because the file no longer holds it. The temp file is gone.
        assert_eq!(fs::read_to_string(&path).unwrap(), "outside 3");
        assert_eq!(
            names_in(dir.path()),
            [
                "notes (other copy 2).md",
                "notes (other copy 3).md",
                "notes (other copy).md",
                "notes.md"
            ]
        );
    }

    #[test]
    fn with_every_numbered_name_taken_the_outside_words_still_get_a_copy() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        // Copies from earlier runs, or a program that writes new bytes after every save.
        fs::write(dir.path().join("notes (other copy).md"), "old").unwrap();
        for count in 2..=99 {
            fs::write(
                dir.path().join(format!("notes (other copy {count}).md")),
                "old",
            )
            .unwrap();
        }
        fs::write(&path, "outside words").unwrap();

        let result =
            write_file_expecting(&path.to_string_lossy(), "mine", Some("base"), None).unwrap();

        let copy = PathBuf::from(result.other_copy.unwrap());
        let name = copy.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("notes (other copy "), "{name}");
        assert_eq!(name.len(), "notes (other copy 12345678).md".len(), "{name}");
        assert_eq!(fs::read_to_string(&copy).unwrap(), "outside words");
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
        assert_eq!(names_in(dir.path()).len(), 101);
    }

    #[test]
    fn a_save_that_copies_twice_returns_both_copies() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "outside 1").unwrap();
        let rounds = std::cell::Cell::new(0);
        let once = || {
            rounds.set(rounds.get() + 1);
            if rounds.get() == 1 {
                fs::write(&path, "outside 2").unwrap();
            }
        };

        let result = write_file_with(
            &path.to_string_lossy(),
            "mine",
            Some("base"),
            None,
            &|from, to| fs::rename(from, to),
            &once,
        )
        .unwrap();

        let copy = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        assert_eq!(
            result.other_copies,
            [
                copy("notes (other copy).md"),
                copy("notes (other copy 2).md")
            ]
        );
        assert_eq!(
            result.other_copy.as_deref(),
            Some(copy("notes (other copy 2).md").as_str())
        );
    }

    #[test]
    fn a_save_that_gave_up_names_the_copies_it_left() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "outside 0").unwrap();
        let rounds = std::cell::Cell::new(0);
        let always = || {
            rounds.set(rounds.get() + 1);
            fs::write(&path, format!("outside {}", rounds.get())).unwrap();
        };

        let error = write_file_with(
            &path.to_string_lossy(),
            "mine",
            Some("base"),
            None,
            &|from, to| fs::rename(from, to),
            &always,
        )
        .unwrap_err();

        let AppError::Message(line) = error else {
            panic!("{error:?}");
        };
        // Copy's wording, word for word.
        assert_eq!(
            line,
            "This document kept changing outside Alkuin, so it couldn't be saved yet. The outside changes are saved as notes (other copy).md, notes (other copy 2).md, notes (other copy 3).md. Alkuin will try again."
        );

        // With no copy left to name, the line says only that.
        let AppError::Message(plain) =
            name_kept_copies(AppError::Message(KEPT_CHANGING.into()), &[])
        else {
            panic!("the kept-changing error changed its kind");
        };
        assert_eq!(
            plain,
            "This document kept changing outside Alkuin, so it couldn't be saved yet. Alkuin will try again."
        );
    }

    #[test]
    fn a_file_remembers_its_newest_copies_and_forgets_deleted_ones() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("notes.md");
        let copies: Vec<PathBuf> = (0..KEPT_COPIES_PER_FILE + 5)
            .map(|index| {
                let copy = dir.path().join(format!("copy {index}.md"));
                fs::write(&copy, format!("bytes {index}")).unwrap();
                remember_copy(&file, &copy);
                copy
            })
            .collect();
        let listed = || kept_copies().get(&file).cloned().unwrap_or_default();
        assert_eq!(listed(), copies[5..]);

        // Only the newest are compared.
        assert!(!already_kept(&file, b"bytes 0"));
        assert!(already_kept(&file, b"bytes 24"));
        // A copy deleted since is forgotten when the list is read.
        fs::remove_file(&copies[24]).unwrap();
        assert!(!already_kept(&file, b"bytes 24"));
        assert_eq!(listed(), copies[5..24]);
    }

    #[cfg(unix)]
    #[test]
    fn the_other_copy_of_a_private_note_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("private.md");
        fs::write(&path, "outside").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        let result =
            write_file_expecting(&path.to_string_lossy(), "mine", Some("base"), None).unwrap();

        let copy = PathBuf::from(result.other_copy.unwrap());
        let mode = fs::metadata(&copy).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    /// The mode is set when the file is created, before any text is written, so the
    /// staged text is never readable by others (a later chmod would leave a window).
    #[cfg(unix)]
    #[test]
    fn a_staged_file_is_created_with_the_notes_mode_before_any_text_is_written() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let temp = dir.path().join(".~staged");

        let file = create_copy_file(&temp, Some(&fs::Permissions::from_mode(0o600))).unwrap();

        let mode = file.metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
    }

    #[test]
    fn the_other_version_of_a_document_kept_on_this_mac_is_kept_too() {
        let home = TempDir::new().unwrap();
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("private.md");
        fs::write(&path, "from the other window").unwrap();
        crate::mac_only::set_stays_on_this_mac(home.path(), &path, true).unwrap();

        let result = write_file_expecting(
            &path.to_string_lossy(),
            "mine",
            Some("base"),
            Some(home.path()),
        )
        .unwrap();

        let copy = PathBuf::from(result.other_copy.unwrap());
        let kept = crate::mac_only::MacOnlySet::load(home.path());
        assert!(kept.blocks(&copy), "the other copy is not kept");
        assert!(kept.blocks(&path));
        assert_eq!(fs::read_to_string(&copy).unwrap(), "from the other window");
    }

    #[test]
    fn a_kept_document_is_not_replaced_when_its_other_version_cannot_be_marked_kept() {
        let home = TempDir::new().unwrap();
        // The list of kept documents cannot be read, so nothing can be added to it.
        fs::write(home.path().join("mac-only.json"), "not a list").unwrap();
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("private.md");
        fs::write(&path, "from the other window").unwrap();

        let result = write_file_expecting(
            &path.to_string_lossy(),
            "mine",
            Some("base"),
            Some(home.path()),
        );

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "from the other window");
        assert_eq!(names_in(dir.path()), ["private.md"]);
    }

    #[test]
    fn a_changed_file_that_is_not_text_is_kept_byte_for_byte() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.md");
        let latin1 = [b'c', b'a', b'f', 0xE9];
        fs::write(&path, latin1).unwrap();

        let result =
            write_file_expecting(&path.to_string_lossy(), "mine", Some("base"), None).unwrap();

        let copy = PathBuf::from(result.other_copy.unwrap());
        assert_eq!(fs::read(&copy).unwrap(), latin1);
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
    }

    #[test]
    fn a_long_file_name_still_gets_its_other_copy() {
        let dir = TempDir::new().unwrap();
        // 125 two-byte letters: 253 bytes with the extension, which the disk takes. The
        // copy's name would be 14 bytes longer than the disk allows.
        let name = format!("{}.md", "\u{e9}".repeat(125));
        let path = dir.path().join(&name);
        fs::write(&path, "from the other Mac").unwrap();

        let result =
            write_file_expecting(&path.to_string_lossy(), "mine", Some("base"), None).unwrap();

        let copy = PathBuf::from(result.other_copy.unwrap());
        let copy_name = copy.file_name().unwrap().to_string_lossy().into_owned();
        assert!(copy_name.len() <= 255, "{}", copy_name.len());
        assert!(copy_name.ends_with(" (other copy).md"), "{copy_name}");
        assert!(copy_name.starts_with('\u{e9}'), "{copy_name}");
        assert_eq!(fs::read_to_string(&copy).unwrap(), "from the other Mac");
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
    }

    #[test]
    fn test_create_file_already_exists() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("exists.md");
        fs::write(&path, "do not overwrite").unwrap();

        let result = create_file_impl(&path.to_string_lossy());
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::AlreadyExists(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "do not overwrite");
    }

    #[test]
    fn test_create_directory_already_exists() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("exists");
        fs::create_dir(&path).unwrap();

        let result = create_directory_impl(&path.to_string_lossy());
        assert!(matches!(result.unwrap_err(), AppError::AlreadyExists(_)));
    }

    #[test]
    fn test_create_sidebar_entry_retries_collisions_without_overwriting() {
        let dir = TempDir::new().unwrap();
        let existing = dir.path().join("Untitled.md");
        fs::write(&existing, "existing content").unwrap();

        let created =
            create_sidebar_entry_impl(dir.path(), dir.path(), SidebarEntryKind::File).unwrap();

        assert_eq!(created.name, "Untitled 2.md");
        assert_eq!(fs::read_to_string(existing).unwrap(), "existing content");
        assert_eq!(fs::read_to_string(created.path).unwrap(), "# ");
    }

    #[test]
    fn test_create_sidebar_entry_has_no_999_name_ceiling() {
        let dir = TempDir::new().unwrap();
        for suffix in 1..1000 {
            let name = if suffix == 1 {
                "Untitled.md".to_string()
            } else {
                format!("Untitled {suffix}.md")
            };
            fs::write(dir.path().join(name), "occupied").unwrap();
        }

        let created =
            create_sidebar_entry_impl(dir.path(), dir.path(), SidebarEntryKind::File).unwrap();

        assert_eq!(created.name, "Untitled 1000.md");
    }

    #[test]
    fn test_create_sidebar_folder_retries_collisions() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("Untitled Folder")).unwrap();

        let created =
            create_sidebar_entry_impl(dir.path(), dir.path(), SidebarEntryKind::Folder).unwrap();

        assert_eq!(created.name, "Untitled Folder 2");
    }

    #[test]
    fn test_create_sidebar_entry_rejects_parent_outside_workspace() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();

        let result =
            create_sidebar_entry_impl(outside.path(), workspace.path(), SidebarEntryKind::Folder);

        assert!(result.is_err());
    }

    #[test]
    fn sidebar_entry_kind_serialization_matches_the_shared_contract() {
        let contract: std::collections::HashMap<String, bool> =
            serde_json::from_str(include_str!("../../../shared/sidebar-entry-kinds.json")).unwrap();
        let serialized = SidebarEntryKind::ALL
            .iter()
            .copied()
            .map(|kind| {
                serde_json::to_value(kind)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(
            serialized,
            contract
                .into_keys()
                .collect::<std::collections::HashSet<_>>()
        );
    }

    #[test]
    fn create_sidebar_entry_rejects_stale_workspace_before_mutation() {
        let workspace = TempDir::new().unwrap();
        let replacement = TempDir::new().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let state = WorkspaceState::default();
        let epoch = state.replace_workspace_root(root.clone());
        state.replace_workspace_root(replacement.path().canonicalize().unwrap());

        assert!(matches!(
            create_sidebar_entry_for_snapshot(&state, &root, &root, epoch, SidebarEntryKind::File,)
                .unwrap_err(),
            AppError::InvalidPath(_)
        ));
        assert!(!root.join("Untitled.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn create_sidebar_entry_rejects_a_replaced_workspace_root() {
        use std::os::unix::fs::symlink;

        let parent = TempDir::new().unwrap();
        let workspace_path = parent.path().join("workspace");
        fs::create_dir(&workspace_path).unwrap();
        let root = workspace_path.canonicalize().unwrap();
        let state = WorkspaceState::default();
        let epoch = state.replace_workspace_root(root.clone());

        fs::rename(&workspace_path, parent.path().join("moved-workspace")).unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), &workspace_path).unwrap();

        assert!(matches!(
            create_sidebar_entry_for_snapshot(
                &state,
                &workspace_path,
                &root,
                epoch,
                SidebarEntryKind::File,
            )
            .unwrap_err(),
            AppError::InvalidPath(_)
        ));
        assert!(!outside.path().join("Untitled.md").exists());
    }

    #[test]
    fn test_delete_entry_moves_to_trash() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("to_delete.md");
        fs::write(&path, "delete me").unwrap();
        assert!(path.exists());

        delete_entry_impl(&path.to_string_lossy()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn test_rename_entry() {
        let dir = TempDir::new().unwrap();
        let old_path = dir.path().join("old.md");
        let new_path = dir.path().join("new.md");
        fs::write(&old_path, "content").unwrap();

        rename_entry_impl(&old_path.to_string_lossy(), &new_path.to_string_lossy()).unwrap();

        assert!(!old_path.exists());
        assert!(new_path.exists());
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "content");
    }

    #[cfg(unix)]
    #[test]
    fn same_file_is_true_for_two_names_of_one_inode() {
        let dir = TempDir::new().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        let c = dir.path().join("c.md");
        fs::write(&a, "x").unwrap();
        fs::hard_link(&a, &b).unwrap();
        fs::write(&c, "x").unwrap();
        assert!(same_file(&a, &b));
        assert!(!same_file(&a, &c));
        assert!(!same_file(&a, &dir.path().join("missing.md")));
    }

    #[cfg(unix)]
    #[test]
    fn renaming_onto_another_file_is_still_refused() {
        let dir = TempDir::new().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let result = rename_entry_impl(&a.to_string_lossy(), &b.to_string_lossy());
        assert!(matches!(result.unwrap_err(), AppError::AlreadyExists(_)));
        assert_eq!(fs::read_to_string(&a).unwrap(), "a");
        assert_eq!(fs::read_to_string(&b).unwrap(), "b");
    }

    // Needs a case-insensitive volume (the macOS default); cannot run on Linux.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_case_only_rename_works() {
        let dir = TempDir::new().unwrap();
        let old = dir.path().join("notes.md");
        let new = dir.path().join("Notes.md");
        fs::write(&old, "x").unwrap();
        rename_entry_impl(&old.to_string_lossy(), &new.to_string_lossy()).unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["Notes.md".to_string()]);
    }

    #[test]
    fn a_rename_carries_the_share_id_the_kept_mark_and_the_sync_id() {
        let dir = setup_test_dir();
        let home = TempDir::new().unwrap();
        let old = dir.path().join("hello.md");
        let new = dir.path().join("renamed.md");
        crate::share_paths::bind_document_id(home.path(), &old, "server-doc");
        crate::mac_only::set_kept(home.path(), &old, true).unwrap();
        fs::write(
            dir.path().join(".alkuin-sync.json"),
            r#"{"projectId":"p","documents":{"hello.md":{"id":"doc-1"}}}"#,
        )
        .unwrap();
        rename_carrying(
            Some(home.path()),
            old.to_str().unwrap(),
            new.to_str().unwrap(),
            Some(dir.path()),
        )
        .unwrap();
        assert!(new.is_file());
        assert_eq!(
            crate::commands::shares::share_document_id(Some(home.path()), &new),
            "server-doc"
        );
        assert!(crate::mac_only::MacOnlySet::load(home.path()).blocks(&new));
        let book = fs::read_to_string(dir.path().join(".alkuin-sync.json")).unwrap();
        assert!(
            book.contains("renamed.md") && !book.contains("hello.md"),
            "{book}"
        );
    }

    #[test]
    fn an_atomic_write_replaces_the_file_and_leaves_no_temp() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("store.json");
        write_atomic(&target, b"first").unwrap();
        write_atomic(&target, b"second").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["store.json".to_string()]);
    }

    #[test]
    fn a_delete_queues_both_online_steps_before_any_request() {
        let dir = setup_test_dir();
        let home = TempDir::new().unwrap();
        let file = dir.path().join("hello.md");
        fs::write(
            dir.path().join(".alkuin-sync.json"),
            r#"{"projectId":"p","documents":{"hello.md":{"id":"doc-1"}}}"#,
        )
        .unwrap();
        let cloud = crate::share_paths::plan_cloud_delete(Some(home.path()), &file);
        let plan = crate::commands::history::deletion_plan(&file, Some(dir.path())).unwrap();
        trash_and_record(
            Some(home.path()),
            file.to_str().unwrap(),
            false,
            &cloud,
            Some(&plan),
        )
        .unwrap();
        assert!(!file.exists());
        // This Mac has no share record for the note, so its erase waits for
        // the share list instead of being posted.
        let erase = fs::read_to_string(home.path().join("share-removal-pending.txt")).unwrap();
        assert!(erase.starts_with("erase?\t"), "{erase}");
        assert!(!home.path().join("share-removal.txt").exists());
        assert_eq!(
            fs::read_to_string(home.path().join("history-deletes")).unwrap(),
            "p\tdoc-1\n"
        );
    }

    #[test]
    fn a_delete_of_a_known_share_queues_a_confirmed_erase() {
        let dir = setup_test_dir();
        let home = TempDir::new().unwrap();
        let file = dir.path().join("hello.md");
        crate::share_paths::bind_document_id(home.path(), &file, "server-doc");
        let cloud = crate::share_paths::plan_cloud_delete(Some(home.path()), &file);
        let recorded = trash_and_record(
            Some(home.path()),
            file.to_str().unwrap(),
            false,
            &cloud,
            None,
        )
        .unwrap();
        assert_eq!(
            recorded,
            crate::commands::removal::split_cloud_delete(
                &crate::share_paths::CloudPlan::Erase(vec!["server-doc".into()]),
                &["server-doc".to_string()].into(),
            )
        );
        assert_eq!(
            fs::read_to_string(home.path().join("share-removal.txt")).unwrap(),
            "erase\tserver-doc"
        );
        // The record is read before the share map forgets the document.
        assert!(!crate::share_paths::known_share_ids(home.path()).contains("server-doc"));
    }

    #[test]
    fn a_rename_with_an_unreadable_share_map_moves_nothing() {
        let dir = setup_test_dir();
        let home = TempDir::new().unwrap();
        fs::write(home.path().join("share-paths.json"), "not-json").unwrap();
        let old = dir.path().join("hello.md");
        let new = dir.path().join("renamed.md");
        let error = rename_carrying(
            Some(home.path()),
            old.to_str().unwrap(),
            new.to_str().unwrap(),
            None,
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            crate::commands::shares::SHARE_LIST_UNREADABLE
        );
        assert!(old.is_file());
        assert!(!new.exists());
    }

    #[test]
    fn test_rename_entry_not_found() {
        let result = rename_entry_impl("/nonexistent/old.md", "/nonexistent/new.md");
        assert!(matches!(result.unwrap_err(), AppError::NotFound(_)));
    }

    #[test]
    fn test_rename_entry_already_exists() {
        let dir = TempDir::new().unwrap();
        let old_path = dir.path().join("old.md");
        let new_path = dir.path().join("new.md");
        fs::write(&old_path, "old").unwrap();
        fs::write(&new_path, "new").unwrap();

        let result = rename_entry_impl(&old_path.to_string_lossy(), &new_path.to_string_lossy());
        assert!(matches!(result.unwrap_err(), AppError::AlreadyExists(_)));
    }

    #[test]
    fn test_error_serializes() {
        let err = AppError::Io("test error".to_string());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"IO error: test error\"");

        let err = AppError::NotFound("file.md".to_string());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"Not found: file.md\"");

        let err = AppError::NoWorkspace;
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"No workspace is open\"");
    }

    #[test]
    fn test_extract_title_strips_inline_marks() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "# *Title* and **bold** and _note_ and `code`\n").unwrap();
        assert_eq!(
            extract_title(&path).as_deref(),
            Some("Title and bold and note and code")
        );
        fs::write(&path, "# snake_case stays\n").unwrap();
        assert_eq!(extract_title(&path).as_deref(), Some("snake_case stays"));
    }

    fn test_extract_title_from_h1() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "# My Document\n\nSome content").unwrap();
        assert_eq!(extract_title(&path).as_deref(), Some("My Document"));
    }

    #[test]
    fn test_extract_title_from_frontmatter() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "---\ntitle: Front Title\n---\n\nBody").unwrap();
        assert_eq!(extract_title(&path).as_deref(), Some("Front Title"));
    }

    #[test]
    fn test_extract_title_frontmatter_quoted() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "---\ntitle: \"Quoted Title\"\n---\n\nBody").unwrap();
        assert_eq!(extract_title(&path).as_deref(), Some("Quoted Title"));
    }

    #[test]
    fn test_extract_title_frontmatter_beats_h1() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "---\ntitle: FM Title\n---\n\n# Heading").unwrap();
        assert_eq!(extract_title(&path).as_deref(), Some("FM Title"));
    }

    #[test]
    fn test_extract_title_h1_after_empty_frontmatter() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "---\ndate: 2025-01-01\n---\n\n# Fallback Heading").unwrap();
        assert_eq!(extract_title(&path).as_deref(), Some("Fallback Heading"));
    }

    #[test]
    fn test_extract_title_none_for_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "").unwrap();
        assert_eq!(extract_title(&path), None);
    }

    #[test]
    fn test_extract_title_none_when_no_heading() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "Just a paragraph.\nAnother line.").unwrap();
        assert_eq!(extract_title(&path), None);
    }

    #[test]
    fn test_workspace_state_default() {
        let state = WorkspaceState::default();
        assert!(state.workspace_root.read().is_none());
        assert!(state.file_index.read().is_empty());
        assert!(state.dirs_with_markdown.read().is_empty());
        assert!(!state.index_ready.load(Ordering::Relaxed));
        assert!(state.watcher_handle.read().is_none());
    }
}
