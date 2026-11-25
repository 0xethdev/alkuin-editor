//! Auto-updater state machine, native menu wiring, and release-check plumbing.
//!
//! v1 deliberately keeps the entire user-facing surface in the native app menu
//! and native dialogs — no React components.

#[cfg(test)]
use base64::Engine;
#[cfg(test)]
use minisign_verify::{PublicKey, Signature};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind,
};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Pick a window to anchor native dialogs to. Without a parent, `rfd` falls
/// back to `CFUserNotificationDisplayAlert` on macOS, which shows a generic
/// system icon instead of our app icon. Passing any visible window forces the
/// `NSAlert` path, which displays the running app's icon.
fn dialog_parent(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_visible().unwrap_or(false))
        .or_else(|| app.webview_windows().into_values().next())
}

fn with_parent<R: tauri::Runtime>(
    mut builder: MessageDialogBuilder<R>,
    parent: Option<&WebviewWindow<R>>,
) -> MessageDialogBuilder<R> {
    if let Some(parent) = parent {
        builder = builder.parent(parent);
    }
    builder
}

const DAILY_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const DISMISSED_VERSION_FILE: &str = "updater-dismissed-version.json";
const DEFERRED_INSTALL_FILE: &str = "updater-deferred-install.json";
/// ponytail: 15s. A window that never replies counts as a missed save, so Alkuin does not restart.
const SAVE_BEFORE_RESTART_TIMEOUT: Duration = Duration::from_secs(15);

/// Menu and dialog copy. The install-ready body and the save-failure lines also live in `margin-copy.ts`.
pub const CHECK_FOR_UPDATES_LABEL: &str = "Check for Updates…";
const CHECKING_FOR_UPDATES_LINE: &str = "Checking for updates…";
const UP_TO_DATE_LINE: &str = "You're on the latest version of Alkuin ({version}).";
const UPDATE_READY_TITLE: &str = "Alkuin {new} is ready to install.";
const UPDATE_READY_BODY: &str = "You're on {current}. Alkuin will restart to finish.";
const INSTALL_AND_RESTART_LABEL: &str = "Install and Restart";
const NOT_NOW_LABEL: &str = "Not Now";
const CANT_CHECK_UPDATES_LINE: &str = "Can't check for updates right now. Try again later.";
const DOWNLOAD_FAILED_LINE: &str =
    "The update didn't finish downloading. Nothing changed. Try again later.";
const SIGNATURE_REFUSED_LINE: &str =
    "Alkuin couldn't verify this update, so it didn't install it. You're still on {current}.";
const SAVE_FAILED_ONE_LINE: &str = "Alkuin couldn't save {document}, so it didn't restart. The update will install the next time you open Alkuin.";
const SAVE_FAILED_SOME_LINE: &str = "Alkuin couldn't save some of your documents, so it didn't restart. The update will install the next time you open Alkuin.";

/// The public update feed. Swap this string and the same endpoint in
/// `tauri.conf.json` together. `cargo test` fails if they differ. Do not point it at
/// `https://github.com/joelbqz/writer-computer/releases/latest/download/latest.json`.
const UPDATE_FEED_URL: &str = "https://updates.alkuin.app/latest.json";

/// Minisign public key, base64 of the public key box.
/// Key id `2640ADD87A870767`. The matching private key is never committed.
/// The app reads this key from `tauri.conf.json`. Tests compare the two.
#[cfg(test)]
const UPDATE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI2NDBBREQ4N0E4NzA3NjcKUldSbkI0ZDYySzFBSnFLTEZQY0JBYTJCemFlZmY2MHBETjdMYUZ6dWtIVk1PL2p4SDNOMUJQZVgK";

#[cfg(test)]
const UPSTREAM_UPDATER: &str = "joelbqz/writer-computer";

/// Checks stay off while the feed host is `example.invalid`. A real https
/// domain turns the Check for Updates item on.
pub const UPDATES_ENABLED: bool = updates_enabled_for(UPDATE_FEED_URL);

const fn starts_with(hay: &str, prefix: &str) -> bool {
    let hay = hay.as_bytes();
    let prefix = prefix.as_bytes();
    if hay.len() < prefix.len() {
        return false;
    }
    let mut i = 0;
    while i < prefix.len() {
        if hay[i] != prefix[i] {
            return false;
        }
        i += 1;
    }
    true
}

const fn contains_bytes(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return false;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        let mut j = 0;
        while j < needle.len() && hay[i + j] == needle[j] {
            j += 1;
        }
        if j == needle.len() {
            return true;
        }
        i += 1;
    }
    false
}

const fn updates_enabled_for(feed: &str) -> bool {
    starts_with(feed, "https://")
        && !contains_bytes(feed.as_bytes(), b"example.invalid")
        && !contains_bytes(feed.as_bytes(), b"writer-computer")
        && !contains_bytes(feed.as_bytes(), b"joelbqz")
}

/// Download URL for one archive, next to `latest.json` on the feed host.
#[cfg(test)]
fn artifact_url(feed: &str, archive_name: &str) -> String {
    match feed.rsplit_once('/') {
        Some((base, _)) => format!("{base}/{archive_name}"),
        None => format!("{feed}/{archive_name}"),
    }
}

/// A background check may ask. It does not install. Install runs only after
/// the person chooses it.
fn install_after_agreement(user_agreed: bool) -> bool {
    user_agreed
}

/// What to do after every open document has been asked to save.
enum RestartDecision {
    Install,
    /// Stay open. `line` is the dialog body.
    Defer {
        line: String,
    },
}

/// Empty `failed` and no missed window: install. One document: name it.
/// Anything else, including a window that never replied: the some-documents line.
/// Never install when a save failed.
fn decide_restart(failed: &[String], missed: bool) -> RestartDecision {
    if failed.is_empty() && !missed {
        return RestartDecision::Install;
    }
    if failed.len() == 1 && !missed {
        return RestartDecision::Defer {
            line: SAVE_FAILED_ONE_LINE.replace("{document}", &failed[0]),
        };
    }
    RestartDecision::Defer {
        line: SAVE_FAILED_SOME_LINE.to_string(),
    }
}

fn fill_version(template: &str, version: &str) -> String {
    template.replace("{version}", version)
}

fn fill_current(template: &str, current: &str) -> String {
    template.replace("{current}", current)
}

fn fill_new(template: &str, new_version: &str) -> String {
    template.replace("{new}", new_version)
}

fn is_signature_refusal(err: &str) -> bool {
    let err = err.to_ascii_lowercase();
    err.contains("signature") || err.contains("tampered") || err.contains("unsigned")
}

/// Check failures. A bad signature, a tampered manifest, or an unsigned
/// update uses the verify line. Other check failures use the can't-check line.
fn message_for_check_error(err: &str, current: &str) -> String {
    if is_signature_refusal(err) {
        fill_current(SIGNATURE_REFUSED_LINE, current)
    } else {
        CANT_CHECK_UPDATES_LINE.to_string()
    }
}

fn message_for_install_error(err: &str, current: &str) -> String {
    if is_signature_refusal(err) {
        fill_current(SIGNATURE_REFUSED_LINE, current)
    } else {
        DOWNLOAD_FAILED_LINE.to_string()
    }
}

/// The agreed update installs on the next launch when the feed still offers it.
fn next_launch_should_install(deferred: Option<&str>, found: &str) -> bool {
    deferred == Some(found)
}

/// What started a check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckTrigger {
    /// The check a couple of seconds after launch.
    Launch,
    /// The once-a-day check while the app stays open.
    Daily,
    /// Check for Updates… in the menu.
    Manual,
}

/// What to do with an update the feed offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FoundAction {
    /// The person agreed earlier and a save failed; this is the next launch
    /// the deferral dialog promised. Save and install without asking again.
    InstallDeferred,
    /// Agreed earlier, but this is not a launch. The dialog said "the next
    /// time you open Alkuin", so keep it for then and do not restart now.
    HoldDeferred,
    /// The person already said Not Now to this version. Automatic checks stay
    /// quiet about it.
    Quiet,
    /// Ask.
    Prompt,
}

fn on_update_found(
    trigger: CheckTrigger,
    deferred: Option<&str>,
    dismissed: Option<&str>,
    found: &str,
) -> FoundAction {
    let agreed = next_launch_should_install(deferred, found);
    match trigger {
        CheckTrigger::Manual => FoundAction::Prompt,
        CheckTrigger::Launch if agreed => FoundAction::InstallDeferred,
        CheckTrigger::Daily if agreed => FoundAction::HoldDeferred,
        _ if dismissed == Some(found) => FoundAction::Quiet,
        _ => FoundAction::Prompt,
    }
}

/// How the install prompt was closed, after checking it is still current.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptOutcome {
    /// Install and Restart on the current prompt: the updater is now saving.
    Install,
    /// Not Now on the current prompt: the updater is idle again, and the
    /// version is dismissed.
    Dismissed,
    /// The updater has moved on (it is downloading, or another prompt
    /// replaced this one). Nothing changes.
    Stale,
}

fn read_version_file(path: &Path) -> Option<String> {
    let data = std::fs::read_to_string(path).ok()?;
    let parsed: DismissedVersionFile = serde_json::from_str(&data).ok()?;
    parsed.dismissed
}

fn write_version_file(path: &Path, version: Option<&str>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = DismissedVersionFile {
        dismissed: version.map(|s| s.to_string()),
    };
    if let Ok(json) = serde_json::to_string(&file) {
        let _ = std::fs::write(path, json);
    }
}

/// Accept a `latest.json` whose platform signature is a minisign signature
/// over `archive`. This is the check `tauri-plugin-updater` runs before install:
/// the public key and the signature are base64 of the minisign boxes.
///
/// A signature that does not match the archive is a bad signature. A trusted
/// comment that names a different version than the manifest is a tampered
/// manifest. An empty signature is an unsigned update.
#[cfg(test)]
fn accept_signed_manifest(
    manifest_json: &str,
    archive: &[u8],
    pubkey_b64: &str,
    platform: &str,
) -> Result<(), &'static str> {
    let manifest: LatestManifest =
        serde_json::from_str(manifest_json).map_err(|_| "bad manifest")?;
    let Some(entry) = manifest.platforms.get(platform) else {
        return Err("missing platform");
    };
    if entry.url.contains(UPSTREAM_UPDATER) {
        return Err("upstream updater");
    }
    if entry.signature.trim().is_empty() {
        return Err("unsigned update");
    }
    let pubkey_text = decode_b64(pubkey_b64).map_err(|_| "bad public key")?;
    let signature_text = decode_b64(entry.signature.trim()).map_err(|_| "bad signature")?;
    let public_key = PublicKey::decode(&pubkey_text).map_err(|_| "bad public key")?;
    let signature = Signature::decode(&signature_text).map_err(|_| "bad signature")?;
    if public_key.verify(archive, &signature, true).is_err() {
        return Err("bad signature");
    }
    if let Some(signed) = signed_version(signature.trusted_comment()) {
        if !versions_match(signed, &manifest.version) {
            return Err("tampered manifest");
        }
    }
    Ok(())
}

#[cfg(test)]
#[derive(serde::Deserialize)]
struct LatestPlatform {
    signature: String,
    url: String,
}

#[cfg(test)]
#[derive(serde::Deserialize)]
struct LatestManifest {
    version: String,
    platforms: std::collections::BTreeMap<String, LatestPlatform>,
}

#[cfg(test)]
fn decode_b64(value: &str) -> Result<String, ()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| ())?;
    String::from_utf8(bytes).map_err(|_| ())
}

#[cfg(test)]
fn signed_version(trusted_comment: &str) -> Option<&str> {
    trusted_comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
}

#[cfg(test)]
fn versions_match(signed: &str, announced: &str) -> bool {
    fn norm(value: &str) -> &str {
        value.trim().strip_prefix('v').unwrap_or(value.trim())
    }
    norm(signed) == norm(announced)
}

/// Custom labels in the app submenu, in menu order. The menu builder inserts
/// "Check for Updates…" only when this list contains it.
fn app_submenu_custom_labels(updates_enabled: bool) -> &'static [&'static str] {
    if updates_enabled {
        &[
            "About Alkuin",
            CHECK_FOR_UPDATES_LABEL,
            "Settings…",
            "Hide Alkuin",
            "Quit Alkuin",
        ]
    } else {
        &["About Alkuin", "Settings…", "Hide Alkuin", "Quit Alkuin"]
    }
}

pub fn app_menu_includes_update_check(updates_enabled: bool) -> bool {
    app_submenu_custom_labels(updates_enabled).contains(&CHECK_FOR_UPDATES_LABEL)
}

/// State machine for the updater lifecycle. One owner: `UpdaterManager`'s
/// transition methods. Check for Updates… is disabled in every busy state.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
enum UpdaterState {
    Idle,
    Checking,
    UpToDate,
    /// Found and kept, not being asked about: a deferred install waiting for
    /// the next launch, or one whose save failed.
    Available {
        version: String,
    },
    /// The install prompt for `version` is open.
    Prompting {
        version: String,
    },
    /// Install and Restart was chosen; every window is saving first.
    Saving {
        version: String,
    },
    Downloading,
    ReadyToInstall {
        version: String,
    },
    Error {
        message: String,
    },
}

impl UpdaterState {
    /// A check, a prompt, a save round or an install is in progress. No new
    /// check may start, so no second prompt can open on top of this one.
    fn is_busy(&self) -> bool {
        matches!(
            self,
            Self::Checking
                | Self::Prompting { .. }
                | Self::Saving { .. }
                | Self::Downloading
                | Self::ReadyToInstall { .. }
        )
    }
}

/// Menu item handles the state machine rebuilds on each transition.
/// `None` while updates are off, so the item is not in the menu.
pub struct UpdaterMenuItems {
    pub check: Option<MenuItem<Wry>>,
}

/// Application-managed state that owns the updater lifecycle.
struct SaveRound {
    id: u64,
    left: HashSet<String>,
    failed: Vec<String>,
    missed: bool,
}

pub struct UpdaterManager {
    state: Mutex<UpdaterState>,
    menu_items: UpdaterMenuItems,
    pending_update: Mutex<Option<Update>>,
    dismissed_version_path: PathBuf,
    deferred_install_path: PathBuf,
    save_round: Mutex<Option<SaveRound>>,
    next_save_id: AtomicU64,
}

#[derive(Serialize, Deserialize)]
struct DismissedVersionFile {
    dismissed: Option<String>,
}

impl UpdaterManager {
    pub fn new(menu_items: UpdaterMenuItems, app_data_dir: PathBuf) -> Self {
        let dismissed_version_path = app_data_dir.join(DISMISSED_VERSION_FILE);
        let deferred_install_path = app_data_dir.join(DEFERRED_INSTALL_FILE);
        let manager = Self {
            state: Mutex::new(UpdaterState::Idle),
            menu_items,
            pending_update: Mutex::new(None),
            dismissed_version_path,
            deferred_install_path,
            save_round: Mutex::new(None),
            next_save_id: AtomicU64::new(1),
        };
        manager.refresh_menu(&UpdaterState::Idle);
        manager
    }

    fn set_state(&self, new: UpdaterState) {
        self.refresh_menu(&new);
        *self.state.lock() = new;
    }

    /// Atomically transition from a non-busy state to `Checking`. Returns
    /// `false` if the updater was already checking, prompting, saving or
    /// installing, so callers can bail without racing another task.
    fn try_begin_check(&self) -> bool {
        {
            let mut state = self.state.lock();
            if state.is_busy() {
                return false;
            }
            *state = UpdaterState::Checking;
        }
        self.refresh_menu(&UpdaterState::Checking);
        true
    }

    /// Close the install prompt for `version`. Only the prompt that is still
    /// current can move the updater: a Not Now that arrives while an install
    /// is already under way must not set Idle or dismiss the version being
    /// installed.
    fn finish_prompt(&self, version: &str, accepted: bool) -> PromptOutcome {
        let next = {
            let mut state = self.state.lock();
            if !matches!(&*state, UpdaterState::Prompting { version: open } if open == version) {
                return PromptOutcome::Stale;
            }
            let next = if install_after_agreement(accepted) {
                UpdaterState::Saving {
                    version: version.to_string(),
                }
            } else {
                UpdaterState::Idle
            };
            *state = next.clone();
            next
        };
        self.refresh_menu(&next);
        if accepted {
            PromptOutcome::Install
        } else {
            PromptOutcome::Dismissed
        }
    }

    fn refresh_menu(&self, state: &UpdaterState) {
        let Some(check) = &self.menu_items.check else {
            return;
        };
        let (check_text, check_enabled) = match state {
            UpdaterState::Checking => (CHECKING_FOR_UPDATES_LINE.to_string(), false),
            UpdaterState::Downloading => ("Downloading Update…".to_string(), false),
            busy if busy.is_busy() => (CHECK_FOR_UPDATES_LABEL.to_string(), false),
            _ => (CHECK_FOR_UPDATES_LABEL.to_string(), true),
        };

        let _ = check.set_text(check_text);
        let _ = check.set_enabled(check_enabled);
    }

    fn read_dismissed_version(&self) -> Option<String> {
        read_version_file(&self.dismissed_version_path)
    }

    fn write_dismissed_version(&self, version: Option<&str>) {
        write_version_file(&self.dismissed_version_path, version);
    }

    fn read_deferred_version(&self) -> Option<String> {
        read_version_file(&self.deferred_install_path)
    }

    fn write_deferred_version(&self, version: Option<&str>) {
        write_version_file(&self.deferred_install_path, version);
    }
}

fn manager(app: &AppHandle) -> tauri::State<'_, UpdaterManager> {
    app.state::<UpdaterManager>()
}

/// Trigger a check for updates. A manual check surfaces "up to date" and error
/// dialogs; automatic checks stay quiet when there's nothing to do. Only the
/// launch check may install an update the person deferred to the next launch.
pub fn start_check(app: AppHandle, trigger: CheckTrigger) {
    let manual = trigger == CheckTrigger::Manual;
    if !UPDATES_ENABLED {
        if manual {
            let parent = dialog_parent(&app);
            with_parent(
                app.dialog()
                    .message("This build does not check for updates.")
                    .kind(MessageDialogKind::Info)
                    .title("Alkuin"),
                parent.as_ref(),
            )
            .show(|_| {});
        }
        return;
    }

    if manager(&app).save_round.lock().is_some() {
        return;
    }

    if !manager(&app).try_begin_check() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let check_result = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(err) => Err(err),
        };

        match check_result {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let action = {
                    let mgr = manager(&app);
                    on_update_found(
                        trigger,
                        mgr.read_deferred_version().as_deref(),
                        mgr.read_dismissed_version().as_deref(),
                        &version,
                    )
                };
                let mgr = manager(&app);
                match action {
                    FoundAction::Quiet => mgr.set_state(UpdaterState::UpToDate),
                    FoundAction::HoldDeferred => {
                        *mgr.pending_update.lock() = Some(update);
                        mgr.set_state(UpdaterState::Available { version });
                    }
                    FoundAction::InstallDeferred => {
                        *mgr.pending_update.lock() = Some(update);
                        mgr.set_state(UpdaterState::Saving { version });
                        begin_save_before_restart(app.clone());
                    }
                    FoundAction::Prompt => {
                        *mgr.pending_update.lock() = Some(update);
                        mgr.set_state(UpdaterState::Prompting {
                            version: version.clone(),
                        });
                        prompt_install(app.clone(), version);
                    }
                }
            }
            Ok(None) => {
                manager(&app).write_deferred_version(None);
                manager(&app).set_state(UpdaterState::UpToDate);
                if manual {
                    let current = app.package_info().version.to_string();
                    let parent = dialog_parent(&app);
                    with_parent(
                        app.dialog()
                            .message(fill_version(UP_TO_DATE_LINE, &current))
                            .kind(MessageDialogKind::Info)
                            .title("Alkuin"),
                        parent.as_ref(),
                    )
                    .show(|_| {});
                }
            }
            Err(err) => {
                let message = err.to_string();
                manager(&app).set_state(UpdaterState::Error {
                    message: message.clone(),
                });
                if manual {
                    let current = app.package_info().version.to_string();
                    let parent = dialog_parent(&app);
                    with_parent(
                        app.dialog()
                            .message(message_for_check_error(&message, &current))
                            .kind(MessageDialogKind::Error)
                            .title("Alkuin"),
                        parent.as_ref(),
                    )
                    .show(|_| {});
                }
            }
        }
    });
}

fn prompt_install(app: AppHandle, version: String) {
    let current = app.package_info().version.to_string();
    let body = fill_current(UPDATE_READY_BODY, &current);
    let title = fill_new(UPDATE_READY_TITLE, &version);

    let version_for_dismiss = version.clone();
    let app_for_cb = app.clone();
    let parent = dialog_parent(&app);

    with_parent(
        app.dialog()
            .message(body)
            .kind(MessageDialogKind::Info)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                INSTALL_AND_RESTART_LABEL.to_string(),
                NOT_NOW_LABEL.to_string(),
            )),
        parent.as_ref(),
    )
    .show(move |accepted| {
        let outcome = manager(&app_for_cb).finish_prompt(&version_for_dismiss, accepted);
        match outcome {
            PromptOutcome::Install => start_install(app_for_cb),
            PromptOutcome::Dismissed => {
                let mgr = manager(&app_for_cb);
                mgr.write_dismissed_version(Some(&version_for_dismiss));
                mgr.write_deferred_version(None);
            }
            PromptOutcome::Stale => {}
        }
    });
}

/// Install and Restart saves every open document first. Download and relaunch
/// run only after every window reports that those saves landed.
fn start_install(app: AppHandle) {
    if !UPDATES_ENABLED || manager(&app).pending_update.lock().is_none() {
        // Nothing to install after all; do not leave the menu disabled.
        manager(&app).set_state(UpdaterState::Idle);
        return;
    }
    begin_save_before_restart(app);
}

fn begin_save_before_restart(app: AppHandle) {
    if manager(&app).save_round.lock().is_some() {
        return;
    }

    let labels: HashSet<String> = app.webview_windows().keys().cloned().collect();
    if labels.is_empty() {
        download_and_restart(app);
        return;
    }

    let id = manager(&app).next_save_id.fetch_add(1, Ordering::Relaxed);
    *manager(&app).save_round.lock() = Some(SaveRound {
        id,
        left: labels.clone(),
        failed: Vec::new(),
        missed: false,
    });

    for label in &labels {
        let _ = app.emit_to(label, "updater:save-before-restart", ());
    }

    let timeout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_BEFORE_RESTART_TIMEOUT).await;
        finish_save_round(&timeout_app, id, true);
    });
}

/// One window finished saving. `missed` means that window could not tell
/// which documents failed, so the restart waits.
#[tauri::command]
pub fn report_update_saves(
    app: AppHandle,
    window: WebviewWindow,
    failed: Vec<String>,
    missed: bool,
) {
    let id = {
        let mgr = manager(&app);
        let mut round = mgr.save_round.lock();
        let Some(round) = round.as_mut() else {
            return;
        };
        if !round.left.remove(window.label()) {
            return;
        }
        round.failed.extend(failed);
        round.missed |= missed;
        if !round.left.is_empty() {
            return;
        }
        round.id
    };
    finish_save_round(&app, id, false);
}

fn finish_save_round(app: &AppHandle, id: u64, timed_out: bool) {
    let outcome = {
        let mgr = manager(app);
        let mut round = mgr.save_round.lock();
        let Some(current) = round.as_ref() else {
            return;
        };
        if current.id != id {
            return;
        }
        let missed = current.missed || (timed_out && !current.left.is_empty());
        let failed = current.failed.clone();
        *round = None;
        decide_restart(&failed, missed)
    };

    match outcome {
        RestartDecision::Install => download_and_restart(app.clone()),
        RestartDecision::Defer { line } => defer_until_next_launch(app, &line),
    }
}

fn defer_until_next_launch(app: &AppHandle, line: &str) {
    let version = manager(app)
        .pending_update
        .lock()
        .as_ref()
        .map(|update| update.version.clone());
    manager(app).write_deferred_version(version.as_deref());
    if let Some(version) = version {
        manager(app).set_state(UpdaterState::Available { version });
    } else {
        manager(app).set_state(UpdaterState::Idle);
    }
    let parent = dialog_parent(app);
    with_parent(
        app.dialog()
            .message(line)
            .kind(MessageDialogKind::Info)
            .title("Alkuin"),
        parent.as_ref(),
    )
    .show(|_| {});
}

fn download_and_restart(app: AppHandle) {
    let pending = manager(&app).pending_update.lock().take();
    let Some(update) = pending else {
        manager(&app).set_state(UpdaterState::Idle);
        return;
    };

    manager(&app).set_state(UpdaterState::Downloading);

    tauri::async_runtime::spawn(async move {
        let version = update.version.clone();
        let result = update
            .download_and_install(|_chunk, _total| {}, || {})
            .await;

        match result {
            Ok(_) => {
                manager(&app).set_state(UpdaterState::ReadyToInstall {
                    version: version.clone(),
                });
                manager(&app).write_dismissed_version(None);
                manager(&app).write_deferred_version(None);
                app.restart();
            }
            Err(err) => {
                let message = err.to_string();
                manager(&app).set_state(UpdaterState::Error {
                    message: message.clone(),
                });
                let current = app.package_info().version.to_string();
                let parent = dialog_parent(&app);
                with_parent(
                    app.dialog()
                        .message(message_for_install_error(&message, &current))
                        .kind(MessageDialogKind::Error)
                        .title("Alkuin"),
                    parent.as_ref(),
                )
                .show(|_| {});
            }
        }
    });
}

/// Spawn the background task that runs a check once per day while the app is
/// open. The initial at-launch check is triggered separately from `setup`.
pub fn spawn_daily_check(app: AppHandle) {
    if !UPDATES_ENABLED {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(DAILY_CHECK_INTERVAL);
        // The first tick fires immediately — skip it because `setup` already
        // schedules the launch check.
        interval.tick().await;
        loop {
            interval.tick().await;
            start_check(app.clone(), CheckTrigger::Daily);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        accept_signed_manifest, app_menu_includes_update_check, app_submenu_custom_labels,
        artifact_url, decide_restart, install_after_agreement, message_for_check_error,
        message_for_install_error, next_launch_should_install, on_update_found, read_version_file,
        updates_enabled_for, write_version_file, CheckTrigger, FoundAction, PromptOutcome,
        RestartDecision, UpdaterManager, UpdaterMenuItems, UpdaterState, CANT_CHECK_UPDATES_LINE,
        SAVE_FAILED_ONE_LINE, SAVE_FAILED_SOME_LINE, SIGNATURE_REFUSED_LINE, UPDATES_ENABLED,
        UPDATE_FEED_URL, UPDATE_PUBKEY,
    };

    fn manager_in(dir: &std::path::Path) -> UpdaterManager {
        UpdaterManager::new(UpdaterMenuItems { check: None }, dir.to_path_buf())
    }

    fn state_of(manager: &UpdaterManager) -> UpdaterState {
        manager.state.lock().clone()
    }

    #[test]
    fn the_daily_check_keeps_a_deferred_install_for_the_next_launch() {
        // The save-failed dialog says the update installs "the next
        // time you open Alkuin". The daily check used to install it mid-session.
        let deferred = Some("0.9.0");
        assert_eq!(
            on_update_found(CheckTrigger::Daily, deferred, None, "0.9.0"),
            FoundAction::HoldDeferred
        );
        assert_eq!(
            on_update_found(CheckTrigger::Launch, deferred, None, "0.9.0"),
            FoundAction::InstallDeferred
        );
        assert_eq!(
            on_update_found(CheckTrigger::Manual, deferred, None, "0.9.0"),
            FoundAction::Prompt
        );
        // A newer version than the deferred one is a fresh question.
        assert_eq!(
            on_update_found(CheckTrigger::Daily, deferred, None, "0.9.1"),
            FoundAction::Prompt
        );
        // Not Now stays quiet for automatic checks only.
        let dismissed = Some("0.9.1");
        assert_eq!(
            on_update_found(CheckTrigger::Daily, None, dismissed, "0.9.1"),
            FoundAction::Quiet
        );
        assert_eq!(
            on_update_found(CheckTrigger::Launch, None, dismissed, "0.9.1"),
            FoundAction::Quiet
        );
        assert_eq!(
            on_update_found(CheckTrigger::Manual, None, dismissed, "0.9.1"),
            FoundAction::Prompt
        );
    }

    #[test]
    fn no_check_starts_while_a_prompt_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager_in(dir.path());
        assert!(manager.try_begin_check());
        manager.set_state(UpdaterState::Prompting {
            version: "0.9.0".into(),
        });
        assert!(!manager.try_begin_check());
        manager.set_state(UpdaterState::Saving {
            version: "0.9.0".into(),
        });
        assert!(!manager.try_begin_check());
        manager.set_state(UpdaterState::Available {
            version: "0.9.0".into(),
        });
        assert!(manager.try_begin_check());
    }

    #[test]
    fn a_stale_not_now_cannot_undo_an_install_in_progress() {
        // Not Now on a second prompt used to set Idle during the
        // download and dismiss the version being installed.
        let dir = tempfile::tempdir().unwrap();
        let manager = manager_in(dir.path());
        manager.set_state(UpdaterState::Prompting {
            version: "0.9.0".into(),
        });
        assert_eq!(manager.finish_prompt("0.9.0", true), PromptOutcome::Install);
        assert_eq!(
            state_of(&manager),
            UpdaterState::Saving {
                version: "0.9.0".into()
            }
        );

        manager.set_state(UpdaterState::Downloading);
        assert_eq!(manager.finish_prompt("0.9.0", false), PromptOutcome::Stale);
        assert_eq!(state_of(&manager), UpdaterState::Downloading);

        manager.set_state(UpdaterState::Prompting {
            version: "0.9.1".into(),
        });
        assert_eq!(manager.finish_prompt("0.9.0", false), PromptOutcome::Stale);
        assert_eq!(
            manager.finish_prompt("0.9.1", false),
            PromptOutcome::Dismissed
        );
        assert_eq!(state_of(&manager), UpdaterState::Idle);
    }
    use base64::Engine;
    use minisign_verify::PublicKey;
    use std::io::Cursor;

    /// Minisign prints the 8-byte key id little-endian. The comment line and
    /// the key body must name the same id.
    fn minisign_key_id(pubkey_b64: &str) -> String {
        let text = super::decode_b64(pubkey_b64).expect("pubkey");
        PublicKey::decode(&text).expect("minisign public key");
        let mut lines = text.lines();
        let comment = lines.next().expect("comment");
        let body = lines.next().expect("body");
        let raw = base64::engine::general_purpose::STANDARD
            .decode(body.trim())
            .expect("key body");
        assert!(
            raw.len() >= 10 && raw.starts_with(b"Ed"),
            "minisign public key"
        );
        let id: String = raw[2..10]
            .iter()
            .rev()
            .map(|b| format!("{b:02X}"))
            .collect();
        assert!(
            comment.contains(&format!("minisign public key: {id}")),
            "{comment}"
        );
        id
    }

    #[test]
    fn updater_pubkey_is_key_2640add87a870767() {
        assert_eq!(minisign_key_id(UPDATE_PUBKEY), "2640ADD87A870767");
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains(UPDATE_PUBKEY));
        assert!(!conf.contains("REPLACE_WITH_UPDATER_PUBKEY"));
    }

    #[test]
    fn the_public_feed_shows_check_for_updates() {
        assert_eq!(UPDATE_FEED_URL, "https://updates.alkuin.app/latest.json");
        assert!(!UPDATE_FEED_URL.to_ascii_lowercase().contains("redline"));
        assert!(!UPDATE_FEED_URL.contains("writer-computer"));
        assert!(!UPDATE_FEED_URL.contains("joelbqz"));
        assert!(!UPDATE_FEED_URL.contains("example.invalid"));
        assert!(UPDATES_ENABLED);
        assert!(updates_enabled_for(UPDATE_FEED_URL));
        assert!(!updates_enabled_for(
            "https://updates.example.invalid/redline/latest.json"
        ));
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains(UPDATE_FEED_URL));
        assert!(conf.contains(UPDATE_PUBKEY));
        assert!(!conf.contains("example.invalid"));
        assert!(!conf.contains("joelbqz/writer-computer"));
        let labels = app_submenu_custom_labels(UPDATES_ENABLED);
        assert!(
            labels.contains(&"Check for Updates…"),
            "built menu labels: {labels:?}"
        );
        assert!(!app_menu_includes_update_check(updates_enabled_for(
            "https://updates.example.invalid/redline/latest.json"
        )));
        assert!(!updates_enabled_for(
            "https://github.com/joelbqz/writer-computer/releases/latest/download/latest.json"
        ));
    }

    #[test]
    fn artifact_url_stays_on_the_feed_host() {
        assert_eq!(
            artifact_url(UPDATE_FEED_URL, "Alkuin.app.tar.gz"),
            "https://updates.alkuin.app/Alkuin.app.tar.gz"
        );
    }

    #[test]
    fn update_installs_only_after_agreement() {
        assert!(!install_after_agreement(false));
        assert!(install_after_agreement(true));
    }

    fn sign_archive(archive: &[u8], version: &str) -> (String, String) {
        let minisign::KeyPair { pk, sk } =
            minisign::KeyPair::generate_unencrypted_keypair().expect("dummy keypair");
        let pubkey_b64 =
            base64::engine::general_purpose::STANDARD.encode(pk.to_box().unwrap().to_string());
        let comment = format!("timestamp:1\tfile:Alkuin.app.tar.gz\tversion:{version}");
        let signature =
            minisign::sign(None, &sk, Cursor::new(archive), Some(&comment), None).expect("sign");
        let signature_b64 =
            base64::engine::general_purpose::STANDARD.encode(signature.into_string());
        (pubkey_b64, signature_b64)
    }

    fn manifest(version: &str, signature: &str, url: &str) -> String {
        serde_json::json!({
            "version": version,
            "notes": "test",
            "pub_date": "2026-10-09T00:00:00Z",
            "platforms": {
                "darwin-aarch64": {
                    "signature": signature,
                    "url": url
                }
            }
        })
        .to_string()
    }

    #[test]
    fn signed_manifest_is_accepted() {
        let archive = b"redline-update-archive";
        let (pubkey, signature) = sign_archive(archive, "0.1.1");
        let url = artifact_url(UPDATE_FEED_URL, "Alkuin.app.tar.gz");
        let body = manifest("0.1.1", &signature, &url);
        assert_eq!(
            accept_signed_manifest(&body, archive, &pubkey, "darwin-aarch64"),
            Ok(())
        );
    }

    #[test]
    fn bad_signature_is_refused() {
        let archive = b"redline-update-archive";
        let (pubkey, _) = sign_archive(archive, "0.1.1");
        let (_, other_signature) = sign_archive(b"someone-elses-archive", "0.1.1");
        let url = artifact_url(UPDATE_FEED_URL, "Alkuin.app.tar.gz");
        let body = manifest("0.1.1", &other_signature, &url);
        assert_eq!(
            accept_signed_manifest(&body, archive, &pubkey, "darwin-aarch64"),
            Err("bad signature")
        );
    }

    #[test]
    fn tampered_manifest_is_refused() {
        let archive = b"redline-update-archive";
        let (pubkey, signature) = sign_archive(archive, "0.1.1");
        let url = artifact_url(UPDATE_FEED_URL, "Alkuin.app.tar.gz");
        let body = manifest("9.9.9", &signature, &url);
        let err = accept_signed_manifest(&body, archive, &pubkey, "darwin-aarch64")
            .expect_err("tampered");
        assert_eq!(err, "tampered manifest");
        let shown = message_for_check_error(err, "0.6.1");
        assert_eq!(
            shown,
            "Alkuin couldn't verify this update, so it didn't install it. You're still on 0.6.1."
        );
        assert_ne!(shown, CANT_CHECK_UPDATES_LINE);
        assert_eq!(shown, SIGNATURE_REFUSED_LINE.replace("{current}", "0.6.1"));
        let flipped = {
            let mut bytes = archive.to_vec();
            bytes[0] ^= 0xff;
            bytes
        };
        let intact = manifest("0.1.1", &signature, &url);
        assert_eq!(
            accept_signed_manifest(&intact, &flipped, &pubkey, "darwin-aarch64"),
            Err("bad signature")
        );
    }

    #[test]
    fn unsigned_update_is_refused() {
        let archive = b"redline-update-archive";
        let (pubkey, _) = sign_archive(archive, "0.1.1");
        let url = artifact_url(UPDATE_FEED_URL, "Alkuin.app.tar.gz");
        let body = manifest("0.1.1", "", &url);
        assert_eq!(
            accept_signed_manifest(&body, archive, &pubkey, "darwin-aarch64"),
            Err("unsigned update")
        );
        let upstream = manifest(
            "0.1.1",
            "aaaa",
            "https://github.com/joelbqz/writer-computer/releases/download/v0.1.1/Alkuin.app.tar.gz",
        );
        assert_eq!(
            accept_signed_manifest(&upstream, archive, &pubkey, "darwin-aarch64"),
            Err("upstream updater")
        );
    }

    #[test]
    fn save_failure_does_not_restart_and_uses_both_lines() {
        let one = decide_restart(&["Essay".to_string()], false);
        match one {
            RestartDecision::Defer { line } => {
                assert_eq!(line, SAVE_FAILED_ONE_LINE.replace("{document}", "Essay"));
                assert_eq!(
                    line,
                    "Alkuin couldn't save Essay, so it didn't restart. The update will install the next time you open Alkuin."
                );
            }
            RestartDecision::Install => panic!("a failed save must not restart"),
        }

        let many = decide_restart(&["Essay".to_string(), "Notes".to_string()], false);
        match many {
            RestartDecision::Defer { line } => {
                assert_eq!(line, SAVE_FAILED_SOME_LINE);
                assert_eq!(
                    line,
                    "Alkuin couldn't save some of your documents, so it didn't restart. The update will install the next time you open Alkuin."
                );
            }
            RestartDecision::Install => panic!("a failed save must not restart"),
        }

        assert!(matches!(
            decide_restart(&[], true),
            RestartDecision::Defer { .. }
        ));
        assert!(matches!(
            decide_restart(&[], false),
            RestartDecision::Install
        ));
        assert!(!next_launch_should_install(None, "0.1.1"));
        assert!(next_launch_should_install(Some("0.1.1"), "0.1.1"));
        assert_eq!(
            message_for_install_error("Invalid signature", "0.6.1"),
            SIGNATURE_REFUSED_LINE.replace("{current}", "0.6.1")
        );
        assert_eq!(
            message_for_install_error("connection reset", "0.6.1"),
            "The update didn't finish downloading. Nothing changed. Try again later."
        );
        assert_eq!(
            message_for_check_error("offline", "0.6.1"),
            CANT_CHECK_UPDATES_LINE
        );

        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("updater-deferred-install.json");
        write_version_file(&path, Some("0.1.1"));
        assert_eq!(read_version_file(&path).as_deref(), Some("0.1.1"));
        write_version_file(&path, None);
        assert_eq!(read_version_file(&path), None);
    }
}
