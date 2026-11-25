//! Command-path proof that a document on the mac-only list never reaches a socket.
//!
//! `set_kept` is the write `mac_only_set` uses. The kept note is shorter than
//! the text scan's floor, so only the path in `mac-only.json` can stop a send.

use crate::commands::account::accounts_url;
use crate::commands::git::publish_file_with;
use crate::commands::history::{history_send_at, HistoryConfig};
use crate::commands::redline::{post_learn_in, post_structured_ask_in};
use crate::mac_only::{set_kept, MacOnlySet, ASSISTANT_LINE, SHARE_LINE, UNREADABLE_LINE};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Whole note, and the highlight. Shorter than the 12-character text scan.
const KEPT: &str = "Qm7k9cab";
const SELECT: &str = "ctl9cab-span";
const CONTROL_FILE: &str = "Control note ctl9cab-span may leave this Mac.";
const UNREAD: &str = "Unread note unr9cabZZ must not leave.";

struct Hit {
    raw: Vec<u8>,
    body: Vec<u8>,
}

struct Capture {
    port: u16,
    hits: Arc<Mutex<Vec<Hit>>>,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl Capture {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let hits_thread = Arc::clone(&hits);
        let stop_thread = Arc::clone(&stop);
        let join = thread::spawn(move || serve(listener, hits_thread, stop_thread));
        Self {
            port,
            hits,
            stop,
            join: Some(join),
        }
    }

    fn len(&self) -> usize {
        self.hits
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .len()
    }

    fn contains(&self, needle: &str) -> bool {
        let needle = needle.as_bytes();
        self.hits
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .iter()
            .any(|hit| {
                hit.raw.windows(needle.len()).any(|window| window == needle)
                    || hit
                        .body
                        .windows(needle.len())
                        .any(|window| window == needle)
            })
    }

    fn body_contains_since(&self, from: usize, needle: &str) -> bool {
        let needle = needle.as_bytes();
        self.hits
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .iter()
            .skip(from)
            .any(|hit| {
                hit.body
                    .windows(needle.len())
                    .any(|window| window == needle)
            })
    }

    fn debug(&self) -> String {
        self.hits
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .iter()
            .map(|hit| {
                let raw = String::from_utf8_lossy(&hit.raw);
                raw.chars().take(400).collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n---\n")
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}

fn serve(listener: TcpListener, hits: Arc<Mutex<Vec<Hit>>>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_millis(200)))
                    .ok();
                let mut raw = Vec::new();
                let mut tmp = [0u8; 8192];
                let mut continued = false;
                let start = Instant::now();
                loop {
                    if request_finished(&raw) || start.elapsed() > Duration::from_secs(2) {
                        break;
                    }
                    match stream.read(&mut tmp) {
                        Ok(0) => break,
                        Ok(n) => {
                            raw.extend_from_slice(&tmp[..n]);
                            if !continued && wants_continue(&raw) && !request_finished(&raw) {
                                let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
                                continued = true;
                            }
                        }
                        Err(err)
                            if err.kind() == std::io::ErrorKind::WouldBlock
                                || err.kind() == std::io::ErrorKind::TimedOut =>
                        {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
                let body = body_of(&raw).to_vec();
                hits.lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .push(Hit { raw, body });
                let json = r#"{"intent":"none","suggestedText":"ok"}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                    json.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn content_length(header: &str) -> Option<usize> {
    header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            value.trim().parse().ok()
        } else {
            None
        }
    })
}

fn request_finished(buf: &[u8]) -> bool {
    let Some(at) = header_end(buf) else {
        return false;
    };
    let header = String::from_utf8_lossy(&buf[..at]);
    match content_length(&header) {
        Some(len) => buf.len() >= at + len,
        None => true,
    }
}

fn wants_continue(buf: &[u8]) -> bool {
    let Some(at) = header_end(buf) else {
        return false;
    };
    String::from_utf8_lossy(&buf[..at])
        .to_ascii_lowercase()
        .contains("expect: 100-continue")
}

fn body_of(buf: &[u8]) -> &[u8] {
    let Some(at) = header_end(buf) else {
        return buf;
    };
    let header = String::from_utf8_lossy(&buf[..at]);
    match content_length(&header) {
        Some(len) => {
            let end = (at + len).min(buf.len());
            &buf[at..end]
        }
        None => &[],
    }
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Redline")
        .env("GIT_AUTHOR_EMAIL", "redline@local")
        .env("GIT_COMMITTER_NAME", "Redline")
        .env("GIT_COMMITTER_EMAIL", "redline@local")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn repo(text: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-b", "main"]);
    git(dir.path(), &["config", "user.email", "redline@local"]);
    git(dir.path(), &["config", "user.name", "Redline"]);
    // ponytail: caps a listener that accepts and then stalls. The server in
    // this test answers at once.
    git(dir.path(), &["config", "http.lowSpeedLimit", "1"]);
    git(dir.path(), &["config", "http.lowSpeedTime", "5"]);
    let file = dir.path().join("note.md");
    fs_write(&file, text);
    (dir, file)
}

fn fs_write(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
}

fn point_origin(repo: &Path, port: u16) {
    let url = format!("http://127.0.0.1:{port}/repo.git");
    git(repo, &["remote", "add", "origin", &url]);
}

fn history_config(port: u16) -> HistoryConfig {
    HistoryConfig {
        url: Some(format!("http://127.0.0.1:{port}")),
        token: Some("token".into()),
        allow_insecure: true,
        device_id: "device-proof".into(),
    }
}

#[test]
fn kept_document_on_the_mac_only_list_does_not_leave() {
    assert!(
        KEPT.chars().count() < 12,
        "a longer note would also be stopped by the text scan"
    );
    assert!(CONTROL_FILE.contains(SELECT));
    assert!(!CONTROL_FILE.contains(KEPT));
    assert!(!UNREAD.contains(KEPT) && !UNREAD.contains(SELECT));

    let capture = Capture::start();
    let port = capture.port;
    let home = tempfile::tempdir().unwrap();
    let (kept_repo, kept_file) = repo(KEPT);
    set_kept(home.path(), &kept_file, true).unwrap();
    let listed = std::fs::read_to_string(home.path().join("mac-only.json")).unwrap();
    let canon = kept_file.canonicalize().unwrap();
    assert!(listed.contains(&canon.display().to_string()), "{listed}");
    let set = MacOnlySet::load(home.path());
    assert!(set.blocks(&kept_file));
    assert!(!set.is_unreadable());
    point_origin(kept_repo.path(), port);

    let base = format!("http://127.0.0.1:{port}");
    let ask = accounts_url(&base, "ask");
    let learn = accounts_url(&base, "learn");
    let config = history_config(port);

    let err = block_on(post_structured_ask_in(
        &ask, "anon", "token", KEPT, "improve", &kept_file, &set,
    ))
    .unwrap_err();
    assert_eq!(err.to_string(), ASSISTANT_LINE);
    assert!(!err.to_string().contains(KEPT));

    block_on(post_learn_in(
        &learn, "anon", "token", "accept", KEPT, KEPT, KEPT, &kept_file, &set,
    ))
    .unwrap();

    let outcome = block_on(history_send_at(
        home.path(),
        &kept_file,
        true,
        &config,
        None,
    ))
    .unwrap();
    assert!(
        outcome.refused && !outcome.sent && !outcome.waiting,
        "{outcome:?}"
    );
    let outbox = std::fs::read_to_string(home.path().join("history-outbox")).unwrap_or_default();
    assert!(!outbox.contains(KEPT), "{outbox}");

    let published = publish_file_with(&kept_file, "share the note", &set).unwrap();
    assert!(!published.pushed, "{published:?}");
    assert_eq!(published.error.as_deref(), Some(SHARE_LINE));
    assert!(!published.error.as_deref().unwrap_or("").contains(KEPT));

    assert_eq!(
        capture.len(),
        0,
        "kept note reached the listener:\n{}",
        capture.debug()
    );
    assert!(!capture.contains(KEPT));

    let (ctrl_repo, ctrl_file) = repo(CONTROL_FILE);
    point_origin(ctrl_repo.path(), port);
    let set = MacOnlySet::load(home.path());
    assert!(!set.blocks(&ctrl_file));

    let before = capture.len();
    block_on(post_structured_ask_in(
        &ask, "anon", "token", SELECT, "improve", &ctrl_file, &set,
    ))
    .unwrap();
    assert!(
        capture.body_contains_since(before, SELECT),
        "unmarked help did not reach the listener:\n{}",
        capture.debug()
    );

    let before = capture.len();
    block_on(post_learn_in(
        &learn,
        "anon",
        "token",
        "accept",
        SELECT,
        SELECT,
        CONTROL_FILE,
        &ctrl_file,
        &set,
    ))
    .unwrap();
    assert!(
        capture.body_contains_since(before, SELECT),
        "unmarked lesson did not reach the listener:\n{}",
        capture.debug()
    );
    assert!(capture.body_contains_since(before, "may leave this Mac"));

    let before = capture.len();
    let outcome = block_on(history_send_at(
        home.path(),
        &ctrl_file,
        true,
        &config,
        None,
    ))
    .unwrap();
    assert!(outcome.sent, "{outcome:?}");
    assert!(
        capture.body_contains_since(before, "may leave this Mac"),
        "unmarked history did not reach the listener:\n{}",
        capture.debug()
    );

    let before = capture.len();
    let published = publish_file_with(&ctrl_file, "share the note", &set).unwrap();
    assert!(
        capture.len() > before,
        "unmarked share did not reach the listener: {published:?}\n{}",
        capture.debug()
    );
    assert_ne!(published.error.as_deref(), Some(SHARE_LINE));
    assert!(!capture.contains(KEPT), "{}", capture.debug());

    fs_write(&home.path().join("mac-only.json"), "not-json");
    let set = MacOnlySet::load(home.path());
    assert!(set.is_unreadable());
    let (bad_repo, bad_file) = repo(UNREAD);
    point_origin(bad_repo.path(), port);
    let before = capture.len();

    let err = block_on(post_structured_ask_in(
        &ask, "anon", "token", UNREAD, "improve", &bad_file, &set,
    ))
    .unwrap_err();
    assert_eq!(err.to_string(), UNREADABLE_LINE);
    assert!(!err.to_string().contains(UNREAD));

    block_on(post_learn_in(
        &learn, "anon", "token", "accept", UNREAD, UNREAD, UNREAD, &bad_file, &set,
    ))
    .unwrap();

    let outcome = block_on(history_send_at(home.path(), &bad_file, true, &config, None)).unwrap();
    assert!(outcome.refused && !outcome.sent, "{outcome:?}");

    let published = publish_file_with(&bad_file, "share the note", &set).unwrap();
    assert!(!published.pushed, "{published:?}");
    assert_eq!(published.error.as_deref(), Some(UNREADABLE_LINE));

    assert_eq!(
        capture.len(),
        before,
        "unreadable list still sent:\n{}",
        capture.debug()
    );
    assert!(!capture.contains(UNREAD), "{}", capture.debug());
    assert!(!capture.contains(KEPT), "{}", capture.debug());
}
