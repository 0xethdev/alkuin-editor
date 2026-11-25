//! Save every open document before Alkuin quits.
//!
//! Quit Alkuin in the app menu (Cmd+Q on macOS) is a custom item that calls
//! [`request_quit`]. Every open window is asked to flush its pending saves
//! (`app:save-before-quit` with `{ round }`), and each answers through
//! `report_quit_saves`. When every window has answered with no failure the app
//! exits. A failure, or a window that does not answer within
//! [`QUIT_SAVE_TIMEOUT`], does not quit silently: the person is asked whether
//! to quit anyway.
//!
//! `RunEvent::ExitRequested` with no code starts the same round as a fallback.
//! In practice it only arrives after the last window closed, and that window's
//! own close guard (`use-save-before-close.ts`) already saved it, so no window
//! is left to ask and the exit proceeds. An exit Alkuin requests itself
//! (`app.exit`, `app.restart`) carries a code and goes straight through, which
//! is how the confirmed exit avoids coming back here.
//!
//! Not covered: Quit in the macOS Dock menu, logout and shutdown send
//! `terminate:` straight to AppKit, which ends the app without
//! `ExitRequested`. Catching those would need an `applicationShouldTerminate:`
//! hook on the app delegate.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, ExitRequestApi, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// How long a quit waits for every window to report its saves.
pub const QUIT_SAVE_TIMEOUT: Duration = Duration::from_secs(12);

/// The app menu's Quit item. A custom item, not `PredefinedMenuItem::quit`,
/// so the quit goes through [`request_quit`]. Label and accelerator match the
/// predefined item: Cmd+Q on macOS, no accelerator elsewhere.
pub const QUIT_MENU_ID: &str = "app.quit";
pub const QUIT_MENU_LABEL: &str = "Quit Alkuin";
#[cfg(target_os = "macos")]
pub const QUIT_ACCELERATOR: Option<&str> = Some("CmdOrCtrl+Q");
#[cfg(not(target_os = "macos"))]
pub const QUIT_ACCELERATOR: Option<&str> = None;

const SAVE_BEFORE_QUIT_EVENT: &str = "app:save-before-quit";
const QUIT_UNSAVED_TITLE: &str = "Quit without saving?";
const QUIT_UNSAVED_BODY: &str =
    "Alkuin couldn't save some of your documents. If you quit now, changes since the last save are lost.";
const QUIT_ANYWAY_LABEL: &str = "Quit Anyway";
const DONT_QUIT_LABEL: &str = "Don't Quit";

#[derive(Debug, Clone, Serialize)]
pub struct QuitRound {
    pub round: u64,
}

/// Where a quit is.
#[derive(Debug, Clone, PartialEq, Eq)]
enum QuitPhase {
    /// No quit in progress.
    Running,
    /// Every window in `left` was asked to save and has not answered yet.
    Saving {
        round: u64,
        left: HashSet<String>,
        failed: bool,
    },
    /// A save failed or timed out, and the person is being asked.
    Asking,
    /// The exit is confirmed. The next exit request goes through.
    Exiting,
}

/// What an exit request should do.
#[derive(Debug, PartialEq, Eq)]
enum QuitStart {
    /// Let the exit happen now.
    Proceed,
    /// Hold the exit and announce `round` to every window.
    Ask(u64),
    /// Hold the exit; a round or a question is already open.
    Hold,
}

/// How a round ended.
#[derive(Debug, PartialEq, Eq)]
enum RoundEnd {
    /// Every window saved. Exit.
    Saved,
    /// A window failed or did not answer. Ask before exiting.
    Unsaved,
}

/// The quit lifecycle. Its only owner is this module; `lib.rs` feeds it the
/// run events and the window-destroyed events.
#[derive(Debug)]
pub struct QuitSaves {
    phase: Mutex<QuitPhase>,
    next_round: AtomicU64,
}

impl Default for QuitSaves {
    fn default() -> Self {
        Self {
            phase: Mutex::new(QuitPhase::Running),
            next_round: AtomicU64::new(1),
        }
    }
}

impl QuitSaves {
    fn begin(&self, windows: HashSet<String>) -> QuitStart {
        let mut phase = self.phase.lock();
        match &*phase {
            QuitPhase::Exiting => QuitStart::Proceed,
            QuitPhase::Saving { .. } | QuitPhase::Asking => QuitStart::Hold,
            QuitPhase::Running if windows.is_empty() => {
                // Nothing left that could hold unsaved text (the last window
                // already closed through its own close path).
                *phase = QuitPhase::Exiting;
                QuitStart::Proceed
            }
            QuitPhase::Running => {
                let round = self.next_round.fetch_add(1, Ordering::Relaxed);
                *phase = QuitPhase::Saving {
                    round,
                    left: windows,
                    failed: false,
                };
                QuitStart::Ask(round)
            }
        }
    }

    /// One window answered, or went away (`failed` false: a destroyed window
    /// ran its own close path). Returns how the round ended once it has.
    fn report(&self, round: u64, label: &str, failed: bool) -> Option<RoundEnd> {
        let mut phase = self.phase.lock();
        let QuitPhase::Saving {
            round: current,
            left,
            failed: any_failed,
        } = &mut *phase
        else {
            return None;
        };
        if *current != round || !left.remove(label) {
            return None;
        }
        *any_failed |= failed;
        if !left.is_empty() {
            return None;
        }
        let end = if *any_failed {
            *phase = QuitPhase::Asking;
            RoundEnd::Unsaved
        } else {
            *phase = QuitPhase::Exiting;
            RoundEnd::Saved
        };
        Some(end)
    }

    fn window_gone(&self, label: &str) -> Option<RoundEnd> {
        let round = match &*self.phase.lock() {
            QuitPhase::Saving { round, .. } => *round,
            _ => return None,
        };
        self.report(round, label, false)
    }

    /// The timeout for `round` fired. Windows that never answered count as
    /// failed.
    fn time_out(&self, round: u64) -> Option<RoundEnd> {
        let mut phase = self.phase.lock();
        if !matches!(&*phase, QuitPhase::Saving { round: current, .. } if *current == round) {
            return None;
        }
        *phase = QuitPhase::Asking;
        Some(RoundEnd::Unsaved)
    }

    fn answer(&self, quit: bool) -> bool {
        let mut phase = self.phase.lock();
        if *phase != QuitPhase::Asking {
            return false;
        }
        *phase = if quit {
            QuitPhase::Exiting
        } else {
            QuitPhase::Running
        };
        quit
    }
}

/// Quit Alkuin… in the app menu (Cmd+Q on macOS). This is the path that runs:
/// the predefined Quit item went straight to `terminate:` on macOS and
/// `PostQuitMessage` on Windows, which never raise `ExitRequested` while a
/// window is still open. Saves first, then exits.
pub fn request_quit(app: &AppHandle) {
    if start_round(app) == QuitStart::Proceed {
        app.exit(0);
    }
}

/// Called from the run loop for every `RunEvent::ExitRequested`. A fallback:
/// a quit the person asked for only arrives here with windows open on paths
/// that do not go through [`request_quit`]. After the last window closed (its
/// own close guard saved it) there is no window left, and the exit proceeds.
pub fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &ExitRequestApi) {
    if code.is_some() {
        // Requested by Alkuin itself: the confirmed quit, or the updater's
        // restart, which saves before it gets here.
        return;
    }
    if start_round(app) != QuitStart::Proceed {
        api.prevent_exit();
    }
}

/// Ask every open window to save, unless a round is already running.
fn start_round(app: &AppHandle) -> QuitStart {
    let windows: HashSet<String> = app.webview_windows().keys().cloned().collect();
    let start = app.state::<QuitSaves>().begin(windows.clone());
    if let QuitStart::Ask(round) = start {
        for label in &windows {
            let _ = app.emit_to(label, SAVE_BEFORE_QUIT_EVENT, QuitRound { round });
        }
        let timeout_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(QUIT_SAVE_TIMEOUT).await;
            let end = timeout_app.state::<QuitSaves>().time_out(round);
            finish(&timeout_app, end);
        });
    }
    start
}

/// Called when a window is destroyed, so a round does not wait for it.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    let end = app.state::<QuitSaves>().window_gone(label);
    finish(app, end);
}

/// One window finished flushing its saves for `round`.
#[tauri::command]
pub fn report_quit_saves(app: AppHandle, webview: tauri::Webview, round: u64, failed: bool) {
    if failed {
        eprintln!(
            "quit: window {} could not save every document",
            webview.label()
        );
    }
    let end = app
        .state::<QuitSaves>()
        .report(round, webview.label(), failed);
    finish(&app, end);
}

fn finish(app: &AppHandle, end: Option<RoundEnd>) {
    match end {
        None => {}
        Some(RoundEnd::Saved) => app.exit(0),
        Some(RoundEnd::Unsaved) => ask_to_quit_anyway(app),
    }
}

/// A save failed or a window did not answer. Never quit silently: the text is
/// still in memory, so the default is to stay open.
fn ask_to_quit_anyway(app: &AppHandle) {
    let parent = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_visible().unwrap_or(false));
    let mut dialog = app
        .dialog()
        .message(QUIT_UNSAVED_BODY)
        .title(QUIT_UNSAVED_TITLE)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            QUIT_ANYWAY_LABEL.to_string(),
            DONT_QUIT_LABEL.to_string(),
        ));
    if let Some(parent) = parent.as_ref() {
        dialog = dialog.parent(parent);
    }
    let app = app.clone();
    dialog.show(move |quit| {
        if app.state::<QuitSaves>().answer(quit) {
            app.exit(0);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|label| label.to_string()).collect()
    }

    #[test]
    fn a_quit_waits_for_every_window_then_exits_once() {
        let quit = QuitSaves::default();
        let QuitStart::Ask(round) = quit.begin(windows(&["main", "w-1"])) else {
            panic!("a quit with open windows asks them to save");
        };
        // A second Cmd+Q while saving neither exits nor starts a new round.
        assert_eq!(quit.begin(windows(&["main", "w-1"])), QuitStart::Hold);
        assert_eq!(quit.report(round, "main", false), None);
        assert_eq!(quit.report(round + 1, "w-1", false), None, "a stale round");
        assert_eq!(quit.report(round, "main", false), None, "a repeated answer");
        assert_eq!(quit.report(round, "w-1", false), Some(RoundEnd::Saved));
        // The confirmed `app.exit` comes back as an exit request: let it go.
        assert_eq!(quit.begin(windows(&["main"])), QuitStart::Proceed);
        assert_eq!(quit.time_out(round), None);
    }

    #[test]
    fn a_failed_save_asks_and_only_an_answer_moves_on() {
        let quit = QuitSaves::default();
        let QuitStart::Ask(round) = quit.begin(windows(&["main"])) else {
            panic!("expected a round");
        };
        assert_eq!(quit.report(round, "main", true), Some(RoundEnd::Unsaved));
        assert_eq!(quit.begin(windows(&["main"])), QuitStart::Hold);
        assert!(!quit.answer(false), "Don't Quit keeps the app open");
        // Quitting again starts a fresh round.
        let QuitStart::Ask(next) = quit.begin(windows(&["main"])) else {
            panic!("expected a new round");
        };
        assert!(next > round);
        assert_eq!(quit.time_out(next), Some(RoundEnd::Unsaved));
        assert!(quit.answer(true));
        assert_eq!(quit.begin(windows(&["main"])), QuitStart::Proceed);
    }

    #[test]
    fn a_window_that_closes_mid_round_is_not_waited_for() {
        let quit = QuitSaves::default();
        let QuitStart::Ask(round) = quit.begin(windows(&["main", "w-1"])) else {
            panic!("expected a round");
        };
        assert_eq!(quit.report(round, "main", false), None);
        assert_eq!(quit.window_gone("w-1"), Some(RoundEnd::Saved));
    }

    #[test]
    fn with_no_window_left_the_quit_goes_through() {
        let quit = QuitSaves::default();
        assert_eq!(quit.begin(HashSet::new()), QuitStart::Proceed);
        assert_eq!(quit.window_gone("main"), None);
    }
}
