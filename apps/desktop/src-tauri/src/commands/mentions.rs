//! Mention routes. A kept document never reaches the accounts function.
//! The document id is the same id share uses. The body cannot choose it.

use crate::commands::history::document_id;
use crate::commands::shares::{app_dir, call_as, canonical_document, document_title};
use crate::error::AppError;
use crate::mac_only::MacOnlySet;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct DocumentKey {
    pub path: String,
    pub document_id: String,
}

fn kept(app: &tauri::AppHandle, path: &Path) -> bool {
    MacOnlySet::load_or_block(app_dir(app).as_deref()).blocks(path)
}

fn kept_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// `alkuin://note/<document id>/<note id>` opens that file. The id is the
/// path share already stores. Anything that is not a markdown path is ignored.
pub fn mention_file_from_link(raw: &str) -> Option<PathBuf> {
    let rest = raw.trim().strip_prefix("alkuin://note/")?;
    let mut parts = rest.split('/');
    let document = parts.next()?;
    let note = parts.next()?;
    if parts.next().is_some() || note.is_empty() || note.len() > 80 {
        return None;
    }
    if !note
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && byte != b'/')
    {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(document).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    if text.contains('\0') || !text.ends_with(".md") {
        return None;
    }
    Some(PathBuf::from(text))
}

#[tauri::command]
pub fn mention_document_ids(paths: Vec<String>) -> Vec<DocumentKey> {
    paths
        .into_iter()
        .take(500)
        .map(|path| {
            let document_id = document_id(Path::new(&path));
            DocumentKey { path, document_id }
        })
        .collect()
}

#[tauri::command]
pub async fn mention_people(app: tauri::AppHandle, path: String) -> Result<Value, AppError> {
    let file = PathBuf::from(&path);
    if kept(&app, &file) {
        return Ok(json!({ "mac_only": true, "people": [] }));
    }
    let document = canonical_document(&app, &file).await?;
    let body = call_as(
        &app,
        reqwest::Method::GET,
        &format!("mentions/people?document_id={document}"),
        None,
    )
    .await?;
    Ok(body)
}

#[tauri::command]
pub async fn mention_open(app: tauri::AppHandle) -> Result<Value, AppError> {
    let body = match call_as(&app, reqwest::Method::GET, "mentions", None).await {
        Ok(body) => body,
        Err(AppError::Account(code)) if code == "unauthorized" || code == "bad_jwt" => {
            return Ok(json!([]));
        }
        Err(error) => return Err(error),
    };
    Ok(body.get("mentions").cloned().unwrap_or(json!([])))
}

#[tauri::command]
pub async fn mention_email_pref(
    app: tauri::AppHandle,
    enabled: Option<bool>,
) -> Result<bool, AppError> {
    let body = match enabled {
        None => call_as(&app, reqwest::Method::GET, "mentions/preference", None).await?,
        Some(on) => {
            call_as(
                &app,
                reqwest::Method::POST,
                "mentions/preference",
                Some(json!({ "on": on })),
            )
            .await?
        }
    };
    Ok(body.get("on").and_then(Value::as_bool).unwrap_or(true))
}

/// `quote` is the note or the reply. Wording drops it before the request.
#[tauri::command]
pub async fn mention_write(
    app: tauri::AppHandle,
    path: String,
    action: String,
    note_id: String,
    quote: Option<String>,
    mentioned_ids: Vec<String>,
    note_author: Option<String>,
) -> Result<(), AppError> {
    let file = PathBuf::from(&path);
    if kept(&app, &file) {
        return Err(AppError::Account("mac_only".into()));
    }
    if action != "mention" && action != "reply" && action != "wording" && action != "done" {
        return Err(AppError::Account("validation_failed".into()));
    }
    let mut payload = json!({
        "action": action,
        "document_id": canonical_document(&app, &file).await?,
        "note_id": note_id,
        "title": document_title(&file, &kept_text(&file)),
        "mentioned_ids": mentioned_ids,
    });
    if action != "wording" && action != "done" {
        if let Some(text) = quote {
            payload["quote"] = json!(text);
        }
    }
    if let Some(author) = note_author {
        payload["note_author"] = json!(author);
    }
    call_as(&app, reqwest::Method::POST, "mentions", Some(payload)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::mention_file_from_link;
    use crate::commands::history::document_id;
    use std::fs;

    #[test]
    fn mention_link_round_trips_a_markdown_path() {
        let path = std::env::temp_dir().join(format!("alkuin-mention-{}.md", std::process::id()));
        fs::write(&path, "note").unwrap();
        let id = document_id(&path);
        let link = format!("alkuin://note/{id}/redline-1");
        let opened = mention_file_from_link(&link).expect("link");
        assert_eq!(opened, fs::canonicalize(&path).unwrap());
        assert!(mention_file_from_link("alkuin://share/ab").is_none());
        assert!(mention_file_from_link("alkuin://note/not-base64/redline-1").is_none());
        let _ = fs::remove_file(&path);
    }
}
