//! Account session. Both tokens stay in the keychain and in a memory copy.
//! The webview gets neither, except the access token `share_realtime_auth` hands
//! it to open the live-share socket. An access token within a minute of `exp` is
//! rotated before a command uses it. A 401 rotates once and retries. The
//! session is removed only when the refresh call itself is refused.
//! Delete never sees a document path and does not rotate in order to delete.
//! Every keychain write goes through `commit`. Sign-in, sign-out and delete
//! move the session generation, so a refresh that was already on the network
//! does not write over them.

use crate::error::AppError;
use crate::invite_arrival::INVITE_ARRIVAL;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const SESSION_ITEM: &str = "session";
/// Previous item name, on the previous bundle id and on this service.
const PREVIOUS_SESSION_ITEM: &str = "redline-session";
/// Set after that previous item is gone. A later check does not try again.
static PREVIOUS_SIGN_IN_DROPPED: AtomicBool = AtomicBool::new(false);
/// A local key file that early builds kept. Removing the account removes it.
const GATEWAY_ENV_FILE: &str = "ai-gateway.env";
const UNREACHABLE: &str = "unreachable";
const LOCAL_URL: &str = "http://127.0.0.1:54321";
/// Every request names the region the accounts function runs in.
pub(crate) const ACCOUNTS_FUNCTION_REGION: &str = "eu-central-1";

pub(crate) fn accounts_url(base: &str, route: &str) -> String {
    let root = format!("{base}/functions/v1/accounts");
    if route.is_empty() {
        root
    } else {
        format!("{root}/{route}")
    }
}

/// Every desktop call to the accounts function is built here, so the region
/// header cannot be left off one route.
pub(crate) fn accounts_request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    anon_key: &str,
    bearer: &str,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header("apikey", anon_key)
        .header("Authorization", format!("Bearer {bearer}"))
        .header("x-region", ACCOUNTS_FUNCTION_REGION)
}

#[derive(Debug, Serialize)]
pub struct AccountStatus {
    pub signed_in: bool,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StyleItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub rule: String,
    pub why: String,
    pub scope: String,
    pub seen: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountPreferences {
    pub signed_in: bool,
    pub offline: bool,
    pub email: Option<String>,
    pub effective: Option<String>,
    pub spent: i64,
    pub soft_cap: i64,
    pub hard_cap: i64,
    pub window_end: Option<String>,
    pub status_line: Option<String>,
    pub plan_label: Option<String>,
    pub date_line: Option<String>,
    pub margin_band: Option<String>,
    pub items: Vec<StyleItem>,
    pub eu_consent: bool,
    pub refund_open: bool,
    pub allowance_percent: Option<i64>,
    pub overage: bool,
    pub overage_maximum: Option<i64>,
    pub overage_default_dollars: Option<i64>,
    pub overage_prompt: bool,
    pub overage_ask_price: Option<String>,
    pub allowance_resets: Option<String>,
    pub used_pct: i64,
    pub account_id: Option<String>,
    pub credit: String,
    pub frozen: bool,
    pub referral_code: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredSession {
    access_token: String,
    refresh_token: String,
    email: String,
}

/// Process memory for one keychain item. Every read and every write of the
/// item runs under `state`, so the memory copy and the keychain change
/// together. `commit` is the only writer.
pub struct SessionMemory {
    /// Refresh tokens are single-use. One exchange at a time.
    exchange: tokio::sync::Mutex<()>,
    state: Mutex<MemoryState>,
}

struct MemoryState {
    /// Bumped whenever the session changes hands: sign-in, sign-out, delete,
    /// a refused refresh, an unreadable item. A rotation keeps it. A rotation
    /// or a clear decided under an older generation does not commit.
    generation: u64,
    held: Held,
}

/// What this process holds for the item. The keychain remains the copy that
/// survives a restart.
enum Held {
    /// Signed out, or not read yet.
    Empty,
    /// The same session the keychain holds.
    Saved(StoredSession),
    /// A rotated session the keychain did not take. It holds the only live
    /// refresh token (the old one is spent), so reads use it and write it again.
    Unsaved(StoredSession),
}

impl SessionMemory {
    const fn new() -> Self {
        Self {
            exchange: tokio::sync::Mutex::const_new(()),
            state: Mutex::new(MemoryState {
                generation: 0,
                held: Held::Empty,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MemoryState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

static KEYCHAIN_MEMORY: SessionMemory = SessionMemory::new();

const REFRESH_SKEW_SECS: i64 = 60;

pub trait SessionVault: Send + Sync {
    fn get(&self) -> Result<Option<String>, AppError>;
    fn set(&self, token: &str) -> Result<(), AppError>;
    fn delete(&self) -> Result<(), AppError>;
    /// The memory and locks shared by every handle on this item.
    fn memory(&self) -> &SessionMemory;
}

#[cfg(test)]
struct MemoryVault {
    token: Mutex<Option<String>>,
    memory: SessionMemory,
}

#[cfg(test)]
impl MemoryVault {
    fn new() -> Self {
        Self {
            token: Mutex::new(None),
            memory: SessionMemory::new(),
        }
    }
}

#[cfg(test)]
impl SessionVault for MemoryVault {
    fn get(&self) -> Result<Option<String>, AppError> {
        Ok(self.token.lock().unwrap_or_else(|p| p.into_inner()).clone())
    }

    fn set(&self, token: &str) -> Result<(), AppError> {
        *self.token.lock().unwrap_or_else(|p| p.into_inner()) = Some(token.to_string());
        Ok(())
    }

    fn delete(&self) -> Result<(), AppError> {
        *self.token.lock().unwrap_or_else(|p| p.into_inner()) = None;
        Ok(())
    }

    fn memory(&self) -> &SessionMemory {
        &self.memory
    }
}

struct KeyringVault {
    service: String,
    item: &'static str,
}

impl KeyringVault {
    fn current(service: String) -> Self {
        Self {
            service,
            item: SESSION_ITEM,
        }
    }

    fn entry(&self) -> Result<keyring::Entry, AppError> {
        let _ = native_keyring_store();
        keyring::Entry::new(&self.service, self.item)
            .map_err(|_| AppError::Account(UNREACHABLE.into()))
    }
}

/// Keyring compiles its in-memory mock on every OS. These types exist only
/// when the backend feature that also selects that store as the default is on.
/// A build that drops the feature fails here, before sign-in can be forgotten.
fn native_keyring_store() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        std::any::type_name::<keyring::macos::MacCredential>()
    }
    #[cfg(target_os = "windows")]
    {
        std::any::type_name::<keyring::windows::WinCredential>()
    }
    #[cfg(target_os = "linux")]
    {
        std::any::type_name::<keyring::secret_service::SsCredential>()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        ""
    }
}

impl SessionVault for KeyringVault {
    fn get(&self) -> Result<Option<String>, AppError> {
        match self.entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AppError::Account(UNREACHABLE.into())),
        }
    }

    fn set(&self, token: &str) -> Result<(), AppError> {
        self.entry()?
            .set_password(token)
            .map_err(|_| AppError::Account(UNREACHABLE.into()))
    }

    fn delete(&self) -> Result<(), AppError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::Account(UNREACHABLE.into())),
        }
    }

    /// One process, one session item. The previous-item handles only delete.
    fn memory(&self) -> &SessionMemory {
        &KEYCHAIN_MEMORY
    }
}

/// Local half of a successful delete. The document folder is not an argument.
fn wipe_account_local(app_data_dir: &Path) -> Result<(), AppError> {
    let style = app_data_dir.join("redline-preferences.txt");
    if style.exists() {
        std::fs::remove_file(style)?;
    }
    let gateway_env = app_data_dir.join(GATEWAY_ENV_FILE);
    if gateway_env.exists() {
        std::fs::remove_file(gateway_env)?;
    }
    Ok(())
}

fn install_rustls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub(crate) fn accounts_client() -> Result<reqwest::Client, AppError> {
    install_rustls();
    reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| AppError::Account(UNREACHABLE.into()))
}

pub fn supabase_public() -> Result<(String, String), AppError> {
    supabase_from_env()
}

pub async fn access_token_from_app(app: &tauri::AppHandle) -> Result<Option<String>, AppError> {
    let vault = vault_from_app(app);
    if let Some(cached) = held_session(&vault) {
        if !cached.access_token.is_empty() && !access_expiring(&cached.access_token) {
            // ponytail: one process keeps one session. A keychain edit outside
            // sign-out shows up on the next expiry. Upgrade path is reading
            // the keychain on every call.
            return Ok(Some(cached.access_token));
        }
    }
    let Ok((base, anon)) = supabase_from_env() else {
        return Ok(read_session(&vault)?.map(|stored| stored.access_token));
    };
    let client = accounts_client()?;
    Ok(fresh_session(&client, &base, &anon, &vault)
        .await?
        .map(|stored| stored.access_token))
}

/// After an accounts call rejected this access token, rotate once.
/// `Ok(None)` means there is no token to retry with. The keychain session
/// is removed only when the refresh endpoint refuses the refresh token.
pub async fn refreshed_access_token(
    app: &tauri::AppHandle,
    rejected_access: &str,
) -> Result<Option<String>, AppError> {
    let Ok((base, anon)) = supabase_from_env() else {
        return Ok(None);
    };
    let client = accounts_client()?;
    let vault = vault_from_app(app);
    Ok(
        refresh_for_retry(&client, &base, &anon, &vault, rejected_access)
            .await?
            .map(|stored| stored.access_token),
    )
}

/// Polar sends the writer back to the site, or to `alkuin://`, with the checkout id.
pub(crate) fn is_checkout_return(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    let ours = lower.starts_with("alkuin://")
        || lower.starts_with("https://alkuin.app/")
        || lower.starts_with("https://alkuin.app?")
        || lower.starts_with("https://www.alkuin.app/")
        || lower.starts_with("https://www.alkuin.app?");
    ours && (lower.contains("checkout_id=")
        || lower.contains("://checkout")
        || lower.contains("/checkout"))
}

const MISSING_SUPABASE: &str = "missing_supabase";

/// Stderr only. The desk code stays `missing_supabase`.
fn missing_supabase_log(url_missing: bool) -> &'static str {
    if url_missing {
        "REDLINE_SUPABASE_URL and REDLINE_SUPABASE_ANON_KEY"
    } else {
        "REDLINE_SUPABASE_ANON_KEY"
    }
}

/// An empty key is not a network failure: Auth is never called. Unset URL
/// still means local Supabase.
fn supabase_from_values(
    url: Option<&str>,
    anon: Option<&str>,
) -> Result<(String, String), AppError> {
    let url = url.map(str::trim).filter(|value| !value.is_empty());
    let anon = anon.map(str::trim).filter(|value| !value.is_empty());
    let Some(anon) = anon else {
        eprintln!("sign-in: {}", missing_supabase_log(url.is_none()));
        return Err(AppError::Account(MISSING_SUPABASE.into()));
    };
    let base = url.unwrap_or(LOCAL_URL).trim_end_matches('/').to_string();
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(AppError::Account(UNREACHABLE.into()));
    }
    Ok((base, anon.to_string()))
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// A value set on the process wins. Otherwise the one compiled into a signed build.
fn resolve_setting<'a>(compiled: Option<&'a str>, runtime: Option<&'a str>) -> Option<&'a str> {
    nonempty(runtime).or_else(|| nonempty(compiled))
}

fn supabase_from_env() -> Result<(String, String), AppError> {
    let runtime_url = std::env::var("REDLINE_SUPABASE_URL").ok();
    let runtime_anon = std::env::var("REDLINE_SUPABASE_ANON_KEY").ok();
    let url = resolve_setting(option_env!("REDLINE_SUPABASE_URL"), runtime_url.as_deref());
    let anon = resolve_setting(
        option_env!("REDLINE_SUPABASE_ANON_KEY"),
        runtime_anon.as_deref(),
    );
    supabase_from_values(url, anon)
}

fn local_status(vault: &dyn SessionVault) -> Result<AccountStatus, AppError> {
    let session = read_session(vault)?;
    Ok(AccountStatus {
        signed_in: session.is_some(),
        email: session.and_then(|session| {
            if session.email.is_empty() {
                None
            } else {
                Some(session.email)
            }
        }),
    })
}

fn read_session(vault: &dyn SessionVault) -> Result<Option<StoredSession>, AppError> {
    snapshot(vault).map(|(session, _)| session)
}

/// The session and the generation it was read under. An unsaved rotation
/// wins over the keychain's spent copy, and its write is tried again here.
fn snapshot(vault: &dyn SessionVault) -> Result<(Option<StoredSession>, u64), AppError> {
    let mut state = vault.memory().lock();
    if let Held::Unsaved(session) = &state.held {
        let session = session.clone();
        if session_raw(&session)
            .and_then(|raw| vault.set(&raw))
            .is_ok()
        {
            state.held = Held::Saved(session.clone());
        }
        return Ok((Some(session), state.generation));
    }
    let Some(raw) = vault.get()? else {
        state.held = Held::Empty;
        return Ok((None, state.generation));
    };
    match serde_json::from_str::<StoredSession>(&raw) {
        Ok(session) if !session.access_token.is_empty() => {
            state.held = Held::Saved(session.clone());
            Ok((Some(session), state.generation))
        }
        _ => {
            state.generation = state.generation.wrapping_add(1);
            state.held = Held::Empty;
            vault.delete()?;
            Ok((None, state.generation))
        }
    }
}

fn session_raw(session: &StoredSession) -> Result<String, AppError> {
    serde_json::to_string(session).map_err(|_| AppError::Account("bad_code".into()))
}

/// Memory copy only, for the fast path. `None` means read the keychain.
fn held_session(vault: &dyn SessionVault) -> Option<StoredSession> {
    match &vault.memory().lock().held {
        Held::Empty => None,
        Held::Saved(session) | Held::Unsaved(session) => Some(session.clone()),
    }
}

fn generation(vault: &dyn SessionVault) -> u64 {
    vault.memory().lock().generation
}

enum SessionWrite {
    /// A new sign-in. The session changes hands.
    SignedIn(StoredSession),
    /// The same session after a refresh exchange.
    Rotated(StoredSession),
    /// Sign-out, delete, or a refused refresh. The session changes hands.
    Cleared,
}

/// The only writer of the session item. `seen` is the generation the caller
/// read before its last await. A write decided under an older generation is
/// dropped and returns `false`: a refresh that started before a sign-out or
/// a sign-in does not write over it.
fn commit(
    vault: &dyn SessionVault,
    write: SessionWrite,
    seen: Option<u64>,
) -> Result<bool, AppError> {
    let mut state = vault.memory().lock();
    if seen.is_some_and(|seen| seen != state.generation) {
        return Ok(false);
    }
    match write {
        SessionWrite::SignedIn(session) => {
            vault.set(&session_raw(&session)?)?;
            state.generation = state.generation.wrapping_add(1);
            state.held = Held::Saved(session);
        }
        SessionWrite::Rotated(session) => {
            // The exchange already spent the old refresh token. A keychain
            // that refuses the new pair must not send us back to the old one.
            let raw = session_raw(&session)?;
            state.held = match vault.set(&raw) {
                Ok(()) => Held::Saved(session),
                Err(_) => {
                    eprintln!("[account] keychain refused the rotated session; kept in memory");
                    Held::Unsaved(session)
                }
            };
        }
        SessionWrite::Cleared => {
            state.generation = state.generation.wrapping_add(1);
            state.held = Held::Empty;
            vault.delete()?;
        }
    }
    Ok(true)
}

fn clear_session(vault: &dyn SessionVault) -> Result<(), AppError> {
    commit(vault, SessionWrite::Cleared, None).map(|_| ())
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn jwt_exp(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.get("exp").and_then(Value::as_i64)
}

fn access_expiring(token: &str) -> bool {
    jwt_exp(token).is_some_and(|exp| exp <= unix_now().saturating_add(REFRESH_SKEW_SECS))
}

enum Exchange {
    New(StoredSession),
    Rejected,
    Kept,
}

enum RefreshCommit {
    Ready(StoredSession),
    Cleared,
    Unchanged(StoredSession),
    /// A sign-out or a sign-in landed during the exchange. Nothing was written.
    Superseded,
}

async fn exchange_refresh(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    session: &StoredSession,
) -> Exchange {
    if session.refresh_token.is_empty() {
        return Exchange::Kept;
    }
    let sent = client
        .post(format!("{base}/auth/v1/token?grant_type=refresh_token"))
        .header("apikey", anon_key)
        .header("Authorization", format!("Bearer {anon_key}"))
        .json(&serde_json::json!({ "refresh_token": session.refresh_token }))
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(_) => return Exchange::Kept,
    };
    let status = response.status();
    if status == reqwest::StatusCode::BAD_REQUEST
        || status == reqwest::StatusCode::UNAUTHORIZED
        || status == reqwest::StatusCode::FORBIDDEN
    {
        return Exchange::Rejected;
    }
    if !status.is_success() {
        return Exchange::Kept;
    }
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let Some(access) = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
    else {
        return Exchange::Kept;
    };
    let refresh = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .unwrap_or(session.refresh_token.as_str());
    let email = body
        .pointer("/user/email")
        .and_then(Value::as_str)
        .or_else(|| body.get("email").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(session.email.as_str())
        .to_string();
    Exchange::New(StoredSession {
        access_token: access.to_string(),
        refresh_token: refresh.to_string(),
        email,
    })
}

/// Runs under `SessionMemory::exchange`. `seen` is the generation `session`
/// was read under; the result commits only if no sign-in or sign-out landed
/// while the exchange was on the network.
async fn commit_refresh(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    session: &StoredSession,
    seen: u64,
) -> Result<RefreshCommit, AppError> {
    Ok(
        match exchange_refresh(client, base, anon_key, session).await {
            Exchange::New(next) => {
                if commit(vault, SessionWrite::Rotated(next.clone()), Some(seen))? {
                    RefreshCommit::Ready(next)
                } else {
                    RefreshCommit::Superseded
                }
            }
            Exchange::Rejected => {
                if commit(vault, SessionWrite::Cleared, Some(seen))? {
                    RefreshCommit::Cleared
                } else {
                    RefreshCommit::Superseded
                }
            }
            Exchange::Kept if generation(vault) == seen => {
                RefreshCommit::Unchanged(session.clone())
            }
            Exchange::Kept => RefreshCommit::Superseded,
        },
    )
}

async fn rotate(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
) -> Result<Option<StoredSession>, AppError> {
    let _exchange = vault.memory().exchange.lock().await;
    let (current, seen) = snapshot(vault)?;
    let Some(current) = current else {
        return Ok(None);
    };
    if !access_expiring(&current.access_token) {
        return Ok(Some(current));
    }
    match commit_refresh(client, base, anon_key, vault, &current, seen).await? {
        RefreshCommit::Ready(next) => Ok(Some(next)),
        RefreshCommit::Cleared => Ok(None),
        RefreshCommit::Unchanged(current) => Ok(Some(current)),
        RefreshCommit::Superseded => read_session(vault),
    }
}

async fn fresh_session(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
) -> Result<Option<StoredSession>, AppError> {
    let Some(current) = read_session(vault)? else {
        return Ok(None);
    };
    if !access_expiring(&current.access_token) {
        return Ok(Some(current));
    }
    rotate(client, base, anon_key, vault).await
}

async fn refresh_for_retry(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    rejected_access: &str,
) -> Result<Option<StoredSession>, AppError> {
    let _exchange = vault.memory().exchange.lock().await;
    let (current, seen) = snapshot(vault)?;
    let Some(current) = current else {
        return Ok(None);
    };
    if current.access_token != rejected_access {
        return Ok(Some(current));
    }
    match commit_refresh(client, base, anon_key, vault, &current, seen).await? {
        RefreshCommit::Ready(next) => Ok(Some(next)),
        RefreshCommit::Superseded => read_session(vault),
        RefreshCommit::Cleared | RefreshCommit::Unchanged(_) => Ok(None),
    }
}

async fn session_token(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
) -> Result<String, AppError> {
    match fresh_session(client, base, anon_key, vault).await? {
        Some(session) if !session.access_token.is_empty() => Ok(session.access_token),
        _ => Err(AppError::Account("unauthorized".into())),
    }
}

async fn with_session_retry<F, Fut>(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    mut call: F,
) -> Result<reqwest::Response, AppError>
where
    F: FnMut(&str) -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
    let token = session_token(client, base, anon_key, vault).await?;
    let response = call(&token)
        .await
        .map_err(|_| AppError::Account(UNREACHABLE.into()))?;
    if response.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(response);
    }
    let _ = response.bytes().await;
    let Some(next) = refresh_for_retry(client, base, anon_key, vault, &token).await? else {
        return match read_session(vault)? {
            Some(_) => Err(AppError::Account(UNREACHABLE.into())),
            None => Err(AppError::Account("unauthorized".into())),
        };
    };
    call(&next.access_token)
        .await
        .map_err(|_| AppError::Account(UNREACHABLE.into()))
}

fn amount_before(message: &str, unit: &str) -> Option<u64> {
    let lower = message.to_ascii_lowercase();
    let idx = lower.rfind(unit)?;
    let prefix = lower[..idx].trim_end();
    let mut end = prefix.len();
    let bytes = prefix.as_bytes();
    while end > 0 && bytes[end - 1].is_ascii_digit() {
        end -= 1;
    }
    let digits = &prefix[end..];
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok().filter(|n| *n > 0)
}

/// Seconds to wait, from a Retry-After header or the Auth sentence. No number is `None`.
fn wait_seconds(message: &str, retry_after: Option<&str>) -> Option<u64> {
    if let Some(header) = retry_after {
        if let Ok(seconds) = header.trim().parse::<u64>() {
            if seconds > 0 {
                return Some(seconds);
            }
        }
    }
    if let Some(seconds) = amount_before(message, "second") {
        return Some(seconds);
    }
    amount_before(message, "minute").map(|minutes| minutes.saturating_mul(60))
}

fn auth_message(body: &Value) -> &str {
    body.get("msg")
        .and_then(Value::as_str)
        .or_else(|| body.get("message").and_then(Value::as_str))
        .or_else(|| body.get("error_description").and_then(Value::as_str))
        .unwrap_or("")
}

fn error_code_str(body: &Value) -> &str {
    body.get("error_code").and_then(Value::as_str).unwrap_or("")
}

fn safe_code(code: &str) -> bool {
    !code.is_empty()
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Status and error code only. A message, an address, or a token is not a code.
fn logged_code(body: &Value) -> &str {
    let named = error_code_str(body);
    if safe_code(named) {
        return named;
    }
    if let Some(code) = body.get("code").and_then(Value::as_str) {
        if safe_code(code) {
            return code;
        }
    }
    "mail_failed"
}

fn code_send_log(status: u16, code: &str) -> String {
    format!("sign-in: code send failed status={status} code={code}")
}

fn send_failure(status: u16, body: &Value, retry_after: Option<&str>) -> AppError {
    let code = error_code_str(body);
    if code == "validation_failed" {
        return AppError::Account("validation_failed".into());
    }
    if code == "email_address_not_authorized" {
        return AppError::Account("email_address_not_authorized".into());
    }
    // The server could not reach its own services, or could not place this request.
    if code == UNREACHABLE || code == "no_client_ip" {
        return AppError::Account(code.into());
    }
    // The two doors: Sign in to no account, Create account for one that exists,
    // and Create account's date of birth.
    if matches!(
        code,
        "no_account" | "account_exists" | "age_required" | "age_blocked"
    ) {
        return AppError::Account(code.into());
    }
    if status == 429 || code == "over_email_send_rate_limit" || code == "over_request_rate_limit" {
        let name = if code == "over_request_rate_limit" {
            "over_request_rate_limit"
        } else {
            "over_email_send_rate_limit"
        };
        return AppError::Account(match wait_seconds(auth_message(body), retry_after) {
            Some(seconds) => format!("{name}:{seconds}"),
            None => name.into(),
        });
    }
    AppError::Account("mail_failed".into())
}

/// A verify slow-down is not a wrong code. A named accounts code, including a 429 cap, keeps its name.
fn verify_failure(status: u16, body: &Value, retry_after: Option<&str>) -> String {
    let code = error_code_str(body);
    let alt = body.get("code").and_then(Value::as_str).unwrap_or("");
    let slow = if code == "over_request_rate_limit" || alt == "over_request_rate_limit" {
        "over_request_rate_limit"
    } else if code == "over_email_send_rate_limit" || alt == "over_email_send_rate_limit" {
        "over_email_send_rate_limit"
    } else if status == 429 && !known_code(code) {
        "over_request_rate_limit"
    } else {
        ""
    };
    if !slow.is_empty() {
        return match wait_seconds(auth_message(body), retry_after) {
            Some(seconds) => format!("{slow}:{seconds}"),
            None => slow.to_string(),
        };
    }
    let named = code_from_body(body, "bad_code");
    // A new account: the sign-in is held, and its ticket comes back with the date.
    if named == "age_required" {
        if let Some(ticket) = body
            .get("age_ticket")
            .and_then(Value::as_str)
            .filter(|ticket| age_ticket_shape(ticket))
        {
            return format!("age_required:{ticket}");
        }
    }
    named
}

/// What the server hands out: base64url, and short.
fn age_ticket_shape(ticket: &str) -> bool {
    !ticket.is_empty()
        && ticket.len() <= 1400
        && ticket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn known_code(code: &str) -> bool {
    matches!(
        code,
        "bad_code"
            | "expired"
            | "locked"
            | "validation_failed"
            | "email_address_not_authorized"
            | "mail_failed"
            | "unreachable"
            | "bad_jwt"
            | "session_expired"
            | "session_not_found"
            | "unauthorized"
            | "over_email_send_rate_limit"
            | "over_request_rate_limit"
            | "signup_cap"
            | "not_admitted"
            | "signup_rate"
            | "no_client_ip"
            | "founding"
            | "eu_consent"
            | "checkout_rate"
            | "billing_unavailable"
            | "refund_closed"
            | "not_paid"
            | "no_billing"
            | "bad_interval"
            | "bad_body"
            | "age_required"
            | "age_blocked"
    )
}

fn code_from_body(body: &Value, fallback: &str) -> String {
    let code = error_code_str(body);
    if known_code(code) {
        code.to_string()
    } else {
        fallback.to_string()
    }
}

fn retry_after_header(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

async fn failure_body(response: reqwest::Response) -> (u16, Value, Option<String>) {
    let status = response.status().as_u16();
    let retry = retry_after_header(&response);
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, body, retry)
}

/// Sign in: the server sends an account its sign-in code. An address with no
/// account answers `no_account`.
async fn sign_in_start(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    email: &str,
) -> Result<(), AppError> {
    code_request(
        client,
        base,
        anon_key,
        "sign-in/start",
        email,
        serde_json::json!({ "email": email.trim() }),
    )
    .await
}

/// Create account: the email and the date of birth, then a registration code.
/// The server answers `age_blocked` for an under-age date and
/// `account_exists` for an address that has an account.
async fn register_start(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    email: &str,
    birth_date: &str,
) -> Result<(), AppError> {
    code_request(
        client,
        base,
        anon_key,
        "register/start",
        email,
        serde_json::json!({ "email": email.trim(), "birth_date": birth_date.trim() }),
    )
    .await
}

async fn code_request(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    route: &str,
    email: &str,
    payload: Value,
) -> Result<(), AppError> {
    if email.trim().is_empty() {
        return Err(AppError::Account("validation_failed".into()));
    }
    let response = accounts_request(
        client,
        reqwest::Method::POST,
        &accounts_url(base, route),
        anon_key,
        anon_key,
    )
    .json(&payload)
    .send()
    .await
    .map_err(|_| AppError::Account(UNREACHABLE.into()))?;
    if response.status().is_success() {
        return Ok(());
    }
    let (status, body, retry) = failure_body(response).await;
    eprintln!("{}", code_send_log(status, logged_code(&body)));
    Err(send_failure(status, &body, retry.as_deref()))
}

/// What proves the address at `/verify`: the code, or for a new account the
/// ticket its code returned, with the date of birth.
#[derive(Debug, Clone, Copy)]
enum SignInProof<'a> {
    Code(&'a str),
    /// A registration code from Create account, with the date of birth it was asked with.
    Registration {
        code: &'a str,
        birth_date: &'a str,
    },
    Held {
        ticket: &'a str,
        birth_date: &'a str,
    },
}

async fn sign_in_finish(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    email: &str,
    proof: SignInProof<'_>,
) -> Result<AccountStatus, AppError> {
    let email = email.trim().to_lowercase();
    let payload = match proof {
        SignInProof::Code(code) => serde_json::json!({ "email": email, "code": code.trim() }),
        SignInProof::Registration { code, birth_date } => serde_json::json!({
            "email": email,
            "code": code.trim(),
            "birth_date": birth_date.trim(),
        }),
        // A new account's second step sends the ticket from its code instead of a code.
        SignInProof::Held { ticket, birth_date } => serde_json::json!({
            "email": email,
            "age_ticket": ticket.trim(),
            "birth_date": birth_date.trim(),
        }),
    };
    let response = accounts_request(
        client,
        reqwest::Method::POST,
        &accounts_url(base, "verify"),
        anon_key,
        anon_key,
    )
    .json(&payload)
    .send()
    .await
    .map_err(|_| AppError::Account(UNREACHABLE.into()))?;
    if !response.status().is_success() {
        let (status, body, retry) = failure_body(response).await;
        return Err(AppError::Account(verify_failure(
            status,
            &body,
            retry.as_deref(),
        )));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| AppError::Account("bad_code".into()))?;
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AppError::Account("bad_code".into()))?
        .to_string();
    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AppError::Account("bad_code".into()))?
        .to_string();
    let email = body
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(email.as_str())
        .to_string();
    // A refresh still on the network for the previous session does not commit
    // after this: the sign-in moves the generation.
    commit(
        vault,
        SessionWrite::SignedIn(StoredSession {
            access_token,
            refresh_token,
            email: email.clone(),
        }),
        None,
    )?;
    Ok(AccountStatus {
        signed_in: true,
        email: Some(email),
    })
}

async fn fetch_status(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    previous: &[&dyn SessionVault],
    dropped: &AtomicBool,
) -> Result<AccountStatus, AppError> {
    if read_session(vault)?.is_none() {
        return Ok(AccountStatus {
            signed_in: false,
            email: None,
        });
    }
    let response = match with_session_retry(client, base, anon_key, vault, |token| {
        client
            .get(format!("{base}/auth/v1/user"))
            .header("apikey", anon_key)
            .header("Authorization", format!("Bearer {token}"))
            .send()
    })
    .await
    {
        Ok(response) => response,
        Err(error) if error.to_string() == "unauthorized" => {
            return Ok(AccountStatus {
                signed_in: false,
                email: None,
            });
        }
        Err(error) => return Err(error),
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::Account("unauthorized".into()));
    }
    if !response.status().is_success() {
        return Err(AppError::Account(UNREACHABLE.into()));
    }
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let stored_email = read_session(vault)?.map(|session| session.email);
    let email = body
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .or(stored_email)
        .filter(|value| !value.is_empty());
    // A 403 from the accounts function does not delete the keychain item.
    // The server refuses the next request. Local files stay.
    drop_previous_sign_in(previous, dropped);
    Ok(AccountStatus {
        signed_in: true,
        email,
    })
}

async fn delete_account(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    app_data_dir: &Path,
) -> Result<(), AppError> {
    let (session, seen) = snapshot(vault)?;
    let Some(session) = session else {
        return Err(AppError::Account("unauthorized".into()));
    };
    // The access token is the only credential sent. A refresh token must not mint a new one.
    let response = accounts_request(
        client,
        reqwest::Method::POST,
        &accounts_url(base, "delete"),
        anon_key,
        &session.access_token,
    )
    .send()
    .await
    .map_err(|_| AppError::Account(UNREACHABLE.into()))?;
    // A sign-in that landed while the delete was on the network is a
    // different session. It stays.
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let (_status, body, _retry) = failure_body(response).await;
        commit(vault, SessionWrite::Cleared, Some(seen))?;
        return Err(AppError::Account(code_from_body(&body, "bad_jwt")));
    }
    if !response.status().is_success() {
        let (_status, body, _retry) = failure_body(response).await;
        return Err(AppError::Account(code_from_body(&body, UNREACHABLE)));
    }
    let vault_result = commit(vault, SessionWrite::Cleared, Some(seen)).map(|_| ());
    let wipe_result = wipe_account_local(app_data_dir);
    vault_result?;
    wipe_result
}

fn vault_from_app(app: &tauri::AppHandle) -> KeyringVault {
    KeyringVault::current(app.config().identifier.clone())
}

/// Keychain items earlier builds left: both item names under each earlier
/// bundle id, and the old item name under the current one. Never the current
/// id's `session` item, which is the live sign-in.
fn previous_sign_in_targets(current_service: &str) -> Vec<(String, &'static str)> {
    let mut targets = Vec::new();
    for service in crate::identifier_migration::PREVIOUS_BUNDLE_IDS {
        targets.push((service.to_string(), PREVIOUS_SESSION_ITEM));
        if *service != current_service {
            targets.push((service.to_string(), SESSION_ITEM));
        }
    }
    if !crate::identifier_migration::PREVIOUS_BUNDLE_IDS.contains(&current_service) {
        targets.push((current_service.to_string(), PREVIOUS_SESSION_ITEM));
    }
    targets
}

fn previous_sign_in_vaults(current_service: &str) -> Vec<KeyringVault> {
    previous_sign_in_targets(current_service)
        .into_iter()
        .map(|(service, item)| KeyringVault { service, item })
        .collect()
}

/// Missing is success. Any other keychain error leaves the flag clear so the
/// next successful check tries again. The new `session` item is not in `previous`.
fn drop_previous_sign_in(previous: &[&dyn SessionVault], once: &AtomicBool) {
    if once.load(Ordering::Relaxed) {
        return;
    }
    let mut cleared = true;
    for vault in previous {
        if vault.delete().is_err() {
            cleared = false;
        }
    }
    if cleared {
        once.store(true, Ordering::Relaxed);
    }
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Io(error.to_string()))
}

#[tauri::command]
pub async fn account_sign_in_start(email: String) -> Result<(), AppError> {
    let (base, anon) = supabase_from_env()?;
    sign_in_start(&accounts_client()?, &base, &anon, &email).await
}

#[tauri::command]
pub async fn account_register_start(email: String, birth_date: String) -> Result<(), AppError> {
    let (base, anon) = supabase_from_env()?;
    register_start(&accounts_client()?, &base, &anon, &email, &birth_date).await
}

#[tauri::command]
pub async fn account_sign_in_finish(
    app: tauri::AppHandle,
    email: String,
    code: String,
    birth_date: Option<String>,
    age_ticket: Option<String>,
) -> Result<AccountStatus, AppError> {
    let (base, anon) = supabase_from_env()?;
    let birth_date = birth_date.as_deref().map(str::trim).unwrap_or("");
    let proof = match age_ticket.as_deref().map(str::trim) {
        Some(ticket) if !ticket.is_empty() => SignInProof::Held { ticket, birth_date },
        _ if !birth_date.is_empty() => SignInProof::Registration {
            code: &code,
            birth_date,
        },
        _ => SignInProof::Code(&code),
    };
    let signed = sign_in_finish(
        &accounts_client()?,
        &base,
        &anon,
        &vault_from_app(&app),
        &email,
        proof,
    )
    .await;
    // An invite link opened before this sign-in changes what a refusal says.
    INVITE_ARRIVAL.sign_in(signed)
}

#[tauri::command]
pub async fn account_stored_session(app: tauri::AppHandle) -> Result<AccountStatus, AppError> {
    local_status(&vault_from_app(&app))
}

#[tauri::command]
pub async fn account_status(app: tauri::AppHandle) -> Result<AccountStatus, AppError> {
    let vault = vault_from_app(&app);
    let Ok((base, anon)) = supabase_from_env() else {
        return local_status(&vault);
    };
    let previous = previous_sign_in_vaults(app.config().identifier.as_str());
    let refs: Vec<&dyn SessionVault> = previous
        .iter()
        .map(|vault| vault as &dyn SessionVault)
        .collect();
    fetch_status(
        &accounts_client()?,
        &base,
        &anon,
        &vault,
        &refs,
        &PREVIOUS_SIGN_IN_DROPPED,
    )
    .await
}

#[tauri::command]
pub async fn account_delete(app: tauri::AppHandle) -> Result<(), AppError> {
    let (base, anon) = supabase_from_env()?;
    delete_account(
        &accounts_client()?,
        &base,
        &anon,
        &vault_from_app(&app),
        &app_data_dir(&app)?,
    )
    .await
}

fn empty_preferences(signed_in: bool, offline: bool, email: Option<String>) -> AccountPreferences {
    AccountPreferences {
        signed_in,
        offline,
        email,
        effective: None,
        spent: 0,
        soft_cap: 0,
        hard_cap: 0,
        window_end: None,
        status_line: None,
        plan_label: None,
        date_line: None,
        margin_band: None,
        items: Vec::new(),
        eu_consent: true,
        refund_open: false,
        allowance_percent: None,
        overage: false,
        overage_maximum: None,
        overage_default_dollars: None,
        overage_prompt: false,
        overage_ask_price: None,
        allowance_resets: None,
        used_pct: 0,
        account_id: None,
        credit: "$0.00".into(),
        frozen: false,
        referral_code: None,
    }
}

fn style_items(body: &Value) -> Vec<StyleItem> {
    body.get("items")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(StyleItem {
                        id: row.get("id").and_then(Value::as_str).map(str::to_string),
                        rule: row.get("rule")?.as_str()?.to_string(),
                        why: row.get("why")?.as_str()?.to_string(),
                        scope: row.get("scope")?.as_str()?.to_string(),
                        seen: row.get("seen")?.as_i64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn opt_string(body: &Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn session_email(vault: &dyn SessionVault) -> Result<Option<String>, AppError> {
    Ok(read_session(vault)?.and_then(|session| {
        if session.email.is_empty() {
            None
        } else {
            Some(session.email)
        }
    }))
}

async fn fetch_preferences(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
) -> Result<AccountPreferences, AppError> {
    if read_session(vault)?.is_none() {
        return Ok(empty_preferences(false, false, None));
    }
    let response = match with_session_retry(client, base, anon_key, vault, |token| {
        accounts_request(
            client,
            reqwest::Method::GET,
            &accounts_url(base, "preferences"),
            anon_key,
            token,
        )
        .send()
    })
    .await
    {
        Ok(response) => response,
        Err(error) if error.to_string() == "unauthorized" => {
            return Ok(empty_preferences(false, false, None));
        }
        Err(_) => return Ok(empty_preferences(true, true, session_email(vault)?)),
    };
    let email = session_email(vault)?;
    if !response.status().is_success() {
        return Ok(empty_preferences(true, true, email));
    }
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let margin_band = body
        .pointer("/margin/band")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(AccountPreferences {
        signed_in: true,
        offline: false,
        email: opt_string(&body, "email").or(email),
        effective: opt_string(&body, "effective"),
        spent: body.get("spent").and_then(Value::as_i64).unwrap_or(0),
        soft_cap: body.get("soft_cap").and_then(Value::as_i64).unwrap_or(0),
        hard_cap: body.get("hard_cap").and_then(Value::as_i64).unwrap_or(0),
        window_end: opt_string(&body, "window_end"),
        status_line: opt_string(&body, "status_line"),
        plan_label: opt_string(&body, "plan_label"),
        date_line: opt_string(&body, "date_line"),
        margin_band,
        items: style_items(&body),
        eu_consent: body
            .get("eu_consent")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        refund_open: body
            .get("refund_open")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        allowance_percent: body.get("allowance_percent").and_then(Value::as_i64),
        used_pct: body.get("used_pct").and_then(Value::as_i64).unwrap_or(0),
        account_id: opt_string(&body, "account_id"),
        overage: body
            .get("overage")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        overage_maximum: body.get("overage_maximum").and_then(Value::as_i64),
        overage_default_dollars: body.get("overage_default_dollars").and_then(Value::as_i64),
        overage_prompt: body
            .get("overage_prompt")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        overage_ask_price: opt_string(&body, "overage_ask_price"),
        allowance_resets: opt_string(&body, "allowance_resets"),
        credit: opt_string(&body, "credit").unwrap_or_else(|| "$0.00".into()),
        frozen: body.get("frozen").and_then(Value::as_bool).unwrap_or(false),
        referral_code: opt_string(&body, "referral_code"),
    })
}

async fn clear_style(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    app_data_dir: &Path,
) -> Result<(), AppError> {
    let response = with_session_retry(client, base, anon_key, vault, |token| {
        accounts_request(
            client,
            reqwest::Method::POST,
            &accounts_url(base, "clear-style"),
            anon_key,
            token,
        )
        .send()
    })
    .await?;
    if !response.status().is_success() {
        let (_status, body, _retry) = failure_body(response).await;
        return Err(AppError::Account(code_from_body(&body, UNREACHABLE)));
    }
    let style = app_data_dir.join("redline-preferences.txt");
    if style.exists() {
        std::fs::remove_file(style)?;
    }
    Ok(())
}

fn sign_out(vault: &dyn SessionVault, app_data_dir: &Path) -> Result<(), AppError> {
    clear_session(vault)?;
    let style = app_data_dir.join("redline-preferences.txt");
    if style.exists() {
        std::fs::remove_file(style)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn account_preferences(app: tauri::AppHandle) -> Result<AccountPreferences, AppError> {
    let vault = vault_from_app(&app);
    let Ok((base, anon)) = supabase_from_env() else {
        let session = read_session(&vault)?;
        return Ok(empty_preferences(
            session.is_some(),
            true,
            session.and_then(|session| {
                if session.email.is_empty() {
                    None
                } else {
                    Some(session.email)
                }
            }),
        ));
    };
    fetch_preferences(&accounts_client()?, &base, &anon, &vault).await
}

#[tauri::command]
pub async fn account_forget_style(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    let (base, anon) = supabase_from_env()?;
    let vault = vault_from_app(&app);
    post_accounts(
        &accounts_client()?,
        &base,
        &anon,
        &vault,
        "forget-style",
        Some(serde_json::json!({ "id": id })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn account_clear_style(app: tauri::AppHandle) -> Result<(), AppError> {
    let (base, anon) = supabase_from_env()?;
    clear_style(
        &accounts_client()?,
        &base,
        &anon,
        &vault_from_app(&app),
        &app_data_dir(&app)?,
    )
    .await
}

#[tauri::command]
pub fn account_sign_out(app: tauri::AppHandle) -> Result<(), AppError> {
    sign_out(&vault_from_app(&app), &app_data_dir(&app)?)
}

fn polar_https_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if host != "polar.sh" && !host.ends_with(".polar.sh") {
        return None;
    }
    Some(url.to_string())
}

async fn get_accounts(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    path: &str,
) -> Result<Value, AppError> {
    let response = with_session_retry(client, base, anon_key, vault, |token| {
        accounts_request(
            client,
            reqwest::Method::GET,
            &accounts_url(base, path),
            anon_key,
            token,
        )
        .send()
    })
    .await?;
    if !response.status().is_success() {
        let (_status, body, _retry) = failure_body(response).await;
        return Err(AppError::Account(code_from_body(&body, UNREACHABLE)));
    }
    Ok(response.json::<Value>().await.unwrap_or(Value::Null))
}

fn cancel_view(body: &Value) -> Result<CancelResult, AppError> {
    let line = body.get("line").and_then(Value::as_str).unwrap_or("");
    if line.is_empty() {
        return Err(AppError::Account("billing_unavailable".into()));
    }
    let plan = body.get("plan").and_then(Value::as_str).unwrap_or("paid");
    Ok(CancelResult {
        plan: plan.to_string(),
        line: line.to_string(),
    })
}

#[derive(Debug, Serialize)]
pub struct CancelResult {
    pub plan: String,
    pub line: String,
}

async fn post_accounts(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let response = with_session_retry(client, base, anon_key, vault, |token| {
        let request = accounts_request(
            client,
            reqwest::Method::POST,
            &accounts_url(base, path),
            anon_key,
            token,
        );
        let request = if let Some(body) = &body {
            request.json(body)
        } else {
            request
        };
        request.send()
    })
    .await?;
    if !response.status().is_success() {
        let (_status, body, _retry) = failure_body(response).await;
        return Err(AppError::Account(code_from_body(&body, UNREACHABLE)));
    }
    Ok(response.json::<Value>().await.unwrap_or(Value::Null))
}

fn billing_url(body: &Value) -> Result<String, AppError> {
    polar_https_url(body.get("url").and_then(Value::as_str).unwrap_or(""))
        .ok_or_else(|| AppError::Account("billing_unavailable".into()))
}

const CHECKOUT_BACKOFF: Duration = Duration::from_millis(250);

/// One extra try on a network error or 5xx. A 4xx, including eu_consent and
/// checkout_rate, is not tried again. Creating the Polar session does not charge.
async fn post_checkout(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    body: &Value,
) -> Result<Value, AppError> {
    let mut last = AppError::Account(UNREACHABLE.into());
    for attempt in 0..2 {
        if attempt == 1 {
            tokio::time::sleep(CHECKOUT_BACKOFF).await;
        }
        let sent = with_session_retry(client, base, anon_key, vault, |token| {
            accounts_request(
                client,
                reqwest::Method::POST,
                &accounts_url(base, "checkout"),
                anon_key,
                token,
            )
            .json(body)
            .send()
        })
        .await;
        let response = match sent {
            Ok(response) => response,
            Err(error) if error.to_string() == "unauthorized" => return Err(error),
            Err(error) => {
                last = error;
                continue;
            }
        };
        if response.status().is_success() {
            return Ok(response.json::<Value>().await.unwrap_or(Value::Null));
        }
        let status = response.status().as_u16();
        let (_status, failed, _retry) = failure_body(response).await;
        last = AppError::Account(code_from_body(&failed, UNREACHABLE));
        if status < 500 {
            return Err(last);
        }
    }
    Err(last)
}

async fn start_checkout(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    interval: &str,
    service_starts_now: bool,
    referral: Option<&str>,
) -> Result<String, AppError> {
    if interval != "month" && interval != "year" && interval != "topup" {
        return Err(AppError::Account("bad_interval".into()));
    }
    let mut payload = serde_json::json!({
        "interval": interval,
        "service_starts_now": service_starts_now,
    });
    if let Some(code) = referral.map(str::trim).filter(|code| !code.is_empty()) {
        payload["referral"] = serde_json::Value::String(code.to_string());
    }
    let body = post_checkout(client, base, anon_key, vault, &payload).await?;
    billing_url(&body)
}

async fn open_portal(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
) -> Result<String, AppError> {
    let body = post_accounts(client, base, anon_key, vault, "portal", None).await?;
    billing_url(&body)
}

async fn refund_purchase(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
) -> Result<CancelResult, AppError> {
    let body = post_accounts(client, base, anon_key, vault, "refund", None).await?;
    cancel_view(&body)
}

async fn cancel_preview(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
) -> Result<CancelResult, AppError> {
    let body = get_accounts(client, base, anon_key, vault, "refund").await?;
    cancel_view(&body)
}

async fn save_usage(
    client: &reqwest::Client,
    base: &str,
    anon_key: &str,
    vault: &dyn SessionVault,
    overage: bool,
    maximum: Option<i64>,
    prompt: bool,
) -> Result<(), AppError> {
    post_accounts(
        client,
        base,
        anon_key,
        vault,
        "usage",
        Some(serde_json::json!({ "overage": overage, "maximum": maximum, "prompt": prompt })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn account_checkout(
    app: tauri::AppHandle,
    interval: String,
    service_starts_now: bool,
    referral: Option<String>,
) -> Result<String, AppError> {
    let (base, anon) = supabase_from_env()?;
    start_checkout(
        &accounts_client()?,
        &base,
        &anon,
        &vault_from_app(&app),
        &interval,
        service_starts_now,
        referral.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn account_portal(app: tauri::AppHandle) -> Result<String, AppError> {
    let (base, anon) = supabase_from_env()?;
    open_portal(&accounts_client()?, &base, &anon, &vault_from_app(&app)).await
}

#[tauri::command]
pub async fn account_cancel_preview(app: tauri::AppHandle) -> Result<CancelResult, AppError> {
    let (base, anon) = supabase_from_env()?;
    cancel_preview(&accounts_client()?, &base, &anon, &vault_from_app(&app)).await
}

#[tauri::command]
pub async fn account_refund(app: tauri::AppHandle) -> Result<CancelResult, AppError> {
    let (base, anon) = supabase_from_env()?;
    refund_purchase(&accounts_client()?, &base, &anon, &vault_from_app(&app)).await
}

#[tauri::command]
pub async fn account_usage(
    app: tauri::AppHandle,
    overage: bool,
    maximum: Option<i64>,
    prompt: bool,
) -> Result<(), AppError> {
    let (base, anon) = supabase_from_env()?;
    save_usage(
        &accounts_client()?,
        &base,
        &anon,
        &vault_from_app(&app),
        overage,
        maximum,
        prompt,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    fn spawn_status(status: u16, body: &str) -> (String, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = body.to_string();
        let captured = Arc::new(Mutex::new(String::new()));
        let slot = captured.clone();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(400)))
                .ok();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            *slot.lock().unwrap_or_else(|p| p.into_inner()) =
                String::from_utf8_lossy(&buf[..n]).into_owned();
            let reason = match status {
                204 => "No Content",
                401 => "Unauthorized",
                429 => "Too Many Requests",
                _ => "OK",
            };
            let resp = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
        });
        (format!("http://{addr}"), captured)
    }

    fn session_json() -> String {
        serde_json::json!({
            "access_token": "access-secret",
            "refresh_token": "refresh-secret",
            "email": "ada@example.com"
        })
        .to_string()
    }

    #[test]
    fn a_denied_preferences_read_keeps_the_keychain_session() {
        let vault = MemoryVault::new();
        vault.set(&session_json()).unwrap();
        let (base, _) = spawn_status(403, r#"{"error_code":"not_admitted"}"#);
        let client = accounts_client().unwrap();
        let prefs = block_on(fetch_preferences(&client, &base, "anon-public", &vault)).unwrap();
        assert!(prefs.signed_in);
        let stored = vault.get().unwrap().unwrap();
        assert!(stored.contains("access-secret"));
        assert_eq!(
            read_session(&vault).unwrap().unwrap().access_token,
            "access-secret"
        );
    }

    #[test]
    fn stored_session_is_signed_in_without_a_request() {
        let vault = MemoryVault::new();
        vault.set(&session_json()).unwrap();
        let status = local_status(&vault).unwrap();
        assert!(status.signed_in);
        assert_eq!(status.email.as_deref(), Some("ada@example.com"));
        assert!(!local_status(&MemoryVault::new()).unwrap().signed_in);
    }

    #[test]
    fn missing_anon_key_is_not_a_network_failure() {
        let missing = supabase_from_values(None, None).unwrap_err();
        assert_eq!(missing.to_string(), MISSING_SUPABASE);
        assert!(!missing.to_string().contains("REDLINE_SUPABASE"));
        assert_ne!(missing.to_string(), UNREACHABLE);
        assert_eq!(
            missing_supabase_log(true),
            "REDLINE_SUPABASE_URL and REDLINE_SUPABASE_ANON_KEY"
        );
        let key_only =
            supabase_from_values(Some("https://abcdefghijklmnopqrst.supabase.co"), Some("  "))
                .unwrap_err();
        assert_eq!(key_only.to_string(), MISSING_SUPABASE);
        assert!(!key_only.to_string().contains("REDLINE_SUPABASE"));
        assert_eq!(missing_supabase_log(false), "REDLINE_SUPABASE_ANON_KEY");
        assert!(!missing_supabase_log(false).contains("REDLINE_SUPABASE_URL"));
        let bad_url = supabase_from_values(Some("ftp://example"), Some("anon")).unwrap_err();
        assert_eq!(bad_url.to_string(), UNREACHABLE);
        assert_eq!(
            resolve_setting(Some("https://compiled.example"), Some("  ")),
            Some("https://compiled.example")
        );
        assert_eq!(
            resolve_setting(
                Some("https://compiled.example"),
                Some("https://runtime.example")
            ),
            Some("https://runtime.example")
        );
        assert_eq!(resolve_setting(None, None), None);
        assert_eq!(resolve_setting(Some("  "), Some("")), None);
        let (base, anon) = supabase_from_values(None, Some("local-anon")).unwrap();
        assert_eq!(base, LOCAL_URL);
        assert_eq!(anon, "local-anon");
        let (base, anon) = supabase_from_values(
            Some("https://abcdefghijklmnopqrst.supabase.co/"),
            Some(" anon-public "),
        )
        .unwrap();
        assert_eq!(base, "https://abcdefghijklmnopqrst.supabase.co");
        assert_eq!(anon, "anon-public");
    }

    #[test]
    fn a_code_is_asked_of_the_accounts_function_with_only_the_address() {
        let (base, captured) = spawn_status(200, r#"{"sent":true}"#);
        let client = accounts_client().unwrap();
        block_on(sign_in_start(
            &client,
            &base,
            "anon-public",
            " ada@example.com ",
        ))
        .unwrap();
        let request = captured
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        assert!(
            request.starts_with("POST /functions/v1/accounts/sign-in/start "),
            "{request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("x-region: eu-central-1"),
            "{request}"
        );
        assert!(
            request.contains(r#"{"email":"ada@example.com"}"#),
            "{request}"
        );
        assert!(!request.contains("create_user"), "{request}");
    }

    #[test]
    fn create_account_sends_the_address_and_the_date_of_birth() {
        let (base, captured) = spawn_status(200, r#"{"sent":true}"#);
        let client = accounts_client().unwrap();
        block_on(register_start(
            &client,
            &base,
            "anon-public",
            " ada@example.com ",
            " 1990-01-01 ",
        ))
        .unwrap();
        let request = captured
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        assert!(
            request.starts_with("POST /functions/v1/accounts/register/start "),
            "{request}"
        );
        assert!(
            request.contains(r#"{"birth_date":"1990-01-01","email":"ada@example.com"}"#)
                || request.contains(r#"{"email":"ada@example.com","birth_date":"1990-01-01"}"#),
            "{request}"
        );
    }

    #[test]
    fn the_doors_keep_the_server_names() {
        for (status, code) in [
            (404, "no_account"),
            (409, "account_exists"),
            (403, "age_blocked"),
            (400, "age_required"),
        ] {
            let body = serde_json::json!({ "error_code": code });
            assert_eq!(send_failure(status, &body, None).to_string(), code);
        }
    }

    #[test]
    fn a_registration_code_goes_back_with_its_date() {
        let (base, captured) = spawn_status(401, r#"{"error_code":"bad_code"}"#);
        let vault = MemoryVault::new();
        let client = accounts_client().unwrap();
        let _ = block_on(sign_in_finish(
            &client,
            &base,
            "anon-public",
            &vault,
            "ada@example.com",
            SignInProof::Registration {
                code: "12345678",
                birth_date: "1990-01-01",
            },
        ));
        let request = captured
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        assert!(request.contains(r#""code":"12345678""#), "{request}");
        assert!(
            request.contains(r#""birth_date":"1990-01-01""#),
            "{request}"
        );
        assert!(!request.contains("age_ticket"), "{request}");
    }

    #[test]
    fn a_code_the_server_could_not_send_keeps_its_name() {
        let (base, _) = spawn_status(502, r#"{"error_code":"unreachable"}"#);
        let client = accounts_client().unwrap();
        let error = block_on(sign_in_start(&client, &base, "anon", "ada@example.com")).unwrap_err();
        assert_eq!(error.to_string(), "unreachable");
        let (base, _) = spawn_status(502, r#"{"error_code":"mail_failed"}"#);
        let error = block_on(sign_in_start(&client, &base, "anon", "ada@example.com")).unwrap_err();
        assert_eq!(error.to_string(), "mail_failed");
    }

    #[test]
    fn checkout_sends_the_interval_and_opens_only_a_polar_url() {
        let vault = MemoryVault::new();
        vault.set(&session_json()).unwrap();
        let (base, captured) =
            spawn_status(200, r#"{"url":"https://sandbox.polar.sh/checkout/abc"}"#);
        let client = accounts_client().unwrap();
        let url = block_on(start_checkout(
            &client,
            &base,
            "anon-public",
            &vault,
            "month",
            true,
            Some("abcd2345"),
        ))
        .unwrap();
        assert_eq!(url, "https://sandbox.polar.sh/checkout/abc");
        let request = captured.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert!(request.contains("\"interval\":\"month\""), "{request}");
        assert!(request.contains("\"service_starts_now\":true"), "{request}");
        assert!(request.contains("\"referral\":\"abcd2345\""), "{request}");
        assert!(!request.contains("product"), "{request}");
        assert!(
            request
                .to_ascii_lowercase()
                .contains(&format!("x-region: {}", super::ACCOUNTS_FUNCTION_REGION)),
            "{request}"
        );
        assert!(polar_https_url("https://evil.example/pay").is_none());
        assert!(polar_https_url("http://sandbox.polar.sh/checkout/abc").is_none());
        let (base, _captured) = spawn_status(200, r#"{"url":"https://evil.example/pay"}"#);
        let error = block_on(start_checkout(
            &client,
            &base,
            "anon-public",
            &vault,
            "year",
            false,
            None,
        ))
        .unwrap_err();
        assert_eq!(error.to_string(), "billing_unavailable");
    }

    fn spawn_sequence(steps: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let slot = captured.clone();
        std::thread::spawn(move || {
            for (status, body) in steps {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                stream
                    .set_read_timeout(Some(Duration::from_millis(400)))
                    .ok();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                slot.lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .push(String::from_utf8_lossy(&buf[..n]).into_owned());
                let resp = format!(
                    "HTTP/1.1 {status} ERR\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        (format!("http://{addr}"), captured)
    }

    #[test]
    fn checkout_retries_a_5xx_once_and_names_the_region() {
        let vault = MemoryVault::new();
        vault.set(&session_json()).unwrap();
        let (base, captured) = spawn_sequence(vec![
            (503, r#"{"error_code":"billing_unavailable"}"#.into()),
            (
                200,
                r#"{"url":"https://sandbox.polar.sh/checkout/abc"}"#.into(),
            ),
        ]);
        let url = block_on(start_checkout(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            "month",
            true,
            None,
        ))
        .unwrap();
        assert_eq!(url, "https://sandbox.polar.sh/checkout/abc");
        let requests = captured.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        for request in &requests {
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains(&format!("x-region: {}", super::ACCOUNTS_FUNCTION_REGION)),
                "{request}"
            );
            assert!(!request.contains("referral"), "{request}");
        }
    }

    #[test]
    fn checkout_does_not_retry_a_4xx() {
        let vault = MemoryVault::new();
        vault.set(&session_json()).unwrap();
        let (base, captured) = spawn_sequence(vec![
            (400, r#"{"error_code":"eu_consent"}"#.into()),
            (
                200,
                r#"{"url":"https://sandbox.polar.sh/checkout/abc"}"#.into(),
            ),
        ]);
        let error = block_on(start_checkout(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            "year",
            true,
            None,
        ))
        .unwrap_err();
        assert_eq!(error.to_string(), "eu_consent");
        let (limited, limited_hits) = spawn_sequence(vec![
            (429, r#"{"error_code":"checkout_rate"}"#.into()),
            (
                200,
                r#"{"url":"https://sandbox.polar.sh/checkout/abc"}"#.into(),
            ),
        ]);
        let rate = block_on(start_checkout(
            &accounts_client().unwrap(),
            &limited,
            "anon-public",
            &vault,
            "topup",
            true,
            None,
        ))
        .unwrap_err();
        assert_eq!(rate.to_string(), "checkout_rate");
        assert_eq!(captured.lock().unwrap().len(), 1);
        assert_eq!(limited_hits.lock().unwrap().len(), 1);
    }

    #[test]
    fn no_client_ip_is_not_the_per_network_limit() {
        assert_eq!(
            code_from_body(
                &serde_json::json!({"error_code": "no_client_ip"}),
                "bad_code"
            ),
            "no_client_ip"
        );
        assert_eq!(
            code_from_body(
                &serde_json::json!({"error_code": "signup_rate"}),
                "bad_code"
            ),
            "signup_rate"
        );
    }

    #[test]
    fn wait_seconds_reads_the_header_then_the_sentence() {
        assert_eq!(wait_seconds("after 60 seconds.", None), Some(60));
        assert_eq!(wait_seconds("after 2 minutes.", None), Some(120));
        assert_eq!(wait_seconds("Request rate limit reached", None), None);
        assert_eq!(wait_seconds("no number here", Some("90")), Some(90));
        assert_eq!(
            send_failure(
                429,
                &serde_json::json!({
                    "error_code": "over_email_send_rate_limit",
                    "msg": "For security purposes, you can only request this after 60 seconds."
                }),
                None,
            )
            .to_string(),
            "over_email_send_rate_limit:60"
        );
        assert_eq!(
            send_failure(
                429,
                &serde_json::json!({
                    "error_code": "over_request_rate_limit",
                    "msg": "Request rate limit reached"
                }),
                None,
            )
            .to_string(),
            "over_request_rate_limit"
        );
        assert_eq!(
            send_failure(
                429,
                &serde_json::json!({
                    "error_code": "over_email_send_rate_limit",
                    "msg": "For security purposes, you can only request this after 2 minutes."
                }),
                None,
            )
            .to_string(),
            "over_email_send_rate_limit:120"
        );
    }

    #[test]
    fn a_verify_slowdown_is_not_a_wrong_code() {
        let wait = serde_json::json!({
            "error_code": "over_request_rate_limit",
            "msg": "Request rate limit reached"
        });
        assert_eq!(
            verify_failure(429, &wait, Some("60")),
            "over_request_rate_limit:60"
        );
        assert_eq!(
            verify_failure(
                429,
                &serde_json::json!({ "code": "over_email_send_rate_limit" }),
                Some("120"),
            ),
            "over_email_send_rate_limit:120"
        );
        assert_eq!(
            verify_failure(429, &serde_json::json!({ "msg": "slow down" }), None),
            "over_request_rate_limit"
        );
        assert_eq!(
            verify_failure(401, &serde_json::json!({ "error_code": "bad_code" }), None),
            "bad_code"
        );
        assert_eq!(
            verify_failure(
                429,
                &serde_json::json!({ "error_code": "signup_cap" }),
                Some("60"),
            ),
            "signup_cap"
        );
    }

    #[test]
    fn an_address_not_on_the_list_is_not_a_wrong_code() {
        // The accounts function refuses the address after the code matched.
        let refused = serde_json::json!({ "error_code": "not_admitted" });
        assert_eq!(verify_failure(403, &refused, None), "not_admitted");
        // Billing and account calls name it too, instead of "unreachable".
        assert_eq!(code_from_body(&refused, UNREACHABLE), "not_admitted");
    }

    #[test]
    fn a_sign_in_refused_for_the_list_says_so_and_stores_nothing() {
        let vault = MemoryVault::new();
        let (base, _) = spawn_status(403, r#"{"error_code":"not_admitted"}"#);
        let refused = block_on(sign_in_finish(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            "ada@example.com",
            SignInProof::Code("12345678"),
        ))
        .unwrap_err();
        assert_eq!(refused.to_string(), "not_admitted");
        assert!(vault.get().unwrap().is_none());
    }

    #[test]
    fn code_send_log_is_status_and_code_without_the_address() {
        let mailed = serde_json::json!({
            "error_code": "unexpected_failure",
            "msg": "Error sending confirmation email to ada@example.com"
        });
        let line = code_send_log(500, logged_code(&mailed));
        assert_eq!(
            line,
            "sign-in: code send failed status=500 code=unexpected_failure"
        );
        assert!(!line.contains("ada@"));
        assert!(!line.contains("confirmation"));
        let limited = serde_json::json!({ "error_code": "over_email_send_rate_limit" });
        assert_eq!(
            code_send_log(429, logged_code(&limited)),
            "sign-in: code send failed status=429 code=over_email_send_rate_limit"
        );
        let prose = serde_json::json!({
            "msg": "Error sending confirmation email to ada@example.com"
        });
        let hidden = code_send_log(500, logged_code(&prose));
        assert_eq!(
            hidden,
            "sign-in: code send failed status=500 code=mail_failed"
        );
        assert!(!hidden.contains('@'));
        let address = serde_json::json!({ "error_code": "ada@example.com" });
        assert_eq!(logged_code(&address), "mail_failed");
    }

    #[test]
    fn a_new_account_comes_back_held_and_finishes_with_its_ticket() {
        let vault = MemoryVault::new();
        let client = accounts_client().unwrap();
        let (base, _) = spawn_status(
            403,
            r#"{"error_code":"age_required","age_ticket":"Ab-_09xyz"}"#,
        );
        let held = block_on(sign_in_finish(
            &client,
            &base,
            "anon-public",
            &vault,
            "new@example.com",
            SignInProof::Code("12345678"),
        ))
        .unwrap_err();
        assert_eq!(held.to_string(), "age_required:Ab-_09xyz");
        assert!(vault.get().unwrap().is_none());

        // Not ticket-shaped: the code alone.
        let odd = serde_json::json!({ "error_code": "age_required", "age_ticket": "a b" });
        assert_eq!(verify_failure(403, &odd, None), "age_required");
        let none = serde_json::json!({ "error_code": "age_required" });
        assert_eq!(verify_failure(403, &none, None), "age_required");

        // The second step sends the ticket and the date, and no code.
        let (base, captured) = spawn_status(
            200,
            r#"{"access_token":"access-secret","refresh_token":"refresh-secret","email":"new@example.com"}"#,
        );
        let status = block_on(sign_in_finish(
            &client,
            &base,
            "anon-public",
            &vault,
            "new@example.com",
            SignInProof::Held {
                ticket: "Ab-_09xyz",
                birth_date: "1990-05-17",
            },
        ))
        .unwrap();
        assert!(status.signed_in);
        let request = captured
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        assert!(request.contains(r#""age_ticket":"Ab-_09xyz""#), "{request}");
        assert!(
            request.contains(r#""birth_date":"1990-05-17""#),
            "{request}"
        );
        assert!(!request.contains(r#""code""#), "{request}");
    }

    #[test]
    fn sign_in_status_hides_the_refresh_token() {
        let vault = MemoryVault::new();
        let (base, captured) = spawn_status(
            200,
            r#"{"access_token":"access-secret","refresh_token":"refresh-secret","email":"ada@example.com"}"#,
        );
        let client = accounts_client().unwrap();
        let status = block_on(sign_in_finish(
            &client,
            &base,
            "anon-public",
            &vault,
            "Ada@Example.com",
            SignInProof::Code("12345678"),
        ))
        .unwrap();
        let rendered = serde_json::to_string(&status).unwrap();
        assert!(status.signed_in);
        assert_eq!(status.email.as_deref(), Some("ada@example.com"));
        let request = captured
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        assert!(
            request
                .to_ascii_lowercase()
                .contains(&format!("x-region: {}", super::ACCOUNTS_FUNCTION_REGION)),
            "{request}"
        );
        assert_eq!(super::ACCOUNTS_FUNCTION_REGION, "eu-central-1");
        assert!(!rendered.contains("refresh-secret"));
        assert!(!rendered.contains("access-secret"));
        assert!(!rendered.contains("refresh_token"));
        let stored = vault.get().unwrap().unwrap();
        assert!(stored.contains("refresh-secret"));
        assert!(stored.contains("access-secret"));
    }

    #[test]
    fn account_delete_leaves_the_document_folder_untouched() {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path().join("app-data");
        let documents = root.path().join("Documents");
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::create_dir_all(documents.join("notes")).unwrap();
        let draft = documents.join("chapter.md");
        std::fs::write(&draft, "the draft stays\n").unwrap();
        std::fs::write(documents.join("notes").join("scene.md"), "scene\n").unwrap();
        std::fs::write(
            app_data.join("redline-preferences.txt"),
            "prefer short lines\n",
        )
        .unwrap();
        std::fs::write(app_data.join(GATEWAY_ENV_FILE), "KEY=secret\n").unwrap();

        let vault = MemoryVault::new();
        vault.set(&session_json()).unwrap();
        let (base, captured) = spawn_status(204, "");
        let client = accounts_client().unwrap();
        block_on(delete_account(
            &client,
            &base,
            "anon-public",
            &vault,
            &app_data,
        ))
        .unwrap();

        let request = captured.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert!(request.contains("Bearer access-secret"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains(&format!("x-region: {}", super::ACCOUNTS_FUNCTION_REGION)),
            "{request}"
        );
        assert!(!request.contains("refresh-secret"));
        assert!(!request.contains("chapter.md"));
        assert!(!request.contains(documents.to_string_lossy().as_ref()));
        assert_eq!(
            std::fs::read_to_string(&draft).unwrap(),
            "the draft stays\n"
        );
        assert_eq!(
            std::fs::read_to_string(documents.join("notes").join("scene.md")).unwrap(),
            "scene\n"
        );
        assert!(documents.is_dir());
        assert!(!app_data.join("redline-preferences.txt").exists());
        assert!(!app_data.join(GATEWAY_ENV_FILE).exists());
        assert!(vault.get().unwrap().is_none());
    }

    #[test]
    fn expired_session_cannot_delete_and_clears_the_local_session() {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path().join("app-data");
        let documents = root.path().join("Documents");
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::create_dir_all(&documents).unwrap();
        let draft = documents.join("chapter.md");
        std::fs::write(&draft, "the draft stays\n").unwrap();
        std::fs::write(
            app_data.join("redline-preferences.txt"),
            "prefer short lines\n",
        )
        .unwrap();
        std::fs::write(app_data.join(GATEWAY_ENV_FILE), "KEY=secret\n").unwrap();

        let vault = MemoryVault::new();
        vault.set(&session_json()).unwrap();
        let (base, captured) = spawn_status(401, r#"{"error_code":"session_expired"}"#);
        let client = accounts_client().unwrap();
        let error = block_on(delete_account(
            &client,
            &base,
            "anon-public",
            &vault,
            &app_data,
        ))
        .unwrap_err();
        assert_eq!(error.to_string(), "session_expired");
        let request = captured.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert!(request.contains("/accounts/delete"), "{request}");
        assert!(!request.contains("grant_type=refresh_token"), "{request}");
        assert!(request.contains("Bearer access-secret"), "{request}");
        assert!(vault.get().unwrap().is_none());
        assert_eq!(
            std::fs::read_to_string(app_data.join("redline-preferences.txt")).unwrap(),
            "prefer short lines\n"
        );
        assert!(app_data.join(GATEWAY_ENV_FILE).exists());
        assert_eq!(
            std::fs::read_to_string(&draft).unwrap(),
            "the draft stays\n"
        );
    }

    #[test]
    fn successful_sign_in_check_drops_the_previous_session_once() {
        let current = MemoryVault::new();
        current.set(&session_json()).unwrap();
        let old_item = MemoryVault::new();
        old_item.set("old-keychain-item").unwrap();
        let old_key = MemoryVault::new();
        old_key.set("old-auth-key").unwrap();
        let once = AtomicBool::new(false);
        let client = accounts_client().unwrap();
        let previous: [&dyn SessionVault; 2] = [&old_item, &old_key];
        let (base, _) = spawn_status(200, r#"{"email":"ada@example.com"}"#);
        let status = block_on(fetch_status(
            &client,
            &base,
            "anon-public",
            &current,
            &previous,
            &once,
        ))
        .unwrap();
        assert!(status.signed_in);
        assert!(old_item.get().unwrap().is_none());
        assert!(old_key.get().unwrap().is_none());
        assert!(current.get().unwrap().unwrap().contains("access-secret"));
        assert!(once.load(Ordering::Relaxed));

        old_item.set("came-back").unwrap();
        let (base, _) = spawn_status(200, r#"{"email":"ada@example.com"}"#);
        let again = block_on(fetch_status(
            &client,
            &base,
            "anon-public",
            &current,
            &previous,
            &once,
        ))
        .unwrap();
        assert!(again.signed_in);
        assert_eq!(old_item.get().unwrap().as_deref(), Some("came-back"));
        assert!(current.get().unwrap().unwrap().contains("access-secret"));

        let missing_item = MemoryVault::new();
        let missing_key = MemoryVault::new();
        let fresh = AtomicBool::new(false);
        let missing: [&dyn SessionVault; 2] = [&missing_item, &missing_key];
        let (base, _) = spawn_status(200, r#"{"email":"ada@example.com"}"#);
        let status = block_on(fetch_status(
            &client,
            &base,
            "anon-public",
            &current,
            &missing,
            &fresh,
        ))
        .unwrap();
        assert!(status.signed_in);
        assert!(fresh.load(Ordering::Relaxed));
        assert!(current.get().unwrap().unwrap().contains("access-secret"));
    }

    #[test]
    fn sign_in_check_keeps_the_previous_session_until_it_succeeds() {
        let current = MemoryVault::new();
        let old_item = MemoryVault::new();
        old_item.set("old-keychain-item").unwrap();
        let old_key = MemoryVault::new();
        old_key.set("old-auth-key").unwrap();
        let once = AtomicBool::new(false);
        let client = accounts_client().unwrap();
        let previous: [&dyn SessionVault; 2] = [&old_item, &old_key];
        let status = block_on(fetch_status(
            &client,
            "http://127.0.0.1:9",
            "anon-public",
            &current,
            &previous,
            &once,
        ))
        .unwrap();
        assert!(!status.signed_in);
        assert_eq!(
            old_item.get().unwrap().as_deref(),
            Some("old-keychain-item")
        );
        assert_eq!(old_key.get().unwrap().as_deref(), Some("old-auth-key"));
        assert!(!once.load(Ordering::Relaxed));

        current.set(&session_json()).unwrap();
        let (base, _) = spawn_status(401, r#"{"error_code":"session_expired"}"#);
        let error = block_on(fetch_status(
            &client,
            &base,
            "anon-public",
            &current,
            &previous,
            &once,
        ))
        .unwrap_err();
        assert_eq!(error.to_string(), UNREACHABLE);
        assert!(current.get().unwrap().unwrap().contains("access-secret"));
        assert_eq!(
            old_item.get().unwrap().as_deref(),
            Some("old-keychain-item")
        );
        assert_eq!(old_key.get().unwrap().as_deref(), Some("old-auth-key"));
        assert!(!once.load(Ordering::Relaxed));

        current.set(&session_json()).unwrap();
        let (base, _) = spawn_status(500, "nope");
        let error = block_on(fetch_status(
            &client,
            &base,
            "anon-public",
            &current,
            &previous,
            &once,
        ))
        .unwrap_err();
        assert_eq!(error.to_string(), UNREACHABLE);
        assert!(current.get().unwrap().is_some());
        assert_eq!(
            old_item.get().unwrap().as_deref(),
            Some("old-keychain-item")
        );
        assert!(!once.load(Ordering::Relaxed));
    }

    fn test_jwt(exp: i64) -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#);
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{payload}.sig")
    }

    fn session_with(access: &str, refresh: &str) -> String {
        serde_json::json!({
            "access_token": access,
            "refresh_token": refresh,
            "email": "ada@example.com"
        })
        .to_string()
    }

    #[test]
    fn access_near_expiry_is_rotated_before_the_status_check() {
        let vault = MemoryVault::new();
        let expiring = test_jwt(unix_now() + 30);
        vault
            .set(&session_with(&expiring, "refresh-secret"))
            .unwrap();
        let fresh = test_jwt(unix_now() + 3600);
        let (base, captured) = spawn_sequence(vec![
            (
                200,
                format!(
                    r#"{{"access_token":"{fresh}","refresh_token":"rotated","user":{{"email":"ada@example.com"}}}}"#
                ),
            ),
            (200, r#"{"email":"ada@example.com"}"#.into()),
        ]);
        let once = AtomicBool::new(false);
        let status = block_on(fetch_status(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            &[],
            &once,
        ))
        .unwrap();
        assert!(status.signed_in);
        let requests = captured.lock().unwrap().clone();
        assert_eq!(requests.len(), 2, "{requests:?}");
        assert!(
            requests[0].contains("/auth/v1/token?grant_type=refresh_token"),
            "{}",
            requests[0]
        );
        assert!(
            requests[0].contains("apikey: anon-public"),
            "{}",
            requests[0]
        );
        assert!(
            requests[0].contains("\"refresh_token\":\"refresh-secret\""),
            "{}",
            requests[0]
        );
        assert!(
            requests[1].contains(&format!("Bearer {fresh}")),
            "{}",
            requests[1]
        );
        let stored = vault.get().unwrap().unwrap();
        assert!(stored.contains(&fresh), "{stored}");
        assert!(stored.contains("rotated"), "{stored}");
        assert!(!stored.contains("refresh-secret"), "{stored}");
    }

    #[test]
    fn access_with_time_left_is_not_rotated() {
        let vault = MemoryVault::new();
        let token = test_jwt(unix_now() + 3600);
        vault.set(&session_with(&token, "refresh-secret")).unwrap();
        let (base, captured) = spawn_status(200, r#"{"email":"ada@example.com"}"#);
        let once = AtomicBool::new(false);
        let status = block_on(fetch_status(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            &[],
            &once,
        ))
        .unwrap();
        assert!(status.signed_in);
        let request = captured.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert!(request.contains("/auth/v1/user"), "{request}");
        assert!(!request.contains("grant_type=refresh_token"), "{request}");
        assert!(vault.get().unwrap().unwrap().contains("refresh-secret"));
    }

    #[test]
    fn unauthorized_retries_once_after_a_refresh() {
        let vault = MemoryVault::new();
        vault
            .set(&session_with(
                &test_jwt(unix_now() + 3600),
                "refresh-secret",
            ))
            .unwrap();
        let (base, captured) = spawn_sequence(vec![
            (401, r#"{"error_code":"session_expired"}"#.into()),
            (
                200,
                r#"{"access_token":"new-access","refresh_token":"rotated"}"#.into(),
            ),
            (200, r#"{"email":"ada@example.com"}"#.into()),
        ]);
        let once = AtomicBool::new(false);
        let status = block_on(fetch_status(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            &[],
            &once,
        ))
        .unwrap();
        assert!(status.signed_in);
        assert_eq!(status.email.as_deref(), Some("ada@example.com"));
        let requests = captured.lock().unwrap().clone();
        assert_eq!(requests.len(), 3, "{requests:?}");
        assert!(
            requests[1].contains("grant_type=refresh_token"),
            "{}",
            requests[1]
        );
        assert!(requests[2].contains("Bearer new-access"), "{}", requests[2]);
        let stored = vault.get().unwrap().unwrap();
        assert!(stored.contains("new-access"), "{stored}");
        assert!(stored.contains("rotated"), "{stored}");
    }

    #[test]
    fn a_refused_refresh_clears_the_session_and_a_failed_one_does_not() {
        for status in [400_u16, 401, 403] {
            let vault = MemoryVault::new();
            vault
                .set(&session_with(
                    &test_jwt(unix_now() + 3600),
                    "refresh-secret",
                ))
                .unwrap();
            let (base, captured) = spawn_sequence(vec![
                (401, r#"{"error_code":"session_expired"}"#.into()),
                (status, r#"{"error":"invalid_grant"}"#.into()),
            ]);
            let once = AtomicBool::new(false);
            let signed_out = block_on(fetch_status(
                &accounts_client().unwrap(),
                &base,
                "anon-public",
                &vault,
                &[],
                &once,
            ))
            .unwrap();
            assert!(!signed_out.signed_in, "{status}");
            assert!(vault.get().unwrap().is_none(), "{status}");
            assert_eq!(captured.lock().unwrap().len(), 2, "{status}");
        }

        let vault = MemoryVault::new();
        vault
            .set(&session_with(
                &test_jwt(unix_now() + 3600),
                "refresh-secret",
            ))
            .unwrap();
        let (base, _) = spawn_sequence(vec![
            (401, r#"{"error_code":"session_expired"}"#.into()),
            (500, r#"{"error":"unavailable"}"#.into()),
        ]);
        let once = AtomicBool::new(false);
        let error = block_on(fetch_status(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            &[],
            &once,
        ))
        .unwrap_err();
        assert_eq!(error.to_string(), UNREACHABLE);
        assert!(vault.get().unwrap().unwrap().contains("refresh-secret"));
    }

    #[test]
    fn sign_out_and_a_refused_refresh_leave_local_documents() {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path().join("app-data");
        let docs = root.path().join("docs");
        std::fs::create_dir_all(app_data.join("Tutorial")).unwrap();
        std::fs::create_dir_all(&docs).unwrap();
        let tutorial = app_data.join("Tutorial").join("Tutorial.md");
        let note = docs.join("harbor.md");
        let tutorial_bytes = b"# Tutorial\nStay.\n";
        let note_bytes = b"# Harbor\nThe boats are in.\n";
        std::fs::write(&tutorial, tutorial_bytes).unwrap();
        std::fs::write(&note, note_bytes).unwrap();
        std::fs::write(app_data.join("redline-preferences.txt"), b"style").unwrap();

        let vault = MemoryVault::new();
        vault.set(&session_json()).unwrap();
        sign_out(&vault, &app_data).unwrap();
        assert!(vault.get().unwrap().is_none());
        assert!(!app_data.join("redline-preferences.txt").exists());
        assert_eq!(std::fs::read(&tutorial).unwrap(), tutorial_bytes);
        assert_eq!(std::fs::read(&note).unwrap(), note_bytes);

        let expiring = test_jwt(unix_now() - 30);
        vault
            .set(&session_with(&expiring, "refresh-secret"))
            .unwrap();
        let fresh = test_jwt(unix_now() + 3600);
        let (base, _) = spawn_sequence(vec![
            (
                200,
                format!(
                    r#"{{"access_token":"{fresh}","refresh_token":"rotated","user":{{"email":"ada@example.com"}}}}"#
                ),
            ),
            (200, r#"{"email":"ada@example.com"}"#.into()),
        ]);
        let once = AtomicBool::new(false);
        let renewed = block_on(fetch_status(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            &[],
            &once,
        ))
        .unwrap();
        assert!(renewed.signed_in);
        assert!(vault.get().unwrap().unwrap().contains("rotated"));
        assert_eq!(std::fs::read(&note).unwrap(), note_bytes);

        vault
            .set(&session_with(
                &test_jwt(unix_now() + 3600),
                "refresh-secret",
            ))
            .unwrap();
        let (base, _) = spawn_sequence(vec![
            (401, r#"{"error_code":"session_expired"}"#.into()),
            (401, r#"{"error":"invalid_grant"}"#.into()),
        ]);
        let once = AtomicBool::new(false);
        let signed_out = block_on(fetch_status(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            &[],
            &once,
        ))
        .unwrap();
        assert!(!signed_out.signed_in);
        assert!(vault.get().unwrap().is_none());
        assert_eq!(std::fs::read(&tutorial).unwrap(), tutorial_bytes);
        assert_eq!(std::fs::read(&note).unwrap(), note_bytes);
    }

    /// Answers one request, but only after the test says so. `arrived`
    /// fires once the request is in, so the test can act mid-flight.
    fn spawn_held(
        status: u16,
        body: String,
    ) -> (
        String,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (arrived_tx, arrived) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(400)))
                .ok();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = arrived_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
            let resp = format!(
                "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
        });
        (format!("http://{addr}"), arrived, release)
    }

    fn rotated_body(access: &str) -> String {
        format!(r#"{{"access_token":"{access}","refresh_token":"rotated"}}"#)
    }

    #[test]
    fn a_refresh_in_flight_does_not_bring_back_a_signed_out_session() {
        let root = tempfile::tempdir().unwrap();
        let vault = Arc::new(MemoryVault::new());
        vault
            .set(&session_with(&test_jwt(unix_now() - 30), "refresh-secret"))
            .unwrap();
        let fresh = test_jwt(unix_now() + 3600);
        let (base, arrived, release) = spawn_held(200, rotated_body(&fresh));
        let worker = {
            let vault = vault.clone();
            std::thread::spawn(move || {
                block_on(rotate(
                    &accounts_client().unwrap(),
                    &base,
                    "anon-public",
                    &*vault,
                ))
                .unwrap()
            })
        };
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        sign_out(&*vault, root.path()).unwrap();
        release.send(()).unwrap();
        let after = worker.join().unwrap();
        assert!(after.is_none(), "the refresh reported a session");
        assert!(vault.get().unwrap().is_none(), "sign-out was undone");
        assert!(held_session(&*vault).is_none());
    }

    #[test]
    fn a_refresh_in_flight_does_not_overwrite_a_new_sign_in() {
        let vault = Arc::new(MemoryVault::new());
        vault
            .set(&session_with(&test_jwt(unix_now() - 30), "refresh-secret"))
            .unwrap();
        let fresh = test_jwt(unix_now() + 3600);
        let (base, arrived, release) = spawn_held(200, rotated_body(&fresh));
        let worker = {
            let vault = vault.clone();
            std::thread::spawn(move || {
                block_on(rotate(
                    &accounts_client().unwrap(),
                    &base,
                    "anon-public",
                    &*vault,
                ))
                .unwrap()
            })
        };
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        let (verify, _) = spawn_status(
            200,
            r#"{"access_token":"grace-access","refresh_token":"grace-refresh","email":"grace@example.com"}"#,
        );
        block_on(sign_in_finish(
            &accounts_client().unwrap(),
            &verify,
            "anon-public",
            &*vault,
            "grace@example.com",
            SignInProof::Code("123456"),
        ))
        .unwrap();
        release.send(()).unwrap();
        let after = worker.join().unwrap().expect("signed in");
        assert_eq!(after.email, "grace@example.com");
        let stored = vault.get().unwrap().unwrap();
        assert!(stored.contains("grace-refresh"), "{stored}");
        assert!(!stored.contains("rotated"), "{stored}");
    }

    #[test]
    fn a_refused_refresh_in_flight_does_not_clear_a_new_sign_in() {
        let vault = Arc::new(MemoryVault::new());
        let rejected = test_jwt(unix_now() + 3600);
        vault
            .set(&session_with(&rejected, "refresh-secret"))
            .unwrap();
        let (base, arrived, release) = spawn_held(400, r#"{"error":"invalid_grant"}"#.into());
        let worker = {
            let vault = vault.clone();
            std::thread::spawn(move || {
                block_on(refresh_for_retry(
                    &accounts_client().unwrap(),
                    &base,
                    "anon-public",
                    &*vault,
                    &rejected,
                ))
                .unwrap()
            })
        };
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        commit(
            &*vault,
            SessionWrite::SignedIn(StoredSession {
                access_token: "grace-access".into(),
                refresh_token: "grace-refresh".into(),
                email: "grace@example.com".into(),
            }),
            None,
        )
        .unwrap();
        release.send(()).unwrap();
        let _ = worker.join().unwrap();
        let stored = vault.get().unwrap().expect("the new sign-in stays");
        assert!(stored.contains("grace-refresh"), "{stored}");
    }

    struct RefusingVault {
        inner: MemoryVault,
        refuse_sets: std::sync::atomic::AtomicBool,
    }

    impl SessionVault for RefusingVault {
        fn get(&self) -> Result<Option<String>, AppError> {
            self.inner.get()
        }
        fn set(&self, token: &str) -> Result<(), AppError> {
            if self.refuse_sets.load(Ordering::SeqCst) {
                return Err(AppError::Account(UNREACHABLE.into()));
            }
            self.inner.set(token)
        }
        fn delete(&self) -> Result<(), AppError> {
            self.inner.delete()
        }
        fn memory(&self) -> &SessionMemory {
            self.inner.memory()
        }
    }

    #[test]
    fn a_rotated_session_the_keychain_refused_is_kept_and_written_again() {
        let vault = RefusingVault {
            inner: MemoryVault::new(),
            refuse_sets: std::sync::atomic::AtomicBool::new(true),
        };
        vault
            .inner
            .set(&session_with(&test_jwt(unix_now() - 30), "refresh-secret"))
            .unwrap();
        let fresh = test_jwt(unix_now() + 3600);
        let (base, _) = spawn_status(200, &rotated_body(&fresh));
        let rotated = block_on(rotate(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
        ))
        .unwrap()
        .expect("the new pair is used");
        assert_eq!(rotated.refresh_token, "rotated");
        // The keychain still holds the spent token. Reads must not go back to it.
        assert!(vault
            .inner
            .get()
            .unwrap()
            .unwrap()
            .contains("refresh-secret"));
        let read = read_session(&vault).unwrap().unwrap();
        assert_eq!(read.refresh_token, "rotated");
        assert_eq!(read.access_token, fresh);
        // Once the keychain takes writes again, the next read stores it.
        vault.refuse_sets.store(false, Ordering::SeqCst);
        let read = read_session(&vault).unwrap().unwrap();
        assert_eq!(read.refresh_token, "rotated");
        let stored = vault.inner.get().unwrap().unwrap();
        assert!(stored.contains("rotated"), "{stored}");
        assert!(!stored.contains("refresh-secret"), "{stored}");
    }

    #[test]
    fn sign_out_drops_an_unsaved_rotation() {
        let root = tempfile::tempdir().unwrap();
        let vault = RefusingVault {
            inner: MemoryVault::new(),
            refuse_sets: std::sync::atomic::AtomicBool::new(true),
        };
        vault
            .inner
            .set(&session_with(&test_jwt(unix_now() - 30), "refresh-secret"))
            .unwrap();
        let (base, _) = spawn_status(200, &rotated_body(&test_jwt(unix_now() + 3600)));
        block_on(rotate(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
        ))
        .unwrap()
        .unwrap();
        sign_out(&vault, root.path()).unwrap();
        vault.refuse_sets.store(false, Ordering::SeqCst);
        assert!(read_session(&vault).unwrap().is_none());
        assert!(vault.inner.get().unwrap().is_none());
    }

    #[test]
    fn delete_does_not_rotate_an_expiring_access_token() {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path().join("app-data");
        std::fs::create_dir_all(&app_data).unwrap();
        let vault = MemoryVault::new();
        let token = test_jwt(unix_now() - 10);
        vault.set(&session_with(&token, "refresh-secret")).unwrap();
        let (base, captured) = spawn_status(204, "");
        block_on(delete_account(
            &accounts_client().unwrap(),
            &base,
            "anon-public",
            &vault,
            &app_data,
        ))
        .unwrap();
        let request = captured.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert!(request.contains("/accounts/delete"), "{request}");
        assert!(!request.contains("grant_type=refresh_token"), "{request}");
        assert!(request.contains(&format!("Bearer {token}")), "{request}");
        assert!(vault.get().unwrap().is_none());
    }

    #[test]
    fn checkout_return_is_an_alkuin_url_with_a_checkout() {
        assert!(is_checkout_return(
            "https://alkuin.app/account?checkout_id=abc"
        ));
        assert!(is_checkout_return("alkuin://checkout"));
        assert!(!is_checkout_return("https://sandbox.polar.sh/checkout/abc"));
        assert!(!is_checkout_return("alkuin://share/ab"));
        assert!(jwt_exp(&test_jwt(90)) == Some(90));
        assert!(jwt_exp("access-secret").is_none());
    }

    #[test]
    fn previous_sign_in_targets_what_earlier_builds_left() {
        assert_eq!(SESSION_ITEM, "session");
        assert_eq!(PREVIOUS_SESSION_ITEM, "redline-session");
        assert_eq!(
            previous_sign_in_targets("app.alkuin.desktop"),
            vec![
                ("com.antonelli.desk".to_string(), "redline-session"),
                ("com.antonelli.desk".to_string(), "session"),
                ("app.redline.desktop".to_string(), "redline-session"),
                ("app.redline.desktop".to_string(), "session"),
                ("app.alkuin.desktop".to_string(), "redline-session"),
            ]
        );
        // A build still run under an earlier id keeps its own live item.
        for current in [
            "app.alkuin.desktop",
            "com.antonelli.desk",
            "app.redline.desktop",
        ] {
            assert!(
                !previous_sign_in_targets(current).contains(&(current.to_string(), SESSION_ITEM)),
                "{current}"
            );
        }
        assert_eq!(
            previous_sign_in_targets("app.redline.desktop"),
            vec![
                ("com.antonelli.desk".to_string(), "redline-session"),
                ("com.antonelli.desk".to_string(), "session"),
                ("app.redline.desktop".to_string(), "redline-session"),
            ]
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn default_keyring_store_is_not_the_mock() {
        let entry =
            keyring::Entry::new("com.writer-computer.e2e", "store-kind").expect("keyring entry");
        assert!(
            entry
                .get_credential()
                .downcast_ref::<keyring::mock::MockCredential>()
                .is_none(),
            "keyring default store is the in-memory mock"
        );
        assert!(!native_keyring_store().is_empty());
    }

    const KEYCHAIN_PROOF_SERVICE: &str = "com.writer-computer.e2e";

    fn keychain_proof_phase() -> Option<String> {
        std::env::var("REDLINE_KEYCHAIN_PROOF").ok()
    }

    fn proof_session() -> StoredSession {
        StoredSession {
            access_token: "proof-access".into(),
            refresh_token: "proof-refresh".into(),
            email: "proof@example.com".into(),
        }
    }

    #[test]
    #[ignore = "writes the macOS keychain; REDLINE_KEYCHAIN_PROOF=store"]
    fn real_keychain_store_session() {
        assert_eq!(keychain_proof_phase().as_deref(), Some("store"));
        commit(
            &KeyringVault::current(KEYCHAIN_PROOF_SERVICE.to_string()),
            SessionWrite::SignedIn(proof_session()),
            None,
        )
        .expect("store session");
        println!("PASS stored session item");
    }

    #[test]
    #[ignore = "reads the macOS keychain; REDLINE_KEYCHAIN_PROOF=read"]
    fn real_keychain_read_session() {
        assert_eq!(keychain_proof_phase().as_deref(), Some("read"));
        let session = read_session(&KeyringVault::current(KEYCHAIN_PROOF_SERVICE.to_string()))
            .expect("read session")
            .expect("signed in");
        assert!(!session.access_token.is_empty());
        assert_eq!(session.email, "proof@example.com");
        println!("PASS session still signed in");
    }

    #[test]
    #[ignore = "macOS keychain; REDLINE_KEYCHAIN_PROOF=old"]
    fn real_keychain_previous_session() {
        assert_eq!(keychain_proof_phase().as_deref(), Some("old"));
        assert!(previous_sign_in_targets(KEYCHAIN_PROOF_SERVICE)
            .iter()
            .any(|(_, item)| *item == PREVIOUS_SESSION_ITEM));
        let current = KeyringVault::current(KEYCHAIN_PROOF_SERVICE.to_string());
        let previous = previous_sign_in_vaults(KEYCHAIN_PROOF_SERVICE);
        current.delete().expect("clear session");
        for vault in &previous {
            vault.set("old-keychain-item").expect("plant old item");
        }
        let client = accounts_client().unwrap();
        let kept = AtomicBool::new(false);
        let refs: Vec<&dyn SessionVault> = previous.iter().map(|vault| vault as _).collect();
        let status = block_on(fetch_status(
            &client,
            "http://127.0.0.1:9",
            "anon-public",
            &current,
            &refs,
            &kept,
        ))
        .expect("status without session");
        assert!(!status.signed_in);
        assert!(!kept.load(Ordering::Relaxed));
        for vault in &previous {
            assert_eq!(
                vault.get().expect("old item").as_deref(),
                Some("old-keychain-item")
            );
        }

        commit(&current, SessionWrite::SignedIn(proof_session()), None).expect("store session");
        let (base, _) = spawn_status(200, r#"{"email":"proof@example.com"}"#);
        let dropped = AtomicBool::new(false);
        let refs: Vec<&dyn SessionVault> = previous.iter().map(|vault| vault as _).collect();
        let status = block_on(fetch_status(
            &client,
            &base,
            "anon-public",
            &current,
            &refs,
            &dropped,
        ))
        .expect("status with session");
        assert!(status.signed_in);
        assert!(dropped.load(Ordering::Relaxed));
        for vault in &previous {
            assert!(vault.get().expect("old gone").is_none());
        }
        assert!(read_session(&current).expect("session").is_some());
        println!("PASS old redline-session removed only after session exists");

        let again = AtomicBool::new(false);
        let refs: Vec<&dyn SessionVault> = previous.iter().map(|vault| vault as _).collect();
        let (base, _) = spawn_status(200, r#"{"email":"proof@example.com"}"#);
        let status = block_on(fetch_status(
            &client,
            &base,
            "anon-public",
            &current,
            &refs,
            &again,
        ))
        .expect("missing old item");
        assert!(status.signed_in);
        assert!(again.load(Ordering::Relaxed));
        println!("PASS missing redline-session returns success");
    }

    #[test]
    #[ignore = "deletes the macOS keychain item; REDLINE_KEYCHAIN_PROOF=delete"]
    fn real_keychain_delete_account() {
        assert_eq!(keychain_proof_phase().as_deref(), Some("delete"));
        let vault = KeyringVault::current(KEYCHAIN_PROOF_SERVICE.to_string());
        vault.delete().expect("delete account");
        assert!(read_session(&vault).expect("read session").is_none());
        println!("PASS deleted account");
    }

    #[test]
    fn accounts_request_names_the_region() {
        let client = accounts_client().unwrap();
        for (route, path) in [
            ("ask", "/functions/v1/accounts/ask"),
            ("", "/functions/v1/accounts"),
        ] {
            let built = accounts_request(
                &client,
                reqwest::Method::GET,
                &accounts_url("http://127.0.0.1:9", route),
                "anon",
                "token",
            )
            .build()
            .unwrap();
            assert_eq!(built.url().path(), path);
            assert_eq!(
                built
                    .headers()
                    .get("x-region")
                    .and_then(|value| value.to_str().ok()),
                Some("eu-central-1")
            );
        }
    }

    #[test]
    fn a_direct_accounts_call_without_the_region_header_fails_the_scan() {
        let missing = "fn sneak(client: &reqwest::Client, base: &str) {\n    \
let _ = client.post(format!(\"{base}/functions/v1/accounts/ask\"));\n}\n";
        let gaps = region_gaps("sneak.rs", missing);
        assert!(!gaps.is_empty(), "{gaps:?}");

        let split = "fn ask(client: &reqwest::Client, base: &str) {\n    \
let url = accounts_url(base, \"ask\");\n    let _ = client.post(&url);\n}\n";
        assert!(!region_gaps("split.rs", split).is_empty());

        let shared = "\
fn accounts_url(base: &str, route: &str) -> String {
    format!(\"{base}/functions/v1/accounts/{route}\")
}
fn accounts_request(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    client.request(url).header(\"x-region\", ACCOUNTS_FUNCTION_REGION)
}
fn ask(client: &reqwest::Client, base: &str) {
    let _ = accounts_request(client, &accounts_url(base, \"ask\"));
}
";
        let ok = region_gaps("ok.rs", shared);
        assert!(ok.is_empty(), "{ok:?}");

        let ts_missing =
            "fetch(`${url}/functions/v1/accounts/checkout`, { headers: { apikey: \"k\" } });\n";
        assert!(!region_gaps("pricing.ts", ts_missing).is_empty());
        let ts_ok = "fetch(`${url}/functions/v1/accounts/checkout`, { headers: { \"x-region\": \"eu-central-1\" } });\n";
        let pinned = region_gaps("pricing.ts", ts_ok);
        assert!(pinned.is_empty(), "{pinned:?}");
    }

    #[test]
    fn raw_string_braces_do_not_hide_a_trailing_test_module() {
        let source = r##"
fn accounts_url() {
    let _ = "{base}/functions/v1/accounts";
}
#[cfg(test)]
mod tests {
    fn local() {
        let body = r#"{"a":1}"#;
        let _ = client.post("/functions/v1/accounts/ask");
    }
}
"##;
        let kept = without_trailing_tests(source);
        assert!(!kept.contains("sandbox") && !kept.contains("client.post"));
        assert!(kept.contains("fn accounts_url"));
        assert!(region_gaps("sample.rs", source).is_empty(), "{kept}");
    }

    /// ponytail: the scan is textual. A trailing `mod tests` is not a call site.
    /// A function that posts a URL built in a different function is the ceiling.
    /// Upgrade path: type-check that every accounts `RequestBuilder` is `accounts_request`.
    #[test]
    fn every_desktop_accounts_call_sends_the_region() {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        collect_sources(&manifest.join("src"), &mut files);
        collect_sources(&manifest.join("../src"), &mut files);
        assert!(files.iter().any(|path| path.ends_with("account.rs")));
        let mut saw_builder = false;
        for path in files {
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            let label = path.display().to_string();
            if label.ends_with("account.rs") {
                let kept = without_trailing_tests(&text);
                assert!(kept.contains("const ACCOUNTS_FUNCTION_REGION: &str = \"eu-central-1\""));
                assert!(kept.contains("fn accounts_request("));
                saw_builder = true;
            }
            let gaps = region_gaps(&label, &text);
            assert!(gaps.is_empty(), "{gaps:?}");
        }
        assert!(saw_builder);
    }

    fn collect_sources(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|name| name.to_str());
                if name == Some("target") || name == Some("node_modules") {
                    continue;
                }
                collect_sources(&path, out);
            } else if path
                .extension()
                .is_some_and(|ext| ext == "rs" || ext == "ts" || ext == "tsx")
            {
                out.push(path);
            }
        }
    }

    fn region_gaps(label: &str, source: &str) -> Vec<String> {
        if !label.ends_with(".rs") {
            return ts_gaps(label, source);
        }
        let source = without_trailing_tests(source);
        let spans = fn_spans(source);
        let mut gaps = Vec::new();
        if path_outside_accounts_url(source, &spans) {
            gaps.push(format!("{label}: accounts URL outside accounts_url"));
        }
        for (name, open, close) in &spans {
            let body = &source[*open..*close];
            if name == "accounts_request"
                && !body.contains(".header(\"x-region\", ACCOUNTS_FUNCTION_REGION)")
            {
                gaps.push(format!("{label}: accounts_request omits x-region"));
            }
            if name != "accounts_request"
                && body.contains("accounts_url(")
                && sends_http(body)
                && !body.contains("accounts_request(")
            {
                gaps.push(format!(
                    "{label}: {name} posts accounts_url without accounts_request"
                ));
            }
        }
        gaps
    }

    fn path_outside_accounts_url(source: &str, spans: &[(String, usize, usize)]) -> bool {
        let needle = "functions/v1/accounts";
        let mut start = 0;
        while let Some(rel) = source[start..].find(needle) {
            let at = start + rel;
            let inside = spans
                .iter()
                .any(|(name, open, close)| *name == "accounts_url" && at >= *open && at < *close);
            if !inside {
                return true;
            }
            start = at + needle.len();
        }
        false
    }

    fn sends_http(body: &str) -> bool {
        body.contains(".post(")
            || body.contains(".get(")
            || body.contains(".put(")
            || body.contains(".patch(")
            || body.contains(".request(")
    }

    fn ts_gaps(label: &str, source: &str) -> Vec<String> {
        let needle = "functions/v1/accounts";
        let mut gaps = Vec::new();
        let mut start = 0;
        while let Some(rel) = source[start..].find(needle) {
            let at = start + rel;
            let window_start = source[..at].rfind("fetch(").unwrap_or(at);
            let window_end = (at + needle.len() + 500).min(source.len());
            let window = &source[window_start..window_end];
            let pinned = window.contains("\"x-region\": \"eu-central-1\"")
                || window.contains("'x-region': 'eu-central-1'")
                || (window.contains("\"x-region\": ACCOUNTS_REGION")
                    && source.contains("const ACCOUNTS_REGION = \"eu-central-1\""));
            if !pinned {
                gaps.push(format!(
                    "{label}: accounts call omits x-region: eu-central-1"
                ));
            }
            start = at + needle.len();
        }
        gaps
    }

    fn without_trailing_tests(source: &str) -> &str {
        // A fixture inside the module also contains `#[cfg(test)] mod tests`.
        // Keep the module whose body runs through the end of the file.
        let mut search = 0;
        while let Some(rel) = source[search..].find("#[cfg(test)]") {
            let idx = search + rel;
            let after = source[idx + "#[cfg(test)]".len()..].trim_start();
            if after.starts_with("mod tests") {
                if let Some(rel_brace) = after.find('{') {
                    let open = source.len() - after.len() + rel_brace;
                    let end = end_of_brace(source.as_bytes(), open);
                    if source[end..].trim().is_empty() {
                        return &source[..idx];
                    }
                }
            }
            search = idx + "#[cfg(test)]".len();
        }
        source
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Scan {
        Code,
        Line,
        Block,
        Str,
        Char,
    }

    fn fn_spans(source: &str) -> Vec<(String, usize, usize)> {
        let bytes = source.as_bytes();
        let mut i = 0;
        let mut mode = Scan::Code;
        let mut spans = Vec::new();
        while i < bytes.len() {
            if mode == Scan::Code {
                if let Some(end) = raw_end(bytes, i) {
                    i = end;
                    continue;
                }
                if fn_keyword(bytes, i) {
                    let mut j = i + 2;
                    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    let name_start = j;
                    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_')
                    {
                        j += 1;
                    }
                    let name = source[name_start..j].to_string();
                    if let Some(open) = find_open_brace(bytes, j) {
                        let close = end_of_brace(bytes, open);
                        spans.push((name, open, close));
                        i = close;
                        mode = Scan::Code;
                        continue;
                    }
                }
            }
            i = step(bytes, i, &mut mode);
        }
        spans
    }

    fn fn_keyword(bytes: &[u8], i: usize) -> bool {
        if i > 0 {
            let prev = bytes[i - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' {
                return false;
            }
        }
        let rest = &bytes[i..];
        rest.starts_with(b"fn")
            && rest
                .get(2)
                .is_some_and(|next| !next.is_ascii_alphanumeric() && *next != b'_')
    }

    fn find_open_brace(bytes: &[u8], mut i: usize) -> Option<usize> {
        let mut mode = Scan::Code;
        while i < bytes.len() {
            if mode == Scan::Code {
                if let Some(end) = raw_end(bytes, i) {
                    i = end;
                    continue;
                }
                if bytes[i] == b'{' {
                    return Some(i);
                }
            }
            i = step(bytes, i, &mut mode);
        }
        None
    }

    fn end_of_brace(bytes: &[u8], open: usize) -> usize {
        let mut i = open + 1;
        let mut depth = 1i32;
        let mut mode = Scan::Code;
        while i < bytes.len() && depth > 0 {
            if mode == Scan::Code {
                if let Some(end) = raw_end(bytes, i) {
                    i = end;
                    continue;
                }
                if bytes[i] == b'{' {
                    depth += 1;
                    i += 1;
                    continue;
                }
                if bytes[i] == b'}' {
                    depth -= 1;
                    i += 1;
                    continue;
                }
            }
            i = step(bytes, i, &mut mode);
        }
        i
    }

    fn raw_end(bytes: &[u8], i: usize) -> Option<usize> {
        let mut j = i;
        if bytes.get(j) == Some(&b'b') {
            j += 1;
        }
        if bytes.get(j) != Some(&b'r') {
            return None;
        }
        j += 1;
        let mut hashes = 0usize;
        while bytes.get(j) == Some(&b'#') {
            hashes += 1;
            j += 1;
        }
        if bytes.get(j) != Some(&b'"') {
            return None;
        }
        j += 1;
        while j < bytes.len() {
            if bytes[j] == b'"' {
                let tail = &bytes[j + 1..];
                if tail.len() >= hashes && tail[..hashes].iter().all(|byte| *byte == b'#') {
                    return Some(j + 1 + hashes);
                }
            }
            j += 1;
        }
        Some(bytes.len())
    }

    fn step(bytes: &[u8], i: usize, mode: &mut Scan) -> usize {
        if i >= bytes.len() {
            return i;
        }
        match *mode {
            Scan::Line => {
                if bytes[i] == b'\n' {
                    *mode = Scan::Code;
                }
                i + 1
            }
            Scan::Block => {
                if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    *mode = Scan::Code;
                    i + 2
                } else {
                    i + 1
                }
            }
            Scan::Str => {
                if bytes[i] == b'\\' {
                    (i + 2).min(bytes.len())
                } else if bytes[i] == b'"' {
                    *mode = Scan::Code;
                    i + 1
                } else {
                    i + 1
                }
            }
            Scan::Char => {
                if bytes[i] == b'\\' {
                    (i + 2).min(bytes.len())
                } else if bytes[i] == b'\'' {
                    *mode = Scan::Code;
                    i + 1
                } else {
                    i + 1
                }
            }
            Scan::Code => step_code(bytes, i, mode),
        }
    }

    fn step_code(bytes: &[u8], i: usize, mode: &mut Scan) -> usize {
        if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'/') {
            *mode = Scan::Line;
            return i + 2;
        }
        if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
            *mode = Scan::Block;
            return i + 2;
        }
        if bytes[i] == b'"' {
            *mode = Scan::Str;
            return i + 1;
        }
        if bytes[i] == b'\'' {
            return step_tick(bytes, i, mode);
        }
        i + 1
    }

    fn step_tick(bytes: &[u8], i: usize, mode: &mut Scan) -> usize {
        if bytes.get(i + 1) == Some(&b'\\') {
            *mode = Scan::Char;
            return i + 1;
        }
        if bytes.get(i + 2) == Some(&b'\'') {
            return i + 3;
        }
        let mut j = i + 1;
        while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
            j += 1;
        }
        j
    }
}
