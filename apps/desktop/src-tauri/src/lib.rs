mod commands;
mod config;
#[cfg(target_os = "macos")]
mod dock_menu;
mod error;
mod fallback_font;
mod identifier_migration;
mod ignore;
mod invite_arrival;
mod mac_only;
#[cfg(test)]
mod mac_only_depart;
#[cfg(target_os = "macos")]
mod macos;
mod menu;
mod office_exchange;
pub mod open_target;
mod pdf_export;
mod quit;
mod share_paths;
mod state;
mod telemetry;
mod tutorial;
#[cfg(desktop)]
mod updater;
mod watcher;
pub mod writer_cli;

use commands::mentions::mention_file_from_link;
use commands::settings::init_window_settings;
use commands::shares::{share_open_link, share_window_target, token_from_invite_link};
use commands::workspace::load_recent_workspaces;
use error::AppError;
use invite_arrival::INVITE_ARRIVAL;
use open_target::resolve_path;
pub use open_target::PendingOpenPayload;
use state::AppState;
use std::path::{Path, PathBuf};
use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{
    DragDropEvent, Emitter, Manager, PhysicalPosition, RunEvent, WebviewWindow, WindowEvent,
};

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

/// Push an open payload into the target window's pending-open queue and emit
/// the notification so the frontend in that window drains it. Events are
/// routed via `emit_to` so a drop onto window A never triggers window B.
fn queue_open_event(app: &tauri::AppHandle, label: &str, payload: PendingOpenPayload) {
    if let Some(state) = app.state::<AppState>().get(label) {
        state.push_pending_open(payload.clone());
    }
    let _ = app.emit_to(label, "open:from-drop", payload);
}

/// Show a window and bring it forward. `set_focus` alone does nothing for a
/// window the user hid with the last Cmd+W, so every "focus the existing
/// window" path goes through here.
fn reveal_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// Wire up per-window event handlers: drag-drop routes to the window's own
/// pending-open queue, a close request on the main window hides it instead
/// of destroying it (destroying the last window would quit the app; hiding
/// keeps its state so a Dock click brings it straight back), and the destroy
/// event tears down the window's `WorkspaceState` (which drops the watcher,
/// stopping FSEvents / inotify subscriptions).
fn attach_window_handlers(app: &tauri::AppHandle, window: &WebviewWindow) {
    let label = window.label().to_string();
    let handle = app.clone();
    #[cfg(target_os = "macos")]
    let this_window = window.clone();
    window.on_window_event(move |event| match event {
        // macOS only: elsewhere there is no Dock to bring a hidden window
        // back, so a close must stay a close.
        #[cfg(target_os = "macos")]
        WindowEvent::CloseRequested { api, .. } if label == MAIN_WINDOW_LABEL => {
            api.prevent_close();
            let _ = this_window.hide();
        }
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
            for path in paths {
                if let Some(payload) = resolve_path(path) {
                    queue_open_event(&handle, &label, payload);
                    break;
                }
            }
        }
        WindowEvent::Destroyed => {
            // Remove the state; the `WorkspaceState`'s `RecommendedWatcher`
            // drops on the last `Arc` release, unregistering FSEvents/inotify.
            handle.state::<AppState>().remove(&label);
            // A quit that is waiting on this window's saves stops waiting.
            quit::on_window_destroyed(&handle, &label);
        }
        _ => {}
    });
}

/// Open a new `WebviewWindow` inside this process for the given workspace.
/// Used by the `open_workspace_in_new_window` IPC and by the
/// single-instance plugin when a second Alkuin launch arrives with a path.
///
/// If any existing window already hosts `workspace_path`, focus it rather
/// than building a duplicate — the spec states each workspace gets at most
/// one window at a time.
pub(crate) fn open_new_workspace_window(
    app: &tauri::AppHandle,
    workspace_path: String,
    file: Option<String>,
) -> Result<(), AppError> {
    let raw_workspace = PathBuf::from(&workspace_path);
    if !raw_workspace.exists() || !raw_workspace.is_dir() {
        return Err(AppError::NotFound(workspace_path));
    }

    // Canonicalize before lookup and pending-open queueing so aliased paths
    // (`/var/foo` vs. `/private/var/foo`, symlinked workspaces) don't spawn
    // duplicate windows and the watcher's canonical workspace_root matches
    // the pending-open record.
    let workspace = raw_workspace
        .canonicalize()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let workspace_str = workspace.to_string_lossy().to_string();

    if let Some(existing_label) = app.state::<AppState>().find_by_workspace(&workspace) {
        if let Some(window) = app.get_webview_window(&existing_label) {
            reveal_window(&window);
            queue_open_event(
                app,
                &existing_label,
                PendingOpenPayload {
                    workspace: Some(workspace_str),
                    file,
                },
            );
            return Ok(());
        }
    }

    let label = format!("w-{}", uuid::Uuid::new_v4().simple());
    let state = app.state::<AppState>().get_or_create(&label);
    init_window_settings(app, &state)?;
    state.set_startup_open(PendingOpenPayload {
        workspace: Some(workspace_str),
        file,
    });

    build_secondary_window(app, label)
}

/// Open a new standalone compact window for a single markdown file — no
/// workspace, no indexing. If a standalone window already hosts this file,
/// focus it instead of duplicating.
pub(crate) fn open_standalone_file_window(
    app: &tauri::AppHandle,
    file_path: String,
) -> Result<(), AppError> {
    let raw = PathBuf::from(&file_path);
    if !raw.is_file() {
        return Err(AppError::NotFound(file_path));
    }

    // Canonicalize so lookup, pending-open dedupe, and the watcher's path
    // equality all agree (`/var` vs. `/private/var` aliasing).
    let file = raw
        .canonicalize()
        .map_err(|e| AppError::Io(e.to_string()))?;

    if let Some(existing_label) = app.state::<AppState>().find_by_standalone_file(&file) {
        if let Some(window) = app.get_webview_window(&existing_label) {
            reveal_window(&window);
            return Ok(());
        }
    }

    let label = format!("w-{}", uuid::Uuid::new_v4().simple());
    let state = app.state::<AppState>().get_or_create(&label);
    init_window_settings(app, &state)?;
    state.set_startup_open(PendingOpenPayload {
        workspace: None,
        file: Some(file.to_string_lossy().to_string()),
    });

    build_secondary_window(app, label)
}

/// Build a secondary `WebviewWindow` whose `WorkspaceState` has already been
/// seeded with a startup-open payload. Shared by workspace and standalone
/// window creation.
fn build_secondary_window(app: &tauri::AppHandle, label: String) -> Result<(), AppError> {
    // Clone the main window's config (titlebar overlay, traffic-light
    // position, transparency, hudWindow vibrancy, `visible: false`) so
    // secondary windows look and animate identically. Rewrite the label,
    // strip `center` so subsequent windows aren't stacked directly on top
    // of the previous one.
    let window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| AppError::Io("no window config in tauri.conf.json".into()));
    let mut window_config = match window_config {
        Ok(c) => c,
        Err(e) => {
            app.state::<AppState>().remove(&label);
            return Err(e);
        }
    };
    window_config.label = label.clone();
    window_config.center = false;

    let window = (|| -> Result<WebviewWindow, AppError> {
        tauri::WebviewWindowBuilder::from_config(app, &window_config)
            .map_err(|e| AppError::Io(e.to_string()))?
            .build()
            .map_err(|e| AppError::Io(e.to_string()))
    })();

    let window = match window {
        Ok(w) => w,
        Err(e) => {
            // Prevent an orphaned `WorkspaceState` from lingering in the
            // registry for a window that never opened (so `Destroyed` never
            // fires). Drops the watcher (none yet) and reclaims memory.
            app.state::<AppState>().remove(&label);
            return Err(e);
        }
    };

    attach_window_handlers(app, &window);
    position_new_window(app, &window);

    Ok(())
}

/// Place a freshly built secondary window at a random on-screen position so
/// multiple open windows don't stack on top of each other — scattering them
/// makes it obvious that more than one window is open. Each window gets a
/// random `(x, y)` inside the target monitor's work area (the screen minus the
/// menu bar / dock), clamped so the whole window stays visible. Runs while the
/// window is still `visible: false`, so there's no visible jump when it's shown.
///
/// Fail-soft: any missing monitor info or platform error leaves the window at
/// its OS-default position — a positioning hiccup must never stop a window from
/// opening.
fn position_new_window(app: &tauri::AppHandle, window: &WebviewWindow) {
    // Prefer the monitor under the cursor (where the user is working), then the
    // window's own monitor, then the primary monitor.
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let Ok(win_size) = window.outer_size() else {
        return;
    };

    let area = monitor.work_area();
    // Span of valid top-left positions that keep the whole window inside the
    // work area. `saturating_sub` guards a window larger than the work area
    // (span collapses to 0 → pinned to the work-area origin).
    let span_x = area.size.width.saturating_sub(win_size.width) as f64;
    let span_y = area.size.height.saturating_sub(win_size.height) as f64;

    // Two random fractions in [0, 1] from a fresh v4 UUID's bytes — `uuid` is
    // already a dependency, so no extra crate just for randomness.
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let frac_x = bytes[0] as f64 / u8::MAX as f64;
    let frac_y = bytes[1] as f64 / u8::MAX as f64;

    let x = area.position.x + (span_x * frac_x).round() as i32;
    let y = area.position.y + (span_y * frac_y).round() as i32;

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Build the native menu bar and wire updater menu events. macOS only needs a
/// menu at all because of the auto-updater; the rest of the items are standard
/// predefined actions so nothing has to be rewired on the frontend.
#[cfg(desktop)]
fn install_app_menu(
    app: &tauri::AppHandle,
    app_data_dir: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    // The label list is what the menu is built from. While updates are off the
    // check item is not created, so it is not in the menu.
    let include_updates = updater::app_menu_includes_update_check(updater::UPDATES_ENABLED);
    let check_item = if include_updates {
        Some(
            MenuItemBuilder::with_id("updater.check", updater::CHECK_FOR_UPDATES_LABEL)
                .build(app)?,
        )
    } else {
        None
    };

    let preferences_item = MenuItemBuilder::with_id("preferences.open", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let account_item = MenuItemBuilder::with_id("account.portal", "Account…").build(app)?;
    // Not `PredefinedMenuItem::quit`: that one exits through AppKit or
    // `PostQuitMessage` without giving the windows a chance to save.
    let quit_item = {
        let builder = MenuItemBuilder::with_id(quit::QUIT_MENU_ID, quit::QUIT_MENU_LABEL);
        match quit::QUIT_ACCELERATOR {
            Some(accelerator) => builder.accelerator(accelerator),
            None => builder,
        }
        .build(app)?
    };

    // `credits` is the macOS About panel; `comments` is the Linux/Windows one.
    let about = PredefinedMenuItem::about(
        app,
        Some("About Alkuin"),
        Some(
            AboutMetadataBuilder::new()
                .name(Some("Alkuin"))
                .version(Some(app.package_info().version.to_string()))
                .comments(Some("Alkuin is built on Writer."))
                .credits(Some("Alkuin is built on Writer."))
                .build(),
        ),
    )?;

    let app_submenu = {
        let b = SubmenuBuilder::new(app, "Alkuin").item(&about).separator();
        let b = if let Some(item) = &check_item {
            b.item(item).separator()
        } else {
            b
        };
        b.item(&preferences_item)
            .item(&account_item)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, Some("Hide Alkuin"))?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&quit_item)
            .build()?
    };

    let import_word = MenuItemBuilder::with_id("file.import-docx", "Import Word…").build(app)?;
    let import_google =
        MenuItemBuilder::with_id("file.import-google-doc", "Import Google Docs…").build(app)?;
    let export_word = MenuItemBuilder::with_id("file.export-docx", "Export Word…").build(app)?;
    let export_google =
        MenuItemBuilder::with_id("file.export-google-doc", "Export Google Docs…").build(app)?;
    let export_pdf = MenuItemBuilder::with_id("file.export-pdf", "Export PDF…").build(app)?;
    let file_submenu = SubmenuBuilder::new(app, "File")
        .item(&import_word)
        .item(&import_google)
        .separator()
        .item(&export_word)
        .item(&export_google)
        .item(&export_pdf)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&window_submenu)
        .build()?;

    app.set_menu(menu)?;
    menu::install();

    let menu_items = updater::UpdaterMenuItems { check: check_item };
    app.manage(updater::UpdaterManager::new(menu_items, app_data_dir));

    app.on_menu_event(|app, event| match event.id().0.as_str() {
        "updater.check" => updater::start_check(app.clone(), updater::CheckTrigger::Manual),
        quit::QUIT_MENU_ID => quit::request_quit(app),
        "preferences.open" => emit_to_focused_window(app, "menu:open-preferences"),
        "account.portal" => emit_to_focused_window(app, "menu:open-account"),
        "file.import-docx" => emit_to_focused_window(app, "menu:import-docx"),
        "file.import-google-doc" => emit_to_focused_window(app, "menu:import-google-doc"),
        "file.export-docx" => emit_to_focused_window(app, "menu:export-docx"),
        "file.export-google-doc" => emit_to_focused_window(app, "menu:export-google-doc"),
        "file.export-pdf" => emit_to_focused_window(app, "menu:export-pdf"),
        _ => {}
    });

    Ok(())
}

/// Send an event to whichever webview window currently has focus, scoped to
/// that window so other windows don't react. The native menu handler runs on
/// the `AppHandle` and isn't tied to a window, so we resolve the target here.
///
/// Fallback order if no window reports focus (focus race, platform error
/// from `is_focused`): the main window if visible, else any visible window.
/// `webview_windows()` returns a `HashMap` whose iteration order is
/// non-deterministic, so the explicit main-window preference matters.
fn emit_to_focused_window(app: &tauri::AppHandle, event: &str) {
    let windows = app.webview_windows();
    let target = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| {
            windows
                .get(MAIN_WINDOW_LABEL)
                .filter(|w| w.is_visible().unwrap_or(false))
        })
        .or_else(|| windows.values().find(|w| w.is_visible().unwrap_or(false)));
    if let Some(window) = target {
        let _ = app.emit_to(window.label(), event, ());
    }
}

/// Handle a second Alkuin launch while one is already running. With
/// `tauri-plugin-single-instance` the OS routes the second process's argv
/// here via the existing process; we translate that into either opening a
/// new window for the argv path or surfacing the existing windows if the
/// user just re-launched the app without an argument.
fn open_arrived_link(app: &tauri::AppHandle, url: String) {
    if let Some(path) = mention_file_from_link(&url) {
        if path.is_file() {
            if let Err(_err) = open_shared_copy(app, path.to_string_lossy().to_string()) {
                eprintln!("failed to open mention link");
            }
            return;
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match share_open_link(app.clone(), url).await {
            Ok(path) => {
                if let Err(err) = open_shared_copy(&app, path) {
                    eprintln!("failed to open invited document: {err:?}");
                }
            }
            Err(err) => {
                eprintln!("failed to open invite link: {err:?}");
                INVITE_ARRIVAL.note(&err);
                show_invite_refusal(&app);
            }
        }
    });
}

/// An invite link was followed and no document opened. The main window comes
/// forward, as it does for an invite that opens, and it alone is told to read
/// the refusal: the sign-in step when nobody is signed in, a line on the desk
/// when this account is not on the list. With the main window gone, the window
/// in front is told. A hidden window is never the one that answers.
fn show_invite_refusal(app: &tauri::AppHandle) {
    const EVENT: &str = "share:invite-refused";
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => {
            reveal_window(&window);
            let _ = app.emit_to(MAIN_WINDOW_LABEL, EVENT, ());
        }
        None => emit_to_focused_window(app, EVENT),
    }
}

/// Open `payload` in a window of its own. For a target that no live window
/// can take (the main window was closed on Linux or Windows, where closing it
/// destroys it).
fn open_in_new_window(app: &tauri::AppHandle, payload: PendingOpenPayload) -> Result<(), AppError> {
    match (payload.workspace, payload.file) {
        (Some(workspace), file) => open_new_workspace_window(app, workspace, file),
        (None, Some(file)) => open_standalone_file_window(app, file),
        (None, None) => Ok(()),
    }
}

/// A share link opens as a tab in the main window's workspace chrome.
/// The copy is not a compact window: that chrome hides the footer and the sidebar.
/// When the main window is gone the copy gets a workspace window of its own,
/// rather than a payload parked in a slot no window will ever read.
fn open_shared_copy(app: &tauri::AppHandle, path: String) -> Result<(), AppError> {
    let main_window = app.get_webview_window(MAIN_WINDOW_LABEL);
    let main = main_window
        .as_ref()
        .and_then(|_| app.state::<AppState>().get(MAIN_WINDOW_LABEL));
    let current = main.as_ref().and_then(|main| {
        main.workspace_root
            .read()
            .as_ref()
            .map(|root| root.to_string_lossy().into_owned())
    });
    let recent = load_recent_workspaces(app)
        .ok()
        .and_then(|rows| rows.into_iter().find(|row| Path::new(row).is_dir()));
    let payload = share_window_target(current.as_deref(), recent.as_deref(), &path);
    let (Some(window), Some(main)) = (main_window, main) else {
        return open_in_new_window(app, payload);
    };
    if let Err(payload) = main.try_set_startup_open(payload) {
        queue_open_event(app, MAIN_WINDOW_LABEL, payload);
    }
    reveal_window(&window);
    Ok(())
}

fn emit_checkout_return(app: &tauri::AppHandle) {
    let _ = app.emit("account:checkout-return", ());
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        reveal_window(&window);
    }
}

fn handle_single_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    let path_arg = argv.into_iter().nth(1);
    if let Some(arg) = path_arg.as_deref() {
        if commands::account::is_checkout_return(arg) {
            emit_checkout_return(app);
            return;
        }
        if token_from_invite_link(arg).is_some() {
            open_arrived_link(app, arg.to_string());
            return;
        }
    }
    match path_arg.and_then(|arg| resolve_path(&PathBuf::from(arg))) {
        Some(payload) => {
            let result = match (&payload.workspace, &payload.file) {
                (Some(workspace), file) => {
                    open_new_workspace_window(app, workspace.clone(), file.clone())
                }
                (None, Some(file)) => open_standalone_file_window(app, file.clone()),
                (None, None) => Ok(()),
            };
            if let Err(err) = result {
                eprintln!("failed to open new window from single-instance argv: {err:?}");
            }
        }
        None => {
            // Re-launch with no path: bring an existing window forward.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                reveal_window(&window);
                return;
            }
            // Fallback: focus any known window.
            if let Some(label) = app.state::<AppState>().labels().first() {
                if let Some(window) = app.get_webview_window(label) {
                    reveal_window(&window);
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            handle_single_instance(app, argv);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    // Embed a W3C WebDriver server when built with `--features e2e` so the
    // local E2E suite can drive the WKWebView via `tauri-webdriver`. Never
    // enabled in release builds shipped to users.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .manage(AppState::new())
        .manage(quit::QuitSaves::default())
        .setup(|app| {
            // Before settings, sessions, or the preference shell are read.
            identifier_migration::migrate_previous_app_data(app.handle());

            // Initialize the main window's per-window state (settings layer,
            // pending-open queue). `get_or_create` lazily builds the
            // `WorkspaceState` for the `"main"` label.
            let main_state = app.state::<AppState>().get_or_create(MAIN_WINDOW_LABEL);
            init_window_settings(app.handle(), &main_state)?;

            // Telemetry reads its enabled/email values out of the settings
            // layer above, so it must come after `init_window_settings` and
            // before anything that can emit an event.
            {
                let (enabled, email) = main_state
                    .settings
                    .read()
                    .as_ref()
                    .map(telemetry::settings_snapshot)
                    .unwrap_or((false, None));
                telemetry::init(app.handle(), enabled, email);
                telemetry::report_app_opened();
            }

            // On macOS, `open -a Alkuin /path` delivers the path via
            // RunEvent::Opened, not argv. On Linux/Windows the path
            // arrives through argv (or the single-instance plugin).
            #[cfg(not(target_os = "macos"))]
            {
                let args: Vec<String> = std::env::args().collect();
                if args.len() > 1 {
                    if token_from_invite_link(&args[1]).is_some() {
                        open_arrived_link(app.handle(), args[1].clone());
                    } else {
                        let path = PathBuf::from(&args[1]);
                        if let Some(payload) = resolve_path(&path) {
                            main_state.set_startup_open(payload);
                        }
                    }
                }
            }

            #[cfg(desktop)]
            {
                let config_dir = app
                    .path()
                    .app_data_dir()
                    .expect("failed to get app data dir");
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                let _ = std::fs::remove_file(config_dir.join("redline-preferences.txt"));
                install_app_menu(app.handle(), config_dir)?;
                #[cfg(target_os = "macos")]
                dock_menu::install(app.handle());

                // No launch check while the feed is still the placeholder. A check
                // only asks; install waits for the person to agree.
                if updater::UPDATES_ENABLED {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        updater::start_check(handle.clone(), updater::CheckTrigger::Launch);
                        updater::spawn_daily_check(handle);
                    });
                }
            }

            // Attach drag-drop + close handlers on the main window.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                attach_window_handlers(app.handle(), &window);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_directory,
            commands::fs::read_recent_files,
            commands::fs::read_file_entries,
            commands::fs::read_file,
            commands::fs::write_file,
            pdf_export::export_pdf,
            office_exchange::docx_to_markdown,
            office_exchange::google_doc_to_markdown,
            office_exchange::export_docx,
            commands::fs::create_file,
            commands::fs::create_directory,
            commands::fs::create_sidebar_entry,
            commands::fs::rename_entry,
            commands::fs::delete_entry,
            commands::fs::delete_entry_report,
            commands::fs::file_exists,
            commands::fs::reveal_in_file_manager,
            commands::git::git_file_status,
            commands::git::git_commit_file,
            commands::git::git_publish_file,
            commands::git::git_enqueue_op,
            commands::git::git_flush_queue,
            commands::git::git_pull,
            mac_only::mac_only_get,
            mac_only::mac_only_set,
            mac_only::mac_only_delete_online,
            commands::history::history_set_stays_on_this_mac,
            commands::history::history_stays_on_this_mac,
            commands::history::history_send,
            commands::history::history_bring,
            commands::history::history_flush,
            commands::history::history_pull,
            commands::history::history_settle,
            commands::history::history_proposal_decide,
            commands::history::history_document_identity,
            commands::history::history_delete_project,
            commands::redline::redline_propose,
            commands::account::account_sign_in_start,
            commands::account::account_sign_in_finish,
            commands::account::account_stored_session,
            commands::account::account_status,
            commands::account::account_delete,
            commands::account::account_preferences,
            commands::account::account_clear_style,
            commands::account::account_forget_style,
            commands::account::account_sign_out,
            commands::account::account_checkout,
            commands::account::account_portal,
            commands::account::account_cancel_preview,
            commands::account::account_refund,
            commands::account::account_usage,
            commands::shares::share_role,
            commands::shares::share_realtime_auth,
            commands::shares::share_invite,
            commands::shares::share_pending,
            commands::shares::share_send,
            commands::shares::share_send_report,
            commands::shares::share_decide,
            commands::shares::share_open_link,
            commands::shares::share_invite_refusal,
            commands::shares::share_desk,
            commands::shares::share_open_accepted,
            commands::shares::share_latest,
            commands::shares::share_publish,
            commands::removal::share_erase_document,
            commands::removal::share_restore_document,
            commands::removal::share_answer,
            commands::removal::share_leave,
            commands::mentions::mention_people,
            commands::mentions::mention_write,
            commands::mentions::mention_open,
            commands::mentions::mention_email_pref,
            commands::mentions::mention_document_ids,
            commands::redline::redline_learn,
            commands::workspace::open_workspace,
            commands::workspace::open_workspace_in_file_manager,
            commands::workspace::close_workspace,
            commands::workspace::open_workspace_in_terminal,
            commands::workspace::open_workspace_in_new_window,
            commands::workspace::restore_workspace,
            commands::workspace::get_recent_workspaces,
            commands::workspace::remove_recent_workspace,
            commands::workspace::trash_recent_workspace,
            commands::workspace::take_pending_open,
            commands::workspace::save_session,
            commands::workspace::load_session,
            commands::workspace::open_file_in_standalone_window,
            commands::workspace::watch_standalone_file,
            commands::fonts::list_system_fonts,
            commands::recents::record_recent_file,
            commands::recents::remove_recent_file,
            commands::recents::get_recent_files_global,
            commands::search::index_workspace,
            commands::search::fuzzy_search,
            commands::search::find_file_by_name,
            commands::images::save_clipboard_image,
            commands::settings::get_settings,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::reset_setting,
            #[cfg(desktop)]
            updater::report_update_saves,
            quit::report_quit_saves,
            telemetry::telemetry_should_prompt,
            telemetry::telemetry_answer,
            commands::startup::get_startup_state,
            commands::caret_diag::caret_diag_status,
            commands::caret_diag::caret_diag_set_enabled,
            commands::caret_diag::caret_diag_append,
            commands::caret_diag::caret_diag_copy,
            #[cfg(target_os = "macos")]
            commands::shell_install::cli_status,
            #[cfg(target_os = "macos")]
            commands::shell_install::install_cli,
            #[cfg(target_os = "macos")]
            commands::shell_install::uninstall_cli,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // A quit the person asked for waits for every window's saves.
            if let RunEvent::ExitRequested { code, api, .. } = &_event {
                quit::on_exit_requested(_app, *code, api);
            }

            // Dock click with every window hidden or closed: bring the main
            // window back. It is only ever hidden (never destroyed) by the
            // close-requested handler, so it still holds its workspace.
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = &_event
            {
                if let Some(window) = _app.get_webview_window(MAIN_WINDOW_LABEL) {
                    reveal_window(&window);
                }
            }

            // On macOS, dragging a folder/file to the dock icon sends file:// URLs
            // via the RunEvent::Opened event. The variant only exists in the
            // macOS build of Tauri, so the handler must be gated behind a cfg.
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &_event {
                for url in urls {
                    if commands::account::is_checkout_return(url.as_str()) {
                        emit_checkout_return(_app);
                        continue;
                    }
                    if token_from_invite_link(url.as_str()).is_some() {
                        open_arrived_link(_app, url.as_str().to_string());
                        continue;
                    }
                    if let Ok(path) = url.to_file_path() {
                        if let Some(payload) = resolve_path(&path) {
                            let app_state = _app.state::<AppState>();
                            // Only a window that is still open can take the
                            // payload; a leftover state slot cannot.
                            let existing = match (&payload.workspace, &payload.file) {
                                (Some(workspace), _) => {
                                    app_state.find_by_workspace(Path::new(workspace))
                                }
                                (None, Some(file)) => {
                                    app_state.find_by_standalone_file(Path::new(file))
                                }
                                (None, None) => None,
                            }
                            .filter(|label| _app.get_webview_window(label).is_some());
                            match existing {
                                Some(label) => {
                                    if payload.workspace.is_some() {
                                        queue_open_event(_app, &label, payload);
                                    } else if let Some(window) = _app.get_webview_window(&label) {
                                        // Standalone window already hosts this
                                        // exact file — just bring it forward.
                                        reveal_window(&window);
                                    }
                                }
                                None => {
                                    // `get`, not `get_or_create`: with the main
                                    // window gone, seeding a recreated slot
                                    // would park the open where nothing reads it.
                                    let main_window = _app.get_webview_window(MAIN_WINDOW_LABEL);
                                    let main_state = main_window
                                        .as_ref()
                                        .and_then(|_| app_state.get(MAIN_WINDOW_LABEL));
                                    let seeded = match &main_state {
                                        Some(state) => state.try_set_startup_open(payload),
                                        None => Err(payload),
                                    };
                                    match seeded {
                                        Ok(()) => {}
                                        Err(payload) => {
                                            let main_visible =
                                                main_window.as_ref().is_some_and(|window| {
                                                    window.is_visible().unwrap_or(false)
                                                });

                                            if main_visible || main_state.is_none() {
                                                // Warm start: the app is already
                                                // running with its main window
                                                // visible (or without one). Open
                                                // in a new window so the user's
                                                // current editor state is
                                                // preserved.
                                                let _ = open_in_new_window(_app, payload);
                                            } else {
                                                // Startup state has already been
                                                // read, but the hidden main window
                                                // is still hydrating. Queue the
                                                // open for the startup drainer
                                                // instead of spawning a duplicate
                                                // empty main-adjacent window.
                                                queue_open_event(_app, MAIN_WINDOW_LABEL, payload);
                                            }
                                        }
                                    }
                                }
                            }
                            break;
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod menu_tests {
    /// The menu is built from a live `AppHandle`, so the wiring is checked
    /// against the source, the same way the frontend menu tests do.
    const LIB: &str = include_str!("lib.rs");

    #[test]
    fn quit_alkuin_starts_the_save_round_rather_than_exiting() {
        // The predefined Quit exited without asking the windows to save.
        let predefined_quit = ["PredefinedMenuItem", "::quit("].concat();
        assert!(!LIB.contains(&predefined_quit));
        assert!(LIB.contains("MenuItemBuilder::with_id(quit::QUIT_MENU_ID, quit::QUIT_MENU_LABEL)"));
        assert!(LIB.contains(".item(&quit_item)"));
        assert!(LIB.contains("quit::QUIT_MENU_ID => quit::request_quit(app),"));
        assert_eq!(crate::quit::QUIT_MENU_ID, "app.quit");
        assert_eq!(crate::quit::QUIT_MENU_LABEL, "Quit Alkuin");
        #[cfg(target_os = "macos")]
        assert_eq!(crate::quit::QUIT_ACCELERATOR, Some("CmdOrCtrl+Q"));
        #[cfg(not(target_os = "macos"))]
        assert_eq!(crate::quit::QUIT_ACCELERATOR, None);
    }
}
