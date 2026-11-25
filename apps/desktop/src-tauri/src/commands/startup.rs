use crate::commands::fs::{read_file_impl, FileContent};
use crate::commands::settings::config_value_to_json;
use crate::commands::workspace::{
    build_restore_bundle, load_recent_workspaces, save_session, surface_file_tab,
    watch_standalone_file_impl, RestoreWorkspaceResponse, SessionData,
};
use crate::error::AppError;
use crate::state::AppState;
use crate::tutorial;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;

const RESTORE_WORKSPACE_KEY: &str = "window.restore-workspace";

#[derive(Debug, Serialize)]
pub struct StartupState {
    pub settings: Value,
    pub recent_workspaces: Vec<String>,
    /// Workspace restore payload. Populated for folder opens and session
    /// restores; `None` for standalone file opens and the welcome screen.
    pub restore_bundle: Option<RestoreWorkspaceResponse>,
    /// Standalone compact-mode open (CLI arg / drag-drop of a markdown
    /// file). Mutually exclusive with `restore_bundle`: no workspace is
    /// prepared, no indexing runs — only the prefetched file content and a
    /// single-file watcher started before this returns.
    pub standalone_file: Option<FileContent>,
}

#[tauri::command]
pub async fn get_startup_state(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<StartupState, AppError> {
    let label = webview.label().to_string();
    let state = app.state::<AppState>().window(&label)?;

    let (settings, restore_enabled) = {
        let guard = state.settings.read();
        match guard.as_ref() {
            Some(s) => {
                let merged = s.merged();
                let restore_enabled = merged
                    .get(RESTORE_WORKSPACE_KEY)
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let mut obj = serde_json::Map::new();
                for (k, v) in &merged {
                    obj.insert(k.clone(), config_value_to_json(v));
                }
                (Value::Object(obj), restore_enabled)
            }
            None => return Err(AppError::Io("Settings not initialized".into())),
        }
    };

    let recent_workspaces = load_recent_workspaces(&app).unwrap_or_default();
    let startup_open = state.take_startup_open();

    // Standalone file open (CLI arg / drag-drop of a markdown file): no
    // workspace is prepared at all — no watcher tree, no gitignore load, no
    // index walk. Prefetch the file content so the compact editor mounts
    // loaded, and start the lightweight single-file watcher.
    if let Some(payload) = &startup_open {
        if payload.workspace.is_none() {
            if let Some(file) = &payload.file {
                let standalone_file = match read_file_impl(file) {
                    Ok(content) => Some(content),
                    Err(err) => {
                        // File vanished between the open event and startup —
                        // fall through to the welcome screen.
                        eprintln!("failed to read standalone startup file {file}: {err:?}");
                        None
                    }
                };
                if standalone_file.is_some() {
                    if let Err(err) = watch_standalone_file_impl(&app, &label, file) {
                        eprintln!("failed to start standalone file watcher: {err:?}");
                    }
                }
                return Ok(StartupState {
                    settings,
                    recent_workspaces,
                    restore_bundle: None,
                    standalone_file,
                });
            }
        }
    }

    // Pick a workspace to prefetch a bundle for so the frontend can hydrate
    // synchronously on first render — no second IPC waterfall, no welcome
    // screen flash. startup_open is set during window creation (from CLI
    // args or open_new_workspace_window) before the webview loads — same
    // lifecycle as settings. No runtime event touches it.
    // An explicit open is the file or folder the writer asked for. It does
    // not consume the once-per-install tutorial.
    let explicit_open = startup_open.is_some();
    let mut restore_target = if let Some(payload) = &startup_open {
        payload.workspace.clone()
    } else if restore_enabled {
        recent_workspaces
            .first()
            .filter(|path| Path::new(path).is_dir())
            .cloned()
    } else {
        None
    };

    let tutorial_ship = if explicit_open {
        None
    } else {
        ship_tutorial(&app, &mut restore_target)
    };

    let mut restore_bundle = if let Some(path) = restore_target {
        match build_restore_bundle(&app, &label, &path).await {
            Ok(bundle) => Some(bundle),
            Err(err) => {
                // Don't let a failed restore abort startup — settings still
                // need to hydrate and the welcome screen should render.
                eprintln!("failed to prefetch restore bundle for {path}: {err:?}");
                None
            }
        }
    } else {
        None
    };

    // A workspace+file payload (open_workspace_in_new_window with a file)
    // opens that file as a normal tab instead of restoring the previous
    // session — the user asked for a specific file, not their old tabs.
    if let Some(pending) = startup_open {
        if pending.workspace.is_some() {
            if let Some(ref mut bundle) = restore_bundle {
                bundle.session = None;
                bundle.active_file = None;
                bundle.open_file = pending.file;
            }
        }
    }

    if let Some(app_data) = tutorial_ship {
        if let Some(bundle) = restore_bundle.as_mut() {
            surface_shipped_tutorial(&app, bundle, &app_data);
        }
    }

    Ok(StartupState {
        settings,
        recent_workspaces,
        restore_bundle,
        standalone_file: None,
    })
}

/// Write Tutorial.md before the restore bundle reads the directory. Returns
/// the app-data dir when this launch should select the new document.
fn ship_tutorial(app: &tauri::AppHandle, restore_target: &mut Option<String>) -> Option<PathBuf> {
    let app_data = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            eprintln!("tutorial: no app data dir: {err}");
            return None;
        }
    };
    let workspace = restore_target.as_deref().map(Path::new);
    let prepared = match tutorial::prepare(&app_data, workspace) {
        Ok(prepared) => prepared,
        Err(err) => {
            eprintln!("tutorial ship failed: {err}");
            return None;
        }
    };
    if let Some(desk) = &prepared.desk {
        *restore_target = Some(desk.to_string_lossy().into_owned());
    }
    if prepared.mark_existing {
        if let Err(err) = tutorial::mark_shipped(&app_data) {
            eprintln!("tutorial record failed: {err}");
        }
    }
    prepared.open.then_some(app_data)
}

fn surface_shipped_tutorial(
    app: &tauri::AppHandle,
    bundle: &mut RestoreWorkspaceResponse,
    app_data: &Path,
) {
    // The sidebar path is the one `read_directory` returned. Joining the
    // canonical root is the fallback when the file is hidden from the list.
    let path_str = bundle
        .entries
        .iter()
        .find(|entry| entry.name == tutorial::FILE_NAME && !entry.is_dir)
        .map(|entry| entry.path.clone())
        .unwrap_or_else(|| {
            Path::new(&bundle.workspace.root)
                .join(tutorial::FILE_NAME)
                .to_string_lossy()
                .into_owned()
        });
    if !Path::new(&path_str).is_file() {
        return;
    }
    let session = bundle.session.get_or_insert_with(|| SessionData {
        tabs: Vec::new(),
        active_index: None,
    });
    surface_file_tab(true, session, &path_str);
    let tabs = session.tabs.clone();
    let active_index = session.active_index;
    if let Ok(content) = read_file_impl(&path_str) {
        bundle.active_file = Some(content);
    }
    let root = bundle.workspace.root.clone();
    if let Err(err) = save_session(root, tabs, active_index, app.clone()) {
        eprintln!("tutorial session save failed: {err:?}");
    }
    if let Err(err) = tutorial::mark_shipped(app_data) {
        eprintln!("tutorial record failed: {err}");
    }
}
