//! First launch after a bundle id change.
//!
//! Tauri stores drafts and settings under `app_data_dir()` (`config`,
//! `sessions.json`, recents, the list of documents kept on this Mac, the
//! share paths, collaborator copies under `shares/`, `telemetry.json`,
//! `updater-dismissed-version.json`). On macOS and Windows
//! `app_config_dir()` is that same folder. On Linux it is `$XDG_CONFIG_HOME`
//! or `~/.config/{id}`, which this app does not write today; it is still
//! copied when it exists so a config file is not left behind.
//!
//! The id has changed twice. The newest earlier folder that exists is the one
//! copied: it already holds whatever an older one had.
//!
//! A path stored in a copied file can point into the earlier folder (an open
//! tab on a collaborator copy, for one). Those are repointed at the new
//! folder, so the app does not keep reading the copy it left behind.
//!
//! Webview storage is not copied. On macOS it is kept per bundle id outside
//! app data, so the appearance cache, the age answer, local style notes and
//! the record of which shared edits were sent start empty. On Linux the
//! webview data directory is the app data folder, so the copy includes it.
//!
//! The copy never deletes or writes the previous folder. The keychain item
//! is not copied. A missing item is the normal signed-out state.
//!
//! Done is recorded with an explicit marker file in the new folder. "The new
//! folder is not empty" is not a done marker: on Linux WebKitGTK can create
//! its storage there before this runs, which used to skip the copy and leave
//! every draft and setting behind.

use std::io;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Earlier bundle ids, newest first. The current id is `app.config().identifier`.
pub(crate) const PREVIOUS_BUNDLE_IDS: &[&str] = &["com.antonelli.desk", "app.redline.desktop"];

/// A copied file larger than this is not read to repoint paths.
const REPOINT_CAP: u64 = 8 * 1024 * 1024;

/// Written into the new folder once the copy has finished, or once the folder
/// is found to hold app data already. Its presence is the only "done" state.
const MIGRATED_MARKER: &str = ".identifier-migrated";

/// Files Alkuin itself writes into app data. A new folder that holds any of
/// them already has this install's data (an older build migrated it, or the
/// app has run under the new id), so nothing is copied over it.
const APP_OWNED_FILES: &[&str] = &[
    "config",
    "sessions.json",
    "recent_workspaces.json",
    "recent_files.json",
    "tutorial.json",
    "telemetry.json",
];

/// Tauri's identifier rule (letters, digits, hyphens, periods), which is also
/// what macOS (`CFBundleIdentifier`), Linux (directory name and GTK application
/// id), and Windows (directory name) accept. No label starts with a digit.
#[cfg(test)]
fn bundle_id_accepted(id: &str) -> bool {
    let mut labels = id.split('.');
    labels.clone().count() >= 2
        && labels.all(|label| {
            let mut chars = label.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

pub fn migrate_previous_app_data(app: &AppHandle) {
    if PREVIOUS_BUNDLE_IDS.contains(&app.config().identifier.as_str()) {
        return;
    }
    let Ok(data) = app.path().app_data_dir() else {
        return;
    };
    let Ok(config) = app.path().app_config_dir() else {
        return;
    };
    for (source, dest) in dirs_to_copy(&data, &config) {
        if let Err(error) = copy_dir_once(&source, &dest) {
            eprintln!("app data copy failed for {}: {error}", dest.display());
        }
    }
}

/// The folder to copy from beside `dir`, then `dir`. One pair when data and
/// config resolve to the same path (macOS, Windows). Two when they differ
/// (Linux). A folder with no earlier folder beside it has no pair.
fn dirs_to_copy(data: &Path, config: &Path) -> Vec<(PathBuf, PathBuf)> {
    let mut dirs = Vec::new();
    if let Some(source) = previous_dir(data) {
        dirs.push((source, data.to_path_buf()));
    }
    if config != data {
        if let Some(source) = previous_dir(config) {
            dirs.push((source, config.to_path_buf()));
        }
    }
    dirs
}

/// True while an earlier folder sits beside `dir` and the copy from it has not
/// finished. Until it has, a file missing from `dir` is not known to be absent:
/// it may still be in the earlier folder. The list of documents kept on this
/// Mac reads this, so that an unfinished copy sends nothing.
pub(crate) fn copy_unfinished(dir: &Path) -> bool {
    if dir.join(MIGRATED_MARKER).is_file() {
        return false;
    }
    let earlier = dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| PREVIOUS_BUNDLE_IDS.contains(&name));
    !earlier && previous_dir(dir).is_some()
}

/// The newest earlier id's folder beside `dir` that exists.
fn previous_dir(dir: &Path) -> Option<PathBuf> {
    PREVIOUS_BUNDLE_IDS
        .iter()
        .map(|id| dir.with_file_name(id))
        .find(|candidate| candidate.is_dir())
}

/// Copy `source` into `dest` once. Returns whether anything was copied.
/// `source` is only read.
///
/// - The marker in `dest` means done.
/// - A leftover staging folder means an earlier copy was interrupted, so the
///   copy runs again.
/// - Otherwise a `dest` that already holds app-owned files is marked done
///   without copying.
/// - Otherwise `source` is staged in full, then each top-level entry `dest`
///   lacks is moved into place, so files another component wrote first (the
///   Linux webview) are kept, and nothing in `dest` is overwritten. Stored
///   paths are repointed in the staged copy first. The marker is written last.
fn copy_dir_once(source: &Path, dest: &Path) -> io::Result<bool> {
    if source == dest || !source.is_dir() {
        return Ok(false);
    }
    if dest.exists() && !dest.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "app data path is not a directory",
        ));
    }
    let staging = staging_dir(dest);
    if dest.join(MIGRATED_MARKER).is_file() {
        if staging.exists() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        return Ok(false);
    }
    if !staging.exists() && holds_app_data(dest) {
        write_marker(dest, source)?;
        return Ok(false);
    }

    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    if let Err(error) = stage(source, &staging).and_then(|()| repoint_paths(&staging, source, dest))
    {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(&staging)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if target.exists() {
            continue;
        }
        std::fs::rename(entry.path(), &target)?;
    }
    write_marker(dest, source)?;
    let _ = std::fs::remove_dir_all(&staging);
    Ok(true)
}

/// Rewrite paths that point into `source` so they point into `dest`, in the
/// text files at the top of `staged`. A path is only matched whole: the folder
/// followed by a separator or a closing quote. Folders below the top are left
/// alone. `shares/` holds documents, and a document's text is never edited.
fn repoint_paths(staged: &Path, source: &Path, dest: &Path) -> io::Result<()> {
    let (Some(old), Some(new)) = (source.to_str(), dest.to_str()) else {
        return Ok(());
    };
    for entry in std::fs::read_dir(staged)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if !meta.is_file() || meta.len() > REPOINT_CAP {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !text.contains(old) {
            continue;
        }
        let mut next = text.clone();
        for end in ['/', '"', '\n'] {
            next = next.replace(&format!("{old}{end}"), &format!("{new}{end}"));
        }
        if next != text {
            std::fs::write(&path, next)?;
        }
    }
    Ok(())
}

fn holds_app_data(dir: &Path) -> bool {
    APP_OWNED_FILES.iter().any(|name| dir.join(name).exists())
}

/// The marker's text names the folder the copy came from.
fn write_marker(dir: &Path, source: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let from = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    std::fs::write(dir.join(MIGRATED_MARKER), from)
}

fn staging_dir(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("app-data");
    dest.with_file_name(format!("{name}.migrate-tmp"))
}

/// Copy everything in `source` except its own marker. That marker says the
/// earlier folder was itself a copy once. Carried over, it could be moved into
/// the new folder before the rest, and a launch interrupted there would read
/// as done with the list of kept documents still missing.
fn stage(source: &Path, staging: &Path) -> io::Result<()> {
    std::fs::create_dir_all(staging)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_name() == MIGRATED_MARKER {
            continue;
        }
        let from = entry.path();
        let to = staging.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, dest: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut files = Vec::new();
        fn walk(dir: &Path, root: &Path, files: &mut Vec<(String, Vec<u8>)>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if entry.file_type().unwrap().is_dir() {
                    walk(&path, root, files);
                } else if entry.file_name() == MIGRATED_MARKER {
                    // Bookkeeping, not copied data.
                } else {
                    let rel = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .to_string();
                    files.push((rel, fs::read(&path).unwrap()));
                }
            }
        }
        walk(dir, dir, &mut files);
        files.sort();
        files
    }

    #[test]
    fn bundle_identifier_does_not_contain_redline() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let id = conf["identifier"].as_str().unwrap();
        assert_eq!(id, "app.alkuin.desktop");
        assert!(!id.to_ascii_lowercase().contains("redline"));
        assert_eq!(
            PREVIOUS_BUNDLE_IDS,
            &["com.antonelli.desk", "app.redline.desktop"]
        );
        assert!(!PREVIOUS_BUNDLE_IDS.contains(&id));
    }

    #[test]
    fn bundle_id_is_accepted_on_macos_linux_and_windows() {
        assert!(bundle_id_accepted("app.alkuin.desktop"));
        for id in PREVIOUS_BUNDLE_IDS {
            assert!(bundle_id_accepted(id), "{id}");
        }
        assert!(!bundle_id_accepted("com.writer-computer."));
        assert!(!bundle_id_accepted("1app.redline"));
        assert!(!bundle_id_accepted("app redline"));
    }

    #[test]
    fn copies_once_when_the_new_folder_is_empty_and_leaves_the_old_folder() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("app.redline.desktop");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("config"), "theme = dark\n").unwrap();
        fs::write(source.join("sessions.json"), "{\"tabs\":[]}").unwrap();
        fs::write(source.join("nested").join("notes.txt"), "kept\n").unwrap();
        let before = snapshot(&source);

        let dest = root.path().join("app.alkuin.desktop");
        assert!(copy_dir_once(&source, &dest).unwrap());
        assert_eq!(snapshot(&dest), before);
        assert_eq!(snapshot(&source), before);
        assert!(dest.join(MIGRATED_MARKER).is_file());
        assert!(!staging_dir(&dest).exists());

        fs::write(source.join("config"), "theme = light\n").unwrap();
        assert!(!copy_dir_once(&source, &dest).unwrap());
        assert_eq!(
            fs::read_to_string(dest.join("config")).unwrap(),
            "theme = dark\n"
        );
        assert_eq!(
            fs::read_to_string(source.join("config")).unwrap(),
            "theme = light\n"
        );
        assert!(source.join("sessions.json").is_file());
    }

    #[test]
    fn copies_into_an_empty_directory() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old");
        let dest = root.path().join("new");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(source.join("recent_workspaces.json"), "[]").unwrap();
        let before = snapshot(&source);
        assert!(copy_dir_once(&source, &dest).unwrap());
        assert_eq!(snapshot(&dest), before);
        assert_eq!(snapshot(&source), before);
    }

    #[test]
    fn does_not_copy_when_the_new_folder_already_has_data() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old");
        let dest = root.path().join("new");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(source.join("config"), "from-old").unwrap();
        fs::write(dest.join("config"), "from-new").unwrap();
        let source_before = snapshot(&source);
        assert!(!copy_dir_once(&source, &dest).unwrap());
        assert_eq!(fs::read_to_string(dest.join("config")).unwrap(), "from-new");
        assert_eq!(snapshot(&source), source_before);
        assert!(!dest.join("sessions.json").exists());
        assert!(
            dest.join(MIGRATED_MARKER).is_file(),
            "an older build's copy is recorded as done"
        );
    }

    #[test]
    fn copies_when_the_webview_wrote_the_new_folder_first() {
        // On Linux WebKitGTK can create its storage in the new folder
        // before setup runs. "Not empty" used to count as migrated, so every
        // draft and setting stayed behind.
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old");
        let dest = root.path().join("new");
        fs::create_dir_all(source.join("WebKitCache")).unwrap();
        fs::write(source.join("WebKitCache").join("old-blob"), "old").unwrap();
        fs::write(source.join("config"), "theme = dark\n").unwrap();
        fs::write(source.join("sessions.json"), "{}").unwrap();
        fs::create_dir_all(dest.join("WebKitCache")).unwrap();
        fs::write(dest.join("WebKitCache").join("new-blob"), "new").unwrap();

        assert!(copy_dir_once(&source, &dest).unwrap());
        assert_eq!(
            fs::read_to_string(dest.join("config")).unwrap(),
            "theme = dark\n"
        );
        assert!(dest.join("sessions.json").is_file());
        // What the webview wrote is kept as it is, not merged or replaced.
        assert!(dest.join("WebKitCache").join("new-blob").is_file());
        assert!(!dest.join("WebKitCache").join("old-blob").exists());
        assert!(!copy_dir_once(&source, &dest).unwrap());
    }

    #[test]
    fn an_interrupted_copy_resumes_on_the_next_launch() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old");
        let dest = root.path().join("new");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("config"), "theme = dark\n").unwrap();
        fs::write(source.join("sessions.json"), "{}").unwrap();
        // The last launch moved `config` into place, then stopped.
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("config"), "theme = dark\n").unwrap();
        fs::create_dir_all(staging_dir(&dest)).unwrap();
        fs::write(staging_dir(&dest).join("sessions.json"), "{}").unwrap();

        assert!(copy_dir_once(&source, &dest).unwrap());
        assert!(dest.join("sessions.json").is_file());
        assert!(dest.join(MIGRATED_MARKER).is_file());
        assert!(!staging_dir(&dest).exists());
    }

    #[test]
    fn noop_when_the_old_folder_is_missing() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("missing");
        let dest = root.path().join("new");
        assert!(!copy_dir_once(&source, &dest).unwrap());
        assert!(!dest.exists());
        assert!(!source.exists());
    }

    #[test]
    fn config_dir_is_copied_only_when_it_is_a_different_folder() {
        let root = tempfile::tempdir().unwrap();
        let old_data = root.path().join("share").join(PREVIOUS_BUNDLE_IDS[0]);
        let old_config = root.path().join("config").join(PREVIOUS_BUNDLE_IDS[0]);
        fs::create_dir_all(&old_data).unwrap();
        fs::create_dir_all(&old_config).unwrap();

        let data = root.path().join("share").join("app.alkuin.desktop");
        let same = dirs_to_copy(&data, &data);
        assert_eq!(same, vec![(old_data.clone(), data.clone())]);

        let config = root.path().join("config").join("app.alkuin.desktop");
        let split = dirs_to_copy(&data, &config);
        assert_eq!(split, vec![(old_data, data), (old_config, config)]);
    }

    #[test]
    fn the_newest_earlier_folder_is_the_one_copied() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("app.alkuin.desktop");
        assert_eq!(
            previous_dir(&dest),
            None,
            "nothing to copy on a first install"
        );

        let oldest = root.path().join("app.redline.desktop");
        fs::create_dir_all(&oldest).unwrap();
        fs::write(oldest.join("config"), "theme = oldest\n").unwrap();
        assert_eq!(previous_dir(&dest), Some(oldest.clone()));

        let newest = root.path().join("com.antonelli.desk");
        fs::create_dir_all(&newest).unwrap();
        fs::write(newest.join("config"), "theme = newest\n").unwrap();
        // That folder was itself a copy once, and still holds its own marker.
        fs::write(newest.join(MIGRATED_MARKER), "app.redline.desktop").unwrap();
        assert_eq!(previous_dir(&dest), Some(newest.clone()));

        let (source, _) = dirs_to_copy(&dest, &dest).remove(0);
        assert!(copy_dir_once(&source, &dest).unwrap());
        assert_eq!(
            fs::read_to_string(dest.join("config")).unwrap(),
            "theme = newest\n"
        );
        assert_eq!(
            fs::read_to_string(dest.join(MIGRATED_MARKER)).unwrap(),
            "com.antonelli.desk"
        );
        assert_eq!(
            fs::read_to_string(oldest.join("config")).unwrap(),
            "theme = oldest\n"
        );
    }

    #[test]
    fn the_earlier_folders_own_marker_is_never_staged() {
        // The earlier folder was a copy once and still holds its marker. If
        // that file were moved into the new folder first and the launch stopped
        // there, the next launch would read "done" with the kept list missing.
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("com.antonelli.desk");
        let dest = root.path().join("app.alkuin.desktop");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join(MIGRATED_MARKER), "app.redline.desktop").unwrap();
        let kept = r#"["/Users/ada/notes/private.md"]"#;
        fs::write(source.join("mac-only.json"), kept).unwrap();

        let staging = staging_dir(&dest);
        stage(&source, &staging).unwrap();
        assert!(!staging.join(MIGRATED_MARKER).exists());
        assert!(staging.join("mac-only.json").is_file());
        fs::remove_dir_all(&staging).unwrap();

        // The launch that stopped part way: no marker yet, so it is not done.
        fs::create_dir_all(&dest).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("mac-only.json"), "stale").unwrap();
        assert!(copy_unfinished(&dest));
        assert!(copy_dir_once(&source, &dest).unwrap());
        assert_eq!(
            fs::read_to_string(dest.join("mac-only.json")).unwrap(),
            kept
        );
        assert_eq!(
            fs::read_to_string(dest.join(MIGRATED_MARKER)).unwrap(),
            "com.antonelli.desk"
        );
        assert!(!copy_unfinished(&dest));
    }

    #[test]
    fn a_copy_is_unfinished_only_beside_an_earlier_folder_and_before_the_marker() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("app.alkuin.desktop");
        fs::create_dir_all(&dest).unwrap();
        assert!(
            !copy_unfinished(&dest),
            "a first install has nothing to wait for"
        );

        let earlier = root.path().join("com.antonelli.desk");
        fs::create_dir_all(&earlier).unwrap();
        assert!(copy_unfinished(&dest));
        // A build still run under the earlier id is not waiting on itself.
        assert!(!copy_unfinished(&earlier));

        fs::write(dest.join(MIGRATED_MARKER), "com.antonelli.desk").unwrap();
        assert!(!copy_unfinished(&dest));
    }

    #[test]
    fn stored_paths_into_the_old_folder_point_at_the_new_one() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("com.antonelli.desk");
        let dest = root.path().join("app.alkuin.desktop");
        fs::create_dir_all(source.join("shares")).unwrap();
        let old = source.to_str().unwrap();
        let new = dest.to_str().unwrap();
        let copy = "33333333-3333-4333-8333-333333333333.md";
        // An open tab on a collaborator copy, and a document outside app data.
        fs::write(
            source.join("sessions.json"),
            format!(
                r#"{{"tabs":["{old}/shares/{copy}","/Users/ada/notes/draft.md"],"home":"{old}"}}"#
            ),
        )
        .unwrap();
        // A line-per-entry file, and a look-alike folder that is not this one.
        fs::write(
            source.join("queue.txt"),
            format!("{old}/shares/{copy}\n{old}.backup/shares/{copy}\n{old}\n"),
        )
        .unwrap();
        // A document that happens to mention the folder is not edited.
        let document = format!("My copy is at {old}/shares/{copy}\n");
        fs::write(source.join("shares").join(copy), &document).unwrap();
        let before = snapshot(&source);

        assert!(copy_dir_once(&source, &dest).unwrap());
        assert_eq!(
            fs::read_to_string(dest.join("sessions.json")).unwrap(),
            format!(
                r#"{{"tabs":["{new}/shares/{copy}","/Users/ada/notes/draft.md"],"home":"{new}"}}"#
            )
        );
        assert_eq!(
            fs::read_to_string(dest.join("queue.txt")).unwrap(),
            format!("{new}/shares/{copy}\n{old}.backup/shares/{copy}\n{new}\n")
        );
        assert_eq!(
            fs::read_to_string(dest.join("shares").join(copy)).unwrap(),
            document
        );
        assert_eq!(snapshot(&source), before, "the old folder is only read");
    }
}
