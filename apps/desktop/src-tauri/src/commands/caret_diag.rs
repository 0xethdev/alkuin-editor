use crate::error::AppError;
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

const LOG_FILE: &str = "caret-diag.log";
const FLAG_FILE: &str = "caret-diag.on";
const FILE_CAP: u64 = 1024 * 1024;
const TAIL: usize = 512 * 1024;

#[derive(Debug, Serialize)]
pub struct CaretDiagStatus {
    pub enabled: bool,
    pub pinned: bool,
    pub path: String,
}

fn env_requests_diag(value: Option<&str>) -> bool {
    value.is_some_and(|raw| raw == "1" || raw.eq_ignore_ascii_case("true"))
}

fn diag_enabled(dir: &Path, env_value: Option<&str>) -> bool {
    env_requests_diag(env_value) || dir.join(FLAG_FILE).is_file()
}

fn set_flag(dir: &Path, enabled: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(FLAG_FILE);
    if enabled {
        std::fs::write(path, b"1\n")?;
    } else if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

fn token(value: &str, max: usize) -> bool {
    value.len() <= max && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// KeyA and Digit1 rebuild the typed text. Space, Enter, Backspace, arrows,
/// and modifiers stay so the trace can still show those keys.
fn redact_key(code: &str, key_code: u64) -> (String, u64) {
    let bytes = code.as_bytes();
    if code == "Letter"
        || (bytes.len() == 4 && bytes.starts_with(b"Key") && bytes[3].is_ascii_uppercase())
    {
        return ("Letter".to_string(), 0);
    }
    if code == "Digit"
        || (bytes.len() == 6 && bytes.starts_with(b"Digit") && bytes[5].is_ascii_digit())
    {
        return ("Digit".to_string(), 0);
    }
    (code.to_string(), key_code)
}

fn pair(value: &Value) -> Option<[u64; 2]> {
    let items = value.as_array()?;
    if items.len() != 2 {
        return None;
    }
    Some([items[0].as_u64()?, items[1].as_u64()?])
}

/// Rewrite one event as the fixed field set. Anything else, including the
/// characters that were typed, is dropped.
fn validate_line(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;
    if obj.len() != 10 {
        return None;
    }
    let t = obj.get("t")?.as_str()?;
    if !matches!(t, "keydown" | "keyup" | "beforeinput" | "input" | "mark") {
        return None;
    }
    let us = obj.get("us")?.as_u64()?;
    let input_type = obj.get("inputType")?.as_str()?;
    let code = obj.get("code")?.as_str()?;
    let key_code = obj.get("keyCode")?.as_u64()?;
    let composing = obj.get("composing")?.as_bool()?;
    let before = pair(obj.get("before")?)?;
    let after = pair(obj.get("after")?)?;
    let doc = obj.get("doc")?.as_u64()?;
    let block = obj.get("block")?.as_u64()?;
    if !token(input_type, 40) || !token(code, 32) || key_code > u16::MAX as u64 {
        return None;
    }
    let (code, key_code) = redact_key(code, key_code);
    let mut out = Map::new();
    out.insert("t".into(), Value::String(t.to_string()));
    out.insert("us".into(), Value::from(us));
    out.insert("inputType".into(), Value::String(input_type.to_string()));
    out.insert("code".into(), Value::String(code));
    out.insert("keyCode".into(), Value::from(key_code));
    out.insert("composing".into(), Value::Bool(composing));
    out.insert("before".into(), serde_json::json!(before));
    out.insert("after".into(), serde_json::json!(after));
    out.insert("doc".into(), Value::from(doc));
    out.insert("block".into(), Value::from(block));
    Some(Value::Object(out).to_string())
}

fn append_if_enabled(dir: &Path, env_value: Option<&str>, batch: &str) -> std::io::Result<usize> {
    if !diag_enabled(dir, env_value) {
        return Ok(0);
    }
    append_lines(dir, batch)
}

fn append_lines(dir: &Path, batch: &str) -> std::io::Result<usize> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE);
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    let mut written = 0;
    for line in batch.lines() {
        let Some(canon) = validate_line(line.trim()) else {
            continue;
        };
        writeln!(file, "{canon}")?;
        written += 1;
    }
    drop(file);
    trim_log(&path)?;
    Ok(written)
}

fn trim_log(path: &Path) -> std::io::Result<()> {
    // ponytail: one rewrite of the tail once the file passes 1MB. A ring file
    // replaces this if a long session needs the earlier events.
    let len = std::fs::metadata(path)?.len();
    if len <= FILE_CAP {
        return Ok(());
    }
    let bytes = std::fs::read(path)?;
    let start = bytes.len().saturating_sub(TAIL);
    let skip = bytes[start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| start + index + 1)
        .unwrap_or(start);
    std::fs::write(path, &bytes[skip..])
}

fn read_log(dir: &Path) -> std::io::Result<String> {
    let path = dir.join(LOG_FILE);
    if !path.exists() {
        return Ok(String::new());
    }
    let bytes = std::fs::read(&path)?;
    let start = bytes.len().saturating_sub(TAIL);
    let skip = if start == 0 {
        0
    } else {
        bytes[start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| start + index + 1)
            .unwrap_or(start)
    };
    Ok(String::from_utf8_lossy(&bytes[skip..]).into_owned())
}

fn status_for(dir: &Path, env_value: Option<&str>) -> CaretDiagStatus {
    CaretDiagStatus {
        enabled: diag_enabled(dir, env_value),
        pinned: env_requests_diag(env_value),
        path: dir.join(LOG_FILE).to_string_lossy().into_owned(),
    }
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Io(error.to_string()))
}

fn current_env() -> Option<String> {
    std::env::var("ALKUIN_CARET_DIAG").ok()
}

#[tauri::command]
pub fn caret_diag_status(app: tauri::AppHandle) -> Result<CaretDiagStatus, AppError> {
    let dir = app_data_dir(&app)?;
    Ok(status_for(&dir, current_env().as_deref()))
}

#[tauri::command]
pub fn caret_diag_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<CaretDiagStatus, AppError> {
    let dir = app_data_dir(&app)?;
    set_flag(&dir, enabled)?;
    Ok(status_for(&dir, current_env().as_deref()))
}

#[tauri::command]
pub fn caret_diag_append(app: tauri::AppHandle, lines: String) -> Result<usize, AppError> {
    let dir = app_data_dir(&app)?;
    append_if_enabled(&dir, current_env().as_deref(), &lines).map_err(AppError::from)
}

#[tauri::command]
pub fn caret_diag_copy(app: tauri::AppHandle) -> Result<String, AppError> {
    read_log(&app_data_dir(&app)?).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"t":"keydown","us":1500,"inputType":"","code":"Space","keyCode":32,"composing":false,"before":[2,2],"after":[2,2],"doc":3,"block":2}"#;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "caret-diag-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn keeps_timing_and_drops_typed_text() {
        let kept = validate_line(GOOD).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&kept).unwrap(),
            serde_json::from_str::<Value>(GOOD).unwrap()
        );
        let leaked = GOOD.trim_end_matches('}').to_string() + r#","text":"secret"}"#;
        assert!(validate_line(&leaked).is_none());
        assert!(validate_line(
            r#"{"t":"input","us":1,"inputType":"secret words","code":"","keyCode":0,"composing":false,"before":[0,0],"after":[1,1],"doc":1,"block":1}"#
        )
        .is_none());
    }

    #[test]
    fn flag_and_env_are_the_only_switches() {
        let dir = scratch("flag");
        assert!(!diag_enabled(&dir, None));
        set_flag(&dir, true).unwrap();
        assert!(diag_enabled(&dir, None));
        set_flag(&dir, false).unwrap();
        assert!(!diag_enabled(&dir, None));
        assert!(diag_enabled(&dir, Some("1")));
        assert!(diag_enabled(&dir, Some("true")));
        assert!(!diag_enabled(&dir, Some("0")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn append_skips_a_line_that_carries_text() {
        let dir = scratch("append");
        let batch = format!("{GOOD}\n{{\"text\":\"hello\"}}\n");
        assert_eq!(append_lines(&dir, &batch).unwrap(), 1);
        let log = read_log(&dir).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(log.trim()).unwrap(),
            serde_json::from_str::<Value>(GOOD).unwrap()
        );
        assert!(!log.contains("hello"));
        let off = scratch("off");
        assert_eq!(append_if_enabled(&off, None, GOOD).unwrap(), 0);
        assert!(!off.join(LOG_FILE).exists());
        let on = scratch("on");
        assert_eq!(append_if_enabled(&on, Some("1"), GOOD).unwrap(), 1);
        let written = read_log(&on).unwrap();
        assert!(written.contains("Space"));
        assert!(!written.contains("secret"));
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(off);
        let _ = std::fs::remove_dir_all(on);
    }

    #[test]
    fn letter_and_digit_codes_never_reach_the_log() {
        let dir = scratch("redact");
        let batch = r#"{"t":"keydown","us":1500,"inputType":"","code":"KeyA","keyCode":65,"composing":false,"before":[2,2],"after":[3,3],"doc":3,"block":2}
{"t":"keyup","us":1600,"inputType":"","code":"KeyZ","keyCode":90,"composing":false,"before":[3,3],"after":[3,3],"doc":3,"block":2}
{"t":"keydown","us":1700,"inputType":"","code":"Digit1","keyCode":49,"composing":false,"before":[3,3],"after":[4,4],"doc":3,"block":2}
{"t":"keydown","us":1800,"inputType":"","code":"Digit0","keyCode":48,"composing":false,"before":[4,4],"after":[5,5],"doc":3,"block":2}
{"t":"keydown","us":1910,"inputType":"","code":"Space","keyCode":32,"composing":false,"before":[5,5],"after":[6,6],"doc":3,"block":2}
{"t":"keydown","us":2000,"inputType":"","code":"Enter","keyCode":13,"composing":false,"before":[6,6],"after":[7,7],"doc":3,"block":2}
{"t":"keydown","us":2100,"inputType":"","code":"Backspace","keyCode":8,"composing":false,"before":[7,7],"after":[6,6],"doc":3,"block":2}
{"t":"keydown","us":2200,"inputType":"","code":"ArrowLeft","keyCode":37,"composing":false,"before":[6,6],"after":[5,5],"doc":3,"block":2}
{"t":"keydown","us":2300,"inputType":"","code":"ShiftLeft","keyCode":16,"composing":false,"before":[5,5],"after":[5,5],"doc":3,"block":2}
{"t":"keydown","us":1510,"inputType":"","code":"Letter","keyCode":65,"composing":false,"before":[2,2],"after":[2,2],"doc":3,"block":2}
{"t":"keydown","us":1710,"inputType":"","code":"Digit","keyCode":49,"composing":false,"before":[3,3],"after":[3,3],"doc":3,"block":2}
{"t":"mark","us":2400,"inputType":"","code":"","keyCode":0,"composing":false,"before":[5,5],"after":[5,5],"doc":3,"block":2}
"#;
        assert_eq!(append_lines(&dir, batch).unwrap(), 12);
        let log = read_log(&dir).unwrap();
        assert!(!log.contains("KeyA"));
        assert!(!log.contains("KeyZ"));
        assert!(!log.contains("Digit1"));
        assert!(!log.contains("Digit0"));
        assert!(!log.contains("65"));
        assert!(!log.contains("90"));
        assert!(!log.contains("49"));
        assert!(!log.contains("48"));
        assert!(log.contains("\"code\":\"Letter\""));
        assert!(log.contains("\"code\":\"Digit\""));
        assert!(log.contains("\"keyCode\":0"));
        assert!(log.contains("\"code\":\"Space\""));
        assert!(log.contains("\"keyCode\":32"));
        assert!(log.contains("\"code\":\"Enter\""));
        assert!(log.contains("\"keyCode\":13"));
        assert!(log.contains("\"code\":\"Backspace\""));
        assert!(log.contains("\"keyCode\":8"));
        assert!(log.contains("\"code\":\"ArrowLeft\""));
        assert!(log.contains("\"keyCode\":37"));
        assert!(log.contains("\"code\":\"ShiftLeft\""));
        assert!(log.contains("\"keyCode\":16"));
        assert!(log.contains("\"t\":\"mark\""));
        assert!(log.contains("\"doc\":3"));
        assert!(log.contains("\"block\":2"));
        assert!(!log.contains("secret"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
