//! Cloud delete for a shared document. In-app delete erases. A missing file
//! soft-deletes. The queues are replayed on the next desk read.
//!
//! Two queue files, both edited under one lock and written atomically:
//! - `share-removal.txt` holds confirmed removals: a share the list or this
//!   Mac's map names, a leave, a restore. Each is posted as it is.
//! - `share-removal-pending.txt` holds an erase or soft-delete (`erase?`,
//!   `soft?`) of an id the share list has not confirmed yet. It may be a note
//!   that was never shared, so it is not posted until a later read of the
//!   list, or this Mac's map, names it. It lives apart so it can never take a
//!   slot from a real revocation.

use crate::commands::fs::write_atomic;
use crate::commands::shares::{call_as, forget_share_list, share_list, ShareRoleKind, ShareStatus};
use crate::error::AppError;
use crate::mac_only::keep_without_switch;
use crate::share_paths::{self, Absence, CloudPlan};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

const QUEUE: &str = "share-removal.txt";
/// Unconfirmed ids only. A separate file so they cannot evict a confirmed revocation.
const PENDING: &str = "share-removal-pending.txt";
/// Confirmed queue: past this many ops the oldest one that is not an erase
/// goes. An erase is never dropped to make room: it is the only record that a
/// delete still has to reach everyone else. Pending file: a new id past this
/// many is refused, and the caller hears that it was not saved.
const QUEUE_CAP: usize = 100;
const NOT_SAVED: &str =
    "Alkuin couldn't save this removal to retry. The shared copy is still online.";

/// Every read-modify-write of either queue file runs under this lock.
static QUEUE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RestoreRow {
    pub document_id: String,
    pub title: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RemovalKind {
    /// An invitee leaves. The key is the share row id.
    Leave,
    /// The owner deleted the file in the app. Final.
    Erase,
    /// The owner's file disappeared outside the app.
    Soft,
    /// The owner's file is back.
    Restore,
}

impl RemovalKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "leave" => Some(Self::Leave),
            "erase" => Some(Self::Erase),
            "soft" => Some(Self::Soft),
            "restore" => Some(Self::Restore),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Leave => "leave",
            Self::Erase => "erase",
            Self::Soft => "soft",
            Self::Restore => "restore",
        }
    }

    fn route(self) -> &'static str {
        match self {
            Self::Leave => "shares/leave",
            Self::Erase => "shares/erase",
            Self::Soft => "shares/soft-delete",
            Self::Restore => "shares/restore",
        }
    }

    fn body(self, key: &str) -> Value {
        match self {
            Self::Leave => json!({ "id": key }),
            _ => json!({ "document_id": key }),
        }
    }

    /// An erase or a soft-delete may name a note that was never shared, so
    /// it is posted only for a share the list or this Mac's map confirms.
    fn needs_confirmation(self) -> bool {
        matches!(self, Self::Erase | Self::Soft)
    }
}

/// One queued cloud removal: `kind<TAB>key` on disk.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RemovalOp {
    kind: RemovalKind,
    key: String,
}

impl RemovalOp {
    fn new(kind: RemovalKind, key: &str) -> Self {
        Self {
            kind,
            key: key.to_string(),
        }
    }

    fn line(&self) -> String {
        format!("{}\t{}", self.kind.as_str(), self.key)
    }

    fn parse_parts(kind: &str, key: &str) -> Option<Self> {
        if key.is_empty() {
            return None;
        }
        Some(Self::new(RemovalKind::parse(kind)?, key))
    }

    /// A leave names a share row. The other kinds name a document.
    fn same_target(&self, other: &Self) -> bool {
        self.key == other.key
            && (self.kind == RemovalKind::Leave) == (other.kind == RemovalKind::Leave)
    }
}

/// Which of the two queue files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Queue {
    /// `share-removal.txt`: posted as it is.
    Confirmed,
    /// `share-removal-pending.txt`: `erase?`/`soft?`, posted once confirmed.
    Pending,
}

impl Queue {
    fn path(self, home: &Path) -> PathBuf {
        home.join(match self {
            Self::Confirmed => QUEUE,
            Self::Pending => PENDING,
        })
    }

    fn line(self, op: &RemovalOp) -> String {
        match self {
            Self::Confirmed => op.line(),
            Self::Pending => format!("{}?\t{}", op.kind.as_str(), op.key),
        }
    }

    /// A pending line is only ever an erase or a soft-delete.
    fn parse(self, line: &str) -> Option<RemovalOp> {
        let (kind, key) = line.split_once('\t')?;
        match self {
            Self::Confirmed => RemovalOp::parse_parts(kind, key),
            Self::Pending => RemovalOp::parse_parts(kind.strip_suffix('?')?, key)
                .filter(|op| op.kind.needs_confirmation()),
        }
    }
}

/// The owner's row as owned-state reports it. Any other value is unknown,
/// not "open": an unknown row is skipped, never soft-deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OwnedState {
    Open,
    Soft,
    Gone,
}

impl OwnedState {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            "soft" => Some(Self::Soft),
            "gone" => Some(Self::Gone),
            _ => None,
        }
    }
}

/// A missing file is an empty queue. A read error is an error, so a write
/// never replaces lines it could not read. An unreadable line is dropped.
fn read_ops(home: &Path, queue: Queue) -> Result<Vec<RemovalOp>, AppError> {
    let text = match fs::read_to_string(queue.path(home)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AppError::Io(error.to_string())),
    };
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let op = queue.parse(line);
            if op.is_none() {
                eprintln!("[removal] an unreadable queue line was dropped");
            }
            op
        })
        .collect())
}

fn edit_ops<T>(
    home: &Path,
    queue: Queue,
    change: impl FnOnce(&mut Vec<RemovalOp>) -> T,
) -> Result<T, AppError> {
    let _guard = QUEUE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut ops = read_ops(home, queue)?;
    let before = ops.clone();
    let out = change(&mut ops);
    if ops != before {
        let body: Vec<String> = ops.iter().map(|op| queue.line(op)).collect();
        write_atomic(&queue.path(home), body.join("\n").as_bytes())?;
    }
    Ok(out)
}

/// One op per target. A newer op replaces an older one, except that an erase
/// is final. Past the cap, the oldest op that is not an erase goes.
fn upsert(ops: &mut Vec<RemovalOp>, op: RemovalOp) {
    if let Some(index) = ops.iter().position(|queued| queued.same_target(&op)) {
        if ops[index].kind != RemovalKind::Erase {
            ops[index] = op;
        }
        return;
    }
    if ops.len() >= QUEUE_CAP {
        if let Some(oldest) = ops
            .iter()
            .position(|queued| queued.kind != RemovalKind::Erase)
        {
            ops.remove(oldest);
        }
    }
    ops.push(op);
}

fn enqueue(home: &Path, op: RemovalOp) -> Result<(), AppError> {
    remember_op(home, op, Requeue::Replace)
}

/// Remember an id whose share is not confirmed yet. It never enters the
/// confirmed queue, and it is not posted until a later read of the list or
/// the local map names it. A full pending file refuses a new id rather than
/// dropping an older one, and the caller hears that it was not saved.
fn enqueue_pending(home: &Path, op: RemovalOp) -> Result<(), AppError> {
    if !op.kind.needs_confirmation() || op.key.is_empty() {
        return Ok(());
    }
    let saved = edit_ops(home, Queue::Pending, |ops| {
        if ops.iter().any(|queued| queued.same_target(&op)) {
            upsert(ops, op);
            return true;
        }
        if ops.len() >= QUEUE_CAP {
            return false;
        }
        ops.push(op);
        true
    });
    match saved {
        Ok(true) => Ok(()),
        Ok(false) => Err(AppError::Message(NOT_SAVED.into())),
        Err(err) => {
            eprintln!("[removal] the pending removal file was not written: {err}");
            Err(AppError::Message(NOT_SAVED.into()))
        }
    }
}

/// Where a failed op came from decides whether it may replace what is queued.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Requeue {
    /// A new request (a delete, a restore, a leave): the newest word for its
    /// target, so it replaces an older op (an erase still wins).
    Replace,
    /// A replay of a queued op. If a newer op was queued for the same target
    /// while it ran, that one stays; this op goes back only if the target has
    /// nothing queued.
    IfCurrent,
}

fn remember_op(home: &Path, op: RemovalOp, requeue: Requeue) -> Result<(), AppError> {
    edit_ops(home, Queue::Confirmed, |ops| match requeue {
        Requeue::Replace => upsert(ops, op),
        Requeue::IfCurrent => {
            if !ops.iter().any(|queued| queued.same_target(&op)) {
                upsert(ops, op);
            }
        }
    })
}

/// Only this exact op goes. A newer op for the same target stays queued.
fn drop_op(home: &Path, queue: Queue, op: &RemovalOp) {
    if let Err(error) = edit_ops(home, queue, |ops| ops.retain(|queued| queued != op)) {
        eprintln!("[removal] a finished removal stayed queued: {error}");
    }
}

/// A pending op that was sent leaves the pending file once the removal is
/// done, refused for good, or held by the confirmed queue (this op, or a
/// newer one for the same target). A send that failed and could not be
/// queued keeps it, so the revocation is not lost.
fn pending_settled(home: &Path, op: &RemovalOp, result: &Result<(), AppError>) -> bool {
    match result {
        Ok(()) => true,
        Err(err) if !remembered(err) => true,
        Err(_) => read_ops(home, Queue::Confirmed)
            .map(|ops| ops.iter().any(|queued| queued.same_target(op)))
            .unwrap_or(false),
    }
}

async fn post(app: &tauri::AppHandle, path: &str, body: Value) -> Result<(), AppError> {
    call_as(app, reqwest::Method::POST, path, Some(body)).await?;
    Ok(())
}

fn remembered(err: &AppError) -> bool {
    !matches!(err, AppError::Account(code) if code == "not_found" || code == "validation_failed")
}

fn account_code(err: &AppError) -> &str {
    match err {
        AppError::Account(code) => code.as_str(),
        _ => "",
    }
}

/// An erase or soft-delete of a file that was never shared is finished.
pub(crate) fn quiet_removal(kind: RemovalKind, code: &str) -> bool {
    code == "not_found" && matches!(kind, RemovalKind::Erase | RemovalKind::Soft)
}

/// Signed out. The local delete still happens. The line waits for the next sign-in.
pub(crate) fn signed_out_removal(kind: RemovalKind, code: &str) -> bool {
    code == "unauthorized" && matches!(kind, RemovalKind::Erase | RemovalKind::Soft)
}

/// Finder soft-delete posts the id the server listed, not a path encoding
/// `classify_absence` may have invented.
pub(crate) fn soft_delete_target<'a>(server_id: &'a str, absence: &Absence) -> Option<&'a str> {
    match absence {
        Absence::SoftDelete(_) if !server_id.is_empty() => Some(server_id),
        _ => None,
    }
}

/// Owned-state says the row already moved. `gone` / `soft` / `open` is that move.
pub(crate) fn settled_state(kind: RemovalKind, state: Option<OwnedState>) -> bool {
    match kind {
        RemovalKind::Erase => state == Some(OwnedState::Gone),
        RemovalKind::Soft => matches!(state, Some(OwnedState::Soft | OwnedState::Gone)),
        RemovalKind::Restore => state == Some(OwnedState::Open),
        RemovalKind::Leave => false,
    }
}

/// The row's state, parsed once. A missing or unknown state is `None`.
fn state_of(body: &Value, id: &str) -> Option<OwnedState> {
    let rows = body.get("documents")?.as_array()?;
    for row in rows {
        if row.get("document_id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        return row
            .get("state")
            .and_then(Value::as_str)
            .and_then(OwnedState::parse);
    }
    None
}

/// The server answers `{ok:true, removed|parked}`. Owned-state (`documents`)
/// may not be readable. Erase and soft-delete leave the owner's rows `parked`.
/// A missing id is not gone.
///
/// ponytail: a row that was already parked looks settled when owned-state
/// cannot be read. Upgrade path is owned-state `gone` vs `soft`.
pub(crate) fn settled_from_shares(kind: RemovalKind, id: &str, body: &Value) -> bool {
    let Some(rows) = body.get("shares").and_then(Value::as_array) else {
        return false;
    };
    let mut seen = false;
    let mut parked = false;
    let mut open = false;
    for row in rows {
        if row.get("document_id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        if ShareRoleKind::of(row) != Some(ShareRoleKind::Owner) {
            continue;
        }
        let Some(status) = ShareStatus::of(row) else {
            continue;
        };
        seen = true;
        if status == ShareStatus::Parked {
            parked = true;
        }
        if status.is_live() {
            open = true;
        }
    }
    if !seen {
        return false;
    }
    match kind {
        RemovalKind::Erase | RemovalKind::Soft => parked && !open,
        RemovalKind::Restore => open,
        RemovalKind::Leave => false,
    }
}

/// A removal decides from the server's list, not a copy cached for other screens.
async fn fresh_share_list(app: &tauri::AppHandle) -> Result<Value, AppError> {
    forget_share_list();
    share_list(app).await
}

async fn removal_settled(app: &tauri::AppHandle, kind: RemovalKind, id: &str) -> bool {
    if kind == RemovalKind::Leave {
        return false;
    }
    if let Ok(body) = call_as(app, reqwest::Method::GET, "shares/owned-state", None).await {
        if body.get("documents").and_then(Value::as_array).is_some() {
            return settled_state(kind, state_of(&body, id));
        }
    }
    let Ok(body) = fresh_share_list(app).await else {
        return false;
    };
    settled_from_shares(kind, id, &body)
}

/// A new removal request.
async fn post_removal(
    app: &tauri::AppHandle,
    home: Option<&Path>,
    kind: RemovalKind,
    key: &str,
) -> Result<(), AppError> {
    post_op(app, home, RemovalOp::new(kind, key), Requeue::Replace).await
}

async fn post_op(
    app: &tauri::AppHandle,
    home: Option<&Path>,
    op: RemovalOp,
    requeue: Requeue,
) -> Result<(), AppError> {
    let (kind, key) = (op.kind, op.key.as_str());
    let finished = |home: Option<&Path>| {
        if let Some(home) = home {
            drop_op(home, Queue::Confirmed, &op);
        }
    };
    let remember = |home: Option<&Path>| match home {
        Some(home) => remember_op(home, op.clone(), requeue),
        None => Err(AppError::Io("no app folder to queue a removal".into())),
    };
    match post(app, kind.route(), kind.body(key)).await {
        Ok(()) => {
            finished(home);
            Ok(())
        }
        Err(err) if quiet_removal(kind, account_code(&err)) => {
            finished(home);
            Ok(())
        }
        Err(_) if removal_settled(app, kind, key).await => {
            finished(home);
            Ok(())
        }
        // The local step already happened. The op waits for the next sign-in,
        // and a queue that cannot take it is an error, not a silent loss.
        Err(err) if signed_out_removal(kind, account_code(&err)) => remember(home),
        Err(err) => {
            if remembered(&err) {
                if let Err(queue_err) = remember(home) {
                    eprintln!(
                        "[removal] a failed {} was not queued: {queue_err}",
                        kind.as_str()
                    );
                }
            } else {
                finished(home);
            }
            Err(err)
        }
    }
}

/// Post a pending op as its plain kind. It leaves the pending file only
/// once [`pending_settled`] says so.
async fn post_pending(
    app: &tauri::AppHandle,
    home: Option<&Path>,
    op: RemovalOp,
    requeue: Requeue,
) -> Result<(), AppError> {
    let result = post_op(app, home, op.clone(), requeue).await;
    if let Some(home) = home {
        if pending_settled(home, &op, &result) {
            drop_op(home, Queue::Pending, &op);
        }
    }
    result
}

/// The cloud half of an in-app delete, split by what this Mac knows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CloudDelete {
    /// A leave, and the erase ids this Mac stored for a real share. Queued
    /// and posted as they are.
    now: CloudPlan,
    /// Erase ids this Mac has no share record for: a note that was never
    /// shared, or a share made here that the map does not name yet. Posted
    /// only once the share list names them.
    unconfirmed: Vec<String>,
}

/// Split a delete's plan before `share_paths::forget` drops what this Mac
/// knows. `known` is [`share_paths::known_share_ids`] read at that point.
pub(crate) fn split_cloud_delete(plan: &CloudPlan, known: &HashSet<String>) -> CloudDelete {
    match plan {
        CloudPlan::Erase(ids) => {
            let (now, later) = split_unconfirmed(ids.clone(), known);
            CloudDelete {
                now: if now.is_empty() {
                    CloudPlan::None
                } else {
                    CloudPlan::Erase(now)
                },
                unconfirmed: later,
            }
        }
        other => CloudDelete {
            now: other.clone(),
            unconfirmed: Vec::new(),
        },
    }
}

/// Write the cloud half of a delete down before any network wait, so a crash
/// or a quit during the request still finishes it on the next desk read.
/// Confirmed ids go to the queue, the rest to the pending file. `post_op`
/// drops each op once it lands. Every id is tried; the first failure is
/// returned.
pub(crate) fn record_cloud_delete(home: &Path, delete: &CloudDelete) -> Result<(), AppError> {
    let confirmed = match &delete.now {
        CloudPlan::None => Ok(()),
        CloudPlan::Leave(id) => enqueue(home, RemovalOp::new(RemovalKind::Leave, id)),
        CloudPlan::Erase(ids) => edit_ops(home, Queue::Confirmed, |ops| {
            for id in ids {
                upsert(ops, RemovalOp::new(RemovalKind::Erase, id));
            }
        }),
    };
    let mut first = confirmed.err();
    for id in &delete.unconfirmed {
        if let Err(err) = enqueue_pending(home, RemovalOp::new(RemovalKind::Erase, id)) {
            first.get_or_insert(err);
        }
    }
    match first {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// Post an in-app delete's cloud half, after the Trash and after
/// [`record_cloud_delete`]. Confirmed ids are posted now. Unconfirmed ids are
/// checked against a fresh share list: a listed share is erased, an id a
/// complete list does not name is dropped unsent, and anything else waits in
/// the pending file for the next desk read.
pub async fn apply_cloud_delete(
    app: &tauri::AppHandle,
    home: Option<&Path>,
    delete: &CloudDelete,
) -> Result<(), AppError> {
    let mut first = match &delete.now {
        CloudPlan::None => None,
        CloudPlan::Leave(id) => post_removal(app, home, RemovalKind::Leave, id).await.err(),
        CloudPlan::Erase(ids) => {
            let mut first = None;
            for id in ids {
                if let Err(err) = post_removal(app, home, RemovalKind::Erase, id).await {
                    first.get_or_insert(err);
                }
            }
            first
        }
    };
    if let Err(err) = settle_unconfirmed(app, home, &delete.unconfirmed).await {
        first.get_or_insert(err);
    }
    match first {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

async fn settle_unconfirmed(
    app: &tauri::AppHandle,
    home: Option<&Path>,
    ids: &[String],
) -> Result<(), AppError> {
    if ids.is_empty() {
        return Ok(());
    }
    let confirmation = Confirmation::read(app, home).await;
    // An id that has to wait is only safe if the pending file holds it.
    let saved = match home {
        Some(home) => read_ops(home, Queue::Pending).unwrap_or_default(),
        None => Vec::new(),
    };
    let mut first = None;
    for id in ids {
        let op = RemovalOp::new(RemovalKind::Erase, id);
        let result = match confirmation.decide(id) {
            Replay::Send => post_pending(app, home, op, Requeue::Replace).await,
            Replay::Drop => {
                if let Some(home) = home {
                    drop_op(home, Queue::Pending, &op);
                }
                Ok(())
            }
            Replay::Wait if saved.contains(&op) => Ok(()),
            Replay::Wait => Err(AppError::Message(NOT_SAVED.into())),
        };
        if let Err(err) = result {
            first.get_or_insert(err);
        }
    }
    match first {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// Document ids the account's share list names, as owner or holder: the full id set when
/// the server sends it, plus the ids on the (capped) rows.
pub(crate) fn listed_ids(body: &Value) -> HashSet<String> {
    let mut ids: HashSet<String> = body
        .get("shares")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("document_id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if let Some(all) = all_document_ids(body) {
        ids.extend(all);
    }
    ids
}

/// A `shares` list this long may have been cut short.
pub(crate) const SHARE_LIST_ROW_CAP: usize = 100;

/// Every document id this account is on, uncapped, when the server sends the set
/// (`document_ids`).
fn all_document_ids(body: &Value) -> Option<HashSet<String>> {
    body.get("document_ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
}

/// True when no listed id can be missing: the server sent the full id set, or the
/// capped `shares` rows stop below the cap. Anything else may have been cut.
pub(crate) fn share_list_complete(body: &Value) -> bool {
    all_document_ids(body).is_some()
        || body
            .get("shares")
            .and_then(Value::as_array)
            .is_some_and(|rows| rows.len() < SHARE_LIST_ROW_CAP)
}

/// Ids safe to post. The server's ids always count. When that list may be cut or
/// is malformed, ids this Mac stored for a real share count too. An invented path
/// id is not in either set, so a never-shared note is not posted.
pub(crate) fn removal_ids(body: &Value, known: &HashSet<String>) -> HashSet<String> {
    let mut ids = listed_ids(body);
    if !share_list_complete(body) {
        ids.extend(known.iter().cloned());
    }
    ids
}

/// When the share list can't be read: the ids this Mac stored for a real share are posted
/// now. The rest wait in the pending file and are not posted until a later read names them.
pub(crate) fn split_unconfirmed(
    ids: Vec<String>,
    known: &HashSet<String>,
) -> (Vec<String>, Vec<String>) {
    ids.into_iter().partition(|id| known.contains(id))
}

#[derive(Debug, PartialEq)]
pub(crate) enum Replay {
    Send,
    Drop,
    Wait,
}

/// What replay does with a queued erase or soft-delete. A listed id, or one this Mac stored
/// for a share, is sent. Anything else is dropped unsent only when the list is complete;
/// a cut or malformed list cannot rule a share out, and no list at all says nothing, so
/// the line waits. A path never leaves unconfirmed, and a real share is never dropped.
pub(crate) fn replay_decision(
    key: &str,
    listed: Option<&Value>,
    known: &HashSet<String>,
) -> Replay {
    match listed {
        Some(body) if removal_ids(body, known).contains(key) => Replay::Send,
        Some(body) if share_list_complete(body) => Replay::Drop,
        Some(_) => Replay::Wait,
        None if known.contains(key) => Replay::Send,
        None => Replay::Wait,
    }
}

/// Whether a Finder soft-delete of `id` is posted. Only an id the list names,
/// or, when that list may be cut, an id this Mac stored for a real share.
pub(crate) fn should_soft_delete(body: &Value, id: &str, known: &HashSet<String>) -> bool {
    removal_ids(body, known).contains(id)
}

/// A fresh share list (or none, when it cannot be read) and the ids this
/// Mac stored for a real share, read once for every decision that needs them.
struct Confirmation {
    listed: Option<Value>,
    known: HashSet<String>,
}

impl Confirmation {
    async fn read(app: &tauri::AppHandle, home: Option<&Path>) -> Self {
        Self {
            listed: fresh_share_list(app).await.ok(),
            known: home.map(share_paths::known_share_ids).unwrap_or_default(),
        }
    }

    fn decide(&self, key: &str) -> Replay {
        replay_decision(key, self.listed.as_ref(), &self.known)
    }
}

/// Finder soft-delete. Posts an id the list names, or a stored share id when the list
/// may be cut. A never-shared note stays on this Mac.
/// When the list can't be read, a stored share id is posted now. Any other id waits
/// in the pending file and is not posted until the list or the map names it.
pub(crate) async fn soft_delete_if_listed(app: &tauri::AppHandle, home: Option<&Path>, id: &str) {
    let confirmation = Confirmation::read(app, home).await;
    let Some(body) = confirmation.listed.as_ref() else {
        if confirmation.known.contains(id) {
            soft_delete_id(app, home, id).await;
        } else if let Some(home) = home {
            if let Err(err) = enqueue_pending(home, RemovalOp::new(RemovalKind::Soft, id)) {
                eprintln!("[removal] a soft-delete was not saved to retry: {err}");
            }
        }
        return;
    };
    if should_soft_delete(body, id, &confirmation.known) {
        soft_delete_id(app, home, id).await;
    }
}

pub async fn soft_delete_id(app: &tauri::AppHandle, home: Option<&Path>, id: &str) {
    if let Err(err) = post_removal(app, home, RemovalKind::Soft, id).await {
        eprintln!("[removal] soft-delete waits: {err}");
    }
}

async fn restore_id(app: &tauri::AppHandle, home: Option<&Path>, id: &str) {
    if let Err(err) = post_removal(app, home, RemovalKind::Restore, id).await {
        eprintln!("[removal] restore waits: {err}");
    }
}

fn queued_ops(home: &Path, queue: Queue) -> Vec<RemovalOp> {
    match edit_ops(home, queue, |ops| ops.clone()) {
        Ok(ops) => ops,
        Err(err) => {
            eprintln!("[removal] a removal queue could not be read: {err}");
            Vec::new()
        }
    }
}

/// The confirmed queue, then the pending file. The share list is read once,
/// and only when an erase or soft-delete needs it; see [`replay_decision`].
async fn replay(app: &tauri::AppHandle, home: &Path) {
    let confirmed = queued_ops(home, Queue::Confirmed);
    let pending = queued_ops(home, Queue::Pending);
    let mut confirmation: Option<Confirmation> = None;
    for op in confirmed {
        if op.kind.needs_confirmation() {
            if confirmation.is_none() {
                confirmation = Some(Confirmation::read(app, Some(home)).await);
            }
            match confirmation.as_ref().map(|found| found.decide(&op.key)) {
                Some(Replay::Drop) => {
                    drop_op(home, Queue::Confirmed, &op);
                    continue;
                }
                Some(Replay::Wait) | None => continue,
                Some(Replay::Send) => {}
            }
        }
        let _ = post_op(app, Some(home), op, Requeue::IfCurrent).await;
    }
    for op in pending {
        if confirmation.is_none() {
            confirmation = Some(Confirmation::read(app, Some(home)).await);
        }
        match confirmation.as_ref().map(|found| found.decide(&op.key)) {
            Some(Replay::Drop) => drop_op(home, Queue::Pending, &op),
            Some(Replay::Wait) | None => {}
            Some(Replay::Send) => {
                let _ = post_pending(app, Some(home), op, Requeue::IfCurrent).await;
            }
        }
    }
}

pub async fn reconcile(app: &tauri::AppHandle) -> Vec<RestoreRow> {
    let home = app.path().app_data_dir().ok();
    if let Some(home) = home.as_ref() {
        replay(app, home).await;
    }
    let Ok(body) = call_as(app, reqwest::Method::GET, "shares/owned-state", None).await else {
        return Vec::new();
    };
    let Some(home) = home else {
        return Vec::new();
    };
    let Some(rows) = body.get("documents").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut restore = Vec::new();
    for row in rows {
        let Some(id) = row.get("document_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(state) = row
            .get("state")
            .and_then(Value::as_str)
            .and_then(OwnedState::parse)
        else {
            eprintln!("[removal] an owned row has no state Alkuin knows; it is left alone");
            continue;
        };
        let title = row
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Document");
        let Some(decoded) = share_paths::path_of_document_id(id) else {
            continue;
        };
        let current = share_paths::live_path(&home, id).unwrap_or_else(|| decoded.clone());
        if current.is_file() {
            share_paths::note_present(&home, &current);
            share_paths::bind_document_id(&home, &current, id);
            if state == OwnedState::Soft {
                restore_id(app, Some(&home), id).await;
            }
            continue;
        }
        if state == OwnedState::Gone {
            continue;
        }
        let candidates = share_paths::sibling_markdown(&decoded);
        match share_paths::classify_listed_absence(&home, &decoded, &candidates) {
            Absence::Ignore => {}
            Absence::Carried => {
                if state == OwnedState::Soft {
                    restore_id(app, Some(&home), id).await;
                }
            }
            absence @ Absence::SoftDelete(_) => {
                if state == OwnedState::Open {
                    if let Some(target) = soft_delete_target(id, &absence) {
                        soft_delete_id(app, Some(&home), target).await;
                    }
                } else if state == OwnedState::Soft {
                    restore.push(RestoreRow {
                        document_id: id.to_string(),
                        title: title.to_string(),
                    });
                }
            }
        }
    }
    restore
}

pub fn keep_removed_copies(home: &Path, rows: &[(String, bool)]) {
    for (id, removed) in rows {
        if !removed {
            continue;
        }
        let path = home.join("shares").join(format!("{id}.md"));
        if path.is_file() {
            if let Err(err) = keep_without_switch(home, &path) {
                eprintln!("[removal] a removed copy could not be kept on this Mac: {err}");
            }
        }
    }
}

#[tauri::command]
pub async fn share_erase_document(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let home = app.path().app_data_dir().ok();
    let id = crate::commands::shares::share_document_id(home.as_deref(), Path::new(&path));
    post_removal(&app, home.as_deref(), RemovalKind::Erase, &id).await
}

#[tauri::command]
pub async fn share_restore_document(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<(), AppError> {
    let home = app.path().app_data_dir().ok();
    post_removal(&app, home.as_deref(), RemovalKind::Restore, &document_id).await
}

#[tauri::command]
pub async fn share_answer(app: tauri::AppHandle, id: String, accept: bool) -> Result<(), AppError> {
    let path = if accept {
        "shares/accept"
    } else {
        "shares/decline"
    };
    post(&app, path, json!({ "id": id })).await
}

#[tauri::command]
pub async fn share_leave(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    let home = app.path().app_data_dir().ok();
    post_removal(&app, home.as_deref(), RemovalKind::Leave, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_removal_drops_a_cached_share_list_before_it_reads() {
        crate::commands::shares::remember_share_list(
            "removal-stale",
            json!({"shares":[{"document_id":"old"}]}),
        );
        assert!(crate::commands::shares::share_list_cached("removal-stale"));
        forget_share_list();
        assert!(!crate::commands::shares::share_list_cached("removal-stale"));
    }

    #[test]
    fn listed_ids_reads_owner_and_invitee_rows() {
        let body = json!({"shares": [
            {"document_id": "a", "role": "owner"},
            {"document_id": "b", "role": "invitee"},
            {"role": "owner"}
        ]});
        let ids = listed_ids(&body);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("a") && ids.contains("b"));
        assert!(listed_ids(&json!({"shares": []})).is_empty());
        assert!(listed_ids(&json!({})).is_empty());
    }

    fn rows(count: usize) -> Value {
        let shares: Vec<Value> = (0..count)
            .map(|n| json!({"document_id": format!("doc-{n}"), "role": "owner"}))
            .collect();
        json!({ "shares": shares })
    }

    #[test]
    fn a_capped_list_drops_a_never_shared_note_and_keeps_a_listed_share() {
        let body = rows(SHARE_LIST_ROW_CAP);
        let none = HashSet::new();
        assert!(!share_list_complete(&body));
        assert!(!should_soft_delete(&body, "never-shared", &none));
        assert!(should_soft_delete(&body, "doc-0", &none));
        // In-app delete uses the same allow-list.
        assert_eq!(replay_decision("doc-0", Some(&body), &none), Replay::Send);
        assert_eq!(
            replay_decision("never-shared", Some(&body), &none),
            Replay::Wait
        );
        // A share this Mac stored, whose row was cut, is still revoked.
        let known: HashSet<String> = ["past-cap".into()].into();
        assert!(should_soft_delete(&body, "past-cap", &known));
        assert!(!should_soft_delete(&body, "never-shared", &known));
        assert_eq!(
            replay_decision("past-cap", Some(&body), &known),
            Replay::Send
        );
    }

    #[test]
    fn a_list_under_the_row_cap_still_filters() {
        let body = rows(SHARE_LIST_ROW_CAP - 1);
        assert!(share_list_complete(&body));
        let none = HashSet::new();
        assert_eq!(replay_decision("doc-0", Some(&body), &none), Replay::Send);
        assert_eq!(
            replay_decision("unlisted", Some(&body), &none),
            Replay::Drop
        );
    }

    #[test]
    fn an_unexpected_list_shape_is_not_complete() {
        assert!(!share_list_complete(&json!({})));
        assert!(!share_list_complete(&json!({"shares": "x"})));
        assert!(share_list_complete(&json!({"shares": []})));
    }

    #[test]
    fn a_soft_delete_never_posts_an_id_the_list_and_the_map_do_not_know() {
        let none = HashSet::new();
        assert!(!should_soft_delete(
            &rows(SHARE_LIST_ROW_CAP - 1),
            "unlisted",
            &none
        ));
        assert!(should_soft_delete(
            &rows(SHARE_LIST_ROW_CAP - 1),
            "doc-3",
            &none
        ));
        assert!(!should_soft_delete(
            &rows(SHARE_LIST_ROW_CAP),
            "unlisted",
            &none
        ));
        assert!(!should_soft_delete(&json!({}), "unlisted", &none));
        assert!(!should_soft_delete(
            &json!({"shares": "x"}),
            "unlisted",
            &none
        ));
    }

    #[test]
    fn the_full_id_set_filters_even_when_the_rows_are_cut() {
        // 150 shares: the rows stop at the cap, but `document_ids` names every one.
        let mut body = rows(SHARE_LIST_ROW_CAP);
        let all: Vec<String> = (0..150).map(|n| format!("doc-{n}")).collect();
        body["document_ids"] = json!(all);
        assert!(share_list_complete(&body));
        assert!(listed_ids(&body).contains("doc-149"));
        // A never-shared note is not posted, so its path-derived id stays on this Mac.
        let none = HashSet::new();
        assert!(!should_soft_delete(&body, "never-shared", &none));
        assert!(should_soft_delete(&body, "doc-149", &none));
        // A complete list does not revive an id it does not name.
        let stale: HashSet<String> = ["never-shared".into()].into();
        assert!(!should_soft_delete(&body, "never-shared", &stale));
        assert_eq!(
            replay_decision("never-shared", Some(&body), &stale),
            Replay::Drop
        );
        assert_eq!(
            replay_decision("doc-149", Some(&body), &stale),
            Replay::Send
        );
        // A malformed set is not trusted; an unknown id is still not posted.
        body["document_ids"] = json!("doc-1");
        assert!(!share_list_complete(&body));
        assert!(!should_soft_delete(&body, "never-shared", &none));
        assert!(should_soft_delete(&body, "doc-0", &none));
    }

    #[test]
    fn an_unreadable_list_defers_an_unconfirmed_id_instead_of_dropping_it() {
        // A share made on this Mac may not be in share-paths.json yet.
        let known: HashSet<String> = ["stored-share".into()].into();
        let (now, later) = split_unconfirmed(
            vec!["stored-share".into(), "new-share-or-private".into()],
            &known,
        );
        assert_eq!(now, vec!["stored-share".to_string()]);
        assert_eq!(later, vec!["new-share-or-private".to_string()]);
    }

    #[test]
    fn replay_sends_only_confirmed_shares_and_waits_without_the_list() {
        let known: HashSet<String> = ["stored-share".into()].into();
        let mut body = rows(SHARE_LIST_ROW_CAP);
        body["document_ids"] = json!(["doc-7", "new-share"]);
        // The list can be read: a listed id goes, a never-shared one is dropped unsent.
        assert_eq!(
            replay_decision("new-share", Some(&body), &known),
            Replay::Send
        );
        assert_eq!(
            replay_decision("never-shared", Some(&body), &known),
            Replay::Drop
        );
        // No list: a stored share id goes; anything else waits for the list.
        assert_eq!(replay_decision("stored-share", None, &known), Replay::Send);
        assert_eq!(replay_decision("new-share", None, &known), Replay::Wait);
    }

    #[test]
    fn a_cut_list_never_drops_a_queued_revocation() {
        // Rows at the cap and no document_ids. A share past the cap is
        // absent from the rows, so the queued line waits instead of being dropped.
        let known = HashSet::new();
        let cut = rows(SHARE_LIST_ROW_CAP);
        assert_eq!(
            replay_decision("past-the-cap", Some(&cut), &known),
            Replay::Wait
        );
        assert_eq!(
            replay_decision("past-the-cap", Some(&json!({"shares": "x"})), &known),
            Replay::Wait
        );
        assert_eq!(replay_decision("doc-3", Some(&cut), &known), Replay::Send);
    }

    fn queued(home: &Path) -> Vec<String> {
        lines(home, Queue::Confirmed)
    }

    fn lines(home: &Path, queue: Queue) -> Vec<String> {
        read_ops(home, queue)
            .unwrap()
            .iter()
            .map(|op| queue.line(op))
            .collect()
    }

    #[test]
    fn an_unconfirmed_delete_never_takes_a_slot_from_a_confirmed_revocation() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        enqueue(home, RemovalOp::new(RemovalKind::Erase, "shared-folder")).unwrap();
        for n in 0..QUEUE_CAP {
            enqueue_pending(
                home,
                RemovalOp::new(RemovalKind::Erase, &format!("private-{n}")),
            )
            .unwrap();
        }
        // A full pending file refuses a new id and says so.
        let err =
            enqueue_pending(home, RemovalOp::new(RemovalKind::Erase, "private-new")).unwrap_err();
        assert!(err.to_string().contains("shared copy is still online"));
        assert_eq!(lines(home, Queue::Pending).len(), QUEUE_CAP);
        // The same id again is not a new line.
        enqueue_pending(home, RemovalOp::new(RemovalKind::Erase, "private-0")).unwrap();
        // The confirmed queue still holds the revocation, and only it.
        assert_eq!(queued(home), vec!["erase\tshared-folder"]);
        // Only an erase or a soft-delete waits for confirmation.
        let other = tempfile::tempdir().unwrap();
        enqueue_pending(other.path(), RemovalOp::new(RemovalKind::Leave, "row")).unwrap();
        assert!(lines(other.path(), Queue::Pending).is_empty());
    }

    #[test]
    fn pending_lines_round_trip_and_a_confirmed_kind_is_not_pending() {
        assert_eq!(
            Queue::Pending.parse("erase?\tdoc-1"),
            Some(RemovalOp::new(RemovalKind::Erase, "doc-1"))
        );
        assert_eq!(
            Queue::Pending.parse("soft?\tdoc-1"),
            Some(RemovalOp::new(RemovalKind::Soft, "doc-1"))
        );
        assert_eq!(Queue::Pending.parse("erase\tdoc-1"), None);
        assert_eq!(Queue::Pending.parse("restore?\tdoc-1"), None);
        assert_eq!(Queue::Confirmed.parse("erase?\tdoc-1"), None);
        let op = RemovalOp::new(RemovalKind::Soft, "doc-2");
        assert_eq!(Queue::Pending.parse(&Queue::Pending.line(&op)), Some(op));
    }

    #[test]
    fn a_confirmed_pending_delete_stays_until_it_is_sent_or_queued() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let op = RemovalOp::new(RemovalKind::Erase, "doc-1");
        let offline = || Err(AppError::Account("unavailable".into()));

        // Sent, or refused for good: the pending line can go.
        assert!(pending_settled(home, &op, &Ok(())));
        assert!(pending_settled(
            home,
            &op,
            &Err(AppError::Account("validation_failed".into()))
        ));

        // The send failed and nothing holds it: it stays.
        assert!(!pending_settled(home, &op, &offline()));

        // A queue that cannot be written does not hold it either.
        let root = tempfile::tempdir().unwrap();
        let not_a_folder = root.path().join("not-a-folder");
        fs::write(&not_a_folder, "").unwrap();
        assert!(remember_op(&not_a_folder, op.clone(), Requeue::Replace).is_err());
        assert!(!pending_settled(&not_a_folder, &op, &offline()));

        // Once the confirmed queue holds it, the pending copy is not needed.
        enqueue(home, op.clone()).unwrap();
        assert!(pending_settled(home, &op, &offline()));

        // A newer op for the same document also supersedes it.
        let soft = RemovalOp::new(RemovalKind::Soft, "doc-2");
        enqueue(home, RemovalOp::new(RemovalKind::Restore, "doc-2")).unwrap();
        assert!(pending_settled(home, &soft, &offline()));
    }

    #[test]
    fn a_queue_that_cannot_be_written_is_not_reported_as_saved() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("not-a-folder");
        fs::write(&file, "").unwrap();
        // The app folder is a file, so the queue cannot be created inside it.
        assert!(enqueue(&file, RemovalOp::new(RemovalKind::Erase, "doc-1")).is_err());
        assert!(enqueue_pending(&file, RemovalOp::new(RemovalKind::Erase, "doc-1")).is_err());
    }

    #[test]
    fn a_new_share_deleted_offline_is_revoked_when_the_list_returns() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("app");
        let notes = root.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        let essay = notes.join("essay.md");
        let private = notes.join("private.md");
        fs::write(&essay, "shared words\n").unwrap();
        fs::write(&private, "local only\n").unwrap();
        // What share_invite sends, remembered before any reconciliation.
        let id = crate::commands::history::document_id(&essay);
        share_paths::bind_document_id(&home, &essay, &id);
        assert!(share_paths::known_share_ids(&home).contains(&id));

        let plan = share_paths::plan_cloud_delete(Some(&home), &notes);
        let known = share_paths::known_share_ids(&home);
        let delete = split_cloud_delete(&plan, &known);
        let private_id = crate::commands::history::document_id(&private);
        assert_eq!(delete.now, CloudPlan::Erase(vec![id.clone()]));
        assert_eq!(delete.unconfirmed, vec![private_id.clone()]);

        // Before any request: the known share is a confirmed revocation. The
        // private note waits apart.
        record_cloud_delete(&home, &delete).unwrap();
        for n in 0..(QUEUE_CAP - 1) {
            enqueue_pending(
                &home,
                RemovalOp::new(RemovalKind::Erase, &format!("unmapped-{n}")),
            )
            .unwrap();
        }
        assert!(enqueue_pending(
            &home,
            RemovalOp::new(RemovalKind::Erase, "unmapped-overflow")
        )
        .is_err());
        assert_eq!(queued(&home), vec![format!("erase\t{id}")]);
        let pending = lines(&home, Queue::Pending);
        assert!(pending
            .iter()
            .any(|line| line == &format!("erase?\t{private_id}")));
        assert!(!pending.iter().any(|line| line.contains(&id)));

        // The folder is gone, so reconciliation cannot repair the share.
        share_paths::forget(&home, &notes, true);
        fs::remove_dir_all(&notes).unwrap();
        assert_eq!(
            share_paths::classify_absence(&home, &essay, &[]),
            Absence::Ignore
        );
        let known_after = share_paths::known_share_ids(&home);
        assert!(!known_after.contains(&id));
        // Reconnect: the server still lists the share. The private path is not sent.
        let body = json!({"document_ids": [id], "shares": []});
        assert_eq!(
            replay_decision(&id, Some(&body), &known_after),
            Replay::Send
        );
        assert_eq!(
            replay_decision(&private_id, Some(&body), &known_after),
            Replay::Drop
        );
        assert_eq!(
            replay_decision(&private_id, None, &known_after),
            Replay::Wait
        );
    }

    #[test]
    fn finder_soft_delete_posts_the_server_id() {
        let local = Absence::SoftDelete("path-encoding".into());
        assert_eq!(soft_delete_target("server-doc", &local), Some("server-doc"));
        assert_eq!(soft_delete_target("server-doc", &Absence::Ignore), None);
        assert_eq!(soft_delete_target("server-doc", &Absence::Carried), None);
        assert_eq!(soft_delete_target("", &local), None);
    }

    #[test]
    fn an_unshared_file_is_quiet_and_a_real_failure_is_not() {
        assert!(quiet_removal(RemovalKind::Erase, "not_found"));
        assert!(quiet_removal(RemovalKind::Soft, "not_found"));
        assert!(!quiet_removal(RemovalKind::Leave, "not_found"));
        assert!(!quiet_removal(RemovalKind::Restore, "not_found"));
        assert!(!quiet_removal(RemovalKind::Erase, "unavailable"));
        assert!(signed_out_removal(RemovalKind::Erase, "unauthorized"));
        assert!(signed_out_removal(RemovalKind::Soft, "unauthorized"));
        assert!(!signed_out_removal(RemovalKind::Leave, "unauthorized"));
    }

    #[test]
    fn a_misread_success_is_settled_when_the_row_changed() {
        assert!(settled_state(RemovalKind::Erase, Some(OwnedState::Gone)));
        assert!(!settled_state(RemovalKind::Erase, Some(OwnedState::Open)));
        assert!(!settled_state(RemovalKind::Erase, None));
        assert!(settled_state(RemovalKind::Soft, Some(OwnedState::Soft)));
        assert!(settled_state(RemovalKind::Soft, Some(OwnedState::Gone)));
        assert!(!settled_state(RemovalKind::Soft, Some(OwnedState::Open)));
        assert!(settled_state(RemovalKind::Restore, Some(OwnedState::Open)));
        assert!(!settled_state(RemovalKind::Restore, Some(OwnedState::Soft)));
        assert!(!settled_state(RemovalKind::Leave, Some(OwnedState::Gone)));

        let body = json!({
            "documents": [
                {"document_id": "server-doc", "state": "gone"},
                {"document_id": "other", "state": "open"}
            ]
        });
        assert_eq!(state_of(&body, "server-doc"), Some(OwnedState::Gone));
        assert_eq!(state_of(&body, "missing"), None);
        assert!(settled_state(
            RemovalKind::Erase,
            state_of(&body, "server-doc")
        ));
    }

    #[test]
    fn a_share_list_settles_a_parked_erase_and_not_an_open_one() {
        let parked = json!({
            "shares": [
                {"document_id": "server-doc", "role": "owner", "status": "parked"},
                {"document_id": "server-doc", "role": "invitee", "status": "accepted"},
                {"document_id": "other", "role": "owner", "status": "accepted"}
            ]
        });
        assert!(settled_from_shares(
            RemovalKind::Erase,
            "server-doc",
            &parked
        ));
        assert!(settled_from_shares(
            RemovalKind::Soft,
            "server-doc",
            &parked
        ));
        assert!(!settled_from_shares(
            RemovalKind::Restore,
            "server-doc",
            &parked
        ));
        assert!(!settled_from_shares(RemovalKind::Erase, "missing", &parked));
        assert!(!settled_from_shares(RemovalKind::Erase, "other", &parked));

        let open = json!({
            "shares": [
                {"document_id": "server-doc", "role": "owner", "status": "accepted"},
                {"document_id": "server-doc", "role": "owner", "status": "parked"}
            ]
        });
        assert!(!settled_from_shares(
            RemovalKind::Erase,
            "server-doc",
            &open
        ));
        assert!(!settled_from_shares(RemovalKind::Soft, "server-doc", &open));
        assert!(settled_from_shares(
            RemovalKind::Restore,
            "server-doc",
            &open
        ));
        assert!(!settled_from_shares(
            RemovalKind::Leave,
            "server-doc",
            &parked
        ));
        assert!(!settled_from_shares(
            RemovalKind::Erase,
            "server-doc",
            &json!({})
        ));
    }

    #[test]
    fn a_recorded_erase_is_queued_for_every_document() {
        let home = tempfile::tempdir().unwrap();
        let known: HashSet<String> = ["doc-a".into()].into();
        record_cloud_delete(
            home.path(),
            &split_cloud_delete(
                &CloudPlan::Erase(vec!["doc-a".into(), "doc-b".into()]),
                &known,
            ),
        )
        .unwrap();
        record_cloud_delete(
            home.path(),
            &split_cloud_delete(&CloudPlan::Leave("row-1".into()), &known),
        )
        .unwrap();
        record_cloud_delete(home.path(), &split_cloud_delete(&CloudPlan::None, &known)).unwrap();
        assert_eq!(queued(home.path()), vec!["erase\tdoc-a", "leave\trow-1"]);
        // The id this Mac has no share record for waits for the list.
        assert_eq!(lines(home.path(), Queue::Pending), vec!["erase?\tdoc-b"]);
    }

    #[test]
    fn one_op_per_document_and_an_erase_is_final() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        enqueue(home, RemovalOp::new(RemovalKind::Soft, "doc-a")).unwrap();
        enqueue(home, RemovalOp::new(RemovalKind::Restore, "doc-a")).unwrap();
        enqueue(home, RemovalOp::new(RemovalKind::Erase, "doc-b")).unwrap();
        enqueue(home, RemovalOp::new(RemovalKind::Restore, "doc-b")).unwrap();
        enqueue(home, RemovalOp::new(RemovalKind::Soft, "doc-b")).unwrap();
        // A leave names a share row, so it does not replace a document's op.
        enqueue(home, RemovalOp::new(RemovalKind::Leave, "doc-a")).unwrap();
        assert_eq!(
            queued(home),
            vec!["restore\tdoc-a", "erase\tdoc-b", "leave\tdoc-a"]
        );
        // Dropping a finished op leaves a newer op for the same document.
        drop_op(
            home,
            Queue::Confirmed,
            &RemovalOp::new(RemovalKind::Soft, "doc-a"),
        );
        assert_eq!(queued(home).len(), 3);
        drop_op(
            home,
            Queue::Confirmed,
            &RemovalOp::new(RemovalKind::Restore, "doc-a"),
        );
        assert_eq!(queued(home), vec!["erase\tdoc-b", "leave\tdoc-a"]);
    }

    #[test]
    fn a_replay_that_fails_again_does_not_replace_a_newer_op() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let soft = RemovalOp::new(RemovalKind::Soft, "doc-x");
        enqueue(home, soft.clone()).unwrap();
        // The file came back while the soft-delete replay was on the network.
        enqueue(home, RemovalOp::new(RemovalKind::Restore, "doc-x")).unwrap();
        remember_op(home, soft.clone(), Requeue::IfCurrent).unwrap();
        assert_eq!(queued(home), vec!["restore\tdoc-x"]);
        // A replay whose target has nothing queued goes back in.
        remember_op(
            home,
            RemovalOp::new(RemovalKind::Soft, "doc-y"),
            Requeue::IfCurrent,
        )
        .unwrap();
        assert_eq!(queued(home), vec!["restore\tdoc-x", "soft\tdoc-y"]);
        // A new request still replaces an older op.
        remember_op(home, soft, Requeue::Replace).unwrap();
        assert_eq!(queued(home), vec!["soft\tdoc-x", "soft\tdoc-y"]);
    }

    #[test]
    fn a_full_queue_never_drops_an_erase() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        enqueue(home, RemovalOp::new(RemovalKind::Erase, "first-erase")).unwrap();
        for index in 0..QUEUE_CAP {
            enqueue(
                home,
                RemovalOp::new(RemovalKind::Soft, &format!("soft-{index}")),
            )
            .unwrap();
        }
        let lines = queued(home);
        assert_eq!(lines.len(), QUEUE_CAP);
        assert_eq!(lines[0], "erase\tfirst-erase");
        assert!(!lines.contains(&"soft\tsoft-0".to_string()));

        let erases = tempfile::tempdir().unwrap();
        for index in 0..QUEUE_CAP + 5 {
            enqueue(
                erases.path(),
                RemovalOp::new(RemovalKind::Erase, &format!("erase-{index}")),
            )
            .unwrap();
        }
        assert_eq!(queued(erases.path()).len(), QUEUE_CAP + 5);
    }

    #[test]
    fn concurrent_queue_writes_keep_every_op_and_bad_lines_go() {
        let home = tempfile::tempdir().unwrap();
        fs::write(
            Queue::Confirmed.path(home.path()),
            "erase\tkept\nnot a line\nshred\tx\n",
        )
        .unwrap();
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let home = home.path().to_path_buf();
                std::thread::spawn(move || {
                    for round in 0..5 {
                        enqueue(
                            &home,
                            RemovalOp::new(RemovalKind::Soft, &format!("doc-{index}-{round}")),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let lines = queued(home.path());
        assert_eq!(lines.len(), 41, "{lines:?}");
        assert_eq!(lines[0], "erase\tkept");
    }

    #[test]
    fn an_owned_row_without_a_known_state_is_not_open() {
        assert_eq!(OwnedState::parse("open"), Some(OwnedState::Open));
        assert_eq!(OwnedState::parse("soft"), Some(OwnedState::Soft));
        assert_eq!(OwnedState::parse("gone"), Some(OwnedState::Gone));
        assert_eq!(OwnedState::parse(""), None);
        assert_eq!(OwnedState::parse("Open"), None);
        let body = json!({
            "documents": [
                {"document_id": "no-state"},
                {"document_id": "odd", "state": "archived"}
            ]
        });
        assert_eq!(state_of(&body, "no-state"), None);
        assert_eq!(state_of(&body, "odd"), None);
        assert!(!settled_state(
            RemovalKind::Restore,
            state_of(&body, "no-state")
        ));
    }

    #[test]
    fn a_custom_dialog_label_is_visible_to_the_confirm_check() {
        let value = serde_json::to_value(tauri_plugin_dialog::MessageDialogResult::Custom(
            "Delete".into(),
        ))
        .unwrap();
        let ok = value == json!("Delete") || value == json!({ "Custom": "Delete" });
        assert!(ok, "{value}");
    }
}
