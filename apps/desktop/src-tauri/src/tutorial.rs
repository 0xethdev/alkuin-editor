//! First-launch Tutorial.md.
//!
//! One file per install. It is written into the workspace that is about to
//! open, or into a small desk folder when Alkuin has no folder yet. Closing
//! the tab does not write another copy: `tutorial.json` in app data stays set.
//!
//! `version` is the locked body. A record from an older body is shipped once
//! more. The previous file is replaced only when it is still that exact text,
//! and a remint never writes a new file where none is left.

use serde::Deserialize;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub(crate) const FILE_NAME: &str = "Tutorial.md";

/// Copy's locked text. Do not edit.
const TUTORIAL_BODY: &str = include_str!("tutorial.md");

/// Exact bytes of earlier locked bodies. v1 is the first ship. v2 is remint A.
/// v3 is remint B. v4 is remint C. v5 is remint D. v6 is remint E.
const V1_BODY: &str = include_str!("tutorial-v1.md");
const V2_BODY: &str = include_str!("tutorial-v2.md");
const V3_BODY: &str = include_str!("tutorial-v3.md");
const V4_BODY: &str = include_str!("tutorial-v4.md");
const V5_BODY: &str = include_str!("tutorial-v5.md");
const V6_BODY: &str = include_str!("tutorial-v6.md");

const DESK_DIR: &str = "Tutorial";
const RECORD_NAME: &str = "tutorial.json";
const TUTORIAL_VERSION: u32 = 7;
const RECORD_BYTES: &[u8] = br#"{"shipped":true,"version":7}"#;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Prepared {
    /// Folder to open when the caller had no workspace.
    pub desk: Option<PathBuf>,
    /// Select Tutorial.md on this launch.
    pub open: bool,
    /// The name is already a different document. Record the install and do not open it.
    pub mark_existing: bool,
}

#[derive(Deserialize)]
struct Record {
    shipped: bool,
    #[serde(default)]
    version: u32,
}

fn record_path(app_data: &Path) -> PathBuf {
    app_data.join(RECORD_NAME)
}

/// What `tutorial.json` says about this install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shipped {
    /// No record: the first launch.
    Never,
    /// An earlier body was shipped. This launch is a remint.
    Earlier,
    /// This version was shipped, or the record is unreadable.
    Current,
}

/// Read the record.
///
/// ponytail: a torn `tutorial.json` counts as shipped so a bad read cannot mint
/// a new Tutorial.md every launch, and it also skips a remint. Delete the record
/// to show the tutorial again. Bump [`TUTORIAL_VERSION`] when the locked body changes.
fn shipped(app_data: &Path) -> Shipped {
    let path = record_path(app_data);
    if !path.is_file() {
        return Shipped::Never;
    }
    let Ok(text) = fs::read_to_string(&path) else {
        return Shipped::Current;
    };
    match serde_json::from_str::<Record>(&text) {
        Ok(record) if record.shipped && record.version < TUTORIAL_VERSION => Shipped::Earlier,
        Ok(record) if !record.shipped => Shipped::Never,
        _ => Shipped::Current,
    }
}

pub(crate) fn mark_shipped(app_data: &Path) -> io::Result<()> {
    fs::create_dir_all(app_data)?;
    fs::write(record_path(app_data), RECORD_BYTES)?;
    Ok(())
}

fn write_tutorial(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(TUTORIAL_BODY.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

fn rewrite_tutorial(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "tutorial is a symlink",
        ));
    }
    let mut file = open_tutorial(path)?;
    file.write_all(TUTORIAL_BODY.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

/// Opens the file checked above. O_NOFOLLOW refuses a symlink swapped in after that check.
fn open_tutorial(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn open_prepared(dir: PathBuf, created_desk: bool) -> Prepared {
    Prepared {
        desk: created_desk.then_some(dir),
        open: true,
        mark_existing: false,
    }
}

fn prepared_from_body(
    body: &str,
    file: &Path,
    dir: PathBuf,
    created_desk: bool,
) -> io::Result<Prepared> {
    if body == TUTORIAL_BODY {
        return Ok(open_prepared(dir, created_desk));
    }
    if body == V1_BODY
        || body == V2_BODY
        || body == V3_BODY
        || body == V4_BODY
        || body == V5_BODY
        || body == V6_BODY
    {
        rewrite_tutorial(file)?;
        return Ok(open_prepared(dir, created_desk));
    }
    Ok(Prepared {
        desk: None,
        open: false,
        mark_existing: true,
    })
}

/// Decide and, when needed, write Tutorial.md. Does not record the install.
/// The caller records it after the document is actually surfaced.
pub(crate) fn prepare(app_data: &Path, workspace: Option<&Path>) -> io::Result<Prepared> {
    let record = shipped(app_data);
    if record == Shipped::Current {
        return Ok(Prepared {
            desk: None,
            open: false,
            mark_existing: false,
        });
    }

    let (dir, created_desk) = match workspace {
        Some(dir) => {
            if !dir.is_dir() {
                return Ok(Prepared {
                    desk: None,
                    open: false,
                    mark_existing: false,
                });
            }
            (dir.to_path_buf(), false)
        }
        // `write_tutorial` creates the desk folder when it writes the file.
        None => (app_data.join(DESK_DIR), true),
    };

    let file = dir.join(FILE_NAME);
    match read_body(&file)? {
        Some(body) => prepared_from_body(&body, &file, dir, created_desk),
        // A remint only refreshes a Tutorial.md that is still the earlier
        // text. With none here the writer deleted it, or it lives in another
        // folder; either way a new copy must not appear in whatever folder
        // happens to open now. Record the install so it is not asked again.
        None if record == Shipped::Earlier => Ok(Prepared {
            desk: None,
            open: false,
            mark_existing: true,
        }),
        None => match write_tutorial(&file) {
            Ok(()) => Ok(open_prepared(dir, created_desk)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => match read_body(&file)? {
                Some(body) => prepared_from_body(&body, &file, dir, created_desk),
                None => Ok(Prepared {
                    desk: None,
                    open: false,
                    mark_existing: true,
                }),
            },
            Err(err) => Err(err),
        },
    }
}

/// `Ok(None)` when the file is absent. A symlink is refused. Any other read error is returned.
fn read_body(path: &Path) -> io::Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "tutorial is a symlink",
            ));
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
        Ok(_) => {}
    }
    match fs::read_to_string(path) {
        Ok(body) => Ok(Some(body)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn assert_once(body: &str, needle: &str) {
        assert_eq!(body.matches(needle).count(), 1, "{needle}");
    }

    #[test]
    fn body_is_the_locked_copy() {
        assert!(TUTORIAL_BODY.starts_with("# Tutorial\n"));
        assert!(TUTORIAL_BODY.contains("Thank you for choosing Alkuin."));
        assert!(!TUTORIAL_BODY.contains("chosing"));
        assert!(TUTORIAL_BODY.contains("Try it out yourself: formatted text."));
        assert!(TUTORIAL_BODY.contains("click Note."));
        assert!(TUTORIAL_BODY.contains("click Ask Alkuin"));
        assert!(TUTORIAL_BODY.contains("simply proof read"));
        assert!(TUTORIAL_BODY.contains(
            "You can be sure that Alkuin always chooses the best model for the given task!"
        ));
        assert!(TUTORIAL_BODY.contains("**Invite someone**"));
        assert!(TUTORIAL_BODY.contains("**Keep on this Mac only**"));
        assert!(TUTORIAL_BODY.contains("shareable"));
        assert!(!TUTORIAL_BODY.contains("sharable"));
        assert!(TUTORIAL_BODY.contains("**Send changes**"));
        assert!(TUTORIAL_BODY.contains("## Files and folders"));
        assert!(TUTORIAL_BODY.contains("Open Folder\u{2026}"));
        assert!(TUTORIAL_BODY.contains("folder\u{2019}s menu"));
        assert!(TUTORIAL_BODY.contains("**Reveal in Finder**"));
        assert!(TUTORIAL_BODY.contains("Alkuin\u{2019}s"));
        assert!(!TUTORIAL_BODY.contains("This line already mixes"));
        assert!(!TUTORIAL_BODY.contains("This first draft runs long."));
        assert!(!TUTORIAL_BODY.contains("North grew faster than South last quarter."));
        assert!(!TUTORIAL_BODY.contains("choose **Leave note**"));
        assert!(!TUTORIAL_BODY.contains("TODO"));
        assert!(TUTORIAL_BODY.ends_with(
            "You can close Tutorial anytime. It won\u{2019}t come back every time you open Alkuin.\n"
        ));
        assert_ne!(TUTORIAL_BODY, V1_BODY);
        assert_ne!(TUTORIAL_BODY, V2_BODY);
        assert_ne!(TUTORIAL_BODY, V3_BODY);
        assert_ne!(TUTORIAL_BODY, V4_BODY);
        assert_ne!(TUTORIAL_BODY, V5_BODY);
        assert_ne!(TUTORIAL_BODY, V6_BODY);
    }

    #[test]
    fn margin_seeds_anchor_on_the_locked_body() {
        let format = "Try it out yourself: formatted text.";
        let ask = "You can be sure that Alkuin always chooses the best model for the given task!";
        let invite = "Once they have accepted the invitation, `@` them in a margin note when you need their input. They can **Send changes**; you Accept or Reject the same way you do Alkuin\u{2019}s.";
        assert_once(TUTORIAL_BODY, format);
        assert_once(TUTORIAL_BODY, ask);
        assert_once(TUTORIAL_BODY, invite);
    }

    #[test]
    fn first_launch_writes_tutorial_once() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(first.open);
        assert!(first.desk.is_none());
        assert!(!first.mark_existing);
        let written = fs::read_to_string(notes.join(FILE_NAME)).unwrap();
        assert_eq!(written, TUTORIAL_BODY);
        assert_eq!(written.matches("Thank you for choosing Alkuin.").count(), 1);

        mark_shipped(&app_data).unwrap();
        let second = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!second.open);
        assert!(!second.mark_existing);
        assert_eq!(
            fs::read_to_string(notes.join(FILE_NAME)).unwrap(),
            TUTORIAL_BODY
        );
    }

    #[test]
    fn closing_does_not_recreate_the_file() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();

        assert!(prepare(&app_data, Some(&notes)).unwrap().open);
        mark_shipped(&app_data).unwrap();
        fs::remove_file(notes.join(FILE_NAME)).unwrap();

        let again = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!again.open);
        assert!(!notes.join(FILE_NAME).exists());
    }

    #[test]
    fn an_edited_tutorial_is_not_rewritten() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();

        assert!(prepare(&app_data, Some(&notes)).unwrap().open);
        mark_shipped(&app_data).unwrap();
        fs::write(notes.join(FILE_NAME), "edited\n").unwrap();

        let again = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!again.open);
        assert_eq!(
            fs::read_to_string(notes.join(FILE_NAME)).unwrap(),
            "edited\n"
        );
    }

    #[test]
    fn a_different_tutorial_file_is_left_alone() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join(FILE_NAME), "mine\n").unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!first.open);
        assert!(first.mark_existing);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), "mine\n");

        mark_shipped(&app_data).unwrap();
        let second = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!second.open);
        assert!(!second.mark_existing);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), "mine\n");
    }

    #[test]
    fn no_folder_yet_gets_one_desk_and_a_second_launch_does_not() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");

        let first = prepare(&app_data, None).unwrap();
        let desk = first.desk.expect("desk");
        assert!(first.open);
        assert_eq!(
            fs::read_to_string(desk.join(FILE_NAME)).unwrap(),
            TUTORIAL_BODY
        );

        mark_shipped(&app_data).unwrap();
        fs::remove_dir_all(&desk).unwrap();
        let second = prepare(&app_data, None).unwrap();
        assert!(second.desk.is_none());
        assert!(!second.open);
        assert!(!app_data.join(DESK_DIR).exists());
    }

    #[test]
    fn a_written_file_without_a_record_still_opens_once() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let desk = app_data.join(DESK_DIR);
        fs::create_dir_all(&desk).unwrap();
        fs::write(desk.join(FILE_NAME), TUTORIAL_BODY).unwrap();

        let first = prepare(&app_data, None).unwrap();
        assert!(first.open);
        assert_eq!(first.desk.as_deref(), Some(desk.as_path()));
    }

    #[test]
    fn a_v1_tutorial_is_replaced_once() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true}"#).unwrap();
        fs::write(notes.join(FILE_NAME), V1_BODY).unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(first.open);
        assert!(!first.mark_existing);
        assert_eq!(
            fs::read_to_string(notes.join(FILE_NAME)).unwrap(),
            TUTORIAL_BODY
        );

        mark_shipped(&app_data).unwrap();
        fs::write(notes.join(FILE_NAME), V1_BODY).unwrap();
        let again = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!again.open);
        assert!(!again.mark_existing);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), V1_BODY);
    }

    #[test]
    fn a_v5_tutorial_is_replaced_once() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true,"version":5}"#).unwrap();
        fs::write(notes.join(FILE_NAME), V5_BODY).unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(first.open);
        assert_eq!(
            fs::read_to_string(notes.join(FILE_NAME)).unwrap(),
            TUTORIAL_BODY
        );

        mark_shipped(&app_data).unwrap();
        fs::write(notes.join(FILE_NAME), V5_BODY).unwrap();
        let again = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!again.open);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), V5_BODY);
    }

    #[test]
    fn a_v6_tutorial_is_replaced_once() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true,"version":6}"#).unwrap();
        fs::write(notes.join(FILE_NAME), V6_BODY).unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(first.open);
        assert_eq!(
            fs::read_to_string(notes.join(FILE_NAME)).unwrap(),
            TUTORIAL_BODY
        );

        mark_shipped(&app_data).unwrap();
        assert_eq!(fs::read(record_path(&app_data)).unwrap(), RECORD_BYTES);
        fs::write(notes.join(FILE_NAME), V6_BODY).unwrap();
        let again = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!again.open);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), V6_BODY);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_tutorial_is_not_rewritten() {
        use std::os::unix::fs::symlink;
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true,"version":6}"#).unwrap();
        let secret = dir.path().join("secret.md");
        fs::write(&secret, V6_BODY).unwrap();
        symlink(&secret, notes.join(FILE_NAME)).unwrap();

        let err = prepare(&app_data, Some(&notes)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(fs::read_to_string(&secret).unwrap(), V6_BODY);

        let swapped = dir.path().join("swapped.md");
        fs::write(&swapped, "secret\n").unwrap();
        let link = dir.path().join("link.md");
        symlink(&swapped, &link).unwrap();
        assert!(open_tutorial(&link).is_err());
        assert_eq!(fs::read_to_string(&swapped).unwrap(), "secret\n");
    }

    #[test]
    fn an_edited_v6_tutorial_is_not_replaced() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true,"version":6}"#).unwrap();
        fs::write(notes.join(FILE_NAME), "mine\n").unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!first.open);
        assert!(first.mark_existing);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), "mine\n");
    }

    #[test]
    fn an_edited_v5_tutorial_is_not_replaced() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true,"version":5}"#).unwrap();
        fs::write(notes.join(FILE_NAME), "mine\n").unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!first.open);
        assert!(first.mark_existing);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), "mine\n");
    }

    #[test]
    fn a_v4_tutorial_is_replaced_once() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true,"version":4}"#).unwrap();
        fs::write(notes.join(FILE_NAME), V4_BODY).unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(first.open);
        assert_eq!(
            fs::read_to_string(notes.join(FILE_NAME)).unwrap(),
            TUTORIAL_BODY
        );

        mark_shipped(&app_data).unwrap();
        fs::write(notes.join(FILE_NAME), V4_BODY).unwrap();
        let again = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!again.open);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), V4_BODY);
    }

    #[test]
    fn a_v3_tutorial_is_replaced_once() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true,"version":3}"#).unwrap();
        fs::write(notes.join(FILE_NAME), V3_BODY).unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(first.open);
        assert_eq!(
            fs::read_to_string(notes.join(FILE_NAME)).unwrap(),
            TUTORIAL_BODY
        );

        mark_shipped(&app_data).unwrap();
        fs::write(notes.join(FILE_NAME), V3_BODY).unwrap();
        let again = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!again.open);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), V3_BODY);
    }

    #[test]
    fn a_v2_tutorial_is_replaced_once() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true,"version":2}"#).unwrap();
        fs::write(notes.join(FILE_NAME), V2_BODY).unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(first.open);
        assert_eq!(
            fs::read_to_string(notes.join(FILE_NAME)).unwrap(),
            TUTORIAL_BODY
        );

        mark_shipped(&app_data).unwrap();
        fs::write(notes.join(FILE_NAME), V2_BODY).unwrap();
        let again = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!again.open);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), V2_BODY);
    }

    #[test]
    fn a_changed_tutorial_is_not_replaced_on_remint() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true}"#).unwrap();
        fs::write(notes.join(FILE_NAME), "mine\n").unwrap();

        let first = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!first.open);
        assert!(first.mark_existing);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), "mine\n");

        mark_shipped(&app_data).unwrap();
        let second = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!second.open);
        assert!(!second.mark_existing);
        assert_eq!(fs::read_to_string(notes.join(FILE_NAME)).unwrap(), "mine\n");
    }

    #[test]
    fn no_folder_remint_rewrites_the_desk_tutorial() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let desk = app_data.join(DESK_DIR);
        fs::create_dir_all(&desk).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true}"#).unwrap();
        fs::write(desk.join(FILE_NAME), V1_BODY).unwrap();

        let first = prepare(&app_data, None).unwrap();
        assert!(first.open);
        assert_eq!(first.desk.as_deref(), Some(desk.as_path()));
        assert_eq!(
            fs::read_to_string(desk.join(FILE_NAME)).unwrap(),
            TUTORIAL_BODY
        );
    }

    #[test]
    fn a_remint_does_not_recreate_a_deleted_tutorial() {
        // An old record plus a deleted Tutorial.md used to write a new
        // copy into whichever folder opened next.
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), br#"{"shipped":true,"version":6}"#).unwrap();

        let in_folder = prepare(&app_data, Some(&notes)).unwrap();
        assert_eq!(
            in_folder,
            Prepared {
                desk: None,
                open: false,
                mark_existing: true,
            }
        );
        assert!(!notes.join(FILE_NAME).exists());

        let no_folder = prepare(&app_data, None).unwrap();
        assert!(!no_folder.open);
        assert!(no_folder.desk.is_none());
        assert!(!app_data.join(DESK_DIR).exists());

        mark_shipped(&app_data).unwrap();
        assert_eq!(
            prepare(&app_data, Some(&notes)).unwrap(),
            Prepared {
                desk: None,
                open: false,
                mark_existing: false,
            }
        );
    }

    #[test]
    fn a_broken_record_does_not_write_another_copy() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let notes = dir.path().join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(record_path(&app_data), "nope").unwrap();
        fs::write(notes.join(FILE_NAME), "edited\n").unwrap();

        let prepared = prepare(&app_data, Some(&notes)).unwrap();
        assert!(!prepared.open);
        assert_eq!(
            fs::read_to_string(notes.join(FILE_NAME)).unwrap(),
            "edited\n"
        );
    }

    #[test]
    fn a_missing_workspace_does_not_count_as_shipped() {
        let dir = scratch();
        let app_data = dir.path().join("app-data");
        let missing = dir.path().join("gone");

        let prepared = prepare(&app_data, Some(&missing)).unwrap();
        assert!(!prepared.open);
        assert!(!prepared.mark_existing);
        assert!(!record_path(&app_data).exists());
    }
}
