//! A missing file is not a delete until the caller says so. Rename and the
//! path-to-id map live in `shares` (`share-paths.json`). This module
//! only decides whether a disappearance is a rename, a missing volume, or a
//! soft delete, and it stores a fingerprint in that same map.
//!
//! ponytail: one folder is scanned, and two identical files are left alone.
//! Upgrade path is a stored inode on the server row.

use crate::commands::history::document_id;
use crate::commands::shares::{
    load_share_paths, path_key, save_share_paths, share_document_id, share_paths_lock,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Print rows are not paths. The path lookup skips them.
const PRINT: char = '\u{1}';
const WALK_CAP: usize = 5000;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Absence {
    Ignore,
    Carried,
    SoftDelete(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CloudPlan {
    None,
    Leave(String),
    Erase(Vec<String>),
}

/// Parent still has to be here. The file name is appended to that canonical
/// parent, which is the key recorded while the file existed.
fn missing_key(path: &Path) -> String {
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(parent) = fs::canonicalize(parent) {
            return parent.join(name).to_string_lossy().into_owned();
        }
    }
    path.to_string_lossy().into_owned()
}

fn is_print(key: &str) -> bool {
    key.starts_with(PRINT)
}

fn print_key(id: &str) -> String {
    format!("{PRINT}{id}")
}

fn is_markdown(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("md")
}

pub(crate) fn fingerprint(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    #[cfg(unix)]
    let ino = std::os::unix::fs::MetadataExt::ino(&meta);
    #[cfg(not(unix))]
    let ino = 0u64;
    let bytes = fs::read(path).ok()?;
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let _ = meta;
    Some(format!("{ino}:{hash:016x}"))
}

pub(crate) fn same_fingerprint(stored: &str, path: &Path) -> bool {
    let Some(now) = fingerprint(path) else {
        return false;
    };
    let Some((ino, hash)) = stored.split_once(':') else {
        return false;
    };
    let Some((ino_now, hash_now)) = now.split_once(':') else {
        return false;
    };
    if ino != "0" && ino == ino_now {
        return true;
    }
    !hash.is_empty() && hash == hash_now
}

/// Document ids this Mac stored because the file was shared. Fingerprint rows
/// are not ids. A path encoding that was never written here is not included.
pub(crate) fn known_share_ids(home: &Path) -> std::collections::HashSet<String> {
    let _guard = share_paths_lock();
    let Some(map) = load_share_paths(home) else {
        return std::collections::HashSet::new();
    };
    map.into_iter()
        .filter(|(path, id)| !is_print(path) && !id.is_empty())
        .map(|(_, id)| id)
        .collect()
}

pub(crate) fn path_of_document_id(id: &str) -> Option<PathBuf> {
    let bytes = URL_SAFE_NO_PAD.decode(id).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let path = PathBuf::from(text);
    if path.is_absolute() {
        Some(path)
    } else {
        None
    }
}

pub(crate) fn live_path(home: &Path, id: &str) -> Option<PathBuf> {
    let _guard = share_paths_lock();
    let map = load_share_paths(home)?;
    map.into_iter().find_map(|(path, stored)| {
        if is_print(&path) || stored != id {
            return None;
        }
        let file = PathBuf::from(path);
        if file.is_file() {
            Some(file)
        } else {
            None
        }
    })
}

/// The id the server already has for this file. Stored even when it matches
/// the path encoding, so a later disappearance does not invent a new one.
pub(crate) fn bind_document_id(home: &Path, path: &Path, id: &str) {
    if id.is_empty() || !path.is_file() {
        return;
    }
    let _guard = share_paths_lock();
    let Some(mut map) = load_share_paths(home) else {
        return;
    };
    let key = path_key(path);
    if map.get(&key).map(String::as_str) == Some(id) {
        return;
    }
    map.insert(key, id.to_string());
    let _ = save_share_paths(home, &map);
}

pub(crate) fn note_present(home: &Path, path: &Path) {
    if !path.is_file() {
        return;
    }
    let Some(print) = fingerprint(path) else {
        return;
    };
    let _guard = share_paths_lock();
    let Some(mut map) = load_share_paths(home) else {
        return;
    };
    let id = map
        .get(&path_key(path))
        .cloned()
        .unwrap_or_else(|| document_id(path));
    map.insert(print_key(&id), print);
    let _ = save_share_paths(home, &map);
}

/// The file is already at `to`. Finder rename and move use this.
/// The id is written with that map, so a later open keeps the share.
pub(crate) fn note_moved(home: &Path, from: &Path, to: &Path) {
    if !to.is_file() {
        return;
    }
    let _guard = share_paths_lock();
    let Some(mut map) = load_share_paths(home) else {
        eprintln!("[shares] a move was not recorded: share-paths.json cannot be read");
        return;
    };
    let from_key = missing_key(from);
    let to_key = path_key(to);
    let id = match map.remove(&from_key) {
        Some(id) => id,
        // Already carried: an in-app rename, or this same move seen twice.
        // The id stored for `to` stays.
        None if map.contains_key(&to_key) => return,
        None => document_id(Path::new(&from_key)),
    };
    map.insert(to_key, id);
    save_share_paths(home, &map);
}

pub(crate) fn forget(home: &Path, key: &Path, was_dir: bool) {
    let _guard = share_paths_lock();
    let Some(mut map) = load_share_paths(home) else {
        return;
    };
    let key = missing_key(key);
    let prefix = format!("{key}/");
    let mut dropped = Vec::new();
    let before = map.len();
    map.retain(|path, id| {
        if is_print(path) {
            return true;
        }
        let drop_row = path == &key || (was_dir && path.starts_with(&prefix));
        if drop_row {
            dropped.push(id.clone());
        }
        !drop_row
    });
    for id in dropped {
        map.remove(&print_key(&id));
    }
    if map.len() != before {
        let _ = save_share_paths(home, &map);
    }
}

/// The watcher's question: a file vanished. A soft-delete is only for a file
/// this Mac has seen as an owned share (it has a fingerprint, which only the
/// desk read writes for owned rows). Any other vanished file is `Ignore`, so
/// an ordinary delete makes no network call. The next desk read still
/// catches a share that was never fingerprinted
/// ([`classify_listed_absence`]).
pub(crate) fn classify_absence(home: &Path, missing: &Path, candidates: &[PathBuf]) -> Absence {
    absence(home, missing, candidates, false)
}

/// The desk read's question: the server lists this owned document and its
/// file is gone. With no fingerprint to match, that is a soft-delete.
pub(crate) fn classify_listed_absence(
    home: &Path,
    missing: &Path,
    candidates: &[PathBuf],
) -> Absence {
    absence(home, missing, candidates, true)
}

fn absence(home: &Path, missing: &Path, candidates: &[PathBuf], listed: bool) -> Absence {
    if missing.exists() {
        return Absence::Ignore;
    }
    let Some(parent) = missing.parent() else {
        return Absence::Ignore;
    };
    if !parent.is_dir() {
        return Absence::Ignore;
    }
    let _guard = share_paths_lock();
    let Some(mut map) = load_share_paths(home) else {
        return Absence::Ignore;
    };
    let key = missing_key(missing);
    let id = mapped_id(&map, missing).unwrap_or_else(|| document_id(Path::new(&key)));
    let carried = map
        .iter()
        .any(|(path, stored)| !is_print(path) && stored == &id && Path::new(path).is_file());
    if carried {
        return Absence::Carried;
    }
    if let Some(print) = map.get(&print_key(&id)).cloned() {
        let hits: Vec<&PathBuf> = candidates
            .iter()
            .filter(|path| path.is_file() && same_fingerprint(&print, path))
            .collect();
        if hits.len() > 1 {
            return Absence::Ignore;
        }
        if let Some(next) = hits.first() {
            map.remove(&key);
            map.insert(path_key(next), id);
            save_share_paths(home, &map);
            return Absence::Carried;
        }
    } else if !listed {
        return Absence::Ignore;
    }
    Absence::SoftDelete(id)
}

/// The id stored for this missing file. Two files with the same name are
/// left alone.
/// ponytail: one name match across the map. Upgrade path is the path key.
fn mapped_id(map: &BTreeMap<String, String>, missing: &Path) -> Option<String> {
    let key = missing_key(missing);
    if let Some(id) = map.get(&key) {
        return Some(id.clone());
    }
    let raw = missing.to_string_lossy();
    if raw.as_ref() != key {
        if let Some(id) = map.get(raw.as_ref()) {
            return Some(id.clone());
        }
    }
    let name = missing.file_name()?;
    let mut found = None;
    for (path, id) in map {
        if is_print(path) || Path::new(path).file_name() != Some(name) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(id.clone());
    }
    found
}

fn copy_share_id(path: &Path) -> Option<String> {
    let parent = path.parent()?.file_name()?.to_str()?;
    if parent != "shares" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    let bytes = stem.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let dash = index == 8 || index == 13 || index == 18 || index == 23;
        if dash {
            if *byte != b'-' {
                return None;
            }
        } else if !byte.is_ascii_hexdigit() {
            return None;
        }
    }
    Some(stem.to_ascii_lowercase())
}

fn collect_markdown(root: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= WALK_CAP || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= WALK_CAP {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_markdown(&path, out);
        } else if is_markdown(&path) {
            out.push(path);
        }
    }
}

pub(crate) fn plan_cloud_delete(home: Option<&Path>, path: &Path) -> CloudPlan {
    if let Some(id) = copy_share_id(path) {
        return CloudPlan::Leave(id);
    }
    let mut files = Vec::new();
    if path.is_dir() {
        collect_markdown(path, &mut files);
    } else if path.is_file() {
        files.push(path.to_path_buf());
    }
    if files.is_empty() {
        return CloudPlan::None;
    }
    let mut ids: Vec<String> = files
        .iter()
        .map(|file| share_document_id(home, file))
        .collect();
    ids.sort();
    ids.dedup();
    CloudPlan::Erase(ids)
}

pub(crate) fn sibling_markdown(path: &Path) -> Vec<PathBuf> {
    let Some(parent) = path.parent() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|candidate| is_markdown(candidate))
        .take(WALK_CAP)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shares::carry_share_rename;
    use crate::error::AppError;

    fn scratch(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("alkuin-share-paths-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_rename_keeps_the_id_and_a_missing_parent_is_not_a_delete() {
        let root = scratch("rename");
        let home = root.join("app");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let old = notes.join("essay.md");
        let next = notes.join("essay-renamed.md");
        fs::write(&old, "same words\n").unwrap();
        let before = document_id(&old);
        carry_share_rename(&home, &old, &next, false, || {
            fs::rename(&old, &next).map_err(|err| AppError::Io(err.to_string()))
        })
        .unwrap();
        assert_eq!(share_document_id(Some(&home), &next), before);
        assert!(matches!(
            classify_absence(&home, &old, &[next.clone()]),
            Absence::Carried
        ));

        let away = root.join("missing-disk").join("essay.md");
        assert_eq!(classify_absence(&home, &away, &[]), Absence::Ignore);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_vanished_file_never_seen_as_a_share_is_not_a_soft_delete() {
        let root = scratch("unshared");
        let home = root.join("app");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let plain = notes.join("plain.md");
        fs::write(&plain, "just mine\n").unwrap();
        // A rename stores an id but no fingerprint: still not a share.
        let moved = notes.join("moved.md");
        carry_share_rename(&home, &plain, &moved, false, || {
            fs::rename(&plain, &moved).map_err(|err| AppError::Io(err.to_string()))
        })
        .unwrap();
        fs::remove_file(&moved).unwrap();
        assert_eq!(classify_absence(&home, &moved, &[]), Absence::Ignore);
        // The desk read, which knows the server lists it, still soft-deletes.
        assert!(matches!(
            classify_listed_absence(&home, &moved, &[]),
            Absence::SoftDelete(_)
        ));
        let shared = notes.join("shared.md");
        fs::write(&shared, "shared words\n").unwrap();
        note_present(&home, &shared);
        let id = document_id(&shared);
        fs::remove_file(&shared).unwrap();
        assert_eq!(
            classify_absence(&home, &shared, &[]),
            Absence::SoftDelete(id)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_second_note_moved_for_one_move_keeps_the_carried_id() {
        let root = scratch("twice");
        let home = root.join("app");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let a = notes.join("a.md");
        let b = notes.join("b.md");
        fs::write(&a, "words\n").unwrap();
        bind_document_id(&home, &a, "server-doc");
        // In-app rename, then the watcher reports the same move, twice.
        carry_share_rename(&home, &a, &b, false, || {
            fs::rename(&a, &b).map_err(|err| AppError::Io(err.to_string()))
        })
        .unwrap();
        note_moved(&home, &a, &b);
        note_moved(&home, &a, &b);
        assert_eq!(share_document_id(Some(&home), &b), "server-doc");
        // Back to the first name: the carried id is still the server's.
        carry_share_rename(&home, &b, &a, false, || {
            fs::rename(&b, &a).map_err(|err| AppError::Io(err.to_string()))
        })
        .unwrap();
        note_moved(&home, &b, &a);
        assert_eq!(share_document_id(Some(&home), &a), "server-doc");

        // A Finder move of a file with no stored id, reported twice.
        let c = notes.join("c.md");
        let d = notes.join("d.md");
        fs::write(&c, "other\n").unwrap();
        let before = document_id(&c);
        fs::rename(&c, &d).unwrap();
        note_moved(&home, &c, &d);
        note_moved(&home, &c, &d);
        assert_eq!(share_document_id(Some(&home), &d), before);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_move_matched_by_inode_or_bytes_is_not_a_delete() {
        let root = scratch("inode");
        let home = root.join("app");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let old = notes.join("essay.md");
        let next = notes.join("moved.md");
        fs::write(&old, "same words\n").unwrap();
        note_present(&home, &old);
        let before = document_id(&old);
        fs::rename(&old, &next).unwrap();
        assert_eq!(
            classify_absence(&home, &old, &[next.clone()]),
            Absence::Carried
        );
        assert_eq!(share_document_id(Some(&home), &next), before);

        let copy_from = notes.join("other.md");
        let copy_to = notes.join("other-copy.md");
        fs::write(&copy_from, "different words\n").unwrap();
        note_present(&home, &copy_from);
        let copy_id = document_id(&copy_from);
        fs::write(&copy_to, "different words\n").unwrap();
        fs::remove_file(&copy_from).unwrap();
        assert_eq!(
            classify_absence(&home, &copy_from, &[copy_to.clone(), next.clone()]),
            Absence::Carried
        );
        assert_eq!(share_document_id(Some(&home), &copy_to), copy_id);

        let gone = notes.join("gone.md");
        fs::write(&gone, "only here\n").unwrap();
        note_present(&home, &gone);
        let gone_id = document_id(&gone);
        fs::remove_file(&gone).unwrap();
        assert_eq!(
            classify_absence(&home, &gone, &[next, copy_to]),
            Absence::SoftDelete(gone_id)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_matching_files_and_a_corrupt_map_are_not_deletes() {
        let root = scratch("ambiguous");
        let home = root.join("app");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let old = notes.join("essay.md");
        fs::write(&old, "same words\n").unwrap();
        note_present(&home, &old);
        let a = notes.join("a.md");
        let b = notes.join("b.md");
        fs::write(&a, "same words\n").unwrap();
        fs::write(&b, "same words\n").unwrap();
        fs::remove_file(&old).unwrap();
        assert_eq!(classify_absence(&home, &old, &[a, b]), Absence::Ignore);
        fs::write(home.join("share-paths.json"), "not-json").unwrap();
        assert_eq!(classify_absence(&home, &old, &[]), Absence::Ignore);
        // An empty file is damage too, not an empty map.
        fs::write(home.join("share-paths.json"), "").unwrap();
        assert!(load_share_paths(&home).is_none());
        assert_eq!(classify_listed_absence(&home, &old, &[]), Absence::Ignore);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_deleted_file_uses_the_stored_share_id() {
        let root = scratch("stored");
        let home = root.join("app");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let essay = notes.join("essay.md");
        fs::write(&essay, "words\n").unwrap();
        bind_document_id(&home, &essay, "server-doc");
        fs::remove_file(&essay).unwrap();
        assert_ne!(document_id(&essay), "server-doc");
        assert_eq!(
            classify_listed_absence(&home, &essay, &[]),
            Absence::SoftDelete("server-doc".into())
        );

        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let same_name = elsewhere.join("essay.md");
        fs::write(
            home.join("share-paths.json"),
            serde_json::json!({ "/not-the-watched-path/essay.md": "only-one" }).to_string(),
        )
        .unwrap();
        assert_eq!(
            classify_listed_absence(&home, &same_name, &[]),
            Absence::SoftDelete("only-one".into())
        );

        fs::write(
            home.join("share-paths.json"),
            serde_json::json!({
                "/a/essay.md": "id-a",
                "/b/essay.md": "id-b",
            })
            .to_string(),
        )
        .unwrap();
        match classify_listed_absence(&home, &same_name, &[]) {
            Absence::SoftDelete(id) => {
                assert_ne!(id, "id-a");
                assert_ne!(id, "id-b");
            }
            other => panic!("two names were treated as one delete: {other:?}"),
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn known_share_ids_are_mapped_documents_not_fingerprints() {
        let root = scratch("known");
        let home = root.join("app");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("share-paths.json"),
            serde_json::json!({
                "/notes/essay.md": "server-doc",
                "\u{1}server-doc": "1:abc"
            })
            .to_string(),
        )
        .unwrap();
        let ids = known_share_ids(&home);
        assert!(ids.contains("server-doc"));
        assert!(!ids.contains("1:abc"));
        assert_eq!(ids.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_invitee_file_is_a_leave_and_an_owner_file_is_an_erase() {
        let root = scratch("plan");
        let home = root.join("app");
        let shares = home.join("shares");
        fs::create_dir_all(&shares).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        let copy = shares.join(format!("{id}.md"));
        fs::write(&copy, "local words\n").unwrap();
        assert_eq!(
            plan_cloud_delete(Some(&home), &copy),
            CloudPlan::Leave(id.into())
        );
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        let essay = notes.join("essay.md");
        fs::write(&essay, "owner words\n").unwrap();
        assert_eq!(
            plan_cloud_delete(Some(&home), &essay),
            CloudPlan::Erase(vec![document_id(&essay)])
        );
        let _ = fs::remove_dir_all(&root);
    }
}
