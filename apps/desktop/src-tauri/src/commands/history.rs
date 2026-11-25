//! Upload a remembered version, and bring the other version back.
//!
//! The mark that keeps a document on this Mac is `mac-only.json`.
//! The upload runs only inside [`depart`](crate::mac_only::depart).
//! The bearer is the signed-in session. There is no shared history password.
//! The base URL is compiled in (`ALKUIN_HISTORY_URL`). It is not a process variable.

use crate::commands::fs::{create_copy_file, write_atomic};
use crate::error::AppError;
use crate::mac_only::{canon, canon_parent, depart, set_stays_on_this_mac, Channel, MacOnlySet};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

const OUTBOX: &str = "history-outbox";
const DELETE_OUTBOX: &str = "history-deletes";
/// Accepts and rejects of suggested additions that the server has not heard yet.
const PROPOSAL_OUTBOX: &str = "history-proposal-decisions";
/// Hidden notes for this folder. The ids inside are random, not the disk path.
const SYNC_FILE: &str = ".alkuin-sync.json";
/// How often the desk asks for the other Mac's copy.
/// The timer in `use-git-queue.ts` uses this same count.
#[allow(dead_code)]
pub const PULL_EVERY_MS: u64 = 3 * 60 * 1000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SendOutcome {
    pub sent: bool,
    pub waiting: bool,
    pub refused: bool,
    pub unconfigured: bool,
    pub conflict: bool,
    pub deleted: bool,
    pub other_text: Option<String>,
    pub local_text: Option<String>,
    pub version_id: Option<String>,
    /// The server refused this version for good. It is not queued again.
    pub stopped: bool,
    /// The file is gone. Nothing was uploaded and nothing stays queued.
    pub missing: bool,
}

/// What one send did. [`SendOutcome`] is its wire shape for the frontend.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Sent {
    Stored,
    /// Offline, or the server asked to wait. The document is in the outbox.
    Waiting,
    /// Kept on this Mac, or the destination is refused. Not queued.
    Refused,
    /// No destination, or not signed in. Not queued.
    Unconfigured,
    /// The server did not take this session (401/403). A queued line stays.
    Held,
    /// The server refused this version for good. Its queued line is dropped.
    Stopped,
    /// The file is gone. Nothing is uploaded and its queued line is dropped.
    Missing,
    /// The server holds a version this Mac has not seen.
    Conflict {
        other_text: String,
        local_text: String,
        deleted: bool,
        version_id: String,
    },
}

impl Sent {
    fn wire(self) -> SendOutcome {
        let mut out = SendOutcome {
            sent: false,
            waiting: false,
            refused: false,
            unconfigured: false,
            conflict: false,
            deleted: false,
            other_text: None,
            local_text: None,
            version_id: None,
            stopped: false,
            missing: false,
        };
        match self {
            Sent::Stored => out.sent = true,
            Sent::Waiting => out.waiting = true,
            Sent::Refused => out.refused = true,
            Sent::Unconfigured => out.unconfigured = true,
            Sent::Held => {}
            Sent::Stopped => out.stopped = true,
            Sent::Missing => out.missing = true,
            Sent::Conflict {
                other_text,
                local_text,
                deleted,
                version_id,
            } => {
                out.conflict = true;
                out.deleted = deleted;
                out.other_text = Some(other_text);
                out.local_text = Some(local_text);
                out.version_id = Some(version_id);
            }
        }
        out
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BringOutcome {
    pub path: String,
    pub overlap: bool,
    pub other_text: Option<String>,
    pub local_text: Option<String>,
    pub skipped: bool,
    pub deleted: bool,
    pub version_id: String,
}

/// Text an AI chat asked to add to the end of a document, through the connector.
/// It is not in the file. The writer accepts or rejects it in the margin.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PulledProposal {
    pub path: String,
    pub project_id: String,
    pub document_id: String,
    pub proposal_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PullOutcome {
    pub suggestions: Vec<BringOutcome>,
    pub wrote: Vec<String>,
    pub removed: Vec<String>,
    /// Paths whose copy could not be applied here. The book entry is unchanged,
    /// so the next pull tries again.
    pub failed: Vec<String>,
    /// Suggested additions waiting on this folder's documents. `None` when they
    /// were not read this time: the margin keeps the cards it has.
    pub proposals: Option<Vec<PulledProposal>>,
    /// Document ids whose suggestions could not be read this time. Their cards stay too.
    pub proposals_unread: Vec<String>,
}

/// The sync ids this folder's notes hold for one document. A card for a
/// suggestion is painted by these, not by the path, so it follows a rename and
/// a new file under an old name does not inherit it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DocumentIdentity {
    pub project_id: String,
    pub document_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FlushOutcome {
    pub sent: u32,
    pub waiting: bool,
    pub overlaps: Vec<BringOutcome>,
    /// Queued documents removed without an upload: the file or its sync id is
    /// gone, it stays on this Mac, or the server refused that version for good.
    pub dropped: Vec<String>,
    /// Queued documents kept after a local error. The next flush tries again.
    pub failed: Vec<String>,
    /// The part of `dropped` the server refused for good. Their backup did not
    /// happen, so the writer is told which file (`backup-notice.ts`).
    pub stopped: Vec<String>,
}

#[derive(Clone)]
pub struct HistoryConfig {
    pub url: Option<String>,
    /// Sign-in access token. Never a shared history password.
    pub token: Option<String>,
    pub allow_insecure: bool,
    pub device_id: String,
}

impl std::fmt::Debug for HistoryConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HistoryConfig")
            .field("url", &self.url)
            .field("token", &self.token.as_ref().map(|_| "set"))
            .field("allow_insecure", &self.allow_insecure)
            .field("device_id", &self.device_id)
            .finish()
    }
}

pub fn transit_allowed(url: &str, allow_insecure: bool) -> bool {
    if url.starts_with("https://") && url.len() > "https://".len() {
        return true;
    }
    if !allow_insecure {
        return false;
    }
    url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost")
}

fn identity(path: &Path) -> String {
    canon(path).to_string_lossy().into_owned()
}

pub(crate) fn document_id(path: &Path) -> String {
    URL_SAFE_NO_PAD.encode(identity(path).as_bytes())
}

/// Stable FNV-1a 64. A collision can hide an edit.
/// ponytail: not a cryptographic hash. Upgrade is sha256.
fn content_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn random_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncDoc {
    id: String,
    #[serde(default)]
    base_version_id: String,
    #[serde(default)]
    base_hash: String,
    #[serde(default)]
    seen_version_id: String,
    #[serde(default)]
    absent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncBook {
    project_id: String,
    documents: BTreeMap<String, SyncDoc>,
}

impl SyncBook {
    fn fresh() -> Self {
        Self {
            project_id: random_id(),
            documents: BTreeMap::new(),
        }
    }

    /// The entry with this id, wherever a rename moved it.
    fn doc_with_id(&mut self, id: &str) -> Option<&mut SyncDoc> {
        self.documents.values_mut().find(|doc| doc.id == id)
    }
}

impl SyncDoc {
    /// Both sides hold `version`, whose text hashes to `hash`.
    fn synced(&mut self, version: &str, hash: String) {
        self.base_version_id = version.to_string();
        self.seen_version_id = version.to_string();
        self.base_hash = hash;
        self.absent = false;
    }

    /// `version` is the other side's delete, and the file is gone here too.
    fn removed(&mut self, version: &str) {
        self.base_version_id = version.to_string();
        self.seen_version_id = version.to_string();
        self.base_hash = content_hash("");
        self.absent = true;
    }
}

/// The folder that holds `.alkuin-sync.json`, or the workspace, git root, or parent.
fn project_root(path: &Path, workspace: Option<&Path>) -> PathBuf {
    // Git and the workspace may name the folder differently when a symlink is
    // in the way, so work in canonical form throughout.
    let path = canon_parent(path);
    let path = path.as_path();
    let workspace = workspace.map(canon);
    let boundary = workspace
        .filter(|root| path.starts_with(root))
        .or_else(|| crate::commands::git::repo_root_from_file(path))
        .or_else(|| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| path.to_path_buf());
    let mut dir = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };
    loop {
        if dir.join(SYNC_FILE).is_file() {
            return dir;
        }
        if dir == boundary || !dir.starts_with(&boundary) {
            break;
        }
        let Some(parent) = dir.parent() else { break };
        if parent == dir {
            break;
        }
        dir = parent.to_path_buf();
    }
    boundary
}

fn relative_name(root: &Path, path: &Path) -> Result<String, AppError> {
    let canonical = canon_parent(path);
    let rel = canonical
        .strip_prefix(canon(root))
        .map_err(|_| AppError::InvalidPath(path.to_string_lossy().into_owned()))?;
    let name = rel.to_string_lossy().replace('\\', "/");
    if name.is_empty()
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part.starts_with('.'))
    {
        return Err(AppError::InvalidPath(name));
    }
    Ok(name)
}

fn load_book(root: &Path) -> Result<SyncBook, AppError> {
    let path = root.join(SYNC_FILE);
    if !path.is_file() {
        return Ok(SyncBook::fresh());
    }
    let text = fs::read_to_string(&path).map_err(|error| AppError::Io(error.to_string()))?;
    serde_json::from_str(&text)
        .map_err(|_| AppError::Io("The sync notes could not be read.".into()))
}

fn save_book(root: &Path, book: &SyncBook) -> Result<(), AppError> {
    let body = serde_json::to_vec_pretty(book).map_err(|error| AppError::Io(error.to_string()))?;
    write_atomic(&root.join(SYNC_FILE), &body)
}

/// One lock per sync file, keyed by the folder's real path. Every
/// read-modify-write of `.alkuin-sync.json` goes through [`with_book`].
fn book_lock(root: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .entry(key)
        .or_default()
        .clone()
}

/// Load, change, and save the book under its lock. `change` is synchronous,
/// so no network wait sits between the load and the save. A book that
/// cannot be read is an error and is not overwritten.
fn with_book<T>(
    root: &Path,
    change: impl FnOnce(&mut SyncBook) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let lock = book_lock(root);
    let _guard = lock.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut book = load_book(root)?;
    let out = change(&mut book)?;
    save_book(root, &book)?;
    Ok(out)
}

fn ensure_doc<'a>(book: &'a mut SyncBook, name: &str) -> &'a mut SyncDoc {
    book.documents
        .entry(name.to_string())
        .or_insert_with(|| SyncDoc {
            id: random_id(),
            base_version_id: String::new(),
            base_hash: String::new(),
            seen_version_id: String::new(),
            absent: false,
        })
}

/// One queued upload, named by its sync ids rather than its path, so a rename
/// inside the folder still finds it and a delete drops it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct OutboxEntry {
    root: String,
    project: String,
    document: String,
}

impl OutboxEntry {
    fn line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

enum OutboxLine {
    Entry(OutboxEntry),
    /// An absolute path, as versions before ids queued it.
    Legacy(String),
    Unreadable,
}

fn parse_outbox_line(line: &str) -> OutboxLine {
    if line.starts_with('{') {
        return serde_json::from_str(line)
            .map(OutboxLine::Entry)
            .unwrap_or(OutboxLine::Unreadable);
    }
    if Path::new(line).is_absolute() {
        OutboxLine::Legacy(line.to_string())
    } else {
        OutboxLine::Unreadable
    }
}

/// The ids a send for `name` uses, and the version this Mac last synced.
/// A document the book does not know yet gets a new random id.
fn upload_identity(root: &Path, name: &str) -> Result<(OutboxEntry, String), AppError> {
    with_book(root, |book| {
        let doc = ensure_doc(book, name);
        let base = if doc.seen_version_id.is_empty() {
            doc.base_version_id.clone()
        } else {
            doc.seen_version_id.clone()
        };
        let document = doc.id.clone();
        Ok((
            OutboxEntry {
                root: root.to_string_lossy().into_owned(),
                project: book.project_id.clone(),
                document,
            },
            base,
        ))
    })
}

/// The entry the book already holds for `name`. Nothing is created.
fn known_entry(root: &Path, name: &str) -> Result<Option<OutboxEntry>, AppError> {
    if !root.join(SYNC_FILE).is_file() {
        return Ok(None);
    }
    let book = load_book(root)?;
    Ok(book.documents.get(name).map(|doc| OutboxEntry {
        root: root.to_string_lossy().into_owned(),
        project: book.project_id.clone(),
        document: doc.id.clone(),
    }))
}

fn version_body(
    root: &Path,
    name: &str,
    entry: &OutboxEntry,
    base: &str,
    text: &str,
    device_id: &str,
) -> Result<Vec<u8>, AppError> {
    let folder_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| AppError::Io(error.to_string()))?
        .as_millis();
    let body = json!({
        "versionId": random_id(),
        "savedAt": millis.to_string(),
        "text": text,
        "deviceId": device_id,
        "projectId": entry.project,
        "documentId": entry.document,
        "baseVersionId": base,
        "name": name,
        "folderName": folder_name,
    });
    serde_json::to_vec(&body).map_err(|error| AppError::Io(error.to_string()))
}

/// After an upload. The entry is found by the id that was sent, so a rename
/// during the upload does not leave the base on a new entry under the old name.
/// An entry deleted meanwhile stays deleted.
fn note_synced(
    root: &Path,
    document_id: &str,
    version_id: &str,
    text: &str,
) -> Result<(), AppError> {
    with_book(root, |book| {
        if let Some(doc) = book.doc_with_id(document_id) {
            doc.synced(version_id, content_hash(text));
        }
        Ok(())
    })
}

/// Settle writes for the path the person is looking at.
fn note_synced_at(root: &Path, name: &str, version_id: &str, text: &str) -> Result<(), AppError> {
    with_book(root, |book| {
        ensure_doc(book, name).synced(version_id, content_hash(text));
        Ok(())
    })
}

/// The outbox, the delete queue, and the decision queue. Every read-modify-write
/// of any of them runs under this lock, so a concurrent queue or drop is never lost.
static QUEUE_FILES: Mutex<()> = Mutex::new(());

fn edit_queue<T>(file: &Path, change: impl FnOnce(&mut Vec<String>) -> T) -> Result<T, AppError> {
    let _guard = QUEUE_FILES
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut lines = read_queue(file)?;
    let before = lines.clone();
    let out = change(&mut lines);
    if lines != before {
        write_queue(file, &lines)?;
    }
    Ok(out)
}

/// A missing file is an empty queue. Any other read error is an error, so a
/// write never replaces lines it could not read.
fn read_queue(file: &Path) -> Result<Vec<String>, AppError> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AppError::Io(error.to_string())),
    };
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

fn write_queue(file: &Path, lines: &[String]) -> Result<(), AppError> {
    let mut body = lines.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    write_atomic(file, body.as_bytes())
}

fn outbox_add(home: &Path, entry: &OutboxEntry) -> Result<(), AppError> {
    let line = entry.line();
    edit_queue(&outbox_for(home), |lines| {
        if !lines.contains(&line) {
            lines.push(line);
        }
    })
}

fn outbox_remove(home: &Path, entry: &OutboxEntry) -> Result<(), AppError> {
    edit_queue(&outbox_for(home), |lines| {
        lines.retain(|line| {
            !matches!(parse_outbox_line(line), OutboxLine::Entry(queued) if &queued == entry)
        });
    })
}

/// The upload is finished with, one way or another. A failure to drop the
/// line only means one more try later, so it is logged and not returned.
fn drop_entry(home: &Path, entry: &OutboxEntry) {
    if let Err(error) = outbox_remove(home, entry) {
        eprintln!("[history] a finished upload stayed in the outbox: {error}");
    }
}

/// A kept or missing document leaves the outbox, including a path line
/// written by an earlier version.
fn forget_queued(home: &Path, root: &Path, path: &Path) {
    let legacy = identity(path);
    let entry = match relative_name(root, path) {
        Ok(name) => known_entry(root, &name).unwrap_or_else(|error| {
            eprintln!("[history] the sync notes could not be read: {error}");
            None
        }),
        Err(_) => None,
    };
    let result = edit_queue(&outbox_for(home), |lines| {
        lines.retain(|line| match parse_outbox_line(line) {
            OutboxLine::Entry(queued) => Some(&queued) != entry.as_ref(),
            OutboxLine::Legacy(queued) => queued != legacy,
            OutboxLine::Unreadable => true,
        });
    });
    if let Err(error) = result {
        eprintln!("[history] a document that will not be sent stayed in the outbox: {error}");
    }
}

/// Where a queued document is now, by its ids. `Err(label)` means its folder
/// notes, its id, or its file is gone, so there is nothing to send.
fn resolve_entry(entry: &OutboxEntry) -> Result<Result<(PathBuf, PathBuf), String>, AppError> {
    let root = PathBuf::from(&entry.root);
    let unnamed = || format!("{}/{}", entry.root, entry.document);
    if !root.join(SYNC_FILE).is_file() {
        return Ok(Err(unnamed()));
    }
    let book = load_book(&root)?;
    if book.project_id != entry.project {
        return Ok(Err(unnamed()));
    }
    let Some(name) = book
        .documents
        .iter()
        .find(|(_, doc)| doc.id == entry.document)
        .map(|(name, _)| name.clone())
    else {
        return Ok(Err(unnamed()));
    };
    let path = root.join(&name);
    if path.is_file() {
        Ok(Ok((root, path)))
    } else {
        Ok(Err(path.to_string_lossy().into_owned()))
    }
}

/// A path queued by an earlier version. A file that is gone, or a name the
/// folder cannot hold, is dropped: it is never sent as an empty copy.
fn migrate_legacy(
    path: &Path,
    workspace_of: &(dyn Fn(&Path) -> Option<PathBuf> + Sync),
) -> Result<Option<OutboxEntry>, AppError> {
    if !path.is_file() {
        return Ok(None);
    }
    let root = project_root(path, workspace_of(path).as_deref());
    let Ok(name) = relative_name(&root, path) else {
        return Ok(None);
    };
    Ok(Some(upload_identity(&root, &name)?.0))
}

/// Every queued entry, oldest first. Path lines from an earlier version are
/// rewritten as entries here, or dropped and reported.
fn queued_entries(
    home: &Path,
    workspace_of: &(dyn Fn(&Path) -> Option<PathBuf> + Sync),
    outcome: &mut FlushOutcome,
) -> Result<Vec<OutboxEntry>, AppError> {
    let outbox = outbox_for(home);
    let lines = edit_queue(&outbox, |lines| lines.clone())?;
    let mut entries: Vec<OutboxEntry> = Vec::new();
    for line in lines {
        let next = match parse_outbox_line(&line) {
            OutboxLine::Entry(entry) => {
                if !entries.contains(&entry) {
                    entries.push(entry);
                }
                continue;
            }
            OutboxLine::Unreadable => None,
            OutboxLine::Legacy(path) => match migrate_legacy(Path::new(&path), workspace_of) {
                Ok(next) => next,
                Err(error) => {
                    eprintln!("[history] a queued path could not be read again: {error}");
                    outcome.failed.push(path);
                    continue;
                }
            },
        };
        edit_queue(&outbox, |lines| {
            lines.retain(|existing| existing != &line);
            if let Some(entry) = &next {
                let rewritten = entry.line();
                if !lines.contains(&rewritten) {
                    lines.push(rewritten);
                }
            }
        })?;
        match next {
            Some(entry) if !entries.contains(&entry) => entries.push(entry),
            Some(_) => {}
            None => outcome.dropped.push(line),
        }
    }
    Ok(entries)
}

fn outbox_for(home: &Path) -> PathBuf {
    home.join(OUTBOX)
}

/// A sync id in a URL path. A slash, a question mark, or a space would change the request.
fn path_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn endpoint(config: &HistoryConfig, project_id: &str, document_id: &str) -> Option<String> {
    let url = config.url.as_deref().filter(|value| !value.is_empty())?;
    if !transit_allowed(url, config.allow_insecure) || !path_id(project_id) || !path_id(document_id)
    {
        return None;
    }
    Some(format!(
        "{}/v1/projects/{project_id}/documents/{document_id}",
        url.trim_end_matches('/')
    ))
}

/// Their copy is returned. The file on disk is not written. A kept document
/// is not fetched: `depart` refuses before any socket.
pub fn judge_bring(
    path: &Path,
    set: &MacOnlySet,
    config: &HistoryConfig,
    remote_device: Option<&str>,
    remote_text: Option<&str>,
) -> BringOutcome {
    let local = fs::read_to_string(path).ok();
    let skipped = BringOutcome {
        path: path.to_string_lossy().into_owned(),
        overlap: false,
        other_text: None,
        local_text: None,
        skipped: true,
        deleted: false,
        version_id: String::new(),
    };
    if depart(
        set,
        path,
        Channel::Backup,
        &[(path, local.as_deref().unwrap_or(""))],
        || Ok(()),
    )
    .is_err()
    {
        return skipped;
    }
    let Some(text) = remote_text else {
        return skipped;
    };
    let same_device = remote_device == Some(config.device_id.as_str());
    let same_text = local.as_deref() == Some(text);
    let overlap = !same_device && !same_text;
    BringOutcome {
        path: path.to_string_lossy().into_owned(),
        overlap,
        other_text: if overlap {
            Some(text.to_string())
        } else {
            None
        },
        local_text: if overlap { local } else { None },
        skipped: false,
        deleted: false,
        version_id: String::new(),
    }
}

enum ReadySend {
    Done(Sent),
    Upload {
        url: String,
        token: String,
        body: Vec<u8>,
        entry: OutboxEntry,
    },
}

/// Decide the upload. A kept document is `Refused` and is not queued. A file
/// that is gone is `Missing`: an empty copy is never sent in its place.
/// The bytes are returned only when [`depart`](crate::mac_only::depart) allows them.
fn classify_send(
    root: &Path,
    path: &Path,
    online: bool,
    set: &MacOnlySet,
    config: &HistoryConfig,
    home: &Path,
) -> Result<ReadySend, AppError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        // Renamed or deleted after the save that scheduled this copy. Nothing to back up.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            forget_queued(home, root, path);
            return Ok(ReadySend::Done(Sent::Missing));
        }
        Err(error) => return Err(AppError::Io(format!("history read: {error}"))),
    };
    if depart(set, path, Channel::Backup, &[(path, text.as_str())], || {
        Ok(())
    })
    .is_err()
    {
        forget_queued(home, root, path);
        return Ok(ReadySend::Done(Sent::Refused));
    }
    let Some(url) = config.url.as_deref().filter(|value| !value.is_empty()) else {
        return Ok(ReadySend::Done(Sent::Unconfigured));
    };
    if !transit_allowed(url, config.allow_insecure) {
        return Ok(ReadySend::Done(Sent::Refused));
    }
    let Some(token) = config.token.as_deref().filter(|value| !value.is_empty()) else {
        return Ok(ReadySend::Done(Sent::Unconfigured));
    };
    let name = relative_name(root, path)?;
    let (entry, base) = upload_identity(root, &name)?;
    if !online {
        outbox_add(home, &entry)?;
        return Ok(ReadySend::Done(Sent::Waiting));
    }
    let Some(endpoint) = endpoint(config, &entry.project, &entry.document) else {
        drop_entry(home, &entry);
        return Ok(ReadySend::Done(Sent::Refused));
    };
    let body = version_body(root, &name, &entry, &base, &text, &config.device_id)?;
    if depart(set, path, Channel::Backup, &[(path, text.as_str())], || {
        Ok(())
    })
    .is_err()
    {
        forget_queued(home, root, path);
        return Ok(ReadySend::Done(Sent::Refused));
    }
    Ok(ReadySend::Upload {
        url: endpoint,
        token: token.to_string(),
        body,
        entry,
    })
}

/// Offline writing queues the document's ids, never the essay. A kept
/// document is not queued and is not handed to `post`. `post` is the only upload.
#[cfg(test)]
fn send_or_queue(
    path: &Path,
    online: bool,
    set: &MacOnlySet,
    config: &HistoryConfig,
    home: &Path,
    mut post: impl FnMut(&str, &str, &[u8]) -> Result<(), bool>,
) -> Result<SendOutcome, AppError> {
    let root = project_root(path, None);
    let sent = match classify_send(&root, path, online, set, config, home)? {
        ReadySend::Done(sent) => sent,
        ReadySend::Upload {
            url,
            token,
            body,
            entry,
        } => {
            let carried = String::from_utf8_lossy(&body).into_owned();
            let posted = depart(
                set,
                path,
                Channel::Backup,
                &[(path, carried.as_str())],
                || Ok(post(&url, &token, &body)),
            )
            .map_err(AppError::Gateway)?;
            let posted = match posted {
                Ok(()) => Posted::Stored,
                Err(true) => Posted::Wait,
                Err(false) => Posted::Stop { status: 0 },
            };
            finish_exchange(home, &root, path, &entry, &body, posted)?
        }
    };
    Ok(sent.wire())
}

/// The history bearer is the sign-in session. An empty session is no credential.
fn session_bearer(access_token: Option<String>) -> Option<String> {
    access_token.filter(|value| !value.is_empty())
}

/// Public base URL baked in at build time. Not a secret.
/// `https://history.example.invalid` is the placeholder: sync stays off.
pub const HISTORY_URL_PLACEHOLDER: &str = "https://history.example.invalid";

const COMPILED_HISTORY_URL: Option<&str> = option_env!("ALKUIN_HISTORY_URL");

fn history_base_from(raw: Option<&str>) -> Option<String> {
    let value = raw.map(str::trim).filter(|value| !value.is_empty())?;
    if value == HISTORY_URL_PLACEHOLDER {
        return None;
    }
    Some(value.to_string())
}

fn compiled_history_url() -> Option<String> {
    history_base_from(COMPILED_HISTORY_URL)
}

fn loopback_http(url: &str) -> bool {
    url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost")
}

fn config_for(device_id: String, access_token: Option<String>) -> HistoryConfig {
    let url = compiled_history_url();
    let allow_insecure = url.as_deref().is_some_and(loopback_http);
    HistoryConfig {
        url,
        token: session_bearer(access_token),
        allow_insecure,
        device_id,
    }
}

fn device_id(home: &Path) -> Result<String, AppError> {
    let path = home.join("device-id");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| AppError::Io(error.to_string()))?;
    }
    fs::write(&path, &id).map_err(|error| AppError::Io(error.to_string()))?;
    Ok(id)
}

fn home_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Io(error.to_string()))
}

fn waits_for_another_try(status: u16) -> bool {
    status == 429 || status >= 500
}

fn install_rustls() {
    // reqwest is rustls-no-provider. The first install wins; a repeat is ignored.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

enum Posted {
    Stored,
    Stale {
        version_id: String,
        /// Absent when the response did not carry `text`. That is not an empty document.
        text: Option<String>,
        deleted: bool,
    },
    Wait,
    /// 401 or 403: the server did not take this session. Not a verdict on
    /// the version, so a queued line stays for the next session.
    Held,
    /// Any other refusal. This version will not be stored.
    Stop {
        status: u16,
    },
}

struct Reply {
    status: u16,
    body: String,
}

async fn exchange(
    method: &str,
    url: &str,
    token: &str,
    body: Option<&[u8]>,
) -> Result<Reply, bool> {
    install_rustls();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| true)?;
    let mut request = match method {
        "GET" => client.get(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        _ => return Err(false),
    }
    .header("authorization", format!("Bearer {token}"));
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .body(body.to_vec());
    }
    let response = request.send().await.map_err(|_| true)?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|_| true)?;
    Ok(Reply { status, body: text })
}

fn posted_from(reply: Reply) -> Posted {
    if (200..300).contains(&reply.status) {
        return Posted::Stored;
    }
    if reply.status == 409 {
        let value: serde_json::Value =
            serde_json::from_str(&reply.body).unwrap_or(serde_json::Value::Null);
        return Posted::Stale {
            version_id: value
                .get("versionId")
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .to_string(),
            text: value
                .get("text")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            deleted: value
                .get("deleted")
                .and_then(|item| item.as_bool())
                .unwrap_or(false),
        };
    }
    if waits_for_another_try(reply.status) {
        Posted::Wait
    } else if reply.status == 401 || reply.status == 403 {
        Posted::Held
    } else {
        Posted::Stop {
            status: reply.status,
        }
    }
}

async fn post_https(url: &str, token: &str, body: &[u8]) -> Posted {
    match exchange("PUT", url, token, Some(body)).await {
        Ok(reply) => posted_from(reply),
        Err(true) => Posted::Wait,
        Err(false) => Posted::Stop { status: 0 },
    }
}

async fn get_copy(url: &str, token: &str) -> Result<Option<(String, String, String)>, bool> {
    let reply = exchange("GET", url, token, None).await?;
    if reply.status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&reply.status) {
        return Err(waits_for_another_try(reply.status));
    }
    let value: serde_json::Value = serde_json::from_str(&reply.body).map_err(|_| false)?;
    if value.as_object().is_some_and(|object| {
        object
            .keys()
            .any(|key| !matches!(key.as_str(), "text" | "deviceId" | "versionId"))
    }) {
        return Err(false);
    }
    let Some(text) = value.get("text").and_then(|item| item.as_str()) else {
        return Err(false);
    };
    let text = text.to_string();
    let device = value
        .get("deviceId")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    let version = value
        .get("versionId")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    Ok(Some((text, device, version)))
}

/// Same switch as Keep on this Mac only. Writes `mac-only.json`.
#[tauri::command]
pub async fn history_set_stays_on_this_mac(
    app: tauri::AppHandle,
    path: String,
    stays: bool,
) -> Result<(), AppError> {
    let dir = home_dir(&app)?;
    set_stays_on_this_mac(&dir, Path::new(&path), stays)
}

#[tauri::command]
pub async fn history_stays_on_this_mac(
    app: tauri::AppHandle,
    path: String,
) -> Result<bool, AppError> {
    let dir = home_dir(&app)?;
    let set = MacOnlySet::load(&dir);
    if set.is_unreadable() {
        return Err(AppError::Gateway(crate::mac_only::SETTING_FAILED.into()));
    }
    Ok(set.blocks(Path::new(&path)))
}

/// Their copy, when the response actually carried one. A missing `text`, or an
/// empty body with no version, is not a document. Accepting it would wipe the file.
fn offered_text(text: Option<String>, version_id: &str, deleted: bool) -> Option<String> {
    let text = text?;
    if !deleted && text.is_empty() && version_id.is_empty() {
        return None;
    }
    Some(text)
}

fn finish_exchange(
    home: &Path,
    root: &Path,
    path: &Path,
    entry: &OutboxEntry,
    body: &[u8],
    posted: Posted,
) -> Result<Sent, AppError> {
    let value: serde_json::Value = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
    let field = |key: &str| {
        value
            .get(key)
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .to_string()
    };
    match posted {
        Posted::Stored => {
            drop_entry(home, entry);
            let version = field("versionId");
            if !version.is_empty() {
                note_synced(root, &entry.document, &version, &field("text"))?;
            }
            Ok(Sent::Stored)
        }
        Posted::Stale {
            version_id,
            text,
            deleted,
        } => {
            // No copy to offer: not a conflict the person can settle. Like
            // `Held`, a queued line stays, and the next pull brings their copy.
            let Some(text) = offered_text(text, &version_id, deleted) else {
                return Ok(Sent::Held);
            };
            let local = fs::read_to_string(path).unwrap_or_default();
            if !deleted && local == text && !version_id.is_empty() {
                drop_entry(home, entry);
                note_synced(root, &entry.document, &version_id, &text)?;
                return Ok(Sent::Stored);
            }
            Ok(Sent::Conflict {
                other_text: text,
                local_text: local,
                deleted,
                version_id,
            })
        }
        Posted::Wait => {
            outbox_add(home, entry)?;
            Ok(Sent::Waiting)
        }
        Posted::Held => Ok(Sent::Held),
        Posted::Stop { status } => {
            eprintln!(
                "[history] the server refused this version ({status}); it is not queued again"
            );
            drop_entry(home, entry);
            Ok(Sent::Stopped)
        }
    }
}

/// One send for `path` inside the folder whose sync notes are at `root`.
async fn send_in(
    home: &Path,
    root: &Path,
    path: &Path,
    online: bool,
    set: &MacOnlySet,
    config: &HistoryConfig,
) -> Result<Sent, AppError> {
    match classify_send(root, path, online, set, config, home)? {
        ReadySend::Done(sent) => Ok(sent),
        ReadySend::Upload {
            url,
            token,
            body,
            entry,
        } => {
            let carried = String::from_utf8_lossy(&body).into_owned();
            if depart(
                set,
                path,
                Channel::Backup,
                &[(path, carried.as_str())],
                || Ok(()),
            )
            .is_err()
            {
                forget_queued(home, root, path);
                return Ok(Sent::Refused);
            }
            let posted = post_https(&url, &token, &body).await;
            finish_exchange(home, root, path, &entry, &body, posted)
        }
    }
}

/// The body of [`history_send`] after the app directory and env config are known.
pub(crate) async fn history_send_at(
    home: &Path,
    path: &Path,
    online: bool,
    config: &HistoryConfig,
    workspace: Option<&Path>,
) -> Result<SendOutcome, AppError> {
    let set = MacOnlySet::load_or_block(Some(home));
    let root = project_root(path, workspace);
    Ok(send_in(home, &root, path, online, &set, config)
        .await?
        .wire())
}

pub(crate) fn workspace_for(app: &tauri::AppHandle, path: &Path) -> Option<PathBuf> {
    workspace_containing(app, path)
}

pub(crate) fn deletion_plan(path: &Path, workspace: Option<&Path>) -> Option<DeletePlan> {
    plan_delete(path, workspace)
}

pub(crate) async fn config_from_app(
    app: &tauri::AppHandle,
    home: &Path,
) -> Result<HistoryConfig, AppError> {
    Ok(config_for(
        device_id(home)?,
        crate::commands::account::access_token_from_app(app).await?,
    ))
}

fn workspace_containing(app: &tauri::AppHandle, path: &Path) -> Option<PathBuf> {
    let state = app.try_state::<crate::state::AppState>()?;
    for label in state.labels() {
        let Some(window) = state.get(&label) else {
            continue;
        };
        if let Some((root, _)) = window.workspace_snapshot() {
            if path.starts_with(&root) {
                return Some(root);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn history_send(
    app: tauri::AppHandle,
    path: String,
    online: bool,
) -> Result<SendOutcome, AppError> {
    let home = home_dir(&app)?;
    let config = config_for(
        device_id(&home)?,
        crate::commands::account::access_token_from_app(&app).await?,
    );
    let file = PathBuf::from(&path);
    let workspace = workspace_containing(&app, &file);
    history_send_at(&home, &file, online, &config, workspace.as_deref()).await
}

#[tauri::command]
pub async fn history_bring(app: tauri::AppHandle, path: String) -> Result<BringOutcome, AppError> {
    let home = home_dir(&app)?;
    let set = MacOnlySet::load_or_block(Some(&home));
    let config = config_for(
        device_id(&home)?,
        crate::commands::account::access_token_from_app(&app).await?,
    );
    let path = PathBuf::from(path);
    let workspace = workspace_containing(&app, &path);
    let root = project_root(&path, workspace.as_deref());
    Ok(bring_in(&root, &path, &set, &config).await)
}

async fn bring_in(
    root: &Path,
    path: &Path,
    set: &MacOnlySet,
    config: &HistoryConfig,
) -> BringOutcome {
    let local = fs::read_to_string(path).unwrap_or_default();
    if depart(
        set,
        path,
        Channel::Backup,
        &[(path, local.as_str())],
        || Ok(()),
    )
    .is_err()
    {
        return judge_bring(path, set, config, None, None);
    }
    let book = load_book(root).unwrap_or_else(|_| SyncBook::fresh());
    let Some(name) = relative_name(root, path).ok() else {
        return judge_bring(path, set, config, None, None);
    };
    let Some(doc) = book.documents.get(&name) else {
        return judge_bring(path, set, config, None, None);
    };
    let Some(url) = endpoint(config, &book.project_id, &doc.id) else {
        return judge_bring(path, set, config, None, None);
    };
    let Some(token) = config.token.clone().filter(|value| !value.is_empty()) else {
        return judge_bring(path, set, config, None, None);
    };
    match get_copy(&url, &token).await {
        Ok(Some((text, device, _version))) => {
            judge_bring(path, set, config, Some(&device), Some(&text))
        }
        _ => judge_bring(path, set, config, None, None),
    }
}

#[tauri::command]
pub async fn history_flush(app: tauri::AppHandle, online: bool) -> Result<FlushOutcome, AppError> {
    let home = home_dir(&app)?;
    let config = config_for(
        device_id(&home)?,
        crate::commands::account::access_token_from_app(&app).await?,
    );
    history_flush_at(&home, &config, online, &|path| {
        workspace_containing(&app, path)
    })
    .await
}

/// Send every queued document. Each one is found again by its ids, so a
/// rename inside the folder is followed and a delete drops the line. One
/// failure is reported and does not stop the others.
async fn history_flush_at(
    home: &Path,
    config: &HistoryConfig,
    online: bool,
    workspace_of: &(dyn Fn(&Path) -> Option<PathBuf> + Sync),
) -> Result<FlushOutcome, AppError> {
    let mut outcome = FlushOutcome {
        sent: 0,
        waiting: false,
        overlaps: Vec::new(),
        dropped: Vec::new(),
        failed: Vec::new(),
        stopped: Vec::new(),
    };
    let entries = queued_entries(home, workspace_of, &mut outcome)?;
    for entry in entries {
        // Read the kept list again for every send, as one send does: a
        // document marked Keep on this Mac only while the batch runs must
        // not go out with it.
        let set = MacOnlySet::load_or_block(Some(home));
        let (root, path) = match resolve_entry(&entry) {
            Ok(Ok(found)) => found,
            Ok(Err(gone)) => {
                drop_entry(home, &entry);
                outcome.dropped.push(gone);
                continue;
            }
            Err(error) => {
                eprintln!("[history] a queued document could not be found: {error}");
                outcome
                    .failed
                    .push(format!("{}/{}", entry.root, entry.document));
                continue;
            }
        };
        let shown = path.to_string_lossy().into_owned();
        let sent = match send_in(home, &root, &path, online, &set, config).await {
            Ok(sent) => sent,
            Err(error) => {
                eprintln!("[history] a queued document was not sent: {error}");
                outcome.failed.push(shown);
                continue;
            }
        };
        match sent {
            Sent::Stored => outcome.sent += 1,
            Sent::Waiting => outcome.waiting = true,
            Sent::Stopped => {
                drop_entry(home, &entry);
                outcome.stopped.push(shown.clone());
                outcome.dropped.push(shown);
            }
            Sent::Refused | Sent::Missing => {
                drop_entry(home, &entry);
                outcome.dropped.push(shown);
            }
            Sent::Unconfigured | Sent::Held => {}
            Sent::Conflict {
                other_text,
                local_text,
                deleted,
                version_id,
            } => {
                outcome.overlaps.push(BringOutcome {
                    path: shown,
                    overlap: true,
                    other_text: Some(other_text),
                    local_text: Some(local_text),
                    skipped: false,
                    deleted,
                    version_id,
                });
                continue;
            }
        }
        let brought = bring_in(&root, &path, &set, config).await;
        if brought.overlap {
            outcome.overlaps.push(brought);
        }
    }
    Ok(outcome)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedDoc {
    project_id: String,
    document_id: String,
    version_id: String,
    name: String,
    #[serde(default)]
    folder_name: String,
    deleted: bool,
    /// Suggested additions waiting on this document. The field can be missing.
    /// Read through [`ListedDoc::waiting`]: a value that is not a count must not
    /// fail the whole list, and the pull with it.
    #[serde(default)]
    proposals: serde_json::Value,
}

impl ListedDoc {
    fn waiting(&self) -> u64 {
        self.proposals.as_u64().unwrap_or(0)
    }
}

#[derive(Debug, Deserialize)]
struct ListBody {
    documents: Vec<ListedDoc>,
}

enum CopyAction {
    Keep,
    Write,
    Remove,
    Suggest,
}

/// Local unchanged since the last sync: take the server copy.
/// Both sides changed: a suggestion. The file is not written.
/// A path with unsaved edits never gets here: the pull skips the `dirty` list.
fn decide_copy(
    local: Option<&str>,
    base_hash: &str,
    base_version: &str,
    remote_version: &str,
    remote_text: Option<&str>,
    deleted: bool,
    absent: bool,
) -> CopyAction {
    if !deleted && !base_version.is_empty() && remote_version == base_version {
        return CopyAction::Keep;
    }
    if deleted {
        if local.is_none() || absent {
            return CopyAction::Keep;
        }
        if !base_hash.is_empty() && content_hash(local.unwrap_or("")) == base_hash {
            return CopyAction::Remove;
        }
        return CopyAction::Suggest;
    }
    let Some(text) = local else {
        return CopyAction::Write;
    };
    let remote = remote_text.unwrap_or("");
    if text == remote {
        return CopyAction::Keep;
    }
    if !base_hash.is_empty() && content_hash(text) == base_hash {
        return CopyAction::Write;
    }
    CopyAction::Suggest
}

fn name_start(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '(' | '[')
}

fn format_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

/// A superset of the history server's rule: every name the server stores passes here,
/// and this also takes any other visible non-ASCII character (a symbol, an emoji).
/// Both are tested against one table (`shared/history-name-rule.json`). A name can
/// pass here and be refused there, never the other way round. A listed name is joined
/// onto the folder. An apostrophe, an ampersand, and a comma are ordinary file names
/// (`Mom's recipes.md`, `Q&A.md`, `Notes, part 1.md`); none of them can move or hide a file.
fn safe_local_name(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > 200 || name.contains('\\') || name.contains('\0') {
        return false;
    }
    name.split('/').all(|part| {
        let mut chars = part.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        name_start(first)
            && chars.all(|ch| {
                name_start(ch)
                    || matches!(ch, '.' | '_' | ' ' | '-' | ')' | ']' | '\'' | '&' | ',')
                    || (!ch.is_ascii() && !ch.is_control() && !format_char(ch))
            })
    })
}

fn is_random_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .ok()
        .is_some_and(|id| id.get_version() == Some(uuid::Version::Random))
}

/// A random id in the one form the server takes for a suggestion: 36 characters
/// with hyphens. The braced, `urn:` and unhyphenated spellings are refused here,
/// so no decision waits on a request the server would always turn down, and
/// nothing but a path segment goes into the URL.
fn decision_id(value: &str) -> bool {
    value.len() == 36 && path_id(value) && is_random_id(value)
}

/// A listed copy is written only when both ids are random and the name is a
/// path inside the folder. A name that is an id is not a file name.
fn listed_copy_ok(project_id: &str, document_id: &str, name: &str) -> bool {
    is_random_id(project_id)
        && is_random_id(document_id)
        && safe_local_name(name)
        && !name
            .split('/')
            .any(|part| part == project_id || part == document_id)
}

/// New means this folder has no documents yet. Empty means no file or directory
/// other than a dotfile. A read error is treated as not empty.
fn folder_is_new_and_empty(book: &SyncBook, root: &Path) -> bool {
    if !book.documents.is_empty() {
        return false;
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return false;
        };
        if !name.starts_with('.') {
            return false;
        }
    }
    true
}

fn maybe_adopt(book: &mut SyncBook, listed: &[ListedDoc], root: &Path) {
    if !folder_is_new_and_empty(book, root) {
        return;
    }
    let Some(base) = root.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    if base.is_empty() || base.starts_with('.') {
        return;
    }
    let mut matches: Vec<&str> = listed
        .iter()
        .filter(|item| !item.deleted && item.folder_name == base && is_random_id(&item.project_id))
        .map(|item| item.project_id.as_str())
        .collect();
    matches.sort_unstable();
    matches.dedup();
    if matches.len() == 1 {
        book.project_id = matches[0].to_string();
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DeletePlan {
    /// The folder whose sync notes name these documents.
    root: PathBuf,
    project_id: String,
    /// Empty means the whole project.
    documents: Vec<String>,
}

fn plan_delete(path: &Path, workspace: Option<&Path>) -> Option<DeletePlan> {
    let root = project_root(path, workspace);
    if !root.join(SYNC_FILE).is_file() {
        return None;
    }
    let book = load_book(&root).ok()?;
    // project_root answers in canonical form, so compare the same form.
    if canon_parent(path) == root {
        return Some(DeletePlan {
            root,
            project_id: book.project_id,
            documents: Vec::new(),
        });
    }
    if path.is_dir() {
        let Ok(prefix) = relative_name(&root, path) else {
            return None;
        };
        let documents: Vec<_> = book
            .documents
            .iter()
            .filter(|(name, _)| *name == &prefix || name.starts_with(&format!("{prefix}/")))
            .map(|(_, doc)| doc.id.clone())
            .collect();
        if documents.is_empty() {
            return None;
        }
        return Some(DeletePlan {
            root,
            project_id: book.project_id,
            documents,
        });
    }
    let name = relative_name(&root, path).ok()?;
    let doc = book.documents.get(&name)?;
    Some(DeletePlan {
        root,
        project_id: book.project_id,
        documents: vec![doc.id.clone()],
    })
}

/// `project<TAB>document`, or `project<TAB>*` for the whole project.
fn delete_lines(plan: &DeletePlan) -> Vec<String> {
    if plan.documents.is_empty() {
        return vec![format!("{}\t*", plan.project_id)];
    }
    plan.documents
        .iter()
        .map(|document| format!("{}\t{document}", plan.project_id))
        .collect()
}

pub(crate) fn queue_delete_plan(home: &Path, plan: &DeletePlan) -> Result<(), AppError> {
    let lines = delete_lines(plan);
    edit_queue(&home.join(DELETE_OUTBOX), |queued| {
        for line in lines {
            if !queued.contains(&line) {
                queued.push(line);
            }
        }
    })
}

/// Only this line goes. A delete queued meanwhile stays queued.
fn unqueue_delete(home: &Path, line: &str) {
    let result = edit_queue(&home.join(DELETE_OUTBOX), |queued| {
        queued.retain(|existing| existing != line);
    });
    if let Err(error) = result {
        eprintln!("[history] a finished delete stayed queued: {error}");
    }
}

enum DeleteStep {
    /// Deleted online, or there is nothing online to delete.
    Done,
    /// Offline, signed out, or refused this time. The line stays queued.
    Pending,
}

async fn apply_delete_line(config: &HistoryConfig, line: &str) -> DeleteStep {
    let Some((project, document)) = line.split_once('\t') else {
        return DeleteStep::Done;
    };
    let Some(url) = config.url.as_deref().filter(|value| !value.is_empty()) else {
        // Sync is off in this build. There is no online copy to delete.
        return DeleteStep::Done;
    };
    if !transit_allowed(url, config.allow_insecure) {
        return DeleteStep::Pending;
    }
    let Some(token) = config.token.as_deref().filter(|value| !value.is_empty()) else {
        // Signed out: the delete waits for the next sign-in.
        return DeleteStep::Pending;
    };
    if !path_id(project) || (document != "*" && !path_id(document)) {
        return DeleteStep::Done;
    }
    let base = url.trim_end_matches('/');
    let target = if document == "*" {
        format!("{base}/v1/projects/{project}")
    } else {
        format!("{base}/v1/projects/{project}/documents/{document}")
    };
    match exchange("DELETE", &target, token, None).await {
        Ok(reply) if (200..300).contains(&reply.status) || reply.status == 404 => DeleteStep::Done,
        _ => DeleteStep::Pending,
    }
}

async fn replay_deletes(home: &Path, config: &HistoryConfig) {
    let lines = match read_queue(&home.join(DELETE_OUTBOX)) {
        Ok(lines) => lines,
        Err(error) => {
            eprintln!("[history] the delete queue could not be read: {error}");
            return;
        }
    };
    for line in lines {
        if let DeleteStep::Done = apply_delete_line(config, &line).await {
            unqueue_delete(home, &line);
        }
    }
}

/// The plan is written to the delete queue first, so a failure or a crash
/// here leaves it queued. Each line that lands leaves the queue.
pub(crate) async fn history_delete_plan(
    home: &Path,
    config: &HistoryConfig,
    plan: &DeletePlan,
) -> Result<(), AppError> {
    let queued = queue_delete_plan(home, plan);
    let mut pending = false;
    for line in delete_lines(plan) {
        match apply_delete_line(config, &line).await {
            DeleteStep::Done if queued.is_ok() => unqueue_delete(home, &line),
            DeleteStep::Done => {}
            DeleteStep::Pending => pending = true,
        }
    }
    match queued {
        Err(error) if pending => Err(error),
        _ => Ok(()),
    }
}

/// The deleted documents' sync ids and queued uploads go. A file made later
/// under the same name starts as a new document, not as the deleted one.
/// Runs only once the server delete is done or queued: until then the old
/// entry is what keeps a pull from bringing the file back.
fn forget_deleted(home: &Path, plan: &DeletePlan) {
    if plan.documents.is_empty() {
        // The whole folder went to the Trash, its sync notes with it.
        return;
    }
    if plan.root.join(SYNC_FILE).is_file() {
        let result = with_book(&plan.root, |book| {
            if book.project_id == plan.project_id {
                book.documents
                    .retain(|_, doc| !plan.documents.contains(&doc.id));
            }
            Ok(())
        });
        if let Err(error) = result {
            eprintln!("[history] the sync notes still name a deleted document: {error}");
        }
    }
    let result = edit_queue(&outbox_for(home), |lines| {
        lines.retain(|line| {
            !matches!(parse_outbox_line(line), OutboxLine::Entry(queued)
                if queued.project == plan.project_id && plan.documents.contains(&queued.document))
        });
    });
    if let Err(error) = result {
        eprintln!("[history] a deleted document stayed in the outbox: {error}");
    }
}

/// After the file is in the Trash. Signed out, or with no session to read,
/// the server delete is queued, never skipped.
pub(crate) async fn delete_from_history(
    app: &tauri::AppHandle,
    home: Option<&Path>,
    plan: &DeletePlan,
) {
    let Some(home) = home else {
        eprintln!("[history] no app folder: the online copy was not deleted");
        return;
    };
    let config = config_from_app(app, home).await;
    delete_from_history_at(home, config, plan).await;
}

async fn delete_from_history_at(
    home: &Path,
    config: Result<HistoryConfig, AppError>,
    plan: &DeletePlan,
) {
    let recorded = match config {
        Ok(config) => history_delete_plan(home, &config, plan).await,
        Err(error) => {
            eprintln!("[history] the online delete waits for the session: {error}");
            queue_delete_plan(home, plan)
        }
    };
    match recorded {
        Ok(()) => forget_deleted(home, plan),
        Err(error) => {
            eprintln!("[history] the online copy was neither deleted nor queued: {error}")
        }
    }
}

/// A queued delete for this document or its whole project.
fn delete_pending(pending: &[String], project: &str, document: &str) -> bool {
    pending.iter().filter_map(|line| line.split_once('\t')).any(
        |(queued_project, queued_document)| {
            queued_project == project && (queued_document == "*" || queued_document == document)
        },
    )
}

/// A pull may write or remove `path` only when no component between the folder
/// and the file is a symlink, and the canonical parent stays inside the folder.
/// shortcut: checked before the write, so a symlink swapped in afterwards is still
/// followed. Upgrade is O_NOFOLLOW on each component, the way image export opens a picture.
fn copy_stays_in_folder(root: &Path, path: &Path) -> bool {
    let Ok(root_canon) = fs::canonicalize(root) else {
        return false;
    };
    let mut names = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if at_folder_root(&current, root, &root_canon) {
            break;
        }
        let Some(name) = current.file_name() else {
            return false;
        };
        if name == "." || name == ".." {
            return false;
        }
        names.push(name.to_os_string());
        if names.len() > 64 {
            return false;
        }
        let Some(parent) = current.parent() else {
            return false;
        };
        if parent == current {
            return false;
        }
        current = parent.to_path_buf();
    }
    if names.is_empty() {
        return false;
    }
    names.reverse();
    let mut cursor = current;
    for (index, name) in names.iter().enumerate() {
        cursor.push(name);
        let last = index + 1 == names.len();
        match fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.file_type().is_symlink() => return false,
            Ok(meta) if !last && !meta.is_dir() => return false,
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
    }
    cursor
        .parent()
        .is_some_and(|parent| canonical_parent_inside(&root_canon, parent))
}

/// True when `current` is the folder itself. A symlink that is the folder
/// (macOS `/var` -> `/private/var`) is the root. A symlink inside the folder
/// is not, even when it points back at the folder.
fn at_folder_root(current: &Path, root: &Path, root_canon: &Path) -> bool {
    if current == root || current == root_canon {
        return true;
    }
    let Ok(canon) = fs::canonicalize(current) else {
        return false;
    };
    if canon != root_canon {
        return false;
    }
    let Some(parent) = current.parent() else {
        return true;
    };
    match fs::canonicalize(parent) {
        Ok(parent_canon) => parent_canon != root_canon && !parent_canon.starts_with(root_canon),
        Err(_) => true,
    }
}

fn canonical_parent_inside(root_canon: &Path, parent: &Path) -> bool {
    let mut missing = Vec::new();
    let mut current = parent.to_path_buf();
    for _ in 0..64 {
        if let Ok(canon) = fs::canonicalize(&current) {
            if !canon.starts_with(root_canon) {
                return false;
            }
            let mut rebuilt = canon;
            for name in missing.iter().rev() {
                rebuilt.push(name);
            }
            return rebuilt.starts_with(root_canon);
        }
        let Some(name) = current.file_name() else {
            return false;
        };
        missing.push(name.to_os_string());
        let Some(parent) = current.parent() else {
            return false;
        };
        if parent == current {
            return false;
        }
        current = parent.to_path_buf();
    }
    false
}

fn copy_allowed(root: &Path, path: &Path) -> bool {
    if copy_stays_in_folder(root, path) {
        return true;
    }
    eprintln!(
        "history: skipped a copy outside the folder: {}",
        path.display()
    );
    false
}

/// Ask the server for this account's documents and apply the ones in this folder.
async fn history_pull_at(
    home: &Path,
    root: &Path,
    config: &HistoryConfig,
    online: bool,
    dirty: &[PathBuf],
) -> Result<PullOutcome, AppError> {
    let empty = || PullOutcome {
        suggestions: Vec::new(),
        wrote: Vec::new(),
        removed: Vec::new(),
        failed: Vec::new(),
        proposals: None,
        proposals_unread: Vec::new(),
    };
    if !online {
        return Ok(empty());
    }
    let Some(url) = config.url.as_deref().filter(|value| !value.is_empty()) else {
        return Ok(empty());
    };
    if !transit_allowed(url, config.allow_insecure) {
        return Ok(empty());
    }
    let Some(token) = config.token.as_deref().filter(|value| !value.is_empty()) else {
        return Ok(empty());
    };
    replay_deletes(home, config).await;
    // What is still queued must not come back as a new file.
    let pending = read_queue(&home.join(DELETE_OUTBOX))?;
    let list_url = format!("{}/v1/documents", url.trim_end_matches('/'));
    let reply = match exchange("GET", &list_url, token, None).await {
        Ok(reply) if (200..300).contains(&reply.status) => reply,
        _ => return Ok(empty()),
    };
    let listed: ListBody =
        serde_json::from_str(&reply.body).map_err(|error| AppError::Io(error.to_string()))?;
    // Adopt now, so the save below and any send in between agree on the id.
    let book = with_book(root, |book| {
        maybe_adopt(book, &listed.documents, root);
        Ok(book.clone())
    })?;
    let project = book.project_id.clone();
    let set = MacOnlySet::load_or_block(Some(home));
    // Fetch with no lock held. The book is read again below, after the waits.
    let mut fetched = Vec::new();
    for remote in listed.documents.iter().filter(|doc| {
        doc.project_id == project && listed_copy_ok(&doc.project_id, &doc.document_id, &doc.name)
    }) {
        let path = root.join(&remote.name);
        if dirty.iter().any(|item| item == &path)
            || delete_pending(&pending, &remote.project_id, &remote.document_id)
            || !may_bring(&set, &path)
        {
            continue;
        }
        if !may_take_listed(&book, remote) {
            continue;
        }
        if let Some(doc) = book.documents.get(&remote.name) {
            let known = !doc.base_version_id.is_empty() || !doc.seen_version_id.is_empty();
            if known && doc.id != remote.document_id {
                continue;
            }
            if !remote.deleted
                && !doc.base_version_id.is_empty()
                && remote.version_id == doc.base_version_id
            {
                continue;
            }
        }
        // The entry this copy is decided against, and the base_version_id on it.
        // A send, a settle, or a rename that lands during the download moves the
        // entry on, and the copy then answers a base that is gone.
        let began = book.documents.get(&remote.name).cloned();
        let fetched_base = began
            .as_ref()
            .map(|doc| doc.base_version_id.clone())
            .unwrap_or_default();
        let remote_text = if remote.deleted {
            None
        } else {
            let Some(doc_url) = endpoint(config, &project, &remote.document_id) else {
                continue;
            };
            match get_copy(&doc_url, token).await {
                Ok(Some((text, _, _))) => Some(text),
                _ => continue,
            }
        };
        fetched.push((remote, path, remote_text, fetched_base, began));
    }
    let mut outcome = empty();
    with_book(root, |book| {
        if book.project_id != project {
            return Ok(());
        }
        for (remote, path, remote_text, fetched_base, began) in fetched {
            // A save or a settle moved base_version_id while the copy was on its
            // way, so this listing is older than the book. The whole entry is
            // compared too: a reject moves seen_version_id and leaves the base
            // where it was. The next pull lists it again.
            let base_now = book
                .documents
                .get(&remote.name)
                .map_or("", |doc| doc.base_version_id.as_str());
            if base_now != fetched_base || book.documents.get(&remote.name) != began.as_ref() {
                eprintln!(
                    "[history] pull skipped {}: its sync entry changed during the download",
                    remote.name
                );
                continue;
            }
            if !may_bring(&set, &path) {
                continue;
            }
            if let Err(error) =
                bring_listed(book, root, remote, &path, remote_text, &mut outcome, &|| {})
            {
                eprintln!("[history] pull could not apply {}: {error}", remote.name);
                outcome.failed.push(path.to_string_lossy().into_owned());
            }
        }
        Ok(())
    })?;
    // After the copies, so a document this pull just wrote already has its entry.
    if let Some((proposals, unread)) =
        pull_proposals(home, root, config, &listed.documents, &project, &pending).await
    {
        outcome.proposals = Some(proposals);
        outcome.proposals_unread = unread;
    }
    Ok(outcome)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedProposal {
    proposal_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct ProposalsBody {
    proposals: Vec<ListedProposal>,
}

/// `project<TAB>document<TAB>proposal`. Each part is a random id.
fn decision_line(project: &str, document: &str, proposal: &str) -> String {
    format!("{project}\t{document}\t{proposal}")
}

/// The suggestions waiting on one document. An answer that is not the list is an error.
async fn get_proposals(url: &str, token: &str) -> Result<Vec<ListedProposal>, ()> {
    let reply = exchange("GET", url, token, None).await.map_err(|_| ())?;
    if !(200..300).contains(&reply.status) {
        return Err(());
    }
    let body: ProposalsBody = serde_json::from_str(&reply.body).map_err(|_| ())?;
    Ok(body.proposals)
}

/// The suggested additions for this folder's documents, and the documents that
/// could not be asked. `None` when nothing can be said this time.
///
/// A document is asked about only when the list says one is waiting, this
/// folder's notes hold its id under a name inside the folder, the file is here,
/// it may leave this Mac, and no delete of it is waiting. A suggestion whose
/// decision is still queued is left out, so a card the writer already answered
/// does not come back.
async fn pull_proposals(
    home: &Path,
    root: &Path,
    config: &HistoryConfig,
    listed: &[ListedDoc],
    project: &str,
    pending_deletes: &[String],
) -> Option<(Vec<PulledProposal>, Vec<String>)> {
    let token = config.token.as_deref().filter(|value| !value.is_empty())?;
    replay_proposal_decisions(home, config).await;
    let decided = match read_queue(&home.join(PROPOSAL_OUTBOX)) {
        Ok(lines) => lines,
        Err(error) => {
            eprintln!("[history] the decision queue could not be read: {error}");
            return None;
        }
    };
    // Both read now, after the waits above: the copies may have added entries, a
    // rename moves one, and a document kept during this pull is not asked about.
    let book = load_book(root).ok()?;
    if book.project_id != project {
        return None;
    }
    let set = MacOnlySet::load_or_block(Some(home));
    let mut proposals = Vec::new();
    let mut unread = Vec::new();
    for remote in listed.iter().filter(|doc| {
        doc.project_id == project
            && !doc.deleted
            && doc.waiting() > 0
            && decision_id(&doc.project_id)
            && decision_id(&doc.document_id)
    }) {
        // The name this Mac has for that id, wherever a rename moved it. The notes
        // are a file in the folder: a name that leaves the folder is not followed.
        let Some(name) = book
            .documents
            .iter()
            .find(|(name, doc)| {
                doc.id == remote.document_id && !doc.absent && safe_local_name(name)
            })
            .map(|(name, _)| name)
        else {
            continue;
        };
        let path = root.join(name);
        if delete_pending(pending_deletes, project, &remote.document_id)
            || !path.is_file()
            || !may_bring(&set, &path)
        {
            continue;
        }
        let Some(doc_url) = endpoint(config, project, &remote.document_id) else {
            continue;
        };
        let shown = path.to_string_lossy().into_owned();
        let Ok(waiting) = get_proposals(&format!("{doc_url}/proposals"), token).await else {
            unread.push(remote.document_id.clone());
            continue;
        };
        for item in waiting {
            if !decision_id(&item.proposal_id) || item.text.trim().is_empty() {
                continue;
            }
            if decided.contains(&decision_line(
                project,
                &remote.document_id,
                &item.proposal_id,
            )) {
                continue;
            }
            proposals.push(PulledProposal {
                path: shown.clone(),
                project_id: project.to_string(),
                document_id: remote.document_id.clone(),
                proposal_id: item.proposal_id,
                text: item.text,
            });
        }
    }
    Some((proposals, unread))
}

/// The ids the notes hold for `path` now. Nothing is created: a document that
/// has never synced, or is gone here, has none.
fn document_identity_at(path: &Path, workspace: Option<&Path>) -> Option<DocumentIdentity> {
    let root = project_root(path, workspace);
    if !root.join(SYNC_FILE).is_file() {
        return None;
    }
    let book = load_book(&root).ok()?;
    let name = relative_name(&root, path).ok()?;
    let doc = book.documents.get(&name).filter(|doc| !doc.absent)?;
    Some(DocumentIdentity {
        project_id: book.project_id.clone(),
        document_id: doc.id.clone(),
    })
}

/// Which synced document is open at `path`. Read from this folder's notes, with
/// no request: the margin asks before it paints a suggestion's card.
#[tauri::command]
pub async fn history_document_identity(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<DocumentIdentity>, AppError> {
    let file = PathBuf::from(&path);
    let workspace = workspace_containing(&app, &file);
    Ok(document_identity_at(&file, workspace.as_deref()))
}

/// Tell the server to forget one decided suggestion. It is not told which way
/// the writer decided, and the request names three random ids and no text.
///
/// Only a success ends the line. The server answers a suggestion, a document,
/// or a folder that is already gone with a success too, so any refusal means
/// the decision has not landed: a 404 is a server that does not have this
/// route (an older one, or a proxy), and a 400 is its catch-all for a fault.
/// A line that is not three ids in the server's form can never be sent, and is
/// dropped rather than kept for good.
async fn apply_decision_line(config: &HistoryConfig, line: &str) -> DeleteStep {
    let parts: Vec<&str> = line.split('\t').collect();
    let [project, document, proposal] = parts.as_slice() else {
        return DeleteStep::Done;
    };
    if !decision_id(project) || !decision_id(document) || !decision_id(proposal) {
        return DeleteStep::Done;
    }
    let Some(url) = config.url.as_deref().filter(|value| !value.is_empty()) else {
        // Sync is off in this build. Nothing online holds the suggestion.
        return DeleteStep::Done;
    };
    if !transit_allowed(url, config.allow_insecure) {
        return DeleteStep::Pending;
    }
    let Some(token) = config.token.as_deref().filter(|value| !value.is_empty()) else {
        // Signed out: the decision waits for the next sign-in.
        return DeleteStep::Pending;
    };
    let target = format!(
        "{}/v1/projects/{project}/documents/{document}/proposals/{proposal}",
        url.trim_end_matches('/')
    );
    match exchange("DELETE", &target, token, None).await {
        Ok(reply) if (200..300).contains(&reply.status) => DeleteStep::Done,
        _ => DeleteStep::Pending,
    }
}

/// Only this line goes. A decision queued meanwhile stays queued.
fn unqueue_decision(home: &Path, line: &str) {
    let result = edit_queue(&home.join(PROPOSAL_OUTBOX), |queued| {
        queued.retain(|existing| existing != line);
    });
    if let Err(error) = result {
        eprintln!("[history] a sent decision stayed queued: {error}");
    }
}

async fn replay_proposal_decisions(home: &Path, config: &HistoryConfig) {
    let lines = match read_queue(&home.join(PROPOSAL_OUTBOX)) {
        Ok(lines) => lines,
        Err(error) => {
            eprintln!("[history] the decision queue could not be read: {error}");
            return;
        }
    };
    for line in lines {
        if let DeleteStep::Done = apply_decision_line(config, &line).await {
            unqueue_decision(home, &line);
        }
    }
}

/// Write the decision to the queue. Returns its line, and whether it is on
/// disk. Ids that are not the server's form are an error: nothing is queued.
fn record_decision(
    home: &Path,
    project_id: &str,
    document_id: &str,
    proposal_id: &str,
) -> Result<(String, Result<(), AppError>), AppError> {
    for id in [project_id, document_id, proposal_id] {
        if !decision_id(id) {
            return Err(AppError::InvalidPath(id.to_string()));
        }
    }
    let line = decision_line(project_id, document_id, proposal_id);
    let queued = edit_queue(&home.join(PROPOSAL_OUTBOX), |lines| {
        if !lines.contains(&line) {
            lines.push(line.clone());
        }
    });
    Ok((line, queued))
}

/// Try to send a recorded decision now. With no config (the session could not
/// be read) it stays queued. An error means it was neither sent nor queued:
/// the card can come back.
async fn send_decision(
    home: &Path,
    config: Option<&HistoryConfig>,
    line: &str,
    queued: Result<(), AppError>,
) -> Result<(), AppError> {
    let Some(config) = config else {
        return queued;
    };
    match apply_decision_line(config, line).await {
        DeleteStep::Done => {
            if queued.is_ok() {
                unqueue_decision(home, line);
            }
            Ok(())
        }
        DeleteStep::Pending => queued,
    }
}

/// Record, then send. The command does the same with the session read in between.
#[cfg(test)]
async fn history_proposal_decide_at(
    home: &Path,
    config: Option<&HistoryConfig>,
    project_id: &str,
    document_id: &str,
    proposal_id: &str,
) -> Result<(), AppError> {
    let (line, queued) = record_decision(home, project_id, document_id, proposal_id)?;
    send_decision(home, config, &line, queued).await
}

/// The writer accepted or rejected a suggested addition. Accept has already
/// written the text into the document. This only stops the card coming back.
///
/// The decision is on disk before the session is read: reading it can wait on
/// the network, and a quit in that wait must not lose the decision. A later
/// pull sends whatever is still queued.
#[tauri::command]
pub async fn history_proposal_decide(
    app: tauri::AppHandle,
    project_id: String,
    document_id: String,
    proposal_id: String,
) -> Result<(), AppError> {
    let home = home_dir(&app)?;
    let (line, queued) = record_decision(&home, &project_id, &document_id, &proposal_id)?;
    let config = match config_from_app(&app, &home).await {
        Ok(config) => Some(config),
        Err(error) => {
            eprintln!("[history] the decision waits for the session: {error}");
            None
        }
    };
    send_decision(&home, config.as_ref(), &line, queued).await
}

/// A kept document is neither fetched nor written.
fn may_bring(set: &MacOnlySet, path: &Path) -> bool {
    let local = fs::read_to_string(path).unwrap_or_default();
    depart(
        set,
        path,
        Channel::Backup,
        &[(path, local.as_str())],
        || Ok(()),
    )
    .is_ok()
}

/// One listed copy, decided against the book and the file as they are now.
/// Runs under the book lock. An error leaves this entry unchanged.
/// A listed copy may name a book entry here only by its own name.
/// - Its id under another name: this Mac renamed it (or the other Mac did).
///   Taking it would write the old name back beside the new one and leave
///   two entries with one id, so it waits for the next save.
/// - A tombstone with no entry under its name: there is nothing here to
///   remove, and an entry made for it would hand the deleted id to a new
///   file with that name.
fn may_take_listed(book: &SyncBook, remote: &ListedDoc) -> bool {
    let elsewhere = book
        .documents
        .iter()
        .any(|(name, doc)| name != &remote.name && doc.id == remote.document_id);
    if elsewhere {
        return false;
    }
    !remote.deleted || book.documents.contains_key(&remote.name)
}

/// Write a pulled copy over `path` only while the file still reads as `read_as`, the
/// text the pull decided on. The copy is written to a temp file beside it first, the file
/// is read again, and only then renamed into place. A save that lands after the decision
/// is not truncated: the copy is skipped (`false`), and the next pull decides again.
/// `before_replace` runs just before that last read, so a test can land a save there.
fn place_pulled(
    path: &Path,
    text: &str,
    read_as: Option<&str>,
    before_replace: &dyn Fn(),
) -> Result<bool, AppError> {
    let io = |error: std::io::Error| AppError::Io(error.to_string());
    // A symlinked note inside the folder (`copy_allowed`) is written at its target, as a
    // save does, so the link keeps pointing at the document.
    let target = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path).map_err(io)?,
        _ => path.to_path_buf(),
    };
    let dir = target
        .parent()
        .ok_or_else(|| AppError::Io("No parent directory".into()))?;
    fs::create_dir_all(dir).map_err(io)?;
    let temp = dir.join(format!(".~{}", uuid::Uuid::new_v4()));
    // The temp file is created with the note's mode, so a private (0600) note's pulled
    // text is never readable by others while it is staged; the exact mode is then set
    // past the umask.
    let staged = (|| -> std::io::Result<()> {
        use std::io::Write as _;
        let existing = fs::metadata(&target).ok().map(|meta| meta.permissions());
        let mut file = create_copy_file(&temp, existing.as_ref())?;
        file.write_all(text.as_bytes())?;
        drop(file);
        if let Some(permissions) = existing {
            fs::set_permissions(&temp, permissions)?;
        }
        Ok(())
    })();
    if let Err(error) = staged {
        let _ = fs::remove_file(&temp);
        return Err(io(error));
    }
    before_replace();
    if fs::read_to_string(&target).ok().as_deref() != read_as {
        let _ = fs::remove_file(&temp);
        return Ok(false);
    }
    if let Err(error) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(io(error));
    }
    Ok(true)
}

fn bring_listed(
    book: &mut SyncBook,
    root: &Path,
    remote: &ListedDoc,
    path: &Path,
    remote_text: Option<String>,
    outcome: &mut PullOutcome,
    before_replace: &dyn Fn(),
) -> Result<(), AppError> {
    if !may_take_listed(book, remote) {
        return Ok(());
    }
    // A listed name that reaches outside the folder through a symlink is
    // neither read, written nor removed, and the book is left as it is.
    if !copy_allowed(root, path) {
        return Ok(());
    }
    let doc = ensure_doc(book, &remote.name);
    if doc.base_version_id.is_empty() && doc.seen_version_id.is_empty() {
        doc.id = remote.document_id.clone();
    }
    if doc.id != remote.document_id {
        return Ok(());
    }
    if !remote.deleted
        && !doc.base_version_id.is_empty()
        && remote.version_id == doc.base_version_id
    {
        // An upload or a settle caught up while the copy was on its way.
        return Ok(());
    }
    let local = fs::read_to_string(path).ok();
    let action = decide_copy(
        local.as_deref(),
        &doc.base_hash,
        &doc.base_version_id,
        &remote.version_id,
        remote_text.as_deref(),
        remote.deleted,
        doc.absent,
    );
    match action {
        CopyAction::Keep => {
            let hash = remote_text
                .as_deref()
                .or(local.as_deref())
                .map(content_hash)
                .unwrap_or_else(|| doc.base_hash.clone());
            doc.synced(&remote.version_id, hash);
            if remote.deleted {
                doc.absent = true;
            }
        }
        CopyAction::Write => {
            let text = remote_text.unwrap_or_default();
            if !place_pulled(path, &text, local.as_deref(), before_replace)? {
                eprintln!(
                    "[history] pull skipped {}: the file changed after the copy was chosen",
                    remote.name
                );
                return Ok(());
            }
            doc.synced(&remote.version_id, content_hash(&text));
            outcome.wrote.push(path.to_string_lossy().into_owned());
        }
        CopyAction::Remove => {
            // The same check as a write: a save since the decision keeps the file.
            before_replace();
            if fs::read_to_string(path).ok() != local {
                eprintln!(
                    "[history] pull skipped removing {}: the file changed after it was read",
                    remote.name
                );
                return Ok(());
            }
            if path.exists() {
                fs::remove_file(path).map_err(|error| AppError::Io(error.to_string()))?;
            }
            doc.removed(&remote.version_id);
            outcome.removed.push(path.to_string_lossy().into_owned());
        }
        CopyAction::Suggest => {
            // Their copy, when there is one. A missing text, or an empty one
            // with no version, is not a document: offering it would let one
            // click wipe the file.
            let other = if remote.deleted {
                String::new()
            } else {
                match remote_text {
                    Some(text) if !(text.is_empty() && remote.version_id.is_empty()) => text,
                    _ => return Ok(()),
                }
            };
            outcome.suggestions.push(BringOutcome {
                path: path.to_string_lossy().into_owned(),
                overlap: true,
                other_text: Some(other),
                local_text: Some(local.unwrap_or_default()),
                skipped: false,
                deleted: remote.deleted,
                version_id: remote.version_id.clone(),
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn history_pull(
    app: tauri::AppHandle,
    root: String,
    dirty: Vec<String>,
    online: bool,
) -> Result<PullOutcome, AppError> {
    let home = home_dir(&app)?;
    let config = config_for(
        device_id(&home)?,
        crate::commands::account::access_token_from_app(&app).await?,
    );
    let dirty: Vec<PathBuf> = dirty.into_iter().map(PathBuf::from).collect();
    history_pull_at(&home, Path::new(&root), &config, online, &dirty).await
}

#[tauri::command]
pub async fn history_settle(
    app: tauri::AppHandle,
    path: String,
    choice: String,
    version_id: String,
    other_text: String,
    deleted: bool,
) -> Result<SendOutcome, AppError> {
    let home = home_dir(&app)?;
    let config = config_for(
        device_id(&home)?,
        crate::commands::account::access_token_from_app(&app).await?,
    );
    let file = PathBuf::from(&path);
    let workspace = workspace_containing(&app, &file);
    history_settle_at(
        &home,
        &file,
        &config,
        workspace.as_deref(),
        &choice,
        &version_id,
        &other_text,
        deleted,
    )
    .await
}

async fn history_settle_at(
    home: &Path,
    path: &Path,
    config: &HistoryConfig,
    workspace: Option<&Path>,
    choice: &str,
    version_id: &str,
    other_text: &str,
    deleted: bool,
) -> Result<SendOutcome, AppError> {
    let root = project_root(path, workspace);
    if choice == "accept" && !copy_allowed(&root, path) {
        return Err(AppError::InvalidPath(path.to_string_lossy().into_owned()));
    }
    if choice == "accept" && deleted {
        if path.exists() {
            fs::remove_file(path).map_err(|error| AppError::Io(error.to_string()))?;
        }
        let name = relative_name(&root, path)?;
        with_book(&root, |book| {
            ensure_doc(book, &name).removed(version_id);
            Ok(())
        })?;
        return Ok(Sent::Stored.wire());
    }
    if choice == "accept" && other_text.is_empty() && version_id.is_empty() {
        // No version was named. The empty string is not their copy: nothing
        // is written and nothing is sent (an all-false outcome).
        return Ok(Sent::Held.wire());
    }
    if choice == "accept" {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| AppError::Io(error.to_string()))?;
        }
        fs::write(path, other_text).map_err(|error| AppError::Io(error.to_string()))?;
        note_synced_at(&root, &relative_name(&root, path)?, version_id, other_text)?;
        return Ok(Sent::Stored.wire());
    }
    if choice == "reject" {
        let name = relative_name(&root, path)?;
        with_book(&root, |book| {
            let doc = ensure_doc(book, &name);
            doc.seen_version_id = version_id.to_string();
            doc.absent = false;
            Ok(())
        })?;
        return history_send_at(home, path, true, config, workspace).await;
    }
    Err(AppError::InvalidPath(choice.into()))
}

/// Move a stored id when a file is renamed. The id does not follow the path.
/// A failure is logged; [`try_retarget_sync`] returns it.
pub fn retarget_sync(old: &Path, new: &Path, workspace: Option<&Path>, was_dir: bool) {
    if let Err(error) = try_retarget_sync(old, new, workspace, was_dir) {
        eprintln!("[history] the sync id did not follow a rename: {error}");
    }
}

/// `Ok(false)`: this folder has no sync notes, or the new name is outside it.
pub(crate) fn try_retarget_sync(
    old: &Path,
    new: &Path,
    workspace: Option<&Path>,
    was_dir: bool,
) -> Result<bool, AppError> {
    let root = project_root(old, workspace);
    if !root.join(SYNC_FILE).is_file() {
        return Ok(false);
    }
    let (Ok(old_name), Ok(new_name)) = (relative_name(&root, old), relative_name(&root, new))
    else {
        return Ok(false);
    };
    with_book(&root, |book| {
        if was_dir {
            let keys: Vec<_> = book
                .documents
                .keys()
                .filter(|name| *name == &old_name || name.starts_with(&format!("{old_name}/")))
                .cloned()
                .collect();
            for key in keys {
                let Some(doc) = book.documents.remove(&key) else {
                    continue;
                };
                let rest = key.strip_prefix(&old_name).unwrap_or("");
                book.documents.insert(format!("{new_name}{rest}"), doc);
            }
        } else if let Some(doc) = book.documents.remove(&old_name) {
            book.documents.insert(new_name, doc);
        }
        Ok(true)
    })
}

#[tauri::command]
pub async fn history_delete_project(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<(), AppError> {
    let url = compiled_history_url().ok_or_else(|| AppError::Io("no copy destination".into()))?;
    let token = session_bearer(crate::commands::account::access_token_from_app(&app).await?)
        .ok_or_else(|| AppError::Io("no copy destination".into()))?;
    let allow = loopback_http(&url);
    if !transit_allowed(&url, allow) {
        return Err(AppError::Io("this connection has to be scrambled".into()));
    }
    if !path_id(&project_id) {
        return Err(AppError::InvalidPath(project_id));
    }
    let endpoint = format!("{}/v1/projects/{project_id}", url.trim_end_matches('/'));
    install_rustls();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| AppError::Io(error.to_string()))?;
    let response = client
        .delete(endpoint)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|error| AppError::Io(error.to_string()))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(AppError::Io("the copy could not be removed".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mac_only::set_kept;
    use tempfile::TempDir;

    #[cfg(unix)]
    #[test]
    fn deleting_a_project_folder_through_a_linked_parent_deletes_the_project() {
        let tmp = TempDir::new().unwrap();
        let real = tmp.path().join("real");
        let project = real.join("project");
        fs::create_dir_all(&project).unwrap();
        let book = SyncBook::fresh();
        save_book(&project, &book).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let plan = plan_delete(&link.join("project"), None)
            .expect("the folder is the sync project, so its whole history goes");
        assert_eq!(plan.project_id, book.project_id);
        assert!(plan.documents.is_empty(), "{:?}", plan.documents);
    }

    fn config(url: Option<&str>) -> HistoryConfig {
        HistoryConfig {
            url: url.map(str::to_string),
            token: Some("token".into()),
            allow_insecure: true,
            device_id: "device-a".into(),
        }
    }

    #[test]
    fn accepting_an_empty_conflict_does_not_wipe_the_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("draft.md");
        fs::write(&file, "keep me\n").unwrap();
        let home = TempDir::new().unwrap();
        let outcome = block_on(history_settle_at(
            home.path(),
            &file,
            &config(None),
            None,
            "accept",
            "",
            "",
            false,
        ))
        .unwrap();
        assert!(!outcome.conflict);
        assert!(!outcome.sent, "{outcome:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep me\n");
    }

    #[test]
    fn a_conflict_without_their_copy_is_not_offered() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("draft.md");
        fs::write(&file, "keep me\n").unwrap();
        let home = TempDir::new().unwrap();
        let root = project_root(&file, None);
        let entry = OutboxEntry {
            root: root.to_string_lossy().into_owned(),
            project: "p".into(),
            document: "d".into(),
        };
        let finish = |body: &str| {
            finish_exchange(
                home.path(),
                &root,
                &file,
                &entry,
                b"{}",
                posted_from(Reply {
                    status: 409,
                    body: body.into(),
                }),
            )
            .unwrap()
            .wire()
        };
        for body in [
            r#"{"error":"stale","versionId":"","deleted":false}"#,
            r#"{"error":"stale","versionId":"","text":"","deleted":false}"#,
            r#"{"error":"stale","versionId":"v1","deleted":false}"#,
        ] {
            let outcome = finish(body);
            assert!(!outcome.conflict, "{body} -> {outcome:?}");
            assert!(outcome.other_text.is_none(), "{body}");
            assert_eq!(fs::read_to_string(&file).unwrap(), "keep me\n");
        }
        let cleared = finish(r#"{"error":"stale","versionId":"v9","text":"","deleted":false}"#);
        assert!(cleared.conflict, "{cleared:?}");
        assert_eq!(cleared.other_text.as_deref(), Some(""));
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep me\n");
    }

    /// The folder is reached through a symlink (macOS `/var` -> `/private/var`).
    #[cfg(unix)]
    #[test]
    fn a_symlinked_folder_keeps_one_identity_and_one_relative_name() {
        let real = TempDir::new().unwrap();
        let outer = TempDir::new().unwrap();
        let link = outer.path().join("linked");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();
        let through = link.join("Untitled.md");
        fs::write(&through, "draft\n").unwrap();
        let physical = real.path().join("Untitled.md");

        assert_eq!(identity(&through), identity(&physical));
        let root = project_root(&through, None);
        assert_eq!(relative_name(&root, &through).unwrap(), "Untitled.md");

        let home = TempDir::new().unwrap();
        let url = config(Some("https://history.example"));
        let queue = |online| {
            send_or_queue(
                &through,
                online,
                &MacOnlySet::open(),
                &url,
                home.path(),
                |_, _, _| Ok(()),
            )
            .unwrap()
        };
        queue(false);
        fs::remove_file(&through).unwrap();
        // Gone: the same identity as when it existed, so its outbox line is dropped.
        assert_eq!(identity(&through), identity(&physical));
        queue(true);
        let outbox = fs::read_to_string(home.path().join(OUTBOX)).unwrap_or_default();
        assert!(outbox.trim().is_empty(), "{outbox}");
    }

    /// A note that is itself a symlink to a file outside its folder keeps its own name.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_note_keeps_its_own_relative_name() {
        let repo = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let target = outside.path().join("real.md");
        fs::write(&target, "outside\n").unwrap();
        fs::create_dir(repo.path().join("notes")).unwrap();
        let note = repo.path().join("notes/a.md");
        std::os::unix::fs::symlink(&target, &note).unwrap();
        assert_eq!(relative_name(repo.path(), &note).unwrap(), "notes/a.md");
        let root = project_root(&note, Some(repo.path()));
        assert_eq!(relative_name(&root, &note).unwrap(), "notes/a.md");
    }

    /// A directory symlink, including one that points back inside the folder, is not a write target.
    /// A folder opened through a symlink still accepts a note in that folder.
    #[cfg(unix)]
    #[test]
    fn a_copy_through_a_symlink_stays_inside_the_folder() {
        use std::os::unix::fs::symlink;
        let root_dir = TempDir::new().unwrap();
        let root = root_dir.path();
        let outside_dir = TempDir::new().unwrap();
        let outside = outside_dir.path();
        fs::write(outside.join("keep.md"), "keep\n").unwrap();
        fs::create_dir(root.join("notes")).unwrap();
        assert!(copy_stays_in_folder(root, &root.join("notes").join("a.md")));
        assert!(copy_stays_in_folder(
            root,
            &root.join("notes").join("sub").join("b.md")
        ));
        symlink(outside, root.join("escape")).unwrap();
        assert!(!copy_stays_in_folder(
            root,
            &root.join("escape").join("c.md")
        ));
        fs::create_dir(root.join("real")).unwrap();
        symlink(root.join("real"), root.join("alias")).unwrap();
        assert!(!copy_stays_in_folder(
            root,
            &root.join("alias").join("d.md")
        ));
        symlink(outside.join("keep.md"), root.join("linked.md")).unwrap();
        assert!(!copy_stays_in_folder(root, &root.join("linked.md")));
        assert!(!copy_stays_in_folder(
            root,
            &root.join("notes").join("..").join("keep.md")
        ));

        let linked_root = TempDir::new().unwrap();
        let real = linked_root.path().join("real");
        fs::create_dir(&real).unwrap();
        let via = linked_root.path().join("via");
        symlink(&real, &via).unwrap();
        assert!(copy_stays_in_folder(&via, &via.join("a.md")));
        assert!(copy_stays_in_folder(&real, &via.join("a.md")));
    }

    #[test]
    fn a_missing_file_is_not_uploaded_and_leaves_the_outbox() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("Untitled.md");
        fs::write(&file, "draft\n").unwrap();
        let home = TempDir::new().unwrap();
        let url = config(Some("https://history.example"));
        send_or_queue(
            &file,
            false,
            &MacOnlySet::open(),
            &url,
            home.path(),
            |_, _, _| Ok(()),
        )
        .unwrap();
        let outbox = fs::read_to_string(home.path().join(OUTBOX)).unwrap();
        assert_eq!(outbox.lines().filter(|l| !l.trim().is_empty()).count(), 1);

        fs::remove_file(&file).unwrap();
        let mut called = false;
        let outcome = send_or_queue(
            &file,
            true,
            &MacOnlySet::open(),
            &url,
            home.path(),
            |_, _, _| {
                called = true;
                Ok(())
            },
        )
        .unwrap();
        assert!(!called);
        assert!(!outcome.sent);
        let outbox = fs::read_to_string(home.path().join(OUTBOX)).unwrap_or_default();
        assert!(outbox.trim().is_empty(), "{outbox}");
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_is_an_error_not_an_empty_upload() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("locked.md");
        fs::write(&file, "secret\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        // Root ignores permissions, so the read still succeeds: nothing to check.
        if fs::read_to_string(&file).is_ok() {
            fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
            return;
        }
        let home = TempDir::new().unwrap();
        let mut called = false;
        let result = send_or_queue(
            &file,
            true,
            &MacOnlySet::open(),
            &config(Some("https://history.example")),
            home.path(),
            |_, _, _| {
                called = true;
                Ok(())
            },
        );
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(result.is_err());
        assert!(!called);
    }

    #[test]
    fn a_document_marked_keep_on_this_mac_is_never_queued_or_uploaded() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("draft.md");
        let secret = "HISTORY-QUEUE-SECRET-9cab stays on this Mac.\n";
        fs::write(&file, secret).unwrap();
        let home = TempDir::new().unwrap();
        set_kept(home.path(), &file, true).unwrap();
        let set = MacOnlySet::load(home.path());
        assert!(set.blocks(&file));

        let mut called = false;
        let mut seen = String::new();
        let outcome = send_or_queue(
            &file,
            true,
            &set,
            &config(Some("http://127.0.0.1:9")),
            home.path(),
            |_, _, body| {
                called = true;
                seen = String::from_utf8_lossy(body).into_owned();
                Ok(())
            },
        )
        .unwrap();
        assert!(outcome.refused, "{outcome:?}");
        assert!(!outcome.sent);
        assert!(!called);
        assert!(!seen.contains("HISTORY-QUEUE-SECRET-9cab"));
        let outbox = fs::read_to_string(home.path().join(OUTBOX)).unwrap_or_default();
        assert!(!outbox.contains("HISTORY-QUEUE-SECRET-9cab"), "{outbox}");
        assert!(
            !outbox.contains(&file.canonicalize().unwrap().to_string_lossy().to_string()),
            "{outbox}"
        );

        let offline = send_or_queue(
            &file,
            false,
            &set,
            &config(Some("https://history.example")),
            home.path(),
            |_, _, body| {
                called = true;
                seen = String::from_utf8_lossy(body).into_owned();
                Ok(())
            },
        )
        .unwrap();
        assert!(offline.refused, "{offline:?}");
        assert!(!offline.waiting);
        assert!(!called);
        let outbox = fs::read_to_string(home.path().join(OUTBOX)).unwrap_or_default();
        assert!(outbox.trim().is_empty(), "{outbox}");
    }

    #[test]
    fn a_marked_line_is_dropped_from_the_outbox_without_a_post() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("draft.md");
        let secret = "keep this sentence off the queue\n";
        fs::write(&file, secret).unwrap();
        let home = TempDir::new().unwrap();
        // Queued while offline, and a path line from an earlier version.
        let open = MacOnlySet::load(home.path());
        let queued = send_or_queue(
            &file,
            false,
            &open,
            &config(Some("https://history.example")),
            home.path(),
            |_, _, _| Ok(()),
        )
        .unwrap();
        assert!(queued.waiting);
        edit_queue(&outbox_for(home.path()), |lines| {
            lines.push(identity(&file))
        })
        .unwrap();
        set_kept(home.path(), &file, true).unwrap();
        let set = MacOnlySet::load(home.path());
        let mut called = false;
        let outcome = send_or_queue(
            &file,
            true,
            &set,
            &config(Some("https://history.example")),
            home.path(),
            |_, _, _| {
                called = true;
                Ok(())
            },
        )
        .unwrap();
        assert!(outcome.refused);
        assert!(!called);
        let outbox = fs::read_to_string(home.path().join(OUTBOX)).unwrap_or_default();
        assert!(!outbox.contains("keep this sentence"));
        assert!(outbox.trim().is_empty(), "{outbox}");
    }

    #[test]
    fn offline_writing_queues_the_document_and_not_the_essay() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("draft.md");
        fs::write(&file, "The river kept the bend.\n").unwrap();
        let home = TempDir::new().unwrap();
        let set = MacOnlySet::load(home.path());
        let mut called = false;
        let outcome = send_or_queue(
            &file,
            false,
            &set,
            &config(Some("https://history.example")),
            home.path(),
            |_, _, _| {
                called = true;
                Ok(())
            },
        )
        .unwrap();
        assert!(outcome.waiting);
        assert!(!outcome.sent);
        assert!(!called);
        let outbox = fs::read_to_string(home.path().join(OUTBOX)).unwrap();
        assert!(!outbox.contains("river"));
        let book = load_book(dir.path()).unwrap();
        let queued: Vec<_> = read_queue(&outbox_for(home.path()))
            .unwrap()
            .iter()
            .map(|line| parse_outbox_line(line))
            .collect();
        assert!(
            matches!(&queued[..], [OutboxLine::Entry(entry)]
                if entry.document == book.documents["draft.md"].id
                    && entry.project == book.project_id),
            "{outbox}"
        );
    }

    #[test]
    fn a_sync_id_with_a_slash_is_not_requested() {
        let config = HistoryConfig {
            url: Some("https://sync.example".into()),
            token: Some("token".into()),
            allow_insecure: false,
            device_id: "device-a".into(),
        };
        let id = "11111111-1111-4111-8111-111111111111";
        assert!(endpoint(&config, id, id).is_some());
        assert!(endpoint(&config, "../x", id).is_none());
        assert!(endpoint(&config, id, "a/b").is_none());
        assert!(endpoint(&config, id, "").is_none());
        assert!(endpoint(&config, "ok?x", id).is_none());
    }

    /// The table both sides are held to, so the Mac and the sync server agree on
    /// every name in it.
    #[test]
    fn a_listed_name_matches_the_server_rule() {
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../../../shared/history-name-rule.json")).unwrap();
        let names = |key: &str| -> Vec<String> {
            table[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap().to_string())
                .collect()
        };
        for name in names("stored") {
            assert!(safe_local_name(&name), "{name:?} should be stored");
        }
        for name in names("refused") {
            assert!(!safe_local_name(&name), "{name:?} should be refused");
        }
        assert!(
            safe_local_name(&"é".repeat(150)),
            "multi-byte letters under 200 characters"
        );
        assert!(safe_local_name(&"a".repeat(200)));
        assert!(!safe_local_name(&"a".repeat(201)));
    }

    #[test]
    fn a_clear_connection_is_refused() {
        assert!(!transit_allowed("http://history.example", false));
        assert!(transit_allowed("https://history.example", false));
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("draft.md");
        fs::write(&file, "hello\n").unwrap();
        let home = TempDir::new().unwrap();
        let set = MacOnlySet::load(home.path());
        let mut called = false;
        let outcome = send_or_queue(
            &file,
            true,
            &set,
            &HistoryConfig {
                url: Some("http://history.example".into()),
                token: Some("token".into()),
                allow_insecure: false,
                device_id: "device-a".into(),
            },
            home.path(),
            |_, _, _| {
                called = true;
                Ok(())
            },
        )
        .unwrap();
        assert!(outcome.refused);
        assert!(!called);
    }

    #[test]
    fn the_upload_body_is_only_the_version() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("draft.md");
        fs::write(&file, "hello\n").unwrap();
        let body = body_of(&file, "hello\n");
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "baseVersionId",
                "deviceId",
                "documentId",
                "folderName",
                "name",
                "projectId",
                "savedAt",
                "text",
                "versionId"
            ]
        );
        let version = value["versionId"].as_str().unwrap();
        assert_ne!(version.len(), format!("v{}", 1).len());
        assert!(version.contains('-'), "{version}");
        let encoded = identity(&file);
        assert!(!value.to_string().contains(&encoded), "{}", value);
    }

    #[test]
    fn the_history_bearer_is_the_session_and_a_limit_waits() {
        assert_eq!(session_bearer(None), None);
        assert_eq!(session_bearer(Some(String::new())), None);
        assert_eq!(
            session_bearer(Some("access-secret".into())).as_deref(),
            Some("access-secret")
        );
        assert!(waits_for_another_try(429));
        assert!(waits_for_another_try(503));
        assert!(!waits_for_another_try(401));
        assert!(!waits_for_another_try(404));
        let config = config_for("device-a".into(), Some("access-secret".into()));
        assert_eq!(config.token.as_deref(), Some("access-secret"));
        assert!(!format!("{config:?}").contains("access-secret"));
    }

    #[test]
    fn the_placeholder_history_url_keeps_sync_off() {
        assert!(history_base_from(None).is_none());
        assert!(history_base_from(Some("")).is_none());
        assert!(history_base_from(Some("   ")).is_none());
        assert!(history_base_from(Some(HISTORY_URL_PLACEHOLDER)).is_none());
        assert_eq!(
            history_base_from(Some("https://history.example/")).as_deref(),
            Some("https://history.example/")
        );
    }

    #[test]
    fn an_overlap_keeps_both_texts_and_a_kept_document_is_skipped() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("draft.md");
        fs::write(&file, "ours\n").unwrap();
        let home = TempDir::new().unwrap();
        let set = MacOnlySet::load(home.path());
        let config = config(Some("https://history.example"));
        let overlap = judge_bring(&file, &set, &config, Some("device-b"), Some("theirs\n"));
        assert!(overlap.overlap);
        assert_eq!(overlap.other_text.as_deref(), Some("theirs\n"));
        assert_eq!(overlap.local_text.as_deref(), Some("ours\n"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "ours\n");
        let echo = judge_bring(&file, &set, &config, Some("device-a"), Some("ours\n"));
        assert!(!echo.overlap);
        set_kept(home.path(), &file, true).unwrap();
        let marked = MacOnlySet::load(home.path());
        let skipped = judge_bring(&file, &marked, &config, Some("device-b"), Some("theirs\n"));
        assert!(skipped.skipped);
        assert!(skipped.other_text.is_none());
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    /// The upload body a send for `path` would carry, ids included.
    fn body_of(path: &Path, text: &str) -> Vec<u8> {
        let root = project_root(path, None);
        let name = relative_name(&root, path).unwrap();
        let (entry, base) = upload_identity(&root, &name).unwrap();
        version_body(&root, &name, &entry, &base, text, "device-a").unwrap()
    }

    /// Answers each PUT with `status_for(url)` and everything else with 404,
    /// and records every request line and body.
    fn spawn_recording_history(
        status_for: impl Fn(&str) -> u16 + Send + 'static,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        spawn_history(move |request| {
            if request.starts_with("PUT ") {
                (status_for(request), "{}".into())
            } else {
                (404, "{}".into())
            }
        })
    }

    /// Answers each request with `respond(request line)` and records it.
    fn spawn_history(
        respond: impl Fn(&str) -> (u16, String) + Send + 'static,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                stream
                    .set_read_timeout(Some(std::time::Duration::from_millis(500)))
                    .ok();
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => raw.extend_from_slice(&buf[..n]),
                    }
                    let text = String::from_utf8_lossy(&raw);
                    if let Some(split) = text.find("\r\n\r\n") {
                        let length = text[..split]
                            .lines()
                            .find_map(|line| {
                                let lower = line.to_ascii_lowercase();
                                lower
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if raw.len() >= split + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&raw).into_owned();
                let request = text.lines().next().unwrap_or("").to_string();
                log.lock().unwrap().push(text);
                let (status, body) = respond(&request);
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn no_workspace(_: &Path) -> Option<PathBuf> {
        None
    }

    fn queue_offline(home: &Path, file: &Path) -> OutboxEntry {
        let outcome = block_on(history_send_at(
            home,
            file,
            false,
            &config(Some("http://127.0.0.1:9")),
            None,
        ))
        .unwrap();
        assert!(outcome.waiting, "{outcome:?}");
        let root = project_root(file, None);
        known_entry(&root, &relative_name(&root, file).unwrap())
            .unwrap()
            .unwrap()
    }

    fn queued_lines(home: &Path) -> Vec<String> {
        read_queue(&outbox_for(home)).unwrap()
    }

    #[test]
    fn a_queued_document_that_is_gone_is_dropped_and_never_sent_empty() {
        let keep = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let file = keep.path().join("draft.md");
        fs::write(&file, "words that were saved offline\n").unwrap();
        queue_offline(home.path(), &file);
        fs::remove_file(&file).unwrap();
        let (url, seen) = spawn_recording_history(|_| 204);
        let flushed = block_on(history_flush_at(
            home.path(),
            &config(Some(&url)),
            true,
            &no_workspace,
        ))
        .unwrap();
        assert_eq!(flushed.sent, 0, "{flushed:?}");
        assert!(!flushed.waiting, "{flushed:?}");
        assert_eq!(flushed.dropped.len(), 1, "{flushed:?}");
        assert!(queued_lines(home.path()).is_empty());
        assert!(
            seen.lock().unwrap().is_empty(),
            "a missing file opened a socket"
        );

        // A direct send of a file that is gone is not an empty upload either.
        let direct = block_on(history_send_at(
            home.path(),
            &file,
            true,
            &config(Some(&url)),
            None,
        ))
        .unwrap();
        assert!(
            direct.missing && !direct.sent && !direct.waiting,
            "{direct:?}"
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_document_marked_private_during_a_flush_is_not_uploaded() {
        // The flush read the kept list once per batch, so a
        // note marked Keep on this Mac only while the batch ran still went
        // out. The first upload marks both notes; only one may be sent.
        let keep = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let first = keep.path().join("first.md");
        let second = keep.path().join("second.md");
        fs::write(&first, "first note\n").unwrap();
        fs::write(&second, "second note, private\n").unwrap();
        queue_offline(home.path(), &first);
        queue_offline(home.path(), &second);
        let store = home.path().to_path_buf();
        let marked = [first.clone(), second.clone()];
        let (url, seen) = spawn_history(move |request| {
            if request.starts_with("PUT ") {
                for path in &marked {
                    crate::mac_only::set_kept(&store, path, true).unwrap();
                }
                (204, "{}".into())
            } else {
                (404, "{}".into())
            }
        });
        let flushed = block_on(history_flush_at(
            home.path(),
            &config(Some(&url)),
            true,
            &no_workspace,
        ))
        .unwrap();
        let puts = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.starts_with("PUT "))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(puts.len(), 1, "a note marked mid-batch was uploaded");
        assert_eq!(flushed.sent, 1, "{flushed:?}");
        assert_eq!(flushed.dropped.len(), 1, "{flushed:?}");
        assert!(queued_lines(home.path()).is_empty());
    }

    #[test]
    fn a_queued_document_follows_a_rename_inside_the_folder() {
        let keep = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let file = keep.path().join("draft.md");
        fs::write(&file, "chapter one\n").unwrap();
        let entry = queue_offline(home.path(), &file);
        let renamed = keep.path().join("chapter.md");
        fs::rename(&file, &renamed).unwrap();
        retarget_sync(&file, &renamed, None, false);
        let (url, seen) = spawn_recording_history(|_| 204);
        let flushed = block_on(history_flush_at(
            home.path(),
            &config(Some(&url)),
            true,
            &no_workspace,
        ))
        .unwrap();
        assert_eq!(flushed.sent, 1, "{flushed:?}");
        assert!(flushed.dropped.is_empty(), "{flushed:?}");
        assert!(queued_lines(home.path()).is_empty());
        let seen = seen.lock().unwrap().clone();
        let put = seen
            .iter()
            .find(|request| request.starts_with("PUT "))
            .expect("one upload");
        assert!(
            put.contains(&format!("/documents/{}", entry.document)),
            "{put}"
        );
        assert!(put.contains("\"name\":\"chapter.md\""), "{put}");
        assert!(put.contains("chapter one"), "{put}");
        assert!(!put.contains("\"text\":\"\""), "{put}");
    }

    #[test]
    fn a_refused_version_is_dropped_and_one_failure_does_not_stop_the_flush() {
        let keep = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let refused = keep.path().join("Refused");
        let held = keep.path().join("Held");
        let broken = keep.path().join("Broken");
        let fine = keep.path().join("Fine");
        for dir in [&refused, &held, &broken, &fine] {
            fs::create_dir_all(dir).unwrap();
            fs::write(dir.join("draft.md"), "text\n").unwrap();
        }
        let refused_entry = queue_offline(home.path(), &refused.join("draft.md"));
        let held_entry = queue_offline(home.path(), &held.join("draft.md"));
        queue_offline(home.path(), &broken.join("draft.md"));
        queue_offline(home.path(), &fine.join("draft.md"));
        fs::write(broken.join(SYNC_FILE), "not json").unwrap();
        let (refused_doc, held_doc) = (refused_entry.document.clone(), held_entry.document.clone());
        let (url, _) = spawn_recording_history(move |request| {
            if request.contains(&refused_doc) {
                400
            } else if request.contains(&held_doc) {
                401
            } else {
                204
            }
        });
        let flushed = block_on(history_flush_at(
            home.path(),
            &config(Some(&url)),
            true,
            &no_workspace,
        ))
        .unwrap();
        assert_eq!(flushed.sent, 1, "{flushed:?}");
        assert_eq!(flushed.dropped.len(), 1, "{flushed:?}");
        assert!(flushed.dropped[0].contains("Refused"), "{flushed:?}");
        // Only the server's refusal is a backup that did not happen; a 401 is the session.
        assert_eq!(flushed.stopped, flushed.dropped, "{flushed:?}");
        assert_eq!(flushed.failed.len(), 1, "{flushed:?}");
        assert!(flushed.failed[0].contains("Broken"), "{flushed:?}");
        let left: Vec<String> = queued_lines(home.path());
        assert_eq!(left.len(), 2, "{left:?}");
        assert!(left.iter().any(|line| line.contains("Broken")), "{left:?}");
        assert!(
            left.contains(&held_entry.line()),
            "a 401 dropped a queued line: {left:?}"
        );
        assert!(!left.contains(&refused_entry.line()), "{left:?}");
    }

    #[test]
    fn a_path_line_from_an_earlier_version_becomes_an_entry_or_is_dropped() {
        let keep = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let file = keep.path().join("draft.md");
        fs::write(&file, "still here\n").unwrap();
        let gone = keep.path().join("gone.md");
        edit_queue(&outbox_for(home.path()), |lines| {
            lines.push(identity(&file));
            lines.push(gone.to_string_lossy().into_owned());
            lines.push("not a path".into());
        })
        .unwrap();
        let flushed = block_on(history_flush_at(
            home.path(),
            &config(Some("http://127.0.0.1:9")),
            false,
            &no_workspace,
        ))
        .unwrap();
        assert!(flushed.waiting, "{flushed:?}");
        assert_eq!(flushed.dropped.len(), 2, "{flushed:?}");
        let root = project_root(&file, None);
        let entry = known_entry(&root, "draft.md").unwrap().unwrap();
        assert_eq!(queued_lines(home.path()), vec![entry.line()]);
    }

    fn signed_out(url: &str) -> HistoryConfig {
        HistoryConfig {
            token: None,
            ..config(Some(url))
        }
    }

    fn queued_deletes(home: &Path) -> Vec<String> {
        read_queue(&home.join(DELETE_OUTBOX)).unwrap()
    }

    #[test]
    fn a_delete_while_signed_out_is_queued_and_sent_after_sign_in() {
        let keep = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let file = keep.path().join("draft.md");
        fs::write(&file, "text\n").unwrap();
        let entry = queue_offline(home.path(), &file);
        let plan = plan_delete(&file, None).unwrap();
        let (url, seen) = spawn_history(|_| (204, String::new()));
        block_on(history_delete_plan(home.path(), &signed_out(&url), &plan)).unwrap();
        assert_eq!(
            queued_deletes(home.path()),
            vec![format!("{}\t{}", entry.project, entry.document)]
        );
        assert!(seen.lock().unwrap().is_empty());
        block_on(replay_deletes(home.path(), &config(Some(&url))));
        assert!(queued_deletes(home.path()).is_empty());
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(
            seen[0].starts_with(&format!(
                "DELETE /v1/projects/{}/documents/{}",
                entry.project, entry.document
            )),
            "{seen:?}"
        );
    }

    #[test]
    fn a_session_that_cannot_be_read_still_queues_the_delete_and_drops_the_id() {
        let keep = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let file = keep.path().join("draft.md");
        fs::write(&file, "text\n").unwrap();
        let entry = queue_offline(home.path(), &file);
        let plan = plan_delete(&file, None).unwrap();
        fs::remove_file(&file).unwrap();
        block_on(delete_from_history_at(
            home.path(),
            Err(AppError::Account("unreachable".into())),
            &plan,
        ));
        assert_eq!(
            queued_deletes(home.path()),
            vec![format!("{}\t{}", entry.project, entry.document)]
        );
        assert!(
            queued_lines(home.path()).is_empty(),
            "the upload stayed queued"
        );
        let book = load_book(keep.path()).unwrap();
        assert!(!book.documents.contains_key("draft.md"), "{book:?}");
        // A new file under the same name is a new document.
        fs::write(&file, "a new note\n").unwrap();
        let next = queue_offline(home.path(), &file);
        assert_ne!(next.document, entry.document);
    }

    #[test]
    fn replaying_deletes_keeps_a_delete_queued_meanwhile() {
        let home = TempDir::new().unwrap();
        let first = DeletePlan {
            root: PathBuf::from("/notes"),
            project_id: random_id(),
            documents: vec![random_id()],
        };
        let later = DeletePlan {
            root: PathBuf::from("/notes"),
            project_id: first.project_id.clone(),
            documents: vec![random_id()],
        };
        queue_delete_plan(home.path(), &first).unwrap();
        let (url, arrived, release) = spawn_held_history(String::new(), "{}".into());
        let replay = {
            let home = home.path().to_path_buf();
            std::thread::spawn(move || block_on(replay_deletes(&home, &config(Some(&url)))))
        };
        arrived
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        queue_delete_plan(home.path(), &later).unwrap();
        release.send(()).unwrap();
        replay.join().unwrap();
        assert_eq!(queued_deletes(home.path()), delete_lines(&later));
    }

    #[test]
    fn a_pull_does_not_bring_back_a_document_whose_delete_is_queued() {
        let keep = TempDir::new().unwrap();
        let root = keep.path().join("Notes");
        fs::create_dir_all(&root).unwrap();
        let home = TempDir::new().unwrap();
        let file = root.join("draft.md");
        fs::write(&file, "text\n").unwrap();
        let entry = queue_offline(home.path(), &file);
        let plan = plan_delete(&file, None).unwrap();
        fs::remove_file(&file).unwrap();
        block_on(delete_from_history_at(
            home.path(),
            Ok(signed_out("http://127.0.0.1:9")),
            &plan,
        ));
        let list = json!({ "documents": [{
            "projectId": entry.project, "documentId": entry.document, "versionId": "v1",
            "name": "draft.md", "folderName": "Notes", "deleted": false,
        }]})
        .to_string();
        let (url, _) = spawn_history(move |request| {
            if request.starts_with("GET /v1/documents ") {
                (200, list.clone())
            } else if request.starts_with("DELETE ") {
                (503, "{}".into())
            } else {
                (
                    200,
                    json!({ "text": "text\n", "deviceId": "device-b", "versionId": "v1" })
                        .to_string(),
                )
            }
        });
        let pulled = block_on(history_pull_at(
            home.path(),
            &root,
            &config(Some(&url)),
            true,
            &[],
        ))
        .unwrap();
        assert!(pulled.wrote.is_empty(), "{pulled:?}");
        assert!(!file.exists(), "a deleted file came back");
        assert_eq!(queued_deletes(home.path()).len(), 1);
    }

    /// A folder whose book holds `entries` (name, id, base version, text),
    /// each written to disk, and the project id.
    fn synced_folder(entries: &[(&str, &str, &str, &str)]) -> (TempDir, PathBuf, String) {
        let keep = TempDir::new().unwrap();
        let root = keep.path().join("Notes");
        fs::create_dir_all(&root).unwrap();
        let project = random_id();
        let mut book = SyncBook {
            project_id: project.clone(),
            documents: BTreeMap::new(),
        };
        for (name, id, base, text) in entries {
            fs::write(root.join(name), text).unwrap();
            book.documents.insert(
                name.to_string(),
                SyncDoc {
                    id: id.to_string(),
                    base_version_id: base.to_string(),
                    base_hash: content_hash(text),
                    seen_version_id: base.to_string(),
                    absent: false,
                },
            );
        }
        save_book(&root, &book).unwrap();
        (keep, root, project)
    }

    fn listing(project: &str, document: &str, name: &str, version: &str, deleted: bool) -> String {
        json!({ "documents": [{
            "projectId": project, "documentId": document, "versionId": version,
            "name": name, "folderName": "Notes", "deleted": deleted,
        }]})
        .to_string()
    }

    fn serve_listing(list: String, text: &str) -> String {
        let copy = json!({ "text": text, "deviceId": "device-b", "versionId": "v1" }).to_string();
        spawn_history(move |request| {
            if request.starts_with("GET /v1/documents ") {
                (200, list.clone())
            } else {
                (200, copy.clone())
            }
        })
        .0
    }

    #[test]
    fn a_pull_does_not_bring_back_the_old_name_of_a_file_renamed_here() {
        let id = random_id();
        let (_keep, root, project) = synced_folder(&[("a.md", &id, "v1", "words\n")]);
        fs::rename(root.join("a.md"), root.join("b.md")).unwrap();
        retarget_sync(&root.join("a.md"), &root.join("b.md"), Some(&root), false);
        // The server still lists the document under its old name.
        let url = serve_listing(listing(&project, &id, "a.md", "v1", false), "words\n");
        let home = TempDir::new().unwrap();
        let pulled = block_on(history_pull_at(
            home.path(),
            &root,
            &config(Some(&url)),
            true,
            &[],
        ))
        .unwrap();
        assert!(pulled.wrote.is_empty(), "{pulled:?}");
        assert!(!root.join("a.md").exists(), "the old name came back");
        let book = load_book(&root).unwrap();
        let holders: Vec<_> = book
            .documents
            .iter()
            .filter(|(_, doc)| doc.id == id)
            .map(|(name, _)| name.clone())
            .collect();
        assert_eq!(holders, vec!["b.md".to_string()]);
    }

    #[test]
    fn a_tombstone_with_no_entry_here_does_not_hand_its_id_to_a_new_file() {
        let other = random_id();
        let (_keep, root, project) = synced_folder(&[("other.md", &other, "v1", "kept\n")]);
        let deleted = random_id();
        let url = serve_listing(listing(&project, &deleted, "a.md", "v9", true), "");
        let home = TempDir::new().unwrap();
        block_on(history_pull_at(
            home.path(),
            &root,
            &config(Some(&url)),
            true,
            &[],
        ))
        .unwrap();
        let book = load_book(&root).unwrap();
        assert!(!book.documents.contains_key("a.md"), "{book:?}");
        fs::write(root.join("a.md"), "a new note\n").unwrap();
        let (entry, base) = upload_identity(&root, "a.md").unwrap();
        assert_ne!(entry.document, deleted);
        assert!(base.is_empty());
    }

    #[test]
    fn concurrent_queue_writes_keep_every_line() {
        let home = TempDir::new().unwrap();
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let home = home.path().to_path_buf();
                std::thread::spawn(move || {
                    for round in 0..10 {
                        let entry = OutboxEntry {
                            root: "/notes".into(),
                            project: "p".into(),
                            document: format!("d-{index}-{round}"),
                        };
                        outbox_add(&home, &entry).unwrap();
                        if round % 2 == 1 {
                            outbox_remove(&home, &entry).unwrap();
                        }
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(queued_lines(home.path()).len(), 40);
    }

    /// A history server stand-in. `GET /v1/documents` answers `list` at once.
    /// A document read signals `arrived` and waits for `release`.
    fn spawn_held_history(
        list: String,
        copy: String,
    ) -> (
        String,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (arrived_tx, arrived) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut head = Vec::new();
                let mut buf = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&head).into_owned();
                let body = if line.starts_with("GET /v1/documents ") {
                    list.clone()
                } else {
                    let _ = arrived_tx.send(());
                    let _ = release_rx.recv_timeout(std::time::Duration::from_secs(10));
                    copy.clone()
                };
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        (format!("http://{addr}"), arrived, release)
    }

    #[test]
    fn a_pull_waiting_on_the_network_keeps_a_book_write_made_meanwhile() {
        let keep = TempDir::new().unwrap();
        let root = keep.path().join("Notes");
        fs::create_dir_all(&root).unwrap();
        let draft = root.join("draft.md");
        fs::write(&draft, "ours\n").unwrap();
        let project = random_id();
        let document = random_id();
        let mut book = SyncBook {
            project_id: project.clone(),
            documents: BTreeMap::new(),
        };
        book.documents.insert(
            "draft.md".into(),
            SyncDoc {
                id: document.clone(),
                base_version_id: "v1".into(),
                base_hash: content_hash("ours\n"),
                seen_version_id: "v1".into(),
                absent: false,
            },
        );
        save_book(&root, &book).unwrap();
        let list = json!({ "documents": [{
            "projectId": project, "documentId": document, "versionId": "v2",
            "name": "draft.md", "folderName": "Notes", "deleted": false,
        }]})
        .to_string();
        let copy =
            json!({ "text": "theirs\n", "deviceId": "device-b", "versionId": "v2" }).to_string();
        let (url, arrived, release) = spawn_held_history(list, copy);
        let home = TempDir::new().unwrap();
        let pull = {
            let home = home.path().to_path_buf();
            let root = root.clone();
            std::thread::spawn(move || {
                block_on(history_pull_at(
                    &home,
                    &root,
                    &config(Some(&url)),
                    true,
                    &[],
                ))
            })
        };
        arrived
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        // A save fires historySend while the pull waits: a first upload names a new id.
        let other = root.join("other.md");
        fs::write(&other, "second\n").unwrap();
        let body = body_of(&other, "second\n");
        let sent: serde_json::Value = serde_json::from_slice(&body).unwrap();
        release.send(()).unwrap();
        let pulled = pull.join().unwrap().unwrap();
        assert_eq!(pulled.wrote.len(), 1, "{pulled:?}");
        assert_eq!(fs::read_to_string(&draft).unwrap(), "theirs\n");
        let after = load_book(&root).unwrap();
        assert_eq!(
            after.documents.get("other.md").map(|doc| doc.id.as_str()),
            sent["documentId"].as_str(),
            "the pull wrote back a book from before the upload"
        );
        assert_eq!(after.documents["draft.md"].base_version_id, "v2");
    }

    #[test]
    fn a_pull_does_not_write_a_listed_copy_older_than_a_base_advanced_meanwhile() {
        let id = random_id();
        let (_keep, root, project) = synced_folder(&[("draft.md", &id, "v0", "first\n")]);
        let draft = root.join("draft.md");
        let copy =
            json!({ "text": "old\n", "deviceId": "device-b", "versionId": "v1" }).to_string();
        let (url, arrived, release) =
            spawn_held_history(listing(&project, &id, "draft.md", "v1", false), copy);
        let home = TempDir::new().unwrap();
        let pull = {
            let home = home.path().to_path_buf();
            let root = root.clone();
            std::thread::spawn(move || {
                block_on(history_pull_at(
                    &home,
                    &root,
                    &config(Some(&url)),
                    true,
                    &[],
                ))
            })
        };
        arrived
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        // A save lands while the pull waits on the v1 copy: the upload is
        // stored as v2 and the book's base moves past the listing.
        fs::write(&draft, "new\n").unwrap();
        with_book(&root, |book| {
            book.documents
                .get_mut("draft.md")
                .unwrap()
                .synced("v2", content_hash("new\n"));
            Ok(())
        })
        .unwrap();
        release.send(()).unwrap();
        let pulled = pull.join().unwrap().unwrap();
        assert!(pulled.wrote.is_empty(), "{pulled:?}");
        assert!(pulled.suggestions.is_empty(), "{pulled:?}");
        assert_eq!(fs::read_to_string(&draft).unwrap(), "new\n");
        let after = load_book(&root).unwrap();
        assert_eq!(after.documents["draft.md"].base_version_id, "v2");
        assert_eq!(after.documents["draft.md"].base_hash, content_hash("new\n"));
    }

    #[test]
    fn a_pull_does_not_write_a_copy_listed_before_this_mac_stored_a_newer_version() {
        let keep = TempDir::new().unwrap();
        let root = keep.path().join("Notes");
        fs::create_dir_all(&root).unwrap();
        let draft = root.join("draft.md");
        fs::write(&draft, "ours\n").unwrap();
        let project = random_id();
        let document = random_id();
        let mut book = SyncBook {
            project_id: project.clone(),
            documents: BTreeMap::new(),
        };
        book.documents.insert(
            "draft.md".into(),
            SyncDoc {
                id: document.clone(),
                base_version_id: "v1".into(),
                base_hash: content_hash("ours\n"),
                seen_version_id: "v1".into(),
                absent: false,
            },
        );
        save_book(&root, &book).unwrap();
        // The other Mac's v2, listed before this Mac's save below.
        let list = json!({ "documents": [{
            "projectId": project, "documentId": document, "versionId": "v2",
            "name": "draft.md", "folderName": "Notes", "deleted": false,
        }]})
        .to_string();
        let copy =
            json!({ "text": "theirs\n", "deviceId": "device-b", "versionId": "v2" }).to_string();
        let (url, arrived, release) = spawn_held_history(list, copy);
        let home = TempDir::new().unwrap();
        let pull = {
            let home = home.path().to_path_buf();
            let root = root.clone();
            std::thread::spawn(move || {
                block_on(history_pull_at(
                    &home,
                    &root,
                    &config(Some(&url)),
                    true,
                    &[],
                ))
            })
        };
        arrived
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        // While v2 downloads, a save here is stored as v3: the file and the book move on
        // together, as `note_synced` leaves them after an upload.
        fs::write(&draft, "ours, then more\n").unwrap();
        with_book(&root, |book| {
            book.documents
                .get_mut("draft.md")
                .unwrap()
                .synced("v3", content_hash("ours, then more\n"));
            Ok(())
        })
        .unwrap();
        release.send(()).unwrap();
        let pulled = pull.join().unwrap().unwrap();
        // The listed v2 was decided against v1. Against v3 the file reads as its base,
        // so without the check v2 would be written over the newer words.
        assert!(pulled.wrote.is_empty(), "{pulled:?}");
        assert!(pulled.suggestions.is_empty(), "{pulled:?}");
        assert_eq!(fs::read_to_string(&draft).unwrap(), "ours, then more\n");
        let after = load_book(&root).unwrap();
        assert_eq!(after.documents["draft.md"].base_version_id, "v3");
    }

    /// A folder with `draft.md` reading `ours\n`, synced at v1, and the listed v2 of it.
    fn pulled_draft(deleted: bool) -> (TempDir, PathBuf, SyncBook, ListedDoc) {
        let keep = TempDir::new().unwrap();
        let root = keep.path().join("Notes");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("draft.md"), "ours\n").unwrap();
        let project = random_id();
        let document = random_id();
        let mut book = SyncBook {
            project_id: project.clone(),
            documents: BTreeMap::new(),
        };
        book.documents.insert(
            "draft.md".into(),
            SyncDoc {
                id: document.clone(),
                base_version_id: "v1".into(),
                base_hash: content_hash("ours\n"),
                seen_version_id: "v1".into(),
                absent: false,
            },
        );
        let listed = ListedDoc {
            project_id: project,
            document_id: document,
            version_id: "v2".into(),
            name: "draft.md".into(),
            folder_name: "Notes".into(),
            deleted,
            proposals: serde_json::Value::Null,
        };
        (keep, root, book, listed)
    }

    fn names_beside(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_pulled_copy_does_not_truncate_a_save_that_landed_after_the_decision() {
        let (_keep, root, mut book, listed) = pulled_draft(false);
        let draft = root.join("draft.md");
        let mut outcome = PullOutcome {
            suggestions: Vec::new(),
            wrote: Vec::new(),
            removed: Vec::new(),
            failed: Vec::new(),
            proposals: None,
            proposals_unread: Vec::new(),
        };
        // The pull read `ours\n` and chose their copy. A save's rename lands now.
        let save_lands = || fs::write(&draft, "ours, then saved\n").unwrap();

        bring_listed(
            &mut book,
            &root,
            &listed,
            &draft,
            Some("theirs\n".into()),
            &mut outcome,
            &save_lands,
        )
        .unwrap();

        assert!(outcome.wrote.is_empty(), "{outcome:?}");
        assert_eq!(fs::read_to_string(&draft).unwrap(), "ours, then saved\n");
        // The book still says v1, so the next pull decides again, and no temp file is left.
        assert_eq!(book.documents["draft.md"].base_version_id, "v1");
        assert_eq!(names_beside(&root), ["draft.md"]);
    }

    #[test]
    fn a_pulled_copy_is_written_when_nothing_changed_and_keeps_the_mode() {
        let (_keep, root, mut book, listed) = pulled_draft(false);
        let draft = root.join("draft.md");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&draft, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let mut outcome = PullOutcome {
            suggestions: Vec::new(),
            wrote: Vec::new(),
            removed: Vec::new(),
            failed: Vec::new(),
            proposals: None,
            proposals_unread: Vec::new(),
        };

        bring_listed(
            &mut book,
            &root,
            &listed,
            &draft,
            Some("theirs\n".into()),
            &mut outcome,
            &|| {},
        )
        .unwrap();

        assert_eq!(outcome.wrote.len(), 1, "{outcome:?}");
        assert_eq!(fs::read_to_string(&draft).unwrap(), "theirs\n");
        assert_eq!(book.documents["draft.md"].base_version_id, "v2");
        assert_eq!(names_beside(&root), ["draft.md"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&draft).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{mode:o}");
        }
    }

    #[test]
    fn a_pulled_removal_keeps_a_file_saved_after_the_decision() {
        let (_keep, root, mut book, listed) = pulled_draft(true);
        let draft = root.join("draft.md");
        let mut outcome = PullOutcome {
            suggestions: Vec::new(),
            wrote: Vec::new(),
            removed: Vec::new(),
            failed: Vec::new(),
            proposals: None,
            proposals_unread: Vec::new(),
        };
        let save_lands = || fs::write(&draft, "ours, then saved\n").unwrap();

        bring_listed(
            &mut book,
            &root,
            &listed,
            &draft,
            None,
            &mut outcome,
            &save_lands,
        )
        .unwrap();

        assert!(outcome.removed.is_empty(), "{outcome:?}");
        assert_eq!(fs::read_to_string(&draft).unwrap(), "ours, then saved\n");
        assert!(!book.documents["draft.md"].absent);
    }

    #[test]
    fn concurrent_book_writes_keep_every_entry_and_leave_no_temp_file() {
        let keep = TempDir::new().unwrap();
        let root = keep.path().to_path_buf();
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let root = root.clone();
                std::thread::spawn(move || {
                    for round in 0..10 {
                        with_book(&root, |book| {
                            ensure_doc(book, &format!("note-{index}-{round}.md"));
                            Ok(())
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(load_book(&root).unwrap().documents.len(), 80);
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != SYNC_FILE)
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn an_unchanged_file_takes_the_server_copy_and_both_edits_suggest() {
        let local = "ours\n";
        let remote = "theirs\n";
        let hash = content_hash(local);
        assert!(matches!(
            decide_copy(Some(local), &hash, "v1", "v2", Some(remote), false, false),
            CopyAction::Write
        ));
        assert!(matches!(
            decide_copy(
                Some("edited\n"),
                &hash,
                "v1",
                "v2",
                Some(remote),
                false,
                false
            ),
            CopyAction::Suggest
        ));
        assert!(matches!(
            decide_copy(Some(local), &hash, "v1", "v2", None, true, false),
            CopyAction::Remove
        ));
        assert!(matches!(
            decide_copy(Some("edited\n"), &hash, "v1", "v2", None, true, false),
            CopyAction::Suggest
        ));
    }

    #[test]
    fn a_decision_names_three_random_ids_or_is_refused() {
        let home = TempDir::new().unwrap();
        let good = random_id();
        for bad in ["", "*", "../x", "project-a", "a b"] {
            for ids in [
                [bad, &good, &good],
                [&good, bad, &good],
                [&good, &good, bad],
            ] {
                let refused = block_on(history_proposal_decide_at(
                    home.path(),
                    None,
                    ids[0],
                    ids[1],
                    ids[2],
                ));
                assert!(refused.is_err(), "{ids:?}");
            }
        }
        assert!(read_queue(&home.path().join(PROPOSAL_OUTBOX))
            .unwrap()
            .is_empty());
        // A line that is not three random ids is dropped, not sent and not kept for good.
        let config = HistoryConfig {
            url: Some("http://127.0.0.1:9".into()),
            token: Some("session-a".into()),
            allow_insecure: true,
            device_id: "device-a".into(),
        };
        for line in ["", "only-one", "a\tb\tc", &format!("{good}\t{good}")] {
            assert!(matches!(
                block_on(apply_decision_line(&config, line)),
                DeleteStep::Done
            ));
        }
        assert!(matches!(
            block_on(apply_decision_line(
                &config,
                &decision_line(&good, &good, &good)
            )),
            DeleteStep::Pending
        ));
    }

    #[test]
    fn a_decision_takes_only_the_hyphenated_form_of_an_id() {
        let home = TempDir::new().unwrap();
        let good = random_id();
        // Spellings of the same random id that the server does not take.
        let bare = good.replace('-', "");
        let braced = format!("{{{good}}}");
        let urn = format!("urn:uuid:{good}");
        for bad in [bare.as_str(), braced.as_str(), urn.as_str()] {
            assert!(!decision_id(bad), "{bad}");
            let refused = block_on(history_proposal_decide_at(
                home.path(),
                None,
                &good,
                &good,
                bad,
            ));
            assert!(refused.is_err(), "{bad}");
        }
        assert!(decision_id(&good));
        assert!(decision_id(&good.to_uppercase()));
        assert!(read_queue(&home.path().join(PROPOSAL_OUTBOX))
            .unwrap()
            .is_empty());
        // A queued line in one of those spellings can never be sent. It is dropped.
        let config = HistoryConfig {
            url: Some("http://127.0.0.1:9".into()),
            token: Some("session-a".into()),
            allow_insecure: true,
            device_id: "device-a".into(),
        };
        for line in [
            format!("{good}\t{good}\t{bare}"),
            format!("{good}\t{good}\t{good}\t{good}"),
        ] {
            assert!(matches!(
                block_on(apply_decision_line(&config, &line)),
                DeleteStep::Done
            ));
        }
    }

    /// A listener that answers each request the way `answer` says, until dropped.
    /// It records `METHOD path` for every request it saw.
    struct Stub {
        port: u16,
        seen: Arc<Mutex<Vec<String>>>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Stub {
        fn start(answer: impl Fn(&str, &str) -> (u16, String) + Send + 'static) -> Self {
            use std::io::{Read, Write};
            use std::sync::atomic::{AtomicBool, Ordering};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            listener.set_nonblocking(true).unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let (log, flag) = (seen.clone(), stop.clone());
            let thread = std::thread::spawn(move || {
                while !flag.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    let mut head = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !head.windows(4).any(|part| part == b"\r\n\r\n") {
                        match stream.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(read) => head.extend_from_slice(&chunk[..read]),
                        }
                    }
                    let text = String::from_utf8_lossy(&head).into_owned();
                    let mut first = text.lines().next().unwrap_or("").split(' ');
                    let method = first.next().unwrap_or("").to_string();
                    let path = first.next().unwrap_or("").to_string();
                    log.lock().unwrap().push(format!("{method} {path}"));
                    let (status, body) = answer(&method, &path);
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} Stub\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            });
            Self {
                port,
                seen,
                stop,
                thread: Some(thread),
            }
        }

        fn config(&self) -> HistoryConfig {
            HistoryConfig {
                url: Some(format!("http://127.0.0.1:{}", self.port)),
                token: Some("session-a".into()),
                allow_insecure: true,
                device_id: "device-a".into(),
            }
        }

        fn seen(&self) -> Vec<String> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Drop for Stub {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    #[test]
    fn only_a_success_ends_a_queued_decision() {
        let (project, document, proposal) = (random_id(), random_id(), random_id());
        let line = decision_line(&project, &document, &proposal);
        for status in [200u16, 204] {
            let stub = Stub::start(move |_, _| (status, String::new()));
            assert!(
                matches!(
                    block_on(apply_decision_line(&stub.config(), &line)),
                    DeleteStep::Done
                ),
                "{status}"
            );
            assert_eq!(
                stub.seen(),
                vec![format!(
                    "DELETE /v1/projects/{project}/documents/{document}/proposals/{proposal}"
                )]
            );
        }
        // None of these says the suggestion is gone, so the decision keeps waiting.
        for status in [400u16, 401, 403, 404, 409, 429, 500, 503] {
            let stub = Stub::start(move |_, _| (status, "{}".into()));
            let home = TempDir::new().unwrap();
            block_on(history_proposal_decide_at(
                home.path(),
                Some(&stub.config()),
                &project,
                &document,
                &proposal,
            ))
            .unwrap();
            assert_eq!(
                read_queue(&home.path().join(PROPOSAL_OUTBOX)).unwrap(),
                vec![line.clone()],
                "{status}"
            );
        }
    }

    /// A folder whose notes already hold `document` at the listed version, so a
    /// pull fetches no copy and only the suggestions are in question.
    fn folder_at_v1(project: &str, document: &str) -> (TempDir, PathBuf, PathBuf) {
        let keep = TempDir::new().unwrap();
        let dir = keep.path().join("Notes");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("draft.md");
        fs::write(&file, "Mac one.\n").unwrap();
        let book = json!({
            "projectId": project,
            "documents": {
                "draft.md": {
                    "id": document,
                    "baseVersionId": "v1",
                    "baseHash": content_hash("Mac one.\n"),
                    "seenVersionId": "v1",
                    "absent": false
                }
            }
        });
        fs::write(dir.join(SYNC_FILE), book.to_string()).unwrap();
        (keep, dir, file)
    }

    fn listed_with(project: &str, document: &str, proposals: serde_json::Value) -> String {
        json!({ "documents": [{
            "projectId": project,
            "documentId": document,
            "versionId": "v1",
            "name": "draft.md",
            "deleted": false,
            "proposals": proposals
        }] })
        .to_string()
    }

    #[test]
    fn a_document_whose_suggestions_cannot_be_read_is_named_and_the_pull_still_answers() {
        let (project, document) = (random_id(), random_id());
        let (_keep, dir, file) = folder_at_v1(&project, &document);
        let home = TempDir::new().unwrap();
        let list = listed_with(&project, &document, json!(1));
        let stub = Stub::start(move |_, path| {
            if path == "/v1/documents" {
                (200, list.clone())
            } else {
                (500, "{}".into())
            }
        });
        let pulled = block_on(history_pull_at(
            home.path(),
            &dir,
            &stub.config(),
            true,
            &[],
        ))
        .unwrap();
        assert_eq!(pulled.proposals, Some(Vec::new()));
        // Named by its id, so the margin keeps its cards whatever the file is called now.
        assert_eq!(pulled.proposals_unread, vec![document.clone()]);
        assert!(
            pulled.failed.is_empty() && pulled.wrote.is_empty(),
            "{pulled:?}"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "Mac one.\n");
    }

    #[test]
    fn a_document_with_a_delete_waiting_or_no_file_here_is_not_asked_about() {
        let (project, document) = (random_id(), random_id());
        let asked = |seen: &[String]| seen.iter().any(|line| line.contains("/proposals"));

        // The file is gone on this Mac. There is no margin to put a card in.
        let (_keep, dir, file) = folder_at_v1(&project, &document);
        fs::remove_file(&file).unwrap();
        let home = TempDir::new().unwrap();
        let list = listed_with(&project, &document, json!(2));
        let answer = move |_: &str, path: &str| {
            if path == "/v1/documents" {
                (200, list.clone())
            } else {
                (500, "{}".into())
            }
        };
        let stub = Stub::start(answer.clone());
        let pulled = block_on(history_pull_at(
            home.path(),
            &dir,
            &stub.config(),
            true,
            &[],
        ))
        .unwrap();
        assert_eq!(pulled.proposals, Some(Vec::new()));
        assert!(pulled.proposals_unread.is_empty(), "{pulled:?}");
        assert!(!asked(&stub.seen()), "{:?}", stub.seen());

        // A delete of this document is queued and has not landed.
        let (_keep, dir, _file) = folder_at_v1(&project, &document);
        let home = TempDir::new().unwrap();
        write_queue(
            &home.path().join(DELETE_OUTBOX),
            &[format!("{project}\t{document}")],
        )
        .unwrap();
        let stub = Stub::start(answer);
        let pulled = block_on(history_pull_at(
            home.path(),
            &dir,
            &stub.config(),
            true,
            &[],
        ))
        .unwrap();
        assert_eq!(pulled.proposals, Some(Vec::new()));
        assert!(pulled.proposals_unread.is_empty(), "{pulled:?}");
        assert!(!asked(&stub.seen()), "{:?}", stub.seen());
    }

    #[test]
    fn a_notes_entry_that_leaves_the_folder_gets_no_card() {
        let (project, document) = (random_id(), random_id());
        let (keep, dir, _file) = folder_at_v1(&project, &document);
        // The notes are a file in the folder, and someone else can have written them.
        fs::write(keep.path().join("outside.md"), "Not in the folder.\n").unwrap();
        let book = json!({
            "projectId": project,
            "documents": { "../outside.md": { "id": document, "baseVersionId": "v1",
                "baseHash": "", "seenVersionId": "v1", "absent": false } }
        });
        fs::write(dir.join(SYNC_FILE), book.to_string()).unwrap();
        let home = TempDir::new().unwrap();
        let list = listed_with(&project, &document, json!(1));
        let stub = Stub::start(move |_, path| {
            if path == "/v1/documents" {
                (200, list.clone())
            } else {
                (200, r#"{"proposals":[]}"#.into())
            }
        });
        let pulled = block_on(history_pull_at(
            home.path(),
            &dir,
            &stub.config(),
            true,
            &[],
        ))
        .unwrap();
        assert_eq!(pulled.proposals, Some(Vec::new()));
        assert!(
            !stub.seen().iter().any(|line| line.contains("/proposals")),
            "{:?}",
            stub.seen()
        );
    }

    #[test]
    fn a_count_that_is_not_a_number_does_not_fail_the_list() {
        for odd in [
            json!(null),
            json!("three"),
            json!(-1),
            json!(1.5),
            json!({}),
        ] {
            let listed: ListBody = serde_json::from_str(&listed_with("p", "d", odd.clone()))
                .unwrap_or_else(|error| panic!("{odd}: {error}"));
            assert_eq!(listed.documents[0].waiting(), 0, "{odd}");
        }
        let listed: ListBody = serde_json::from_str(&listed_with("p", "d", json!(3))).unwrap();
        assert_eq!(listed.documents[0].waiting(), 3);
        // A listing with no count at all.
        let listed: ListBody = serde_json::from_str(
            r#"{"documents":[{"projectId":"p","documentId":"d","versionId":"v","name":"a.md","deleted":false}]}"#,
        )
        .unwrap();
        assert_eq!(listed.documents[0].waiting(), 0);
    }

    #[test]
    fn a_document_is_known_by_the_ids_in_the_notes_and_keeps_them_through_a_rename() {
        let (project, document) = (random_id(), random_id());
        let (_keep, dir, file) = folder_at_v1(&project, &document);
        let identity = DocumentIdentity {
            project_id: project.clone(),
            document_id: document.clone(),
        };
        assert_eq!(document_identity_at(&file, None), Some(identity.clone()));
        // A file the notes do not name has never synced.
        let fresh = dir.join("new.md");
        fs::write(&fresh, "New.\n").unwrap();
        assert_eq!(document_identity_at(&fresh, None), None);
        // The ids move with the document. A new file under the old name has none.
        let moved = dir.join("essay.md");
        fs::rename(&file, &moved).unwrap();
        assert!(try_retarget_sync(&file, &moved, None, false).unwrap());
        assert_eq!(document_identity_at(&moved, None), Some(identity));
        fs::write(&file, "Another document.\n").unwrap();
        assert_eq!(document_identity_at(&file, None), None);
        // Asking does not write the notes, or make any for a folder without them.
        let plain = TempDir::new().unwrap();
        let loose = plain.path().join("loose.md");
        fs::write(&loose, "Loose.\n").unwrap();
        assert_eq!(document_identity_at(&loose, None), None);
        assert!(!plain.path().join(SYNC_FILE).exists());
    }

    /// The tests that run a real sync server. The server is not part of this repository,
    /// so they compile only where the build names their file. See `build.rs`.
    #[cfg(history_server_tests)]
    mod server {
        include!(env!("ALKUIN_HISTORY_SERVER_TESTS"));
    }
}
