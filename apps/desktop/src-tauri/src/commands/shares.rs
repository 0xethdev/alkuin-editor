//! One document, one invited email. The session stays in the keychain.
//! A kept document never reaches the accounts function.

use crate::commands::account::{
    access_token_from_app, accounts_client, accounts_request, accounts_url, refreshed_access_token,
    supabase_public,
};
use crate::commands::history::document_id;
use crate::error::AppError;
use crate::invite_arrival::INVITE_ARRIVAL;
use crate::mac_only::{depart, Channel, MacOnlySet};
use crate::open_target::PendingOpenPayload;
use crate::state::AppState;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// ponytail: each mark stats the path. 5000 files is the ceiling. Upgrade
/// path is storing the document id on the file index.
const MARK_CAP: usize = 5000;

/// A rename records the id the file already had. The map is one entry per
/// path that has moved. A corrupt file is left unread.
const SHARE_PATHS_FILE: &str = "share-paths.json";

#[derive(Debug, Serialize)]
pub struct ShareRole {
    pub role: String,
    pub share_id: Option<String>,
    pub document_id: String,
    pub status: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ShareChangeView {
    pub id: String,
    pub share_id: String,
    pub start: i64,
    pub end: i64,
    pub original: String,
    pub body: Option<String>,
    pub sender_email: String,
    pub snapshot: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct OutgoingChange {
    pub payload_ref: String,
    pub passage: String,
    pub original: String,
    #[serde(default)]
    pub body: Option<String>,
}

/// `alkuin://share/<64 hex>` is the link in the invite email.
pub fn token_from_invite_link(raw: &str) -> Option<String> {
    let rest = raw.trim().strip_prefix("alkuin://share/")?;
    let token = rest.split(['?', '#', '/']).next().unwrap_or("");
    if token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(token.to_ascii_lowercase())
    } else {
        None
    }
}

/// A new stamp beside the copy. The invitee's next sync treats that text as the baseline.
/// ponytail: one uuid file per open. The watcher already skips dotfiles. Upgrade path
/// is a hosted revision on the copy row if two devices open the same share.
fn reset_share_baseline(path: &Path) -> Result<(), AppError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::Io("copy".into()))?;
    let parent = path.parent().ok_or_else(|| AppError::Io("copy".into()))?;
    let stamp = parent.join(format!(".{name}.host"));
    crate::commands::fs::write_atomic(&stamp, uuid::Uuid::new_v4().to_string().as_bytes())
}

fn hosted_copy_path(dir: &Path, share_id: &str) -> Result<PathBuf, AppError> {
    if share_id.is_empty() || share_id.contains(['/', '\\']) {
        return Err(AppError::Account("validation_failed".into()));
    }
    let folder = dir.join("shares");
    fs::create_dir_all(&folder).map_err(|err| AppError::Io(err.to_string()))?;
    Ok(folder.join(format!("{share_id}.md")))
}

fn write_hosted_copy(dir: &Path, share_id: &str, body: &str) -> Result<PathBuf, AppError> {
    let path = hosted_copy_path(dir, share_id)?;
    fs::write(&path, body).map_err(|err| AppError::Io(err.to_string()))?;
    Ok(path)
}

/// `keep` leaves an existing file when the invitee still has unsent edits.
///
/// The stamp goes first, and each file is a temp file renamed into place.
/// The stamp is what tells the desk "this text is the new baseline". If the
/// body then fails, the text already on disk becomes the baseline and nothing
/// looks like a local edit. Body first would leave the old stamp over the new
/// server text, and that text would be sent back as the invitee's edits.
fn refresh_local_copy(path: &Path, body: &str, keep: bool) -> Result<(), AppError> {
    if keep && path.is_file() {
        return Ok(());
    }
    reset_share_baseline(path)?;
    crate::commands::fs::write_atomic(path, body.as_bytes())
}

pub(crate) fn app_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn read_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// `depart` is the send door. A kept document returns the share refusal.
fn ensure_can_leave(app: &tauri::AppHandle, path: &Path) -> Result<(), AppError> {
    let set = MacOnlySet::load_or_block(app_dir(app).as_deref());
    let text = read_text(path);
    depart(&set, path, Channel::Share, &[(path, text.as_str())], || {
        Ok(())
    })
    .map_err(AppError::Gateway)
}

async fn bearer(app: &tauri::AppHandle) -> Result<String, AppError> {
    access_token_from_app(app)
        .await?
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AppError::Account("unauthorized".into()))
}

fn account_error(text: &str) -> AppError {
    let code = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("error_code")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unreachable".into());
    AppError::Account(code)
}

async fn accounts_send(
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
    token: &str,
) -> Result<reqwest::Response, AppError> {
    let (base, anon) = supabase_public()?;
    let request = accounts_request(
        &accounts_client()?,
        method,
        &accounts_url(&base, path),
        &anon,
        token,
    );
    let request = match body {
        Some(body) => request.json(body),
        None => request,
    };
    request
        .send()
        .await
        .map_err(|_| AppError::Account("unreachable".into()))
}

async fn read_accounts(response: reqwest::Response) -> Result<Value, AppError> {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(account_error(&text));
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// How long one `GET shares` answers every share question. A local share change clears it.
const SHARE_LIST_TTL: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(Default)]
struct ShareListCache {
    entry: Option<(String, std::time::Instant, Value)>,
    /// Bumped by every [`ShareListCache::clear`]. A read that started before
    /// a clear does not store its (possibly older) answer.
    generation: u64,
}

impl ShareListCache {
    fn get(&self, token: &str, now: std::time::Instant) -> Option<Value> {
        let (owner, at, body) = self.entry.as_ref()?;
        (owner == token && now.duration_since(*at) < SHARE_LIST_TTL).then(|| body.clone())
    }
    fn put(&mut self, token: &str, now: std::time::Instant, body: Value) {
        self.entry = Some((token.to_string(), now, body));
    }
    /// Store a read only when no change cleared the cache while it ran.
    fn put_if_current(
        &mut self,
        generation: u64,
        token: &str,
        now: std::time::Instant,
        body: Value,
    ) {
        if self.generation == generation {
            self.put(token, now, body);
        }
    }
    fn clear(&mut self) {
        self.entry = None;
        self.generation = self.generation.wrapping_add(1);
    }
}

static SHARE_LIST: Mutex<ShareListCache> = Mutex::new(ShareListCache {
    entry: None,
    generation: 0,
});

/// The account's share list. One network read answers every caller for 20 s.
pub(crate) async fn share_list(app: &tauri::AppHandle) -> Result<Value, AppError> {
    let token = bearer(app).await?;
    let now = std::time::Instant::now();
    let (cached, generation) = {
        let cache = SHARE_LIST
            .lock()
            .map_err(|_| AppError::Io("share list lock".into()))?;
        (cache.get(&token, now), cache.generation)
    };
    if let Some(body) = cached {
        return Ok(body);
    }
    let body = call_as(app, reqwest::Method::GET, "shares", None).await?;
    if let Ok(mut cache) = SHARE_LIST.lock() {
        cache.put_if_current(generation, &token, now, body.clone());
    }
    Ok(body)
}

/// Drops the cached share list, for example on sign-out.
pub(crate) fn forget_share_list() {
    if let Ok(mut cache) = SHARE_LIST.lock() {
        cache.clear();
    }
}

#[cfg(test)]
pub(crate) fn remember_share_list(token: &str, body: Value) {
    if let Ok(mut cache) = SHARE_LIST.lock() {
        cache.put(token, std::time::Instant::now(), body);
    }
}

#[cfg(test)]
pub(crate) fn share_list_cached(token: &str) -> bool {
    SHARE_LIST
        .lock()
        .ok()
        .and_then(|cache| cache.get(token, std::time::Instant::now()))
        .is_some()
}

pub(crate) async fn call_as(
    app: &tauri::AppHandle,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let changes = method != reqwest::Method::GET;
    let result = call_as_inner(app, method, path, body).await;
    if changes {
        forget_share_list();
    }
    result
}

async fn call_as_inner(
    app: &tauri::AppHandle,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let token = bearer(app).await?;
    let response = accounts_send(method.clone(), path, body.as_ref(), &token).await?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let text = response.text().await.unwrap_or_default();
        if let Some(next) = refreshed_access_token(app, &token).await? {
            return read_accounts(accounts_send(method, path, body.as_ref(), &next).await?).await;
        }
        return Err(account_error(&text));
    }
    read_accounts(response).await
}

fn shares_of(body: &Value) -> Vec<&Value> {
    body.get("shares")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().collect())
        .unwrap_or_default()
}

/// A share row's status, parsed once. A value this build does not know is
/// not live: the row is skipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShareStatus {
    Pending,
    Accepted,
    Declined,
    Removed,
    /// The owner erased or soft-deleted the document.
    Parked,
}

impl ShareStatus {
    pub(crate) fn of(row: &Value) -> Option<Self> {
        match row.get("status").and_then(Value::as_str)? {
            "pending" => Some(Self::Pending),
            "accepted" => Some(Self::Accepted),
            "declined" => Some(Self::Declined),
            "removed" => Some(Self::Removed),
            "parked" => Some(Self::Parked),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Declined => "declined",
            Self::Removed => "removed",
            Self::Parked => "parked",
        }
    }

    /// The invitee can still read it and changes can still be sent.
    pub(crate) fn is_live(self) -> bool {
        matches!(self, Self::Pending | Self::Accepted)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShareRoleKind {
    Owner,
    Invitee,
}

impl ShareRoleKind {
    pub(crate) fn of(row: &Value) -> Option<Self> {
        match row.get("role").and_then(Value::as_str)? {
            "owner" => Some(Self::Owner),
            "invitee" => Some(Self::Invitee),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Invitee => "invitee",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Canon {
    share_id: String,
    document_id: String,
    role: ShareRoleKind,
    status: ShareStatus,
}

fn is_share_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let dash = index == 8 || index == 13 || index == 18 || index == 23;
        if dash {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// `…/shares/<share id>.md` is the collaborator's copy. The id is the row.
fn copy_share_id(path: &Path) -> Option<String> {
    let parent = path.parent()?.file_name()?.to_str()?;
    if parent != "shares" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    if !is_share_id(stem) {
        return None;
    }
    Some(stem.to_ascii_lowercase())
}

/// A live row with a role and status this build knows. Anything else is skipped.
fn live_canon(row: &Value) -> Option<Canon> {
    let status = ShareStatus::of(row).filter(|status| status.is_live())?;
    Some(Canon {
        share_id: row
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        document_id: row
            .get("document_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        role: ShareRoleKind::of(row)?,
        status,
    })
}

fn canon_by_id(body: &Value, id: &str) -> Option<Canon> {
    shares_of(body).into_iter().find_map(|row| {
        let row_id = row.get("id").and_then(Value::as_str)?;
        if !row_id.eq_ignore_ascii_case(id) {
            return None;
        }
        live_canon(row)
    })
}

pub(crate) fn share_paths_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|err| err.into_inner())
}

pub(crate) fn canon_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn share_paths_file(home: &Path) -> PathBuf {
    home.join(SHARE_PATHS_FILE)
}

/// `None` is a corrupt map. Callers must not treat that as "no renames".
/// The map is always written as JSON (`{}` when empty), so an existing file
/// that is empty is damage, not an empty map: reading it as empty would drop
/// every carried id at once.
pub(crate) fn load_share_paths(home: &Path) -> Option<BTreeMap<String, String>> {
    let path = share_paths_file(home);
    if !path.is_file() {
        return Some(BTreeMap::new());
    }
    let text = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Synced temp file and rename (`write_atomic`), so a crash or power loss
/// never leaves a torn or empty map. A failure is logged and returned as `false`.
pub(crate) fn save_share_paths(home: &Path, map: &BTreeMap<String, String>) -> bool {
    let Ok(text) = serde_json::to_string(map) else {
        return false;
    };
    match crate::commands::fs::write_atomic(&share_paths_file(home), text.as_bytes()) {
        Ok(()) => true,
        Err(err) => {
            eprintln!("[shares] share-paths.json was not written: {err}");
            false
        }
    }
}

/// A rename refused because the share map cannot be read.
pub(crate) const SHARE_LIST_UNREADABLE: &str =
    "Alkuin couldn't read which documents are shared, so it didn't rename this one.";

pub(crate) fn path_key(path: &Path) -> String {
    canon_path(path).to_string_lossy().into_owned()
}

/// The id stored for this path, otherwise the path encoding.
pub(crate) fn share_document_id(home: Option<&Path>, path: &Path) -> String {
    if let Some(home) = home {
        let _guard = share_paths_lock();
        if let Some(map) = load_share_paths(home) {
            if let Some(id) = map.get(&path_key(path)) {
                return id.clone();
            }
        }
    }
    document_id(path)
}

fn collect_markdown(root: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MARK_CAP {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MARK_CAP {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_markdown(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            out.push(path);
        }
    }
}

/// Ids captured before the rename, while the old path still exists.
fn ids_before_move(
    map: &BTreeMap<String, String>,
    from: &Path,
    was_dir: bool,
) -> Vec<(PathBuf, String)> {
    let mut files = Vec::new();
    if was_dir {
        collect_markdown(from, &mut files);
    } else if from.is_file() {
        files.push(from.to_path_buf());
    }
    files
        .into_iter()
        .map(|path| {
            let key = path_key(&path);
            let id = map.get(&key).cloned().unwrap_or_else(|| document_id(&path));
            (canon_path(&path), id)
        })
        .collect()
}

/// Every carried id is written under its new path, even one that equals the
/// new path's own encoding, so a later `note_moved` for the same move sees
/// it already carried and leaves it.
fn retarget_share_ids(
    home: &Path,
    mut map: BTreeMap<String, String>,
    from: &Path,
    to: &Path,
    carried: &[(PathBuf, String)],
) {
    if carried.is_empty() {
        return;
    }
    for (old, _) in carried {
        let key = old.to_string_lossy().into_owned();
        // A leading U+0001 key is a fingerprint, not a path.
        if key.starts_with('\u{1}') {
            continue;
        }
        map.remove(&key);
    }
    for (old, id) in carried {
        let next = match old.strip_prefix(from) {
            Ok(rest) if rest.as_os_str().is_empty() => to.to_path_buf(),
            Ok(rest) => to.join(rest),
            Err(_) => continue,
        };
        map.insert(path_key(&next), id.clone());
    }
    save_share_paths(home, &map);
}

/// Rename the file and keep the share id it already had.
pub(crate) fn carry_share_rename(
    home: &Path,
    from: &Path,
    to: &Path,
    was_dir: bool,
    rename: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let _guard = share_paths_lock();
    // A map that cannot be read would leave the renamed file on its path id
    // and lose its share. Nothing moves in that case.
    let Some(map) = load_share_paths(home) else {
        return Err(AppError::Message(SHARE_LIST_UNREADABLE.into()));
    };
    let from_canon = canon_path(from);
    let carried = ids_before_move(&map, &from_canon, was_dir);
    rename()?;
    retarget_share_ids(home, map, &from_canon, &canon_path(to), &carried);
    Ok(())
}

fn heading_of_hosted_copy(home: &Path, share_id: &str) -> Option<String> {
    if !is_share_id(share_id) {
        return None;
    }
    let text = fs::read_to_string(home.join("shares").join(format!("{share_id}.md"))).ok()?;
    heading_title(&text)
}

/// The copy on this Mac wins when it has a heading. Otherwise the server
/// title, which is the heading or the name stored when the invite was sent.
fn title_for_list(server: &str, body: Option<&str>) -> String {
    if let Some(heading) = body.and_then(heading_title) {
        return heading;
    }
    let trimmed = server.trim();
    if trimmed.is_empty() {
        "Document".into()
    } else {
        trimmed.to_string()
    }
}

/// The share row for this file. A copy matches `<share id>.md`. The owner's
/// file matches `document_id`. An accepted row wins over a pending one.
fn canon_for(body: &Value, path: &Path, home: Option<&Path>) -> Option<Canon> {
    let rows = shares_of(body);
    if let Some(id) = copy_share_id(path) {
        return rows.into_iter().find_map(|row| {
            let row_id = row.get("id").and_then(Value::as_str)?;
            if row_id.eq_ignore_ascii_case(&id) {
                live_canon(row)
            } else {
                None
            }
        });
    }
    let local = share_document_id(home, path);
    let mut pending: Option<Canon> = None;
    for row in rows {
        if row.get("document_id").and_then(Value::as_str) != Some(local.as_str()) {
            continue;
        }
        let Some(canon) = live_canon(row) else {
            continue;
        };
        if canon.role != ShareRoleKind::Owner {
            continue;
        }
        if canon.status == ShareStatus::Accepted {
            return Some(canon);
        }
        if pending.is_none() {
            pending = Some(canon);
        }
    }
    pending
}

fn role_from_list(body: &Value, path: &Path, home: Option<&Path>) -> ShareRole {
    if let Some(canon) = canon_for(body, path, home) {
        return ShareRole {
            role: canon.role.as_str().into(),
            share_id: Some(canon.share_id),
            document_id: canon.document_id,
            status: Some(canon.status.as_str().into()),
        };
    }
    ShareRole {
        role: "none".into(),
        share_id: None,
        document_id: share_document_id(home, path),
        status: None,
    }
}

/// The canonical document id when this file is on a share, otherwise the path id.
pub(crate) async fn canonical_document(
    app: &tauri::AppHandle,
    path: &Path,
) -> Result<String, AppError> {
    let body = share_list(app).await?;
    let home = app_dir(app);
    Ok(canon_for(&body, path, home.as_deref())
        .map(|canon| canon.document_id)
        .unwrap_or_else(|| share_document_id(home.as_deref(), path)))
}

fn file_label(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("Document")
        .chars()
        .take(200)
        .collect()
}

fn strip_marks(text: &str) -> String {
    text.chars()
        .filter(|mark| !matches!(*mark, '*' | '_' | '`' | '~'))
        .collect()
}

/// Frontmatter `title:`, else the leading H1, else the file name.
pub(crate) fn document_title(path: &Path, text: &str) -> String {
    heading_title(text)
        .unwrap_or_else(|| file_label(path))
        .chars()
        .take(200)
        .collect()
}

fn heading_title(text: &str) -> Option<String> {
    let mut body = text;
    if let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    {
        if let Some(end) = rest.find("\n---\n").or_else(|| rest.find("\n---\r\n")) {
            let yaml = &rest[..end];
            for line in yaml.lines() {
                let trimmed = line.trim();
                let Some(value) = trimmed.strip_prefix("title:") else {
                    continue;
                };
                let value = value.trim();
                let title = value
                    .strip_prefix('"')
                    .and_then(|item| item.strip_suffix('"'))
                    .or_else(|| {
                        value
                            .strip_prefix('\'')
                            .and_then(|item| item.strip_suffix('\''))
                    })
                    .unwrap_or(value);
                if !title.is_empty() {
                    return Some(title.to_string());
                }
            }
            let marker = if rest[end..].starts_with("\n---\r\n") {
                "\n---\r\n"
            } else {
                "\n---\n"
            };
            body = &rest[end + marker.len()..];
        }
    }
    let line = body.lines().find(|line| !line.trim().is_empty())?;
    let rest = line.trim().strip_prefix("# ")?;
    if rest.starts_with('#') {
        return None;
    }
    let clean = strip_marks(rest.trim().trim_end_matches('#').trim());
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        None
    } else {
        Some(clean)
    }
}

/// Open a shared copy as a tab in the workspace the main window already
/// has. A window with no folder uses the last one, then the shares folder.
pub(crate) fn share_window_target(
    current_root: Option<&str>,
    recent_root: Option<&str>,
    file: &str,
) -> PendingOpenPayload {
    let workspace = current_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            recent_root
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            Path::new(file)
                .parent()
                .filter(|dir| !dir.as_os_str().is_empty())
                .map(|dir| dir.to_string_lossy().into_owned())
        });
    PendingOpenPayload {
        workspace,
        file: Some(file.to_string()),
    }
}

#[tauri::command]
pub async fn share_role(app: tauri::AppHandle, path: String) -> Result<ShareRole, AppError> {
    let body = share_list(&app).await?;
    let home = app_dir(&app);
    Ok(role_from_list(&body, Path::new(&path), home.as_deref()))
}

#[derive(Debug, Serialize)]
pub struct RealtimeAuth {
    pub url: String,
    pub anon: String,
    pub token: String,
}

/// True when the share list names this share id with a live owner or
/// invitee row. A parked, removed or declined share gets no realtime token,
/// and neither does a row whose role or status this build does not know.
fn on_share(body: &Value, share_id: &str) -> bool {
    canon_by_id(body, share_id).is_some()
}

#[tauri::command]
pub async fn share_realtime_auth(
    app: tauri::AppHandle,
    share_id: String,
) -> Result<RealtimeAuth, AppError> {
    let list = share_list(&app).await?;
    if !on_share(&list, &share_id) {
        return Err(AppError::Account("not_found".into()));
    }
    let (url, anon) = supabase_public()?;
    let token = bearer(&app).await?;
    Ok(RealtimeAuth { url, anon, token })
}

#[tauri::command]
pub async fn share_invite(
    app: tauri::AppHandle,
    path: String,
    email: String,
) -> Result<Value, AppError> {
    let file = PathBuf::from(&path);
    ensure_can_leave(&app, &file)?;
    let document = read_text(&file);
    let title = document_title(&file, &document);
    if document.chars().count() > 100_000 {
        return Err(AppError::Account("validation_failed".into()));
    }
    let home = app_dir(&app);
    let Some(home) = home else {
        return Err(AppError::Message(
            "Alkuin couldn't remember this share on this Mac.".into(),
        ));
    };
    let document_id = share_document_id(Some(&home), &file);
    let created = call_as(
        &app,
        reqwest::Method::POST,
        "shares",
        Some(json!({
            "document_id": document_id,
            "email": email,
            "title": title,
            "body": document,
        })),
    )
    .await?;
    // Before the caller hears success, so a sign-out and a folder delete still
    // know this document was shared. Reconciliation is not required.
    crate::share_paths::bind_document_id(&home, &file, &document_id);
    if !crate::share_paths::known_share_ids(&home).contains(&document_id) {
        return Err(AppError::Message(
            "Alkuin shared this document but couldn't remember it on this Mac.".into(),
        ));
    }
    Ok(created)
}

#[tauri::command]
pub async fn share_pending(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<ShareChangeView>, AppError> {
    let file = Path::new(&path);
    let shares = share_list(&app).await?;
    let home = app_dir(&app);
    let document = canon_for(&shares, file, home.as_deref())
        .map(|canon| canon.document_id)
        .unwrap_or_else(|| share_document_id(home.as_deref(), file));
    let body = call_as(&app, reqwest::Method::GET, "changes", None).await?;
    let rows = body.get("changes").and_then(Value::as_array);
    let Some(rows) = rows else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for row in rows {
        if row.get("document_id").and_then(Value::as_str) != Some(document.as_str()) {
            continue;
        }
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(share_id) = row.get("share_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(original) = row.get("original").and_then(Value::as_str) else {
            continue;
        };
        let Some(sender) = row.get("sender_email").and_then(Value::as_str) else {
            continue;
        };
        out.push(ShareChangeView {
            id: id.into(),
            share_id: share_id.into(),
            start: row
                .get("passage_start")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            end: row.get("passage_end").and_then(Value::as_i64).unwrap_or(0),
            original: original.into(),
            body: row.get("body").and_then(Value::as_str).map(str::to_string),
            sender_email: sender.into(),
            snapshot: row
                .get("snapshot")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    Ok(out)
}

/// Which refs one send settled. Every ref that is in none of the lists is
/// unsettled and can be sent again.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct ShareSendReport {
    /// Changes the server now holds.
    pub posted: Vec<String>,
    /// Withdrawals the server took.
    pub withdrawn: Vec<String>,
    /// Changes refused for good (already decided). Do not send them again.
    pub refused: Vec<String>,
    /// The first error that left a ref unsettled, or that stopped the send
    /// before anything was tried.
    pub error: Option<String>,
}

/// Returns the refs refused for good. Any other failure is the error, as
/// before; [`share_send_report`] says which refs were settled anyway.
#[tauri::command]
pub async fn share_send(
    app: tauri::AppHandle,
    path: String,
    share_id: String,
    changes: Vec<OutgoingChange>,
    withdraw: Option<Vec<String>>,
    snapshot: Option<String>,
) -> Result<Vec<String>, AppError> {
    let (report, error) =
        send_share_changes(&app, path, share_id, changes, withdraw, snapshot).await;
    match error {
        Some(error) => Err(error),
        None => Ok(report.refused),
    }
}

/// The same send. Never rejects: a failure is `error`, and the lists say
/// what was settled before or despite it.
#[allow(dead_code)]
#[tauri::command]
pub async fn share_send_report(
    app: tauri::AppHandle,
    path: String,
    share_id: String,
    changes: Vec<OutgoingChange>,
    withdraw: Option<Vec<String>>,
    snapshot: Option<String>,
) -> Result<ShareSendReport, AppError> {
    let (mut report, error) =
        send_share_changes(&app, path, share_id, changes, withdraw, snapshot).await;
    report.error = error.map(|error| error.to_string());
    Ok(report)
}

/// Withdrawals, then posts. Each ref is its own request, so one failure is
/// recorded and the rest are still tried. A failure before the first ref
/// (kept document, share list, cap, accept) settles nothing.
async fn send_share_changes(
    app: &tauri::AppHandle,
    path: String,
    share_id: String,
    changes: Vec<OutgoingChange>,
    withdraw: Option<Vec<String>>,
    snapshot: Option<String>,
) -> (ShareSendReport, Option<AppError>) {
    let mut report = ShareSendReport::default();
    let setup = share_send_target(app, &path, &share_id, changes.len()).await;
    let (share_id, document) = match setup {
        Ok(target) => target,
        Err(error) => return (report, Some(error)),
    };
    let mut hard: Option<AppError> = None;
    for reference in withdraw.unwrap_or_default() {
        let reference = reference.trim();
        if reference.is_empty() {
            continue;
        }
        match call_as(
            app,
            reqwest::Method::POST,
            "changes/withdraw",
            Some(json!({ "share_id": &share_id, "payload_ref": reference })),
        )
        .await
        {
            Ok(_) => report.withdrawn.push(reference.to_string()),
            Err(error) => {
                hard.get_or_insert(error);
            }
        }
    }
    let mut tally = SendTally {
        refused: Vec::new(),
        hard,
    };
    for change in changes {
        let payload = change_body(&change, &share_id, &document, snapshot.as_deref());
        match call_as(app, reqwest::Method::POST, "changes", Some(payload)).await {
            Ok(_) => report.posted.push(change.payload_ref.clone()),
            Err(error) => note_send_error(&mut tally, &change.payload_ref, error),
        }
    }
    report.refused = tally.refused;
    (report, tally.hard)
}

/// The share and document a send goes to, after the kept-document check,
/// the change cap, and the accept that sending implies.
async fn share_send_target(
    app: &tauri::AppHandle,
    path: &str,
    share_id: &str,
    change_count: usize,
) -> Result<(String, String), AppError> {
    let file = PathBuf::from(path);
    ensure_can_leave(app, &file)?;
    let shares = share_list(app).await?;
    let home = app_dir(app);
    let canon = if copy_share_id(&file).is_some() {
        canon_for(&shares, &file, home.as_deref())
    } else {
        canon_by_id(&shares, share_id).or_else(|| canon_for(&shares, &file, home.as_deref()))
    };
    let Some(canon) = canon else {
        return Err(AppError::Account("not_found".into()));
    };
    if change_count > 20 {
        return Err(AppError::Account("change_cap".into()));
    }
    // Sending is the accept. An already-accepted share answers not_found.
    match call_as(
        app,
        reqwest::Method::POST,
        "shares/accept",
        Some(json!({ "id": &canon.share_id })),
    )
    .await
    {
        Ok(_) => {}
        Err(AppError::Account(code)) if code == "not_found" => {}
        Err(error) => return Err(error),
    }
    Ok((canon.share_id, canon.document_id))
}

/// A suggested wording is sealed against the baseline. A comment has no body.
fn change_body(
    change: &OutgoingChange,
    share_id: &str,
    document: &str,
    snapshot: Option<&str>,
) -> Value {
    let mut payload = json!({
        "share_id": share_id,
        "payload_ref": change.payload_ref,
        "passage": change.passage,
        "original": change.original,
        "document_id": document,
    });
    if let Some(body) = change.body.as_deref().filter(|body| !body.is_empty()) {
        payload["body"] = json!(body);
        if let Some(snapshot) = snapshot.filter(|text| !text.is_empty()) {
            payload["snapshot"] = json!(snapshot);
        }
    }
    payload
}

fn validation_refused(error: &AppError) -> bool {
    matches!(error, AppError::Account(code) if code == "validation_failed")
}

struct SendTally {
    refused: Vec<String>,
    hard: Option<AppError>,
}

/// A decided comment answers validation_failed. That one ref is skipped.
/// Anything else is remembered, and the loop still posts the rest.
fn note_send_error(tally: &mut SendTally, payload_ref: &str, error: AppError) {
    if validation_refused(&error) {
        tally.refused.push(payload_ref.to_string());
        return;
    }
    if tally.hard.is_none() {
        tally.hard = Some(error);
    }
}

/// Why the last invite link was refused for this account. Read once, then gone.
#[tauri::command]
pub fn share_invite_refusal() -> Option<String> {
    INVITE_ARRIVAL.take_refusal()
}

#[tauri::command]
pub async fn share_open_link(app: tauri::AppHandle, url: String) -> Result<String, AppError> {
    let token = token_from_invite_link(&url)
        .ok_or_else(|| AppError::Account("validation_failed".into()))?;
    let opened = call_as(
        &app,
        reqwest::Method::POST,
        "shares/redeem",
        Some(json!({ "token": token })),
    )
    .await?;
    let share_id = opened
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Account("not_found".into()))?;
    let text = opened.get("body").and_then(Value::as_str).unwrap_or("");
    let dir = app_dir(&app).ok_or_else(|| AppError::Account("unreachable".into()))?;
    let path = hosted_copy_path(&dir, share_id)?;
    refresh_local_copy(&path, text, false)?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SharedDocument {
    pub id: String,
    pub title: String,
    pub owner: String,
    pub open: i64,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub removed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OwnMention {
    pub path: String,
    pub open: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ShareDesk {
    pub shared: Vec<SharedDocument>,
    pub shared_count: i64,
    pub own: Vec<OwnMention>,
    pub own_count: i64,
    #[serde(default)]
    pub restore: Vec<crate::commands::removal::RestoreRow>,
}

fn number_of(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|n| i64::try_from(n).ok()))
        .unwrap_or(0)
}

fn text_of(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_string)
}

fn shared_documents(body: &Value) -> (Vec<SharedDocument>, Vec<String>) {
    let mut rows = Vec::new();
    let mut ids = Vec::new();
    let Some(list) = body.get("shares").and_then(Value::as_array) else {
        return (rows, ids);
    };
    // Same owner and same document id is one row. Two paths stay two rows.
    let mut seen = HashSet::new();
    for row in list {
        let Some(id) = text_of(row, "id") else {
            continue;
        };
        let Some(document_id) = text_of(row, "document_id") else {
            continue;
        };
        let owner = text_of(row, "owner").unwrap_or_default();
        if !seen.insert(format!("{owner}\0{document_id}")) {
            continue;
        }
        let open = number_of(row.get("open").unwrap_or(&Value::Null)).max(0);
        rows.push(SharedDocument {
            id,
            title: title_for_list(text_of(row, "title").as_deref().unwrap_or(""), None),
            owner,
            open,
            pending: row.get("pending").and_then(Value::as_bool).unwrap_or(false),
            removed: row.get("removed").and_then(Value::as_bool).unwrap_or(false),
        });
        ids.push(document_id);
    }
    (rows, ids)
}

fn mention_pairs(body: &Value) -> Vec<(String, i64)> {
    let Some(list) = body.get("mentions").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in list {
        let Some(document_id) = text_of(row, "document_id") else {
            continue;
        };
        let n = number_of(row.get("n").unwrap_or(&Value::Null));
        if n > 0 {
            out.push((document_id, n));
        }
    }
    out
}

/// Dots on the user's own files. A document id that is in the shared list
/// stays on that list, and the same id is counted once.
pub(crate) fn own_mention_marks(
    paths: &[String],
    mentions: &[(String, i64)],
    shared_document_ids: &[String],
    home: Option<&Path>,
) -> (Vec<OwnMention>, i64) {
    let shared: HashSet<&str> = shared_document_ids.iter().map(String::as_str).collect();
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for (id, n) in mentions {
        if *n > 0 {
            counts.insert(id.as_str(), *n);
        }
    }
    let mut seen_paths = HashSet::new();
    let mut seen_ids = HashSet::new();
    let mut rows = Vec::new();
    let mut total = 0i64;
    for path in paths.iter().take(MARK_CAP) {
        if !seen_paths.insert(path.as_str()) {
            continue;
        }
        let id = share_document_id(home, Path::new(path));
        if shared.contains(id.as_str()) {
            continue;
        }
        let Some(n) = counts.get(id.as_str()).copied() else {
            continue;
        };
        if seen_ids.insert(id) {
            total += n;
        }
        rows.push(OwnMention {
            path: path.clone(),
            open: n,
        });
    }
    (rows, total)
}

fn sum_open(rows: &[SharedDocument]) -> i64 {
    rows.iter().map(|row| row.open).filter(|n| *n > 0).sum()
}

#[tauri::command]
pub async fn share_desk(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    paths: Vec<String>,
) -> Result<ShareDesk, AppError> {
    let restore = crate::commands::removal::reconcile(&app).await;
    let body = call_as(&app, reqwest::Method::GET, "shares/with-you", None).await?;
    let (mut shared, shared_ids) = shared_documents(&body);
    let home = app_dir(&app);
    if let Some(home) = home.as_ref() {
        for row in &mut shared {
            if let Some(heading) = heading_of_hosted_copy(home, &row.id) {
                row.title = heading;
            }
        }
        let kept: Vec<(String, bool)> = shared
            .iter()
            .map(|row| (row.id.clone(), row.removed))
            .collect();
        crate::commands::removal::keep_removed_copies(home, &kept);
    }
    let mentions = mention_pairs(&body);
    let state = app.state::<AppState>().window(webview.label())?;
    let mut marked = paths;
    {
        let index = state.file_index.read();
        for file in index.iter() {
            if marked.len() >= MARK_CAP {
                break;
            }
            marked.push(file.path.to_string_lossy().into_owned());
        }
    }
    let (own, own_count) = own_mention_marks(&marked, &mentions, &shared_ids, home.as_deref());
    let shared_count = sum_open(&shared);
    Ok(ShareDesk {
        shared,
        shared_count,
        own,
        own_count,
        restore,
    })
}

#[tauri::command]
pub async fn share_open_accepted(
    app: tauri::AppHandle,
    id: String,
    keep: Option<bool>,
) -> Result<String, AppError> {
    if id.len() != 36 || id.contains(['/', '\\']) {
        return Err(AppError::Account("validation_failed".into()));
    }
    let opened = call_as(
        &app,
        reqwest::Method::POST,
        "shares/open",
        Some(json!({ "id": id })),
    )
    .await?;
    let share_id = opened
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Account("not_found".into()))?;
    // The body is the document. It is written to the local copy and not logged.
    let text = opened.get("body").and_then(Value::as_str).unwrap_or("");
    let dir = app_dir(&app).ok_or_else(|| AppError::Account("unreachable".into()))?;
    let path = hosted_copy_path(&dir, share_id)?;
    refresh_local_copy(&path, text, keep.unwrap_or(false))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn share_latest(app: tauri::AppHandle, id: String) -> Result<String, AppError> {
    if id.len() != 36 || id.contains(['/', '\\']) {
        return Err(AppError::Account("validation_failed".into()));
    }
    let opened = call_as(
        &app,
        reqwest::Method::POST,
        "shares/open",
        Some(json!({ "id": id })),
    )
    .await?;
    Ok(opened
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

#[tauri::command]
pub async fn share_publish(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let file = PathBuf::from(&path);
    if ensure_can_leave(&app, &file).is_err() {
        return Ok(());
    }
    let shares = share_list(&app).await?;
    let home = app_dir(&app);
    let Some(canon) = canon_for(&shares, &file, home.as_deref()) else {
        return Ok(());
    };
    if canon.role != ShareRoleKind::Owner || !canon.status.is_live() {
        return Ok(());
    }
    let document = read_text(&file);
    if document.chars().count() > 100_000 {
        return Ok(());
    }
    call_as(
        &app,
        reqwest::Method::POST,
        "shares/copy",
        Some(json!({
            "document_id": canon.document_id,
            "body": document,
        })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn share_decide(app: tauri::AppHandle, id: String, accept: bool) -> Result<(), AppError> {
    let path = if accept {
        "changes/accept"
    } else {
        "changes/reject"
    };
    call_as(&app, reqwest::Method::POST, path, Some(json!({ "id": id }))).await?;
    Ok(())
}

/// The claimed document has to be the share's document. An empty claim is a miss.
#[cfg(test)]
fn same_document(claimed: &str, actual: &str) -> bool {
    !claimed.is_empty() && claimed == actual
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_realtime_token_needs_a_share_on_the_list() {
        let body = json!({
            "shares": [
                { "id": "s1", "role": "owner", "status": "accepted" },
                { "id": "s3", "role": "none", "status": "accepted" },
                { "id": "s4", "role": "invitee", "status": "pending" },
                { "id": "s5", "role": "invitee", "status": "removed" },
                { "id": "s6", "role": "owner", "status": "parked" },
                { "id": "s7", "role": "invitee" }
            ]
        });
        assert!(on_share(&body, "s1"));
        assert!(!on_share(&body, "s2"));
        assert!(!on_share(&body, "s3"));
        // A live invitee is on the share; a removed or parked one is not.
        assert!(on_share(&body, "s4"));
        assert!(!on_share(&body, "s5"));
        assert!(!on_share(&body, "s6"));
        assert!(!on_share(&body, "s7"));
    }

    #[test]
    fn a_cached_list_answers_until_it_is_20_seconds_old() {
        let t0 = std::time::Instant::now();
        let mut cache = ShareListCache::default();
        cache.put("a", t0, serde_json::json!({"shares": []}));
        assert!(cache
            .get("a", t0 + std::time::Duration::from_secs(19))
            .is_some());
        assert!(cache
            .get("a", t0 + std::time::Duration::from_secs(20))
            .is_none());
    }

    #[test]
    fn another_session_does_not_read_the_list() {
        let t0 = std::time::Instant::now();
        let mut cache = ShareListCache::default();
        cache.put("a", t0, serde_json::json!({"shares": []}));
        assert!(cache.get("b", t0).is_none());
    }

    #[test]
    fn a_read_that_raced_a_change_is_not_cached() {
        let t0 = std::time::Instant::now();
        let mut cache = ShareListCache::default();
        let started = cache.generation;
        // A share change lands while the read is on the network.
        cache.clear();
        cache.put_if_current(started, "a", t0, serde_json::json!({"shares": []}));
        assert!(cache.get("a", t0).is_none());
        cache.put_if_current(cache.generation, "a", t0, serde_json::json!({"shares": []}));
        assert!(cache.get("a", t0).is_some());
    }

    #[test]
    fn clear_drops_the_list() {
        let t0 = std::time::Instant::now();
        let mut cache = ShareListCache::default();
        cache.put("a", t0, serde_json::json!({"shares": []}));
        cache.clear();
        assert!(cache.get("a", t0).is_none());
    }

    #[test]
    fn one_refused_change_does_not_drop_the_rest() {
        let mut tally = SendTally {
            refused: Vec::new(),
            hard: None,
        };
        note_send_error(
            &mut tally,
            "c1",
            AppError::Account("validation_failed".into()),
        );
        note_send_error(&mut tally, "edit", AppError::Account("unreachable".into()));
        note_send_error(
            &mut tally,
            "c2",
            AppError::Account("validation_failed".into()),
        );
        assert_eq!(tally.refused, vec!["c1", "c2"]);
        assert!(matches!(tally.hard, Some(AppError::Account(code)) if code == "unreachable"));

        let mut only = SendTally {
            refused: Vec::new(),
            hard: None,
        };
        note_send_error(
            &mut only,
            "c1",
            AppError::Account("validation_failed".into()),
        );
        assert!(only.hard.is_none());
        assert_eq!(only.refused, vec!["c1"]);
    }

    #[test]
    fn a_suggestion_carries_the_baseline_and_a_comment_does_not() {
        let suggestion = OutgoingChange {
            payload_ref: "ref".into(),
            passage: "0:4".into(),
            original: "Keep".into(),
            body: Some("Kept.".into()),
        };
        let sent = change_body(&suggestion, "share", "doc", Some("Keep the line."));
        assert_eq!(sent["snapshot"], "Keep the line.");
        assert_eq!(sent["body"], "Kept.");
        let comment = OutgoingChange {
            payload_ref: "note".into(),
            passage: "0:4".into(),
            original: "Keep".into(),
            body: None,
        };
        let noted = change_body(&comment, "share", "doc", Some("Keep the line."));
        assert!(noted.get("snapshot").is_none());
        assert!(noted.get("body").is_none());
    }

    #[test]
    fn a_one_sentence_edit_is_one_passage() {
        let document = "Title line.\n\nThe harbor stays quiet.\n\nThe ledger is in pencil.";
        let sentence = "The harbor stays quiet.";
        let start = document.find(sentence).unwrap();
        let change = OutgoingChange {
            payload_ref: "one".into(),
            passage: format!("{start}:{}", start + sentence.len()),
            original: sentence.into(),
            body: Some("The harbor is quiet.".into()),
        };
        let sent = change_body(&change, "share", "doc", Some(document));
        assert_eq!(sent["original"], sentence);
        assert_ne!(sent["original"], document);
        assert_eq!(sent["snapshot"], document);
        assert_eq!(sent["body"], "The harbor is quiet.");
        let passage = sent["passage"].as_str().unwrap();
        let mut parts = passage.split(':');
        let from: usize = parts.next().unwrap().parse().unwrap();
        let to: usize = parts.next().unwrap().parse().unwrap();
        assert_eq!(to - from, sentence.len());
        assert!(to - from < document.len());
    }

    #[test]
    fn an_invite_link_yields_the_token_and_writes_b_copy() {
        assert_eq!(
            token_from_invite_link(&format!("alkuin://share/{}", "ab".repeat(32))),
            Some("ab".repeat(32))
        );
        assert!(token_from_invite_link("alkuin://share/short").is_none());
        assert!(token_from_invite_link("https://example.com/share/ab").is_none());
        let dir = std::env::temp_dir().join(format!("alkuin-share-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = write_hosted_copy(&dir, "share-1", "Boats wait.\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "Boats wait.\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_a_copy_writes_a_new_host_stamp() {
        let dir = std::env::temp_dir().join(format!("alkuin-stamp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path =
            write_hosted_copy(&dir, "11111111-1111-1111-1111-111111111111", "Boats.\n").unwrap();
        reset_share_baseline(&path).unwrap();
        let stamp = path
            .parent()
            .unwrap()
            .join(".11111111-1111-1111-1111-111111111111.md.host");
        let first = fs::read_to_string(&stamp).unwrap();
        reset_share_baseline(&path).unwrap();
        let second = fs::read_to_string(&stamp).unwrap();
        assert_ne!(first.trim(), second.trim());
        assert!(!first.trim().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsent_copy_is_kept_and_an_idle_open_replaces_it() {
        let dir = std::env::temp_dir().join(format!("alkuin-keep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = write_hosted_copy(&dir, "share-keep", "Local edit.\n").unwrap();
        refresh_local_copy(&path, "Owner text.\n", true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "Local edit.\n");
        refresh_local_copy(&path, "Owner text.\n", false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "Owner text.\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_forged_document_id_does_not_match() {
        assert!(!same_document("forged", "essay"));
        assert!(!same_document("", "essay"));
        assert!(same_document("essay", "essay"));
    }

    #[test]
    fn own_marks_skip_a_shared_document_and_count_a_file_once() {
        let dir = std::env::temp_dir().join(format!("alkuin-marks-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let own = dir.join("own.md");
        let shared = dir.join("shared.md");
        fs::write(&own, "x").unwrap();
        fs::write(&shared, "y").unwrap();
        let own_path = own.to_string_lossy().to_string();
        let shared_path = shared.to_string_lossy().to_string();
        let own_id = document_id(&own);
        let shared_id = document_id(&shared);
        let (rows, count) = own_mention_marks(
            &[own_path.clone(), shared_path, own_path],
            &[(own_id, 2), (shared_id.clone(), 4), ("missing".into(), 9)],
            &[shared_id],
            None,
        );
        assert_eq!(count, 2);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].open, 2);
        assert_eq!(
            sum_open(&[SharedDocument {
                id: "1".into(),
                title: "Harbor".into(),
                owner: "Paul".into(),
                open: 0,
                pending: false,
                removed: false,
            }]),
            0
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_share_copy_uses_the_owner_document_id() {
        let share = "11111111-1111-4111-8111-111111111111";
        let body = json!({
            "shares": [
                {
                    "id": share,
                    "document_id": "owner-about",
                    "role": "invitee",
                    "status": "accepted"
                },
                {
                    "id": "22222222-2222-4222-8222-222222222222",
                    "document_id": "other",
                    "role": "invitee",
                    "status": "accepted"
                }
            ]
        });
        let path = PathBuf::from(format!("/tmp/Alkuin/shares/{share}.md"));
        let canon = canon_for(&body, &path, None).expect("copy");
        assert_eq!(canon.document_id, "owner-about");
        assert_eq!(canon.share_id, share);
        assert_eq!(canon.role, ShareRoleKind::Invitee);
        assert!(copy_share_id(Path::new("/tmp/about.md")).is_none());
        let role = role_from_list(&body, &path, None);
        assert_eq!(role.document_id, "owner-about");
        assert_eq!(role.share_id.as_deref(), Some(share));
    }

    #[test]
    fn an_owner_file_resolves_the_accepted_share() {
        let dir = std::env::temp_dir().join(format!("alkuin-canon-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("about.md");
        fs::write(&file, "# **About**\n\nBoats.\n").unwrap();
        let id = document_id(&file);
        let body = json!({
            "shares": [
                {
                    "id": "33333333-3333-4333-8333-333333333333",
                    "document_id": &id,
                    "role": "owner",
                    "status": "pending"
                },
                {
                    "id": "44444444-4444-4444-8444-444444444444",
                    "document_id": &id,
                    "role": "owner",
                    "status": "accepted"
                }
            ]
        });
        let canon = canon_for(&body, &file, None).expect("owner");
        assert_eq!(canon.share_id, "44444444-4444-4444-8444-444444444444");
        assert_eq!(canon.document_id, id);
        assert_eq!(document_title(&file, "# **About**\n\nBoats.\n"), "About");
        assert_eq!(document_title(&file, "No heading\n"), "about");
        assert_eq!(
            document_title(Path::new("notes/about.md"), "# The *harbor*\n"),
            "The harbor"
        );
        assert_eq!(
            document_title(
                Path::new("about.md"),
                "---\ntitle: Ignored\n---\n\n# Writing as Thinking\n"
            ),
            "Ignored"
        );
        assert_eq!(
            document_title(
                Path::new("about.md"),
                "---\nauthor: Ada\n---\n\n# Writing as Thinking\n"
            ),
            "Writing as Thinking"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_share_link_opens_inside_a_workspace() {
        let file = "/tmp/Alkuin/shares/11111111-1111-4111-8111-111111111111.md";
        let in_vault = share_window_target(Some("/Users/ada/notes"), Some("/else"), file);
        assert_eq!(in_vault.workspace.as_deref(), Some("/Users/ada/notes"));
        assert_eq!(in_vault.file.as_deref(), Some(file));
        let recent = share_window_target(None, Some("/Users/ada/notes"), file);
        assert_eq!(recent.workspace.as_deref(), Some("/Users/ada/notes"));
        let folder = share_window_target(None, None, file);
        assert_eq!(folder.workspace.as_deref(), Some("/tmp/Alkuin/shares"));
        assert!(folder.file.is_some());
    }

    #[test]
    fn a_rename_keeps_the_share_id() {
        let root = std::env::temp_dir().join(format!("alkuin-share-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let notes = root.join("notes");
        let home = root.join("app");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&home).unwrap();
        let old = notes.join("WRITING IS THINKING.md");
        fs::write(&old, "# Writing as Thinking\n").unwrap();
        let new = notes.join("Writing as Thinking.md");
        carry_share_rename(&home, &old, &new, false, || {
            fs::rename(&old, &new).map_err(|err| AppError::Io(err.to_string()))
        })
        .unwrap();
        let carried = share_document_id(Some(&home), &new);
        assert_ne!(carried, document_id(&new));
        assert_eq!(carried, {
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(&carried)
                .unwrap();
            let path = PathBuf::from(String::from_utf8(bytes).unwrap());
            assert!(!path.exists());
            assert!(path.parent().unwrap().is_dir());
            carried.clone()
        });

        assert_eq!(
            title_for_list("WRITING IS THINKING", Some("# Writing as Thinking\n")),
            "Writing as Thinking"
        );
        assert_eq!(
            title_for_list("WRITING IS THINKING", Some("no heading\n")),
            "WRITING IS THINKING"
        );
        assert_eq!(title_for_list("  ", None), "Document");

        let share = "11111111-1111-4111-8111-111111111111";
        fs::create_dir_all(home.join("shares")).unwrap();
        fs::write(
            home.join("shares").join(format!("{share}.md")),
            "# Writing as Thinking\n",
        )
        .unwrap();
        assert_eq!(
            heading_of_hosted_copy(&home, share).as_deref(),
            Some("Writing as Thinking")
        );

        let listed = shared_documents(&json!({
            "shares": [
                {"id": "a", "document_id": "path-old", "title": "WRITING IS THINKING", "owner": "Ada", "open": 0},
                {"id": "b", "document_id": "path-old", "title": "again", "owner": "Ada", "open": 1},
                {"id": "c", "document_id": "path-new", "title": "Writing as Thinking", "owner": "Ada", "open": 0},
                {"id": "d", "document_id": "path-old", "title": "WRITING IS THINKING", "owner": "Bea", "open": 0}
            ]
        }));
        assert_eq!(listed.0.len(), 3);
        assert_eq!(listed.0[0].title, "WRITING IS THINKING");
        assert_eq!(listed.0[1].title, "Writing as Thinking");
        assert_eq!(listed.1, vec!["path-old", "path-new", "path-old"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_row_with_an_unknown_status_or_role_is_not_a_share() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("essay.md");
        fs::write(&file, "words\n").unwrap();
        let id = document_id(&file);
        let body = json!({ "shares": [
            {"id": "a", "document_id": id, "role": "owner", "status": "archived"},
            {"id": "b", "document_id": id, "role": "editor", "status": "accepted"},
            {"id": "c", "document_id": id, "role": "owner", "status": "declined"},
            {"id": "d", "document_id": id, "role": "owner"}
        ]});
        assert!(canon_for(&body, &file, None).is_none());
        let role = role_from_list(&body, &file, None);
        assert_eq!(role.role, "none");
        assert!(role.share_id.is_none());
        let live = json!({ "shares": [
            {"id": "e", "document_id": id, "role": "owner", "status": "pending"}
        ]});
        let role = role_from_list(&live, &file, None);
        assert_eq!(role.role, "owner");
        assert_eq!(role.status.as_deref(), Some("pending"));
    }

    #[test]
    fn the_stamp_is_written_before_the_hosted_body() {
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("11111111-1111-4111-8111-111111111111.md");
        let stamp = dir
            .path()
            .join(".11111111-1111-4111-8111-111111111111.md.host");
        refresh_local_copy(&copy, "server text\n", false).unwrap();
        let first = fs::read_to_string(&stamp).unwrap();
        assert_eq!(fs::read_to_string(&copy).unwrap(), "server text\n");
        // The body cannot be written: a directory sits at its path. The stamp
        // still moved, so the text on disk is the new baseline, not an edit.
        let blocked = dir.path().join("22222222-2222-4222-8222-222222222222.md");
        fs::create_dir_all(blocked.join("inside")).unwrap();
        assert!(refresh_local_copy(&blocked, "newer\n", false).is_err());
        assert!(dir
            .path()
            .join(".22222222-2222-4222-8222-222222222222.md.host")
            .is_file());
        refresh_local_copy(&copy, "next\n", false).unwrap();
        assert_ne!(fs::read_to_string(&stamp).unwrap(), first);
        refresh_local_copy(&copy, "kept\n", true).unwrap();
        assert_eq!(fs::read_to_string(&copy).unwrap(), "next\n");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_share_map_that_cannot_be_read_refuses_the_rename() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("app");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&notes).unwrap();
        fs::write(home.join(SHARE_PATHS_FILE), "not-json").unwrap();
        let old = notes.join("essay.md");
        let new = notes.join("renamed.md");
        fs::write(&old, "words\n").unwrap();
        let mut renamed = false;
        let error = carry_share_rename(&home, &old, &new, false, || {
            renamed = true;
            Ok(())
        })
        .unwrap_err();
        assert_eq!(error.to_string(), SHARE_LIST_UNREADABLE);
        assert!(!renamed);
        assert!(old.is_file());
        assert_eq!(
            fs::read_to_string(home.join(SHARE_PATHS_FILE)).unwrap(),
            "not-json"
        );
    }

    #[test]
    fn a_kept_document_never_reaches_send() {
        let path = Path::new("/tmp/alkuin-share-kept.md");
        let set = MacOnlySet::holding(vec![path.to_path_buf()]);
        let result = depart(&set, path, Channel::Share, &[(path, "The harbor.")], || {
            Ok(())
        });
        assert!(result.is_err());
    }
}
