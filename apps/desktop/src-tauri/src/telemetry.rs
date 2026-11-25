//! Opt-in usage telemetry.
//!
//! The entire network surface of Writer's analytics lives in this file. Nothing
//! here runs until the user explicitly enables telemetry from the first-run
//! consent dialog or Preferences — `track` bails on an atomic load before it
//! allocates anything.
//!
//! See `docs/telemetry.md` for the user-facing disclosure. If the event list
//! or the property set changes, that file changes in the same commit.
//!
//! Three things gate a request, and all three must pass:
//!
//!   1. `WRITER_POSTHOG_KEY` was set at *build* time. An unconfigured build —
//!      which is what anyone cloning this repo gets — cannot phone home at all.
//!   2. `WRITER_TELEMETRY_DISABLED` is not set in the environment.
//!   3. This install's [`Consent`] allows it. Consent is one value stored in
//!      `telemetry.json`: `unasked`, `declined`, `email-only` or `usage`. The
//!      first-run dialog sets it once, through `telemetry_answer`, which writes
//!      the answer and the matching `telemetry.enabled`/`telemetry.email`
//!      settings under the settings lock before anything is sent. Usage events
//!      need `usage`. While consent is `unasked` the two settings are inert, so
//!      a `config` copied from another machine sends nothing. After the answer
//!      they are the Preferences switches, and consent follows them.
//!
//! One event is deliberately exempt from the usage switch. `email_updated`
//! carries an address, which is a subscription the user hands over on its own
//! terms, so it travels — and can be withdrawn — whether or not usage events
//! are switched on. It still needs (1), (2) and an answered prompt that gave
//! an address. Declining the prompt sends nothing.

use crate::config::{ConfigValue, Settings};
use crate::error::AppError;
use crate::state::AppState;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::Manager;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// Compiled-in project token. Absent in development and in any build that does
/// not pass `WRITER_POSTHOG_KEY`, which makes telemetry structurally inert
/// rather than merely switched off.
const POSTHOG_KEY: Option<&str> = option_env!("WRITER_POSTHOG_KEY");

/// Ingestion host. Overridable at build time so self-hosted forks do not have
/// to patch code.
const POSTHOG_HOST: &str = match option_env!("WRITER_POSTHOG_HOST") {
    Some(host) => host,
    None => "https://us.i.posthog.com",
};

/// Runtime kill switch for packagers and for users of third-party builds.
const DISABLE_ENV_VAR: &str = "WRITER_TELEMETRY_DISABLED";

const ENABLED_SETTING_KEY: &str = "telemetry.enabled";
const EMAIL_SETTING_KEY: &str = "telemetry.email";

/// The one event that travels on an email change alone. Handing over an
/// address — or taking it back — is its own consent, separate from the usage
/// switch, so this event is the only one that ignores `enabled`.
const EMAIL_UPDATED_EVENT: &str = "email_updated";

const APP_OPENED_EVENT: &str = "app_opened";

const IDENTITY_FILE: &str = "telemetry.json";

/// Shown when Subscribe arrives without a usable address. The dialog checks
/// first; this is the backstop.
const EMAIL_REQUIRED_LINE: &str = "Enter an email address to subscribe.";
const ALREADY_ANSWERED_LINE: &str = "This question was already answered.";

/// This install's answer to the first-run prompt. The only input to the usage
/// switch besides the build key and the kill switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Consent {
    /// The prompt has not been answered. Nothing is sent.
    Unasked,
    /// No email, no usage data. Nothing is sent.
    Declined,
    /// Release news only: the address, no usage events.
    EmailOnly,
    /// Usage events, with the address when there is one.
    Usage,
}

impl Consent {
    fn answered(self) -> bool {
        self != Self::Unasked
    }

    fn sends_usage(self) -> bool {
        self == Self::Usage
    }

    /// The answer the two Preferences settings describe.
    fn from_settings(enabled: bool, has_email: bool) -> Self {
        match (enabled, has_email) {
            (true, _) => Self::Usage,
            (false, true) => Self::EmailOnly,
            (false, false) => Self::Declined,
        }
    }

    /// After the prompt, the Preferences switches are the answer, so consent
    /// follows them. Before it they are inert: a copied `config` that says
    /// `telemetry.enabled = true` must not stand in for this install's answer.
    fn follow_settings(self, enabled: bool, has_email: bool) -> Self {
        if self.answered() {
            Self::from_settings(enabled, has_email)
        } else {
            self
        }
    }

    /// `telemetry.json` written before consent was stored had only `prompted`.
    /// Read it the way the old switch did: unanswered stays unanswered, and an
    /// answered prompt means whatever the settings say.
    fn migrate(prompted: bool, enabled: bool, has_email: bool) -> Self {
        if prompted {
            Self::from_settings(enabled, has_email)
        } else {
            Self::Unasked
        }
    }
}

/// The three answers the first-run dialog can give.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Answer {
    Declined,
    EmailOnly,
    Usage,
}

/// Everything one answer writes and sends, decided before anything happens.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AnswerPlan {
    consent: Consent,
    /// `telemetry.enabled` and `telemetry.email` as Preferences will show them.
    enabled_setting: bool,
    email_setting: String,
    email: Option<String>,
}

/// Decide what `answer` means. Only an unanswered prompt can be answered, and
/// Subscribe needs an address. "Not now" clears any address, including one a
/// copied `config` or an earlier, half-finished Subscribe left behind.
fn plan_answer(
    current: Consent,
    answer: Answer,
    email: Option<String>,
) -> Result<AnswerPlan, &'static str> {
    if current.answered() {
        return Err(ALREADY_ANSWERED_LINE);
    }
    if answer == Answer::Declined {
        return Ok(AnswerPlan {
            consent: Consent::Declined,
            enabled_setting: false,
            email_setting: String::new(),
            email: None,
        });
    }
    let email = normalize_email(email)
        .filter(|email| email.contains('@'))
        .ok_or(EMAIL_REQUIRED_LINE)?;
    let usage = answer == Answer::Usage;
    Ok(AnswerPlan {
        consent: if usage {
            Consent::Usage
        } else {
            Consent::EmailOnly
        },
        enabled_setting: usage,
        email_setting: email.clone(),
        email: Some(email),
    })
}

/// Per-install identity, stored outside the settings file on purpose.
///
/// `config` is human-editable and is the kind of file people copy between
/// machines; a `distinct_id` living there would silently collapse two installs
/// into one "active user". Consent sits beside it because it is this install's
/// answer rather than a preference that should travel with a copied file.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Identity {
    distinct_id: String,
    /// The pre-consent record of an answered prompt. Still written, as
    /// `consent != unasked`, so an older build reads the same answer.
    #[serde(default)]
    prompted: bool,
    /// Absent in files written before it existed; see [`Consent::migrate`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    consent: Option<Consent>,
}

impl Identity {
    fn new() -> Self {
        Self {
            distinct_id: uuid::Uuid::new_v4().to_string(),
            prompted: false,
            consent: Some(Consent::Unasked),
        }
    }

    fn with_consent(&self, consent: Consent) -> Self {
        Self {
            distinct_id: self.distinct_id.clone(),
            prompted: consent.answered(),
            consent: Some(consent),
        }
    }

    /// This install's consent at launch: the stored value (or the migrated
    /// legacy one), brought in line with the settings once answered.
    fn launch_consent(&self, enabled: bool, has_email: bool) -> Consent {
        self.consent
            .unwrap_or_else(|| Consent::migrate(self.prompted, enabled, has_email))
            .follow_settings(enabled, has_email)
    }
}

fn identity_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(IDENTITY_FILE)
}

/// Read the identity file, generating and persisting a fresh one when it is
/// missing or unreadable. A corrupt file is replaced rather than treated as an
/// error: losing continuity of one install's ID is not worth failing startup.
/// The replacement is logged, because a file that fails to parse on every
/// launch would mint a new "user" each time. A replaced file also resets
/// consent to `unasked`, so the prompt is shown again and nothing is sent.
fn load_or_create_identity(app_data_dir: &Path) -> Identity {
    let path = identity_path(app_data_dir);
    match std::fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<Identity>(&contents) {
            Ok(identity) => return identity,
            Err(error) => eprintln!("telemetry: identity file unreadable, replacing it: {error}"),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!("telemetry: identity file unreadable, replacing it: {error}"),
    }
    let identity = Identity::new();
    if let Err(error) = write_identity(app_data_dir, &identity) {
        eprintln!("telemetry: failed to write identity: {error}");
    }
    identity
}

/// Write via a temp file and rename so a crash mid-write cannot leave a
/// half-written file that the next launch would replace with a new ID.
fn write_identity(app_data_dir: &Path, identity: &Identity) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("failed to create app data dir: {error}"))?;
    let json = serde_json::to_string_pretty(identity)
        .map_err(|error| format!("failed to serialize identity: {error}"))?;
    let path = identity_path(app_data_dir);
    let temp_path = path.with_extension("json.tmp");
    let written =
        std::fs::write(&temp_path, json).and_then(|()| std::fs::rename(&temp_path, &path));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error.to_string());
    }
    Ok(())
}

/// One queued event. Only the name and the exemption vary — see
/// `Telemetry::properties` for the fixed property set every event carries.
struct QueuedEvent {
    name: &'static str,
    /// Send this even with the usage switch off. True only for
    /// `EMAIL_UPDATED_EVENT`; see `retain_sendable`.
    ignores_switch: bool,
}

pub struct Telemetry {
    app_data_dir: PathBuf,
    distinct_id: String,
    /// The answer. Changed only by `commit_answer` and `apply_settings`, both
    /// of which run under the global settings lock.
    consent: Mutex<Consent>,
    /// `consent.sends_usage()`, kept as an atomic for the hot path in `track`.
    enabled: AtomicBool,
    /// Whether this process has already reported `app_opened`. Consent can
    /// arrive after startup, so the event has two possible emit points and
    /// this keeps it to one per launch.
    session_opened_reported: AtomicBool,
    email: Mutex<Option<String>>,
    app_version: &'static str,
    sender: UnboundedSender<QueuedEvent>,
}

static TELEMETRY: OnceLock<Telemetry> = OnceLock::new();

fn instance() -> Option<&'static Telemetry> {
    TELEMETRY.get()
}

/// True when this build can talk to PostHog at all. Checked once, at init: if
/// it is false the client is never constructed, so there is nothing left to
/// re-check on the hot path. The env kill switch is therefore read at startup
/// — setting it takes effect on the next launch, not mid-session.
fn transport_available() -> bool {
    let kill_switch_set = std::env::var_os(DISABLE_ENV_VAR).is_some_and(|value| !value.is_empty());
    POSTHOG_KEY.is_some_and(|key| !key.is_empty()) && !kill_switch_set
}

/// Wire up the process-wide client. Safe to call once; later calls are ignored.
///
/// Reads the initial enabled/email values out of the already-initialized main
/// window settings layer so a returning user's choice applies from launch.
pub fn init(app: &tauri::AppHandle, enabled: bool, email: Option<String>) {
    if TELEMETRY.get().is_some() {
        return;
    }

    // A build with no key, or a run with the kill switch set, never leaves the
    // client uninitialized-but-present: it skips init entirely, so no identity
    // is minted and nothing is written to disk. `instance()` then returns None
    // and every entry point below is a no-op. "Inert" means inert.
    if !transport_available() {
        return;
    }

    let Ok(app_data_dir) = app.path().app_data_dir() else {
        eprintln!("telemetry: no app data dir; telemetry disabled for this session");
        return;
    };

    let (sender, receiver) = unbounded_channel();
    let telemetry = Telemetry::load(app_data_dir, enabled, email, sender);

    if TELEMETRY.set(telemetry).is_err() {
        return;
    }

    tauri::async_runtime::spawn(run_dispatcher(receiver));
}

fn normalize_email(email: Option<String>) -> Option<String> {
    email
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Record an event. A no-op — costing one atomic load — whenever telemetry is
/// off, uninitialized (tests, `*_impl` helpers called directly), or built
/// without a key.
pub fn track(name: &'static str) {
    let Some(telemetry) = instance() else { return };
    if !telemetry.enabled.load(Ordering::Relaxed) {
        return;
    }
    telemetry.enqueue(name);
}

/// Report that the app launched, at most once per process.
///
/// Called twice on purpose: once at startup, and again whenever consent is
/// granted. A user who opts in during their first session enabled telemetry
/// *after* startup had already passed, so the startup call was a no-op —
/// without the second call that first session would never be counted, and
/// someone who opts in and never returns would be invisible in this stream.
/// The flag is only set when the event is actually queued, so a disabled
/// startup leaves the door open for the consent-time call.
pub fn report_app_opened() {
    if let Some(telemetry) = instance() {
        telemetry.report_app_opened();
    }
}

/// Apply the current settings to the running client so toggling the preference
/// takes effect without a restart. Called from the global settings write path
/// while it still holds the settings lock, for *every* global write: a write
/// to an unrelated key reloads `config` from disk first, so this is also where
/// a hand-edited `telemetry.enabled` catches up with the client.
pub fn apply_settings(enabled: bool, email: Option<String>) {
    // Reaching here means `init` ran, which already proved the transport is
    // available — no need to re-check it.
    if let Some(telemetry) = instance() {
        telemetry.apply_settings(enabled, email);
    }
}

/// Whether the first-run consent dialog still needs to be shown.
pub fn should_prompt() -> bool {
    instance().is_some_and(|telemetry| !telemetry.consent.lock().answered())
}

impl Telemetry {
    fn load(
        app_data_dir: PathBuf,
        enabled: bool,
        email: Option<String>,
        sender: UnboundedSender<QueuedEvent>,
    ) -> Self {
        let identity = load_or_create_identity(&app_data_dir);
        let email = normalize_email(email);
        let consent = identity.launch_consent(enabled, email.is_some());
        if identity.consent != Some(consent) {
            // Records a migrated legacy answer, or a Preferences change made
            // while the app was closed, so the file says what is in effect.
            if let Err(error) = write_identity(&app_data_dir, &identity.with_consent(consent)) {
                eprintln!("telemetry: failed to record consent: {error}");
            }
        }
        Self {
            app_data_dir,
            distinct_id: identity.distinct_id,
            consent: Mutex::new(consent),
            enabled: AtomicBool::new(consent.sends_usage()),
            session_opened_reported: AtomicBool::new(false),
            email: Mutex::new(email),
            app_version: env!("CARGO_PKG_VERSION"),
            sender,
        }
    }

    fn persist(&self, consent: Consent) -> Result<(), String> {
        write_identity(
            &self.app_data_dir,
            &Identity {
                distinct_id: self.distinct_id.clone(),
                prompted: consent.answered(),
                consent: Some(consent),
            },
        )
    }

    fn report_app_opened(&self) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        if self
            .session_opened_reported
            .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        // Queue directly rather than via `track`: the flag above is now set, so
        // a second enabled check that could drop the event would burn the one
        // `app_opened` this launch gets.
        self.enqueue(APP_OPENED_EVENT);
    }

    fn apply_settings(&self, enabled: bool, email: Option<String>) {
        let next_email = normalize_email(email);
        let mut consent = self.consent.lock();
        let next = consent.follow_settings(enabled, next_email.is_some());
        let email_changed = {
            let mut current = self.email.lock();
            let changed = *current != next_email;
            *current = next_email;
            changed
        };
        // Before the answer nothing is recorded and nothing is sent, whatever
        // the settings say. That is what keeps a copied `config` inert.
        if !consent.answered() {
            return;
        }
        if next != *consent {
            if let Err(error) = self.persist(next) {
                // The settings file already holds the change, and the next
                // launch re-derives consent from it.
                eprintln!("telemetry: failed to record consent: {error}");
            }
            *consent = next;
            self.enabled.store(next.sends_usage(), Ordering::Relaxed);
        }
        drop(consent);
        // Subscribing and unsubscribing both have to reach the person record,
        // and neither depends on the usage switch: someone can ask for release
        // news while sending no usage data at all, and clearing the field has
        // to remove the address even though nothing else is being sent.
        if email_changed {
            self.enqueue_exempt(EMAIL_UPDATED_EVENT);
        }
        // Covers consent granted mid-session; a no-op if this launch already
        // reported, so re-enabling from Preferences does not double count.
        self.report_app_opened();
    }

    /// Record the first-run answer and send what it allows. The caller has
    /// already written the plan's settings; consent is written last, so a
    /// crash before this point leaves the prompt unanswered and nothing sent.
    /// Declining sends nothing at all: not the answer, not `app_opened`.
    fn commit_answer(&self, plan: &AnswerPlan) -> Result<(), AppError> {
        let mut consent = self.consent.lock();
        if consent.answered() {
            return Err(AppError::Message(ALREADY_ANSWERED_LINE.into()));
        }
        self.persist(plan.consent).map_err(AppError::Io)?;
        *self.email.lock() = plan.email.clone();
        *consent = plan.consent;
        self.enabled
            .store(plan.consent.sends_usage(), Ordering::Relaxed);
        drop(consent);
        match plan.consent {
            // Handing over the address is the point of Subscribe, so it is
            // sent even when a copied `config` already held the same one.
            Consent::EmailOnly | Consent::Usage => self.enqueue_exempt(EMAIL_UPDATED_EVENT),
            Consent::Declined | Consent::Unasked => {}
        }
        self.report_app_opened();
        Ok(())
    }
}

/// The complete property set sent with every event. Deliberately fixed: there
/// is no caller-supplied property channel, so no file name, path, or document
/// content can reach PostHog by accident.
///
/// `distinct_id` belongs *inside* `properties` rather than beside `event` —
/// that is where PostHog's batch endpoint reads it from, and getting it wrong
/// fails silently: the request is accepted and the events are discarded.
fn event_properties(
    distinct_id: &str,
    app_version: &str,
    email: Option<&str>,
) -> Map<String, Value> {
    let mut properties = Map::new();
    properties.insert("distinct_id".into(), json!(distinct_id));
    properties.insert("app_version".into(), json!(app_version));
    properties.insert("os".into(), json!(std::env::consts::OS));
    properties.insert("arch".into(), json!(std::env::consts::ARCH));
    // PostHog Cloud derives location from the request IP unless told not to.
    // `docs/telemetry.md` promises no geolocation, so say so on every event
    // rather than trusting a project-level toggle.
    properties.insert("$geoip_disable".into(), json!(true));
    match email {
        // `$set` is PostHog's person-property channel: it attaches the address
        // to the person behind `distinct_id` rather than to this one event.
        Some(email) => {
            properties.insert("$set".into(), json!({ "email": email }));
        }
        // Omitting `$set` would mean "no change", leaving an address sent
        // earlier attached to the person. Clearing the field has to clear it
        // there too, so every anonymous event explicitly unsets it.
        None => {
            properties.insert("$unset".into(), json!(["email"]));
        }
    }
    properties
}

/// Shape one `POST /batch/` body. Pure so the wire format can be asserted in
/// tests without a project key or a network.
fn build_batch_payload(api_key: &str, events: &[&str], properties: &Map<String, Value>) -> Value {
    let batch: Vec<Value> = events
        .iter()
        .map(|name| json!({ "event": name, "properties": properties }))
        .collect();
    json!({ "api_key": api_key, "batch": batch })
}

impl Telemetry {
    /// Hand an event to the dispatcher. Callers check `enabled` first. A send
    /// failure means the dispatcher is gone; dropping the event is the
    /// intended behavior — telemetry never retries and never buffers to disk.
    fn enqueue(&self, name: &'static str) {
        let _ = self.sender.send(QueuedEvent {
            name,
            ignores_switch: false,
        });
    }

    /// Push an event that the usage switch does not govern. Not routed through
    /// `enqueue`, which checks that switch on the caller's behalf.
    fn enqueue_exempt(&self, name: &'static str) {
        let _ = self.sender.send(QueuedEvent {
            name,
            ignores_switch: true,
        });
    }

    fn properties(&self) -> Map<String, Value> {
        event_properties(
            &self.distinct_id,
            self.app_version,
            self.email.lock().as_deref(),
        )
    }
}

/// Drop whatever the usage switch no longer covers.
///
/// Events are only queued while enabled, but a slow request can leave a batch
/// waiting across a toggle-off, and "off" means nothing sent after that point.
/// Email updates survive: they carry a subscription the user asked for
/// separately, and an unsubscribe that the switch swallowed would leave the
/// address attached to the person record forever.
fn retain_sendable(queued: &mut Vec<QueuedEvent>, enabled: bool) {
    if enabled {
        return;
    }
    queued.retain(|event| event.ignores_switch);
}

/// Drain the queue and POST batches to PostHog until the app shuts down.
///
/// `recv_many` collapses a burst — creating several files in a row — into a
/// single request instead of one round trip per event.
async fn run_dispatcher(mut receiver: UnboundedReceiver<QueuedEvent>) {
    let Some(api_key) = POSTHOG_KEY else { return };

    // reqwest is built with `rustls-no-provider` (matching tauri-plugin-updater,
    // which is why this adds no crates to the tree), so the process needs a
    // crypto provider installed before the first TLS handshake. The updater
    // installs the same one lazily; whichever runs first wins and the other
    // call is a no-op.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("telemetry: failed to build http client: {error}");
            return;
        }
    };

    let endpoint = format!("{}/batch/", POSTHOG_HOST.trim_end_matches('/'));
    let mut queued = Vec::new();

    while receiver.recv_many(&mut queued, 64).await > 0 {
        let Some(telemetry) = instance() else { return };

        retain_sendable(&mut queued, telemetry.enabled.load(Ordering::Relaxed));
        if queued.is_empty() {
            continue;
        }

        let events: Vec<&str> = queued.iter().map(|event| event.name).collect();
        let payload = build_batch_payload(api_key, &events, &telemetry.properties());
        queued.clear();

        // Fire-and-forget: a failed send is dropped, never retried. A 4xx/5xx
        // is a failure too — a bad key comes back as 401, not as an error.
        let response = client.post(&endpoint).json(&payload).send().await;
        if let Err(error) = response.and_then(|response| response.error_for_status()) {
            eprintln!("telemetry: capture failed: {error}");
        }
    }
}

// ---------- IPC ----------

/// Read the current telemetry settings out of a window's settings layer.
/// Used at init and by the settings write path.
pub fn settings_snapshot(settings: &crate::config::Settings) -> (bool, Option<String>) {
    let enabled = settings
        .get(ENABLED_SETTING_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let email = settings
        .get(EMAIL_SETTING_KEY)
        .and_then(|value| value.as_str())
        .map(str::to_owned);
    (enabled, email)
}

/// Only the main window prompts. Compact/standalone windows and secondary
/// workspace windows share the same process and the same one-shot consent
/// record, so without this a second window could race the main one to the
/// dialog.
#[tauri::command]
pub fn telemetry_should_prompt(webview: tauri::Webview) -> bool {
    webview.label() == crate::MAIN_WINDOW_LABEL && should_prompt()
}

/// Answer the first-run prompt in one step. The settings Preferences will show
/// and this install's consent change together under the global settings lock,
/// and nothing is sent until both are written. This replaces the dialog's old
/// sequence of separate writes, which could send a usage event for someone
/// who left usage unchecked.
#[tauri::command]
pub fn telemetry_answer(
    choice: Answer,
    email: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let Some(telemetry) = instance() else {
        // An inert build never shows the prompt; there is nothing to record.
        return Ok(());
    };
    let app_state = app.state::<AppState>();
    let state = app_state
        .get(webview.label())
        .ok_or_else(|| AppError::Io("This window is closed".into()))?;
    crate::commands::settings::with_global_settings_locked(app_state.inner(), &state, |settings| {
        answer_with(telemetry, settings, choice, email)
    })
}

/// The body of `telemetry_answer`, run with the global settings lock held.
/// Settings first, consent last: a failure or a crash in between leaves the
/// prompt unanswered, so it is asked again and nothing has been sent.
fn answer_with(
    telemetry: &Telemetry,
    settings: &mut Settings,
    choice: Answer,
    email: Option<String>,
) -> Result<(), AppError> {
    let current = *telemetry.consent.lock();
    let plan =
        plan_answer(current, choice, email).map_err(|line| AppError::Message(line.into()))?;
    settings
        .set_global(
            EMAIL_SETTING_KEY,
            ConfigValue::String(plan.email_setting.clone()),
        )
        .map_err(|error| AppError::Io(error.to_string()))?;
    settings
        .set_global(ENABLED_SETTING_KEY, ConfigValue::Bool(plan.enabled_setting))
        .map_err(|error| AppError::Io(error.to_string()))?;
    telemetry.commit_answer(&plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queued(name: &'static str, ignores_switch: bool) -> QueuedEvent {
        QueuedEvent {
            name,
            ignores_switch,
        }
    }

    #[test]
    fn switching_off_drops_usage_events_still_in_flight() {
        let mut batch = vec![queued("app_opened", false), queued("file_created", false)];
        retain_sendable(&mut batch, false);
        assert!(batch.is_empty());
    }

    #[test]
    fn an_email_update_survives_the_usage_switch() {
        let mut batch = vec![
            queued("file_created", false),
            queued(EMAIL_UPDATED_EVENT, true),
        ];
        retain_sendable(&mut batch, false);
        let names: Vec<&str> = batch.iter().map(|event| event.name).collect();
        assert_eq!(names, vec![EMAIL_UPDATED_EVENT]);
    }

    #[test]
    fn nothing_is_dropped_while_enabled() {
        let mut batch = vec![
            queued("app_opened", false),
            queued(EMAIL_UPDATED_EVENT, true),
        ];
        retain_sendable(&mut batch, true);
        assert_eq!(batch.len(), 2);
    }

    #[test]
    fn identity_is_generated_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_identity(dir.path());
        assert!(!first.distinct_id.is_empty());
        assert!(!first.prompted);

        let second = load_or_create_identity(dir.path());
        assert_eq!(first.distinct_id, second.distinct_id);
    }

    #[test]
    fn corrupt_identity_is_replaced_rather_than_fatal() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(identity_path(dir.path()), "{ not json").unwrap();

        let identity = load_or_create_identity(dir.path());
        assert!(!identity.distinct_id.is_empty());
        assert_eq!(
            load_or_create_identity(dir.path()).distinct_id,
            identity.distinct_id
        );
    }

    #[test]
    fn tracking_without_init_is_a_no_op() {
        // `create_file_impl` and friends call `track` directly, including from
        // unit tests where no app handle exists.
        track("file_created");
        assert!(!should_prompt());
    }

    #[test]
    fn settings_snapshot_defaults_to_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let settings = crate::config::Settings::new(dir.path().to_path_buf()).unwrap();
        let (enabled, email) = settings_snapshot(&settings);
        assert!(!enabled);
        assert_eq!(email.as_deref(), Some(""));
    }

    #[test]
    fn batch_payload_matches_posthogs_wire_format() {
        let properties = event_properties("install-1", "0.5.0", None);
        let payload =
            build_batch_payload("phc_test", &["file_created", "folder_created"], &properties);

        assert_eq!(payload["api_key"], "phc_test");
        let batch = payload["batch"].as_array().unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0]["event"], "file_created");
        assert_eq!(batch[1]["event"], "folder_created");
        // Nested under `properties`, not alongside `event` — see the doc
        // comment on `event_properties` for why this is the failure that hurts.
        assert_eq!(batch[0]["properties"]["distinct_id"], "install-1");
        assert_eq!(batch[0]["properties"]["app_version"], "0.5.0");
    }

    #[test]
    fn properties_carry_no_path_or_content_channel() {
        let properties = event_properties("install-1", "0.5.0", Some("writer@example.com"));
        let mut keys: Vec<&str> = properties.keys().map(String::as_str).collect();
        keys.sort_unstable();

        // The whole privacy guarantee in one assertion: if a key ever shows up
        // here that could hold a path or document text, this fails.
        assert_eq!(
            keys,
            [
                "$geoip_disable",
                "$set",
                "app_version",
                "arch",
                "distinct_id",
                "os"
            ]
        );
        assert_eq!(properties["$set"]["email"], "writer@example.com");
        assert_eq!(properties["$geoip_disable"], true);
    }

    #[test]
    fn omitted_email_unsets_the_person_property() {
        let properties = event_properties("install-1", "0.5.0", None);
        assert!(!properties.contains_key("$set"));
        assert_eq!(properties["$unset"], json!(["email"]));
    }

    #[test]
    fn the_setting_alone_is_not_consent() {
        assert_eq!(
            Consent::Unasked.follow_settings(true, true),
            Consent::Unasked
        );
        assert!(!Consent::Unasked.sends_usage());
        assert_eq!(
            Consent::EmailOnly.follow_settings(true, true),
            Consent::Usage
        );
        assert_eq!(
            Consent::Usage.follow_settings(false, true),
            Consent::EmailOnly
        );
        assert_eq!(
            Consent::EmailOnly.follow_settings(false, false),
            Consent::Declined
        );
        assert!(Consent::Usage.sends_usage());
        assert!(!Consent::EmailOnly.sends_usage());
    }

    /// A client wired to a channel the test can read, over `dir` as app data.
    fn client(dir: &Path, settings: &Settings) -> (Telemetry, UnboundedReceiver<QueuedEvent>) {
        let (enabled, email) = settings_snapshot(settings);
        let (sender, receiver) = unbounded_channel();
        (
            Telemetry::load(dir.to_path_buf(), enabled, email, sender),
            receiver,
        )
    }

    fn sent(receiver: &mut UnboundedReceiver<QueuedEvent>) -> Vec<&'static str> {
        let mut names = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            names.push(event.name);
        }
        names
    }

    fn stored_consent(dir: &Path) -> Option<Consent> {
        load_or_create_identity(dir).consent
    }

    #[test]
    fn subscribe_without_usage_sends_no_usage_event_even_over_a_copied_config() {
        // A config that says `enabled = true` on an unprompted install,
        // then Subscribe with usage unchecked. The old dialog marked the
        // prompt, wrote the email (which applied `enabled = true` and queued
        // `app_opened`), and only then wrote `enabled = false`.
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::new(dir.path().to_path_buf()).unwrap();
        settings
            .set_global(ENABLED_SETTING_KEY, ConfigValue::Bool(true))
            .unwrap();
        let (telemetry, mut receiver) = client(dir.path(), &settings);
        assert!(!telemetry.consent.lock().answered());
        assert!(!telemetry.enabled.load(Ordering::Relaxed));

        // Any global write before the answer is inert.
        let (enabled, email) = settings_snapshot(&settings);
        telemetry.apply_settings(enabled, email);
        assert_eq!(sent(&mut receiver), Vec::<&str>::new());

        answer_with(
            &telemetry,
            &mut settings,
            Answer::EmailOnly,
            Some(" writer@example.com ".into()),
        )
        .unwrap();
        assert_eq!(sent(&mut receiver), vec![EMAIL_UPDATED_EVENT]);
        assert!(!telemetry.enabled.load(Ordering::Relaxed));
        assert_eq!(stored_consent(dir.path()), Some(Consent::EmailOnly));
        assert_eq!(
            settings_snapshot(&settings),
            (false, Some("writer@example.com".into()))
        );

        // The next global write sees settings that agree with the answer.
        let (enabled, email) = settings_snapshot(&settings);
        telemetry.apply_settings(enabled, email);
        assert_eq!(sent(&mut receiver), Vec::<&str>::new());
        assert!(!telemetry.enabled.load(Ordering::Relaxed));
    }

    #[test]
    fn subscribe_with_usage_sends_the_address_and_the_launch() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::new(dir.path().to_path_buf()).unwrap();
        let (telemetry, mut receiver) = client(dir.path(), &settings);
        answer_with(
            &telemetry,
            &mut settings,
            Answer::Usage,
            Some("writer@example.com".into()),
        )
        .unwrap();
        assert_eq!(
            sent(&mut receiver),
            vec![EMAIL_UPDATED_EVENT, APP_OPENED_EVENT]
        );
        assert!(telemetry.enabled.load(Ordering::Relaxed));
        assert!(settings_snapshot(&settings).0);
        assert_eq!(stored_consent(dir.path()), Some(Consent::Usage));
    }

    #[test]
    fn not_now_clears_an_address_left_in_the_settings() {
        // "Not now" after a half-finished Subscribe (or over a copied
        // config) kept the stored email.
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::new(dir.path().to_path_buf()).unwrap();
        settings
            .set_global(
                EMAIL_SETTING_KEY,
                ConfigValue::String("left@example.com".into()),
            )
            .unwrap();
        let (telemetry, mut receiver) = client(dir.path(), &settings);

        // Declining sends nothing: not the answer, not the launch.
        answer_with(&telemetry, &mut settings, Answer::Declined, None).unwrap();
        assert_eq!(sent(&mut receiver), Vec::<&str>::new());
        assert_eq!(settings_snapshot(&settings), (false, Some(String::new())));
        assert_eq!(*telemetry.email.lock(), None);
        assert_eq!(stored_consent(dir.path()), Some(Consent::Declined));

        // Answered once: a second answer is refused and sends nothing.
        assert!(answer_with(&telemetry, &mut settings, Answer::Declined, None).is_err());
        assert_eq!(sent(&mut receiver), Vec::<&str>::new());
    }

    #[test]
    fn subscribe_needs_an_address_and_writes_nothing_without_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::new(dir.path().to_path_buf()).unwrap();
        settings
            .set_global(ENABLED_SETTING_KEY, ConfigValue::Bool(true))
            .unwrap();
        let (telemetry, mut receiver) = client(dir.path(), &settings);
        assert!(answer_with(&telemetry, &mut settings, Answer::Usage, Some("  ".into())).is_err());
        assert!(answer_with(&telemetry, &mut settings, Answer::EmailOnly, None).is_err());
        assert_eq!(sent(&mut receiver), Vec::<&str>::new());
        assert!(!telemetry.consent.lock().answered());
        assert_eq!(stored_consent(dir.path()), Some(Consent::Unasked));
        assert!(settings_snapshot(&settings).0, "settings untouched");
    }

    #[test]
    fn preferences_move_consent_after_the_answer() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::new(dir.path().to_path_buf()).unwrap();
        let (telemetry, mut receiver) = client(dir.path(), &settings);
        answer_with(&telemetry, &mut settings, Answer::Declined, None).unwrap();
        sent(&mut receiver);

        telemetry.apply_settings(true, None);
        assert_eq!(*telemetry.consent.lock(), Consent::Usage);
        assert_eq!(sent(&mut receiver), vec![APP_OPENED_EVENT]);
        assert_eq!(stored_consent(dir.path()), Some(Consent::Usage));

        telemetry.apply_settings(false, None);
        assert_eq!(*telemetry.consent.lock(), Consent::Declined);
        assert!(!telemetry.enabled.load(Ordering::Relaxed));
    }

    #[test]
    fn a_legacy_prompted_record_migrates_from_the_settings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            identity_path(dir.path()),
            r#"{ "distinct_id": "install-1", "prompted": true }"#,
        )
        .unwrap();
        let mut settings = Settings::new(dir.path().to_path_buf()).unwrap();
        settings
            .set_global(
                EMAIL_SETTING_KEY,
                ConfigValue::String("writer@example.com".into()),
            )
            .unwrap();
        let (telemetry, _receiver) = client(dir.path(), &settings);
        assert_eq!(*telemetry.consent.lock(), Consent::EmailOnly);
        assert_eq!(telemetry.distinct_id, "install-1");
        assert_eq!(stored_consent(dir.path()), Some(Consent::EmailOnly));

        let unprompted = tempfile::tempdir().unwrap();
        std::fs::write(
            identity_path(unprompted.path()),
            r#"{ "distinct_id": "install-2", "prompted": false }"#,
        )
        .unwrap();
        let mut copied = Settings::new(unprompted.path().to_path_buf()).unwrap();
        copied
            .set_global(ENABLED_SETTING_KEY, ConfigValue::Bool(true))
            .unwrap();
        let (telemetry, _receiver) = client(unprompted.path(), &copied);
        assert_eq!(*telemetry.consent.lock(), Consent::Unasked);
        assert!(!telemetry.enabled.load(Ordering::Relaxed));
    }

    #[test]
    fn the_answer_is_written_for_older_builds_too() {
        let identity = Identity::new().with_consent(Consent::EmailOnly);
        let json: Value = serde_json::to_value(&identity).unwrap();
        assert_eq!(json["prompted"], true);
        assert_eq!(json["consent"], "email-only");
        assert_eq!(
            serde_json::from_value::<Answer>(json!("email-only")).unwrap(),
            Answer::EmailOnly
        );
    }

    #[test]
    fn identity_write_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        load_or_create_identity(dir.path());
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [IDENTITY_FILE]);
    }

    #[test]
    fn app_opened_is_a_no_op_without_a_client() {
        // The uninitialized case: a keyless build must not panic or mark state.
        report_app_opened();
    }

    #[test]
    fn blank_emails_normalize_to_none() {
        assert_eq!(normalize_email(Some("  ".into())), None);
        assert_eq!(normalize_email(Some("".into())), None);
        assert_eq!(normalize_email(None), None);
        assert_eq!(
            normalize_email(Some("  writer@example.com ".into())).as_deref(),
            Some("writer@example.com")
        );
    }
}
