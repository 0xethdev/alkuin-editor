//! Ask posts a structured body to the accounts function. The model key stays there.

use crate::error::AppError;
use crate::mac_only::{depart, Channel, MacOnlySet};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

const PAUSED_LINE: &str = "Writing help is paused for now. Your document is unchanged, and you can keep writing. Try again later.";
/// Same sentence as `FROZEN_LINE` in margin-copy.ts.
const FROZEN_LINE: &str = "This account is frozen.";
const TOO_MANY_ASKS_ONE: &str = "That's a lot at once. Try again in 1 second.";
const TOO_MANY_ASKS_LINE: &str = "That's a lot at once. Try again in {seconds} seconds.";
const TOO_MANY_ASKS_FALLBACK: &str = "That's a lot at once. Try again in a moment.";
const FREE_SLICE_LINE: &str = "Today's free help has run out. It comes back at {time}. A paid plan gives you more help every month.";
const FREE_MONTH_LINE: &str = "You've used all your free help. It comes back on {date}. A paid plan gives you more help every month.";
/// Same sentence as `FREE_DAY_LINE` in margin-copy.ts. Free per-account UTC day.
const FREE_DAY_LINE: &str = "You've used today's free help. It comes back at {time}. A paid plan gives you more help every month.";
/// Same sentence as `ACCOUNT_PAUSED_LINE` in margin-copy.ts.
const ACCOUNT_PAUSED_LINE: &str = "This account's writing help is paused until midnight UTC. If you think this is a mistake, email support@alkuin.app.";
/// Same sentence as `DAILY_CAP_LINE` in margin-copy.ts.
const DAILY_CAP_LINE: &str = "You've used today's asks. They come back at midnight UTC.";
const PAID_CAP_LINE: &str =
    "You've used all your help for now. It comes back on {date}. To keep going before then, buy $10 of credit. Tax is added at checkout.";
const HARD_CAP_UNDATED: &str = "You've used this month's writing help.";
const SERVER_ERROR_LINE: &str =
    "Something went wrong on our side. Your text is unchanged. Try again in a moment.";
const MODEL_UNREACHABLE_LINE: &str =
    "Alkuin can't connect right now. Your text is unchanged. Check your connection and try again.";
const ASK_CANCELLED_LINE: &str =
    "Alkuin couldn't run this ask right now, so it was cancelled. You weren't charged. Try again in a moment.";
/// Same sentence as `ASK_REFUSED_LINE` in margin-copy.ts.
const ASK_REFUSED_LINE: &str =
    "Alkuin ran this ask but couldn't finish a suggestion. Your text is unchanged.";
/// Leftover local lessons. Nothing writes this file any more.
const PREFERENCE_SHELL_FILE: &str = "redline-preferences.txt";
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RedlineIntent {
    Insert,
    Replace,
    None,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RedlineProposal {
    pub suggested_text: String,
    pub intent: RedlineIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    /// Set when this suggestion was written without web search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caution: Option<String>,
}

pub fn preference_shell_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(PREFERENCE_SHELL_FILE)
}

/// Remove a leftover copy. Missing file is fine. Nothing writes a new one.
pub fn delete_preference_shell(app_data_dir: &Path) -> Result<(), AppError> {
    let path = preference_shell_path(app_data_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::Io(error.to_string())),
    }
}

pub fn coerce_intent(raw: &str) -> RedlineIntent {
    match raw.trim().to_ascii_lowercase().as_str() {
        "insert" | "add" => RedlineIntent::Insert,
        "none" | "comment-only" | "comment_only" => RedlineIntent::None,
        _ => RedlineIntent::Replace,
    }
}

fn instruction_is_cite_shaped(instruction: &str) -> bool {
    cite_words(instruction).iter().any(|word| {
        matches!(
            word.as_str(),
            "cite" | "citation" | "citations" | "source" | "sources" | "footnote" | "footnotes"
        )
    })
}

fn normalize_cite_text(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn cite_word(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_ascii_alphanumeric())
        .to_ascii_lowercase()
}

fn cite_words(text: &str) -> Vec<String> {
    normalize_cite_text(text)
        .split_whitespace()
        .map(cite_word)
        .filter(|word| !word.is_empty())
        .collect()
}

/// The suggestion in the server's answer. An insert or a replacement with no text is
/// an error. A note needs none.
pub fn proposal_from_answer(
    intent: &str,
    suggested_text: &str,
) -> Result<RedlineProposal, AppError> {
    let proposal = RedlineProposal {
        suggested_text: suggested_text.to_string(),
        intent: coerce_intent(intent),
        notice: None,
        caution: None,
    };
    if proposal.intent != RedlineIntent::None && proposal.suggested_text.trim().is_empty() {
        return Err(AppError::Gateway(
            "No suggestion this time. Try asking again.".into(),
        ));
    }
    Ok(proposal)
}

fn install_rustls() {
    // Same lazy install as telemetry.rs: reqwest is rustls-no-provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Io(error.to_string()))
}

/// The body the accounts function accepts. No model, messages, or tool list.
pub fn structured_ask_body(profile: &str, selection: &str, instruction: &str) -> Value {
    json!({
        "profile": profile,
        "selection": selection,
        "instruction": instruction,
        "context": "",
    })
}

/// Accept, Reject, or an edit. The three texts are the call. The server drops them.
pub fn learn_body(source: &str, before: &str, suggested: &str, final_text: &str) -> Value {
    json!({
        "source": source,
        "before": before,
        // The server's name for the suggestion it sent.
        "eve": suggested,
        "final": final_text,
    })
}

pub fn ask_profile(instruction: &str) -> &'static str {
    if instruction_is_cite_shaped(instruction) {
        "cite"
    } else {
        "polish"
    }
}

fn account_ask_error(body: &Value, status: u16) -> AppError {
    account_ask_error_retry(body, status, None)
}

/// Positive whole seconds. An HTTP-date Retry-After is unknown.
/// ponytail: no date parser. Upgrade path is the `time` crate.
fn positive_seconds(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.as_bytes()[0] == b'0' {
        return None;
    }
    if !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    trimmed.parse().ok()
}

fn retry_seconds(body: &Value, header: Option<&str>) -> Option<u64> {
    if let Some(header) = header.and_then(positive_seconds) {
        return Some(header);
    }
    match body.get("retry_after") {
        Some(Value::Number(number)) => number.as_u64().filter(|seconds| *seconds > 0),
        Some(Value::String(raw)) => positive_seconds(raw),
        _ => None,
    }
}

/// `englishDate` in budget-status.ts. The desk inserts the token; it does not parse a timestamp.
fn english_date_token(raw: &str) -> bool {
    let mut parts = raw.split(' ');
    let (Some(day), Some(month), Some(year), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Ok(day_n) = day.parse::<u32>() else {
        return false;
    };
    if !(1..=31).contains(&day_n) || day.starts_with('0') {
        return false;
    }
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    MONTHS.contains(&month) && year.len() == 4 && year.bytes().all(|byte| byte.is_ascii_digit())
}

fn fill_help(template: &str, iso: &str) -> String {
    let date = local_cap_date(iso);
    let time = local_cap_time(iso);
    let mut line = template.to_string();
    line = if date.is_empty() {
        line.replace(" on {date}", "").replace("{date}", "")
    } else {
        line.replace("{date}", &date)
    };
    if time.is_empty() {
        line.replace(" at {time}", "").replace("{time}", "")
    } else {
        line.replace("{time}", &time)
    }
}

fn hard_cap_line(body: &Value) -> String {
    let plan = body.get("effective").and_then(Value::as_str).unwrap_or("");
    let iso = body
        .get("resets_at")
        .or_else(|| body.get("window_end"))
        .and_then(Value::as_str)
        .unwrap_or("");
    match plan {
        "free" => fill_help(FREE_MONTH_LINE, iso),
        "paid" | "founding" => fill_help(PAID_CAP_LINE, iso),
        _ => HARD_CAP_UNDATED.to_string(),
    }
}

fn too_many_asks(seconds: Option<u64>) -> String {
    match seconds {
        Some(1) => TOO_MANY_ASKS_ONE.to_string(),
        Some(seconds) if seconds > 1 => {
            TOO_MANY_ASKS_LINE.replace("{seconds}", &seconds.to_string())
        }
        _ => TOO_MANY_ASKS_FALLBACK.to_string(),
    }
}

#[repr(C)]
struct LocalTm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    tm_gmtoff: i64,
    tm_zone: *const i8,
}

extern "C" {
    fn localtime_r(timep: *const i64, result: *mut LocalTm) -> *mut LocalTm;
}

fn unix_from_utc(iso: &str) -> Option<i64> {
    if iso.len() < 20 || !iso.ends_with('Z') || iso.as_bytes().get(10) != Some(&b'T') {
        return None;
    }
    let year: i32 = iso.get(0..4)?.parse().ok()?;
    let month: i32 = iso.get(5..7)?.parse().ok()?;
    let day: i32 = iso.get(8..10)?.parse().ok()?;
    let hour: i32 = iso.get(11..13)?.parse().ok()?;
    let min: i32 = iso.get(14..16)?.parse().ok()?;
    let sec: i32 = iso.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let mp = if month > 2 { month - 3 } else { month + 9 } as u32;
    let doy = (153 * mp + 2) / 5 + day as u32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era as i64 * 146097 + doe as i64 - 719468;
    Some(days * 86400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64)
}

fn local_parts(iso: &str) -> Option<LocalTm> {
    let unix = unix_from_utc(iso)?;
    let mut tm = LocalTm {
        tm_sec: 0,
        tm_min: 0,
        tm_hour: 0,
        tm_mday: 0,
        tm_mon: 0,
        tm_year: 0,
        tm_wday: 0,
        tm_yday: 0,
        tm_isdst: 0,
        tm_gmtoff: 0,
        tm_zone: std::ptr::null(),
    };
    let ptr = unsafe { localtime_r(&unix, &mut tm) };
    if ptr.is_null() || tm.tm_mon < 0 || tm.tm_mon > 11 {
        return None;
    }
    Some(tm)
}

fn local_cap_date(iso: &str) -> String {
    let Some(tm) = local_parts(iso) else {
        return String::new();
    };
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{} {} {}",
        tm.tm_mday,
        months[tm.tm_mon as usize],
        tm.tm_year + 1900
    )
}

fn local_cap_time(iso: &str) -> String {
    let Some(tm) = local_parts(iso) else {
        return String::new();
    };
    format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
}

fn machine_key(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty()
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn cap_reset_line(code: &str, body: &Value) -> String {
    let iso = body.get("resets_at").and_then(Value::as_str).unwrap_or("");
    let template = match code {
        "cap_reached" => PAID_CAP_LINE,
        "free_slice_used" => FREE_SLICE_LINE,
        "free_day_reached" => FREE_DAY_LINE,
        _ => FREE_MONTH_LINE,
    };
    fill_help(template, iso)
}

/// The approved sentence for each ask state. Raw `line` text is not shown.
fn mapped_ask_line(body: &Value, status: u16, retry_after: Option<&str>) -> Option<String> {
    let code = body.get("error_code").and_then(Value::as_str).unwrap_or("");
    if code == "frozen" {
        return Some(FROZEN_LINE.to_string());
    }
    if code == "paused" {
        return Some(PAUSED_LINE.to_string());
    }
    if code == "free_cap_reached"
        || code == "free_day_reached"
        || code == "free_slice_used"
        || code == "cap_reached"
    {
        return Some(cap_reset_line(code, body));
    }
    // Daily stops are 429 too. Their wait runs to midnight UTC, which the line already names.
    if code == "account_paused" {
        return Some(ACCOUNT_PAUSED_LINE.to_string());
    }
    if code == "daily_asks" {
        return Some(DAILY_CAP_LINE.to_string());
    }
    if code == "rate" || code == "in_flight" || status == 429 {
        return Some(too_many_asks(retry_seconds(body, retry_after)));
    }
    if code == "hard_cap" {
        return Some(hard_cap_line(body));
    }
    // The cancelled sentence is the one approved line a 502 may show. Any other
    // server text, including the offline sentence, stays the server-error line.
    if body.get("line").and_then(Value::as_str) == Some(ASK_CANCELLED_LINE) {
        return Some(ASK_CANCELLED_LINE.to_string());
    }
    if code == "cost_unparsed" || status == 502 || status >= 500 {
        return Some(SERVER_ERROR_LINE.to_string());
    }
    None
}

fn account_ask_error_retry(body: &Value, status: u16, retry_after: Option<&str>) -> AppError {
    if let Some(line) = mapped_ask_line(body, status, retry_after) {
        return AppError::Gateway(line);
    }
    let code = body.get("error_code").and_then(Value::as_str).unwrap_or("");
    if let Some(line) = body.get("line").and_then(Value::as_str) {
        if !line.is_empty() && line != code && !machine_key(line) {
            return AppError::Gateway(line.to_string());
        }
    }
    let line = match code {
        "refused" => ASK_REFUSED_LINE,
        "citations" => "Help finding sources comes with Alkuin.",
        "bad_ask" => "That ask is too long or has extra fields. Try a shorter ask.",
        "bad_jwt" | "session_expired" | "session_not_found" | "signed_out" => "Sign in",
        _ if status == 401 => "Sign in",
        _ => MODEL_UNREACHABLE_LINE,
    };
    AppError::Gateway(line.to_string())
}

pub async fn post_structured_ask(
    url: &str,
    anon_key: &str,
    access_token: &str,
    original: &str,
    instruction: &str,
) -> Result<RedlineProposal, AppError> {
    post_structured_ask_in(
        url,
        anon_key,
        access_token,
        original,
        instruction,
        Path::new(""),
        &MacOnlySet::open(),
    )
    .await
}

pub async fn post_structured_ask_in(
    url: &str,
    anon_key: &str,
    access_token: &str,
    original: &str,
    instruction: &str,
    path: &Path,
    set: &MacOnlySet,
) -> Result<RedlineProposal, AppError> {
    if let Err(line) = depart(
        set,
        path,
        Channel::Assistant,
        &[(path, original)],
        || Ok(()),
    ) {
        return Err(AppError::Gateway(line));
    }
    if original.is_empty() {
        return Err(AppError::Gateway("No selected text to rewrite".into()));
    }
    let instruction = if instruction.trim().is_empty() {
        "improve"
    } else {
        instruction.trim()
    };
    if instruction.chars().count() > 500 {
        return Err(AppError::Gateway(
            "That ask is too long or has extra fields. Try a shorter ask.".into(),
        ));
    }
    let body = structured_ask_body(ask_profile(instruction), original, instruction);
    install_rustls();
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(130))
        .build()
        .map_err(|_| AppError::Gateway(MODEL_UNREACHABLE_LINE.into()))?;
    let response = super::account::accounts_request(
        &client,
        reqwest::Method::POST,
        url,
        anon_key,
        access_token,
    )
    .json(&body)
    .send()
    .await
    .map_err(|_| AppError::Gateway(MODEL_UNREACHABLE_LINE.into()))?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let text = response
        .text()
        .await
        .map_err(|_| AppError::Gateway(MODEL_UNREACHABLE_LINE.into()))?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(account_ask_error_retry(
            &value,
            status.as_u16(),
            retry_after.as_deref(),
        ));
    }
    let intent = value.get("intent").and_then(Value::as_str).unwrap_or("");
    let suggested = value
        .get("suggestedText")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut proposal = proposal_from_answer(intent, suggested)?;
    proposal.notice = value
        .get("notice")
        .and_then(Value::as_str)
        .filter(|line| !line.is_empty())
        .map(str::to_string);
    proposal.caution = value
        .get("caution")
        .and_then(Value::as_str)
        .filter(|line| !line.is_empty())
        .map(str::to_string);
    Ok(proposal)
}

/// The session is the bearer. The body cannot name a model.
/// `path` stays on this Mac. It is how depart knows which document this is.
/// Every plan can keep a document here. This command does not read the account
/// before that check.
#[tauri::command]
pub async fn redline_propose(
    app: tauri::AppHandle,
    path: String,
    original: String,
    instruction: String,
) -> Result<RedlineProposal, AppError> {
    let set = MacOnlySet::load_or_block(app.path().app_data_dir().ok().as_deref());
    let file = std::path::PathBuf::from(&path);
    if let Err(line) = depart(
        &set,
        &file,
        Channel::Assistant,
        &[(&file, original.as_str())],
        || Ok(()),
    ) {
        return Err(AppError::Gateway(line));
    }
    let token = super::account::access_token_from_app(&app)
        .await?
        .ok_or_else(|| AppError::Gateway("Sign in".into()))?;
    let (base, anon) = super::account::supabase_public()?;
    let url = super::account::accounts_url(&base, "ask");
    let result =
        post_structured_ask_in(&url, &anon, &token, &original, &instruction, &file, &set).await;
    if matches!(&result, Err(AppError::Gateway(line)) if line == "Sign in") {
        if let Some(next) = super::account::refreshed_access_token(&app, &token)
            .await
            .ok()
            .flatten()
        {
            return post_structured_ask_in(
                &url,
                &anon,
                &next,
                &original,
                &instruction,
                &file,
                &set,
            )
            .await;
        }
    }
    result
}

pub async fn post_learn(
    url: &str,
    anon_key: &str,
    access_token: &str,
    source: &str,
    before: &str,
    suggested: &str,
    final_text: &str,
) -> Result<(), AppError> {
    post_learn_in(
        url,
        anon_key,
        access_token,
        source,
        before,
        suggested,
        final_text,
        Path::new(""),
        &MacOnlySet::open(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn post_learn_in(
    url: &str,
    anon_key: &str,
    access_token: &str,
    source: &str,
    before: &str,
    suggested: &str,
    final_text: &str,
    path: &Path,
    set: &MacOnlySet,
) -> Result<(), AppError> {
    let carried = format!("{before}\n{suggested}\n{final_text}");
    // A kept document is not a lesson. Accept still finishes. Nothing is sent.
    if depart(
        set,
        path,
        Channel::Learn,
        &[(path, carried.as_str())],
        || Ok(()),
    )
    .is_err()
    {
        return Ok(());
    }
    install_rustls();
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(70))
        .build()
        .map_err(|_| AppError::Gateway(MODEL_UNREACHABLE_LINE.into()))?;
    let _ = super::account::accounts_request(
        &client,
        reqwest::Method::POST,
        url,
        anon_key,
        access_token,
    )
    .json(&learn_body(source, before, suggested, final_text))
    .send()
    .await;
    Ok(())
}

/// The session is the bearer. A miss does not undo Accept or Reject.
/// `path` stays on this Mac and is not sent.
#[tauri::command]
pub async fn redline_learn(
    app: tauri::AppHandle,
    path: String,
    source: String,
    before: String,
    suggested: String,
    final_text: String,
) -> Result<(), AppError> {
    let set = MacOnlySet::load_or_block(app.path().app_data_dir().ok().as_deref());
    let file = std::path::PathBuf::from(&path);
    let Some(token) = super::account::access_token_from_app(&app).await? else {
        return Ok(());
    };
    let (base, anon) = super::account::supabase_public()?;
    post_learn_in(
        &super::account::accounts_url(&base, "learn"),
        &anon,
        &token,
        &source,
        &before,
        &suggested,
        &final_text,
        &file,
        &set,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    #[test]
    fn a_replacement_uses_the_suggested_text() {
        let proposal = proposal_from_answer("replace", "This is important.").unwrap();
        assert_eq!(proposal.intent, RedlineIntent::Replace);
        assert_eq!(proposal.suggested_text, "This is important.");
    }

    #[test]
    fn an_insert_keeps_its_leading_space() {
        let proposal = proposal_from_answer("insert", " also true.").unwrap();
        assert_eq!(proposal.intent, RedlineIntent::Insert);
        assert_eq!(proposal.suggested_text, " also true.");
    }

    #[test]
    fn a_note_needs_no_suggested_text() {
        let proposal = proposal_from_answer("none", "").unwrap();
        assert_eq!(proposal.intent, RedlineIntent::None);
        assert_eq!(proposal.suggested_text, "");
    }

    #[test]
    fn other_spellings_map_to_the_three_intents() {
        assert_eq!(coerce_intent("add"), RedlineIntent::Insert);
        assert_eq!(coerce_intent("rewrite"), RedlineIntent::Replace);
        assert_eq!(coerce_intent("comment-only"), RedlineIntent::None);
        assert_eq!(coerce_intent(""), RedlineIntent::Replace);
        assert_eq!(
            proposal_from_answer("add", " extra").unwrap().intent,
            RedlineIntent::Insert
        );
        assert_eq!(
            proposal_from_answer("comment-only", "").unwrap().intent,
            RedlineIntent::None
        );
    }

    #[test]
    fn a_sentence_is_not_an_intent() {
        assert_eq!(
            coerce_intent("any data points we can add?"),
            RedlineIntent::Replace
        );
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn delete_preference_shell_removes_a_leftover_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = preference_shell_path(dir.path());
        assert!(path.ends_with(PREFERENCE_SHELL_FILE), "{}", path.display());
        delete_preference_shell(dir.path()).unwrap();
        std::fs::write(&path, "prefer short sentences\n").unwrap();
        delete_preference_shell(dir.path()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn structured_ask_posts_the_session_not_a_model() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 2048];
            loop {
                match stream.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(end) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&buf[..end]);
                            let length = header.lines().find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")?
                                    .trim()
                                    .parse::<usize>()
                                    .ok()
                            });
                            if buf.len() >= end + 4 + length.unwrap_or(0) {
                                break;
                            }
                        }
                    }
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
            let body = r#"{"intent":"replace","suggestedText":"Clearer."}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
        });
        let proposal = block_on(post_structured_ask(
            &format!("http://{addr}/functions/v1/accounts/ask"),
            "anon-public",
            "session-token",
            "This is really very important.",
            "improve",
        ))
        .unwrap();
        assert_eq!(proposal.intent, RedlineIntent::Replace);
        assert_eq!(proposal.suggested_text, "Clearer.");
        let request = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(request.contains("Bearer session-token"), "{request}");
        assert!(
            request.to_ascii_lowercase().contains(&format!(
                "x-region: {}",
                super::super::account::ACCOUNTS_FUNCTION_REGION
            )),
            "{request}"
        );
        assert!(
            !request.to_ascii_lowercase().contains("api_key"),
            "{request}"
        );
        assert!(!request.contains("\"model\""), "{request}");
        assert!(!request.contains("\"messages\""), "{request}");
        assert!(!request.contains("\"tools\""), "{request}");
        assert!(request.contains("\"profile\":\"polish\""), "{request}");
        assert!(
            request.contains("This is really very important."),
            "{request}"
        );
        let paused = account_ask_error(
            &json!({"error_code":"paused","line":"Writing help is paused on our end."}),
            503,
        );
        assert_eq!(paused.to_string(), PAUSED_LINE);
        let frozen = account_ask_error(&json!({"error_code":"frozen","line":"frozen"}), 403);
        assert_eq!(frozen.to_string(), FROZEN_LINE);
        let refused = account_ask_error(&json!({"error_code":"refused"}), 422);
        assert_eq!(refused.to_string(), ASK_REFUSED_LINE);
        let citations = account_ask_error(&json!({"error_code":"citations"}), 402);
        assert_eq!(
            citations.to_string(),
            "Help finding sources comes with Alkuin."
        );
        let too_long = account_ask_error(&json!({"error_code":"bad_ask"}), 400);
        assert_eq!(
            too_long.to_string(),
            "That ask is too long or has extra fields. Try a shorter ask."
        );
        let blocked = block_on(post_structured_ask(
            "http://127.0.0.1:1/functions/v1/accounts/ask",
            "anon-public",
            "session-token",
            "This is really very important.",
            &"x".repeat(501),
        ))
        .unwrap_err();
        assert_eq!(
            blocked.to_string(),
            "That ask is too long or has extra fields. Try a shorter ask."
        );
    }

    #[test]
    fn learn_posts_the_three_texts_and_not_a_model() {
        let body = learn_body("accept", "before words", "suggested words", "final words");
        assert!(body.get("model").is_none());
        assert!(body.get("messages").is_none());
        assert!(body.get("tools").is_none());
        assert_eq!(body["source"], "accept");
        assert_eq!(body["before"], "before words");
        assert_eq!(body["eve"], "suggested words");
        assert_eq!(body["final"], "final words");

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 2048];
            loop {
                match stream.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(end) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&buf[..end]);
                            let length = header.lines().find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")?
                                    .trim()
                                    .parse::<usize>()
                                    .ok()
                            });
                            if buf.len() >= end + 4 + length.unwrap_or(0) {
                                break;
                            }
                        }
                    }
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
            let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
            let _ = stream.write_all(resp.as_bytes());
        });
        block_on(post_learn(
            &format!("http://{addr}/functions/v1/accounts/learn"),
            "anon-public",
            "session-token",
            "reject",
            "the span",
            "the suggested line",
            "",
        ))
        .unwrap();
        let request = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(request.contains("Bearer session-token"), "{request}");
        assert!(
            request.to_ascii_lowercase().contains(&format!(
                "x-region: {}",
                super::super::account::ACCOUNTS_FUNCTION_REGION
            )),
            "{request}"
        );
        assert!(!request.contains("\"model\""), "{request}");
        assert!(request.contains("\"source\":\"reject\""), "{request}");
        assert!(request.contains("the span"), "{request}");
        assert!(request.contains("\"final\":\"\""), "{request}");
    }

    #[test]
    fn an_insert_or_a_replacement_with_no_text_is_an_error() {
        for intent in ["insert", "replace", ""] {
            let error = proposal_from_answer(intent, "  ").unwrap_err().to_string();
            assert!(error.contains("No suggestion"), "{intent}: {error}");
        }
    }

    #[test]
    fn ask_errors_use_the_approved_lines() {
        let date = "22 October 2026";
        let leak = "raw_code: a raw server line";
        assert!(english_date_token(date));
        assert!(!english_date_token("2026-10-22T00:00:00.000Z"));
        assert!(!english_date_token("01 October 2026"));

        let paused = account_ask_error(&json!({"error_code":"paused","line":leak}), 503);
        assert_eq!(paused.to_string(), PAUSED_LINE);
        assert!(!paused.to_string().contains("raw server line"));

        let free_cap = account_ask_error(
            &json!({"error_code":"free_cap_reached","resets_at":"2026-11-01T00:00:00Z","line":"free_cap_reached"}),
            429,
        );
        assert_eq!(
            free_cap.to_string(),
            fill_help(FREE_MONTH_LINE, "2026-11-01T00:00:00Z")
        );
        assert!(!free_cap.to_string().contains("free_cap_reached"));
        assert!(!free_cap.to_string().contains("{date}"));
        let slice = account_ask_error(
            &json!({"error_code":"free_slice_used","resets_at":"2026-10-17T00:00:00Z","line":"free_slice_used"}),
            429,
        );
        assert_eq!(
            slice.to_string(),
            fill_help(FREE_SLICE_LINE, "2026-10-17T00:00:00Z")
        );
        assert!(!slice.to_string().contains("free_slice_used"));
        assert!(!slice.to_string().contains("{time}"));

        // Daily stops are 429 but are not the too-many-asks line.
        let free_day = account_ask_error_retry(
            &json!({"error_code":"free_day_reached","resets_at":"2026-10-17T00:00:00Z","line":leak}),
            429,
            None,
        );
        assert_eq!(
            free_day.to_string(),
            fill_help(FREE_DAY_LINE, "2026-10-17T00:00:00Z")
        );
        assert!(free_day
            .to_string()
            .ends_with("A paid plan gives you more help every month."));
        assert!(!free_day.to_string().contains("{time}"));
        let free_day_undated = account_ask_error(&json!({"error_code":"free_day_reached"}), 429);
        assert_eq!(free_day_undated.to_string(), fill_help(FREE_DAY_LINE, ""));
        assert!(!free_day_undated.to_string().contains("{time}"));
        let account_paused = account_ask_error_retry(
            &json!({"error_code":"account_paused","retry_after":40000,"resets_at":"2026-10-17T00:00:00Z","line":leak}),
            429,
            Some("40000"),
        );
        assert_eq!(account_paused.to_string(), ACCOUNT_PAUSED_LINE);
        let daily_asks = account_ask_error_retry(
            &json!({"error_code":"daily_asks","retry_after":40000,"line":leak}),
            429,
            Some("40000"),
        );
        assert_eq!(daily_asks.to_string(), DAILY_CAP_LINE);
        for line in [&free_day, &free_day_undated, &account_paused, &daily_asks] {
            let line = line.to_string();
            assert!(!line.contains("lot at once"), "{line}");
            assert!(!line.contains("40000"), "{line}");
            assert!(!line.contains("raw server line"), "{line}");
        }
        let unknown_429 = account_ask_error_retry(
            &json!({"error_code":"mystery","line":leak}),
            429,
            Some("12"),
        );
        assert_eq!(
            unknown_429.to_string(),
            "That's a lot at once. Try again in 12 seconds."
        );

        let paid_cap = account_ask_error(
            &json!({"error_code":"cap_reached","resets_at":"2026-11-01T00:00:00Z","topup_available":true,"line":"cap_reached"}),
            402,
        );
        assert_eq!(
            paid_cap.to_string(),
            fill_help(PAID_CAP_LINE, "2026-11-01T00:00:00Z")
        );
        assert!(paid_cap.to_string().contains("buy $10 of credit"));
        assert!(!paid_cap.to_string().contains("cap_reached"));
        let key_only = account_ask_error(
            &json!({"error_code":"mystery","line":"free_slice_used"}),
            400,
        );
        assert!(!key_only.to_string().contains("free_slice_used"));

        let one =
            account_ask_error_retry(&json!({"error_code":"rate","line":leak}), 402, Some("1"));
        assert_eq!(
            one.to_string(),
            "That's a lot at once. Try again in 1 second."
        );
        let rate =
            account_ask_error_retry(&json!({"error_code":"rate","line":leak}), 402, Some("12"));
        assert_eq!(
            rate.to_string(),
            "That's a lot at once. Try again in 12 seconds."
        );
        let burst = account_ask_error(&json!({"error_code":"in_flight"}), 402);
        assert_eq!(burst.to_string(), TOO_MANY_ASKS_FALLBACK);
        let http_429 = account_ask_error_retry(
            &json!({"line":leak}),
            429,
            Some("Wed, 21 Oct 2026 07:28:00 GMT"),
        );
        assert_eq!(http_429.to_string(), TOO_MANY_ASKS_FALLBACK);
        let waited = account_ask_error_retry(
            &json!({"error_code":"rate","retry_after":5}),
            429,
            Some("5"),
        );
        assert_eq!(
            waited.to_string(),
            "That's a lot at once. Try again in 5 seconds."
        );
        let header_only =
            account_ask_error_retry(&json!({"error_code":"in_flight"}), 429, Some("5"));
        assert_eq!(
            header_only.to_string(),
            "That's a lot at once. Try again in 5 seconds."
        );
        let from_number =
            account_ask_error(&json!({"error_code":"in_flight","retry_after":5}), 429);
        assert_eq!(
            from_number.to_string(),
            "That's a lot at once. Try again in 5 seconds."
        );
        let older = account_ask_error(&json!({"error_code":"rate"}), 402);
        assert_eq!(older.to_string(), TOO_MANY_ASKS_FALLBACK);
        let older_wait =
            account_ask_error(&json!({"error_code":"in_flight","retry_after":"5"}), 402);
        assert_eq!(
            older_wait.to_string(),
            "That's a lot at once. Try again in 5 seconds."
        );
        let from_body = account_ask_error(&json!({"error_code":"rate","retry_after":"8"}), 402);
        assert_eq!(
            from_body.to_string(),
            "That's a lot at once. Try again in 8 seconds."
        );

        let free = account_ask_error(
            &json!({"error_code":"hard_cap","effective":"free","reset_date":date,"line":leak}),
            402,
        );
        assert_eq!(free.to_string(), fill_help(FREE_MONTH_LINE, ""));
        let paid = account_ask_error(
            &json!({"error_code":"hard_cap","effective":"paid","reset_date":date,"line":"It's back on 1 November 2026."}),
            402,
        );
        assert_eq!(paid.to_string(), fill_help(PAID_CAP_LINE, ""));
        let founding = account_ask_error(
            &json!({"error_code":"hard_cap","effective":"founding","reset_date":date}),
            402,
        );
        assert_eq!(founding.to_string(), paid.to_string());
        let unknown_plan = account_ask_error(
            &json!({"error_code":"hard_cap","reset_date":date,"line":leak}),
            402,
        );
        assert_eq!(unknown_plan.to_string(), HARD_CAP_UNDATED);
        let no_date = account_ask_error(&json!({"error_code":"hard_cap","effective":"free"}), 402);
        assert_eq!(no_date.to_string(), fill_help(FREE_MONTH_LINE, ""));

        let unparsed = account_ask_error(&json!({"error_code":"cost_unparsed","line":leak}), 502);
        assert_eq!(unparsed.to_string(), SERVER_ERROR_LINE);
        let server = account_ask_error(&json!({"error_code":"http_500","line":leak}), 500);
        assert_eq!(server.to_string(), SERVER_ERROR_LINE);
        assert!(!server.to_string().contains("cost_unparsed"));
        assert!(!server.to_string().contains("502"));
        let cancelled = account_ask_error(
            &json!({"error_code":"http_500","line":ASK_CANCELLED_LINE,"button":"Try again"}),
            502,
        );
        assert_eq!(cancelled.to_string(), ASK_CANCELLED_LINE);
        let offline_on_502 = account_ask_error(
            &json!({"error_code":"http_500","line":MODEL_UNREACHABLE_LINE}),
            502,
        );
        assert_eq!(offline_on_502.to_string(), SERVER_ERROR_LINE);

        let refused = account_ask_error(&json!({"error_code":"refused"}), 422);
        assert_eq!(refused.to_string(), ASK_REFUSED_LINE);
    }

    #[test]
    fn mac_only_text_is_not_posted_to_help_or_learn() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        let secret = "Mac-only sentence 9cab must not be posted.";
        std::fs::write(&file, secret).unwrap();
        let set = MacOnlySet::holding(vec![file.clone()]);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut buf = Vec::new();
                        let mut tmp = [0u8; 4096];
                        if let Ok(n) = stream.read(&mut tmp) {
                            buf.extend_from_slice(&tmp[..n]);
                        }
                        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
                        return;
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        if start.elapsed() > std::time::Duration::from_millis(600) {
                            let _ = tx.send(String::new());
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(_) => {
                        let _ = tx.send(String::new());
                        return;
                    }
                }
            }
        });

        let ask = format!("http://{addr}/functions/v1/accounts/ask");
        let err = block_on(post_structured_ask_in(
            &ask, "anon", "token", secret, "improve", &file, &set,
        ))
        .unwrap_err();
        assert_eq!(err.to_string(), crate::mac_only::ASSISTANT_LINE);
        assert!(!err.to_string().contains(secret));

        block_on(post_learn_in(
            &format!("http://{addr}/learn"),
            "anon",
            "token",
            "accept",
            secret,
            secret,
            secret,
            &file,
            &set,
        ))
        .unwrap();

        let seen = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        assert!(seen.is_empty(), "network carried the document: {seen}");
        assert!(!seen.contains(secret));
    }
}
