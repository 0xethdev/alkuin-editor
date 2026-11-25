//! Native git: status, a one-file Accept commit, an optional push, and a
//! fetch that fast-forwards or merges when a remote exists.
//!
//! Accept writes the file, then `commit_file` (`git add` + `git commit` of
//! that path only). Share (`publish_file`) is the explicit push and commits
//! first only when the file is still dirty. Neither path undoes the disk write.
//!
//! A lock or network miss is recorded in `.git/desk-queue` and replayed
//! by `flush_queue`. A leftover `.git/redline-queue` is renamed on the next
//! read. That file lists git CLI ops. It does not store document
//! bytes. Permanent misses (no repo, nothing to commit, rejected push) are
//! not kept. A missed fetch is the same kind of line (`pull`). Folder open
//! flushes commit and push first, then `pull_folder`. A conflict is not queued.

use crate::error::AppError;
use crate::mac_only::{
    canon, canon_parent, depart, Channel, MacOnlySet, DELETE_COMMIT_MESSAGE, DELETE_DONE,
    DELETE_FAILED, DELETE_NONE, FOLDER_LINE, UNREADABLE_LINE,
};
use serde::Serialize;
use std::cell::Cell;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;

// ponytail: one process lock for every repo queue file. Two windows can
// clobber a line; upgrade is a per-repo file lock.
static GIT_QUEUE_LOCK: Mutex<()> = Mutex::new(());

thread_local! {
    static BACKGROUND_GIT: Cell<bool> = const { Cell::new(false) };
}

struct BackgroundGit {
    prev: bool,
}

impl BackgroundGit {
    fn enter() -> Self {
        Self {
            prev: BACKGROUND_GIT.with(|flag| flag.replace(true)),
        }
    }
}

impl Drop for BackgroundGit {
    fn drop(&mut self) {
        BACKGROUND_GIT.with(|flag| flag.set(self.prev));
    }
}

fn background_git() -> bool {
    BACKGROUND_GIT.with(|flag| flag.get())
}

const GIT_SECURE: &[&str] = &[
    "-c",
    // A folder that is itself a git directory (an embedded bare repo) is not used.
    "safe.bareRepository=explicit",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.ext.allow=never",
];

const GIT_SECURE_BACKGROUND: &[&str] = &[
    "-c",
    "safe.bareRepository=explicit",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    // System ssh for fetch. A background push clears this so a planted queue cannot use the writer's key.
    "core.sshCommand=ssh",
    "-c",
    "core.askPass=",
    "-c",
    "core.gitProxy=",
];

/// Every git call. `safe.directory` stays at git's default, so a repository
/// owned by another user is refused. Setting `safe.directory=*` would run git there.
fn git_cmd(root: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(if background_git() {
        GIT_SECURE_BACKGROUND
    } else {
        GIT_SECURE
    })
    .current_dir(root)
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_CONFIG_NOSYSTEM", "1")
    .env_remove("GIT_CONFIG_COUNT")
    .env_remove("GIT_CONFIG_PARAMETERS");
    cmd
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitFileStatus {
    pub repo_root: Option<String>,
    pub clean: bool,
    pub porcelain: String,
    pub diff: String,
    pub error: Option<String>,
    /// True when the repo has a remote. The desk uses this to show Share.
    /// The strings above stay off the margin card.
    pub sharing: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitCommitResult {
    pub committed: bool,
    pub commit_sha: Option<String>,
    pub error: Option<String>,
    /// True when this failure is a lock or network miss worth retrying.
    #[serde(default)]
    pub retry: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitPublishResult {
    pub committed: bool,
    pub pushed: bool,
    pub commit_sha: Option<String>,
    pub error: Option<String>,
    /// True when the push (or the commit it still needs) should be retried.
    #[serde(default)]
    pub retry: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitPullResult {
    pub updated: bool,
    pub skipped: bool,
    pub conflict: bool,
    pub error: Option<String>,
    /// True when the fetch missed the network and should be tried again.
    /// A conflict is never retried.
    #[serde(default)]
    pub retry: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnlineDelete {
    pub deleted: bool,
    pub missing: bool,
    pub message: String,
}

fn empty_status(error: Option<String>) -> GitFileStatus {
    GitFileStatus {
        repo_root: None,
        clean: true,
        porcelain: String::new(),
        diff: String::new(),
        error,
        sharing: false,
    }
}

fn has_publish_target(root: &Path) -> bool {
    let Ok(output) = git_output(root, &["remote"]) else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    stdout_trim(&output)
        .lines()
        .any(|line| !line.trim().is_empty())
}

fn git_output(root: &Path, args: &[&str]) -> Result<std::process::Output, AppError> {
    git_cmd(root)
        .args(args)
        .output()
        .map_err(|e| AppError::Io(format!("git: {e}")))
}

fn stdout_trim(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn stderr_trim(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

pub(crate) fn repo_root_from_file(path: &Path) -> Option<PathBuf> {
    // A dotfiles repository at ~ is not a writing folder.
    repo_root_with_ceiling(path, std::env::var_os("HOME").as_deref())
}

/// Git never looks for `.git` in a ceiling directory, so a repository rooted
/// exactly there is not found. Repositories below it are unaffected.
fn repo_root_with_ceiling(path: &Path, ceiling: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let dir = if path.is_dir() { path } else { path.parent()? };
    let mut cmd = git_cmd(dir);
    cmd.args(["rev-parse", "--show-toplevel"]);
    if let Some(ceiling) = ceiling {
        cmd.env("GIT_CEILING_DIRECTORIES", ceiling);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let root = stdout_trim(&output);
    if root.is_empty() {
        None
    } else {
        Some(PathBuf::from(root))
    }
}

/// Repo-local settings that make git run a program. Background sync does not run in such a folder.
const COMMAND_KEYS: &[&str] = &[
    "core.sshcommand",
    "core.gitproxy",
    "core.askpass",
    "core.fsmonitor",
    "core.hookspath",
    "credential.helper",
    "diff.external",
    "gpg.program",
    // shortcut: any extensions.worktreeConfig skips background sync, even a false value. Read config.worktree when a vault uses worktrees.
    "extensions.worktreeconfig",
];
const COMMAND_SECTIONS: &[&str] = &["remote.", "filter.", "merge.", "diff."];
const COMMAND_SUFFIXES: &[&str] = &[
    ".uploadpack",
    ".receivepack",
    ".smudge",
    ".clean",
    ".process",
    ".driver",
    ".textconv",
];

/// The first repo-local key that would run a command, if any. Only the key
/// name is read, never its value. An `include` or `includeIf` is refused even
/// when its condition does not match; `--includes` still lists a file that does.
fn local_command_config(root: &Path) -> Option<String> {
    let output = git_output(
        root,
        &["config", "--local", "--includes", "--name-only", "--list"],
    )
    .ok()?;
    if !output.status.success() {
        // An unreadable config is not proof the folder is safe.
        return Some("config".into());
    }
    stdout_trim(&output)
        .lines()
        .map(str::to_ascii_lowercase)
        .find(|key| {
            key.starts_with("include.")
                || key.starts_with("includeif.")
                || COMMAND_KEYS.contains(&key.as_str())
                || (COMMAND_SECTIONS
                    .iter()
                    .any(|section| key.starts_with(section))
                    && COMMAND_SUFFIXES.iter().any(|suffix| key.ends_with(suffix)))
        })
}

/// `root` comes from git and is physical, so both sides are compared in
/// canonical form; a path given through a symlink still comes out relative.
fn relative_to_repo(path: &Path, root: &Path) -> PathBuf {
    let path = canon_parent(path);
    let root = canon(root);
    path.strip_prefix(&root)
        .map(Path::to_path_buf)
        .unwrap_or(path)
}

pub fn file_status(path: &Path) -> Result<GitFileStatus, AppError> {
    let _background = BackgroundGit::enter();
    if !path.exists() {
        return Ok(empty_status(Some("file not found".into())));
    }
    // Folder open only needs to know whether a remote exists. A directory
    // probe does not diff the tree.
    if path.is_dir() {
        let Some(root) = repo_root_from_file(path) else {
            return Ok(empty_status(Some("not a git repository".into())));
        };
        return Ok(GitFileStatus {
            repo_root: Some(root.to_string_lossy().into_owned()),
            clean: true,
            porcelain: String::new(),
            diff: String::new(),
            error: None,
            sharing: has_publish_target(&root),
        });
    }
    let Some(root) = repo_root_from_file(path) else {
        return Ok(empty_status(Some("not a git repository".into())));
    };
    let rel = relative_to_repo(path, &root);
    let rel_str = rel.to_string_lossy();

    let porcelain_out = git_output(&root, &["status", "--porcelain", "--", rel_str.as_ref()])?;
    if !porcelain_out.status.success() {
        return Ok(GitFileStatus {
            repo_root: Some(root.to_string_lossy().into_owned()),
            clean: true,
            porcelain: String::new(),
            diff: String::new(),
            error: Some(stderr_trim(&porcelain_out)),
            sharing: has_publish_target(&root),
        });
    }
    let porcelain = stdout_trim(&porcelain_out);
    let diff_out = git_output(
        &root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            rel_str.as_ref(),
        ],
    )?;
    let diff = String::from_utf8_lossy(&diff_out.stdout).to_string();

    Ok(GitFileStatus {
        repo_root: Some(root.to_string_lossy().into_owned()),
        clean: porcelain.is_empty(),
        porcelain,
        diff,
        error: None,
        sharing: has_publish_target(&root),
    })
}

fn github_token() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .or_else(|_| std::env::var("GH_TOKEN"))
        .ok()
        .filter(|s| !s.is_empty())
}

// Scheme https and host exactly github.com. Scoped so a rewrite cannot carry it.
fn github_bearer_config(url: &str, token: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return None;
    }
    Some(format!(
        "http.https://github.com/.extraHeader=AUTHORIZATION: bearer {token}"
    ))
}

fn origin_push(root: &Path, refspec: &str, set_upstream: bool) -> Result<(), String> {
    let url = remote_url(root, "origin")
        .ok_or_else(|| "no origin remote (GitHub publish skipped)".to_string())?;
    let mut cmd = git_cmd(root);
    // ponytail: caps a dead HTTPS origin. SSH still uses ssh's own timeout.
    cmd.args(["-c", "http.connectTimeout=2"]);
    if background_git() {
        // Replay of .git/desk-queue must not authenticate a push with the writer's SSH key.
        cmd.args(["-c", "core.sshCommand="]);
        cmd.env_remove("GIT_SSH_COMMAND");
        cmd.env_remove("GIT_SSH");
    }
    // Token is never returned in errors.
    if let Some(token) = github_token() {
        if let Some(header) = github_bearer_config(&url, &token) {
            cmd.args(["-c", &header]);
        }
    }
    if set_upstream {
        cmd.args(["push", "-u", "origin", refspec]);
    } else {
        cmd.args(["push", "origin", refspec]);
    }
    let output = cmd.output().map_err(|e| format!("git push: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let err = stderr_trim(&output);
        Err(if err.is_empty() {
            "git push failed".into()
        } else {
            err
        })
    }
}

fn current_branch(root: &Path) -> Option<String> {
    let output = git_output(root, &["branch", "--show-current"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let name = stdout_trim(&output);
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn rev_ok(root: &Path, rev: &str) -> bool {
    git_output(root, &["rev-parse", "--verify", "--quiet", rev])
        .ok()
        .is_some_and(|output| output.status.success() && !stdout_trim(&output).is_empty())
}

fn upstream_ref(root: &Path) -> Option<String> {
    let branch = current_branch(root)?;
    let named = format!("origin/{branch}");
    if rev_ok(root, &named) {
        return Some(named);
    }
    if rev_ok(root, "origin/HEAD") {
        return Some("origin/HEAD".to_string());
    }
    None
}

/// The remote branch an upstream ref names. `origin/HEAD` resolves to the remote default.
fn upstream_branch(root: &Path, upstream: &str) -> Option<String> {
    if upstream == "origin/HEAD" {
        let output = git_output(
            root,
            &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        )
        .ok()?;
        if !output.status.success() {
            return None;
        }
        return stdout_trim(&output)
            .strip_prefix("origin/")
            .map(str::to_string);
    }
    upstream.strip_prefix("origin/").map(str::to_string)
}

fn path_in_tree(root: &Path, rev: &str, rel: &str) -> bool {
    let spec = format!("{rev}:{rel}");
    git_output(root, &["cat-file", "-e", &spec])
        .ok()
        .is_some_and(|output| output.status.success())
}

fn blob_by_sha(root: &Path, sha: &str) -> Option<String> {
    let kind = git_output(root, &["cat-file", "-t", sha]).ok()?;
    if !kind.status.success() || stdout_trim(&kind) != "blob" {
        return None;
    }
    let body = git_output(root, &["cat-file", "-p", sha]).ok()?;
    if !body.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&body.stdout).into_owned())
}

/// Blobs a push of HEAD would send. Includes a document that was saved and
/// then removed, because that text is still in the history being sent.
/// ponytail: one `cat-file` pair per outgoing object when this folder holds a
/// kept document. Upgrade is a path-limited pack, which git cannot do.
fn push_payloads(root: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let mut spec = vec![
        "rev-list".to_string(),
        "--objects".to_string(),
        "HEAD".to_string(),
    ];
    if let Some(upstream) = upstream_ref(root) {
        spec.push("--not".to_string());
        spec.push(upstream);
    }
    let args: Vec<&str> = spec.iter().map(String::as_str).collect();
    let output = git_output(root, &args).map_err(|_| FOLDER_LINE.to_string())?;
    if !output.status.success() {
        return Err(FOLDER_LINE.to_string());
    }
    let mut out = Vec::new();
    for line in stdout_trim(&output).lines() {
        let mut parts = line.splitn(2, ' ');
        let Some(sha) = parts.next() else { continue };
        let Some(rel) = parts.next().map(str::trim).filter(|rel| !rel.is_empty()) else {
            continue;
        };
        let Some(text) = blob_by_sha(root, sha) else {
            continue;
        };
        out.push((root.join(rel), text));
    }
    Ok(out)
}

/// Upload HEAD. Document bytes pass through `depart` first. The upload runs
/// only when `depart` allows every payload.
fn push_origin(root: &Path, set: &MacOnlySet, requested: &Path) -> Result<(), String> {
    if set.is_unreadable() {
        return Err(UNREADABLE_LINE.to_string());
    }
    if !set.affects(root) {
        return origin_push(root, "HEAD", true);
    }
    let payloads = push_payloads(root)?;
    let bodies: Vec<(&Path, &str)> = payloads
        .iter()
        .map(|(path, text)| (path.as_path(), text.as_str()))
        .collect();
    depart(set, requested, Channel::Share, &bodies, || {
        origin_push(root, "HEAD", true)
    })
}

fn git_indexed(root: &Path, index: &Path, args: &[&str]) -> Result<std::process::Output, AppError> {
    git_cmd(root)
        .args(args)
        .env("GIT_INDEX_FILE", index)
        .output()
        .map_err(|e| AppError::Io(format!("git: {e}")))
}

fn tree_has_path(root: &Path, tree: &str, rel: &str) -> bool {
    git_output(root, &["ls-tree", "-r", "--name-only", tree])
        .ok()
        .is_some_and(|output| {
            output.status.success() && stdout_trim(&output).lines().any(|line| line == rel)
        })
}

fn hash_bytes(root: &Path, bytes: &[u8]) -> Option<String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = git_cmd(root)
        .args(["hash-object", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.as_mut()?.write_all(bytes).ok()?;
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if hash.is_empty() {
        None
    } else {
        Some(hash)
    }
}

fn new_objects_include(root: &Path, commit: &str, upstream: &str, blob: &str) -> bool {
    let output = git_output(root, &["rev-list", "--objects", commit, "--not", upstream]).ok();
    let Some(output) = output else {
        return true;
    };
    if !output.status.success() {
        return true;
    }
    stdout_trim(&output)
        .lines()
        .any(|line| line.split_whitespace().next() == Some(blob))
}

fn online_missing() -> OnlineDelete {
    OnlineDelete {
        deleted: false,
        missing: true,
        message: DELETE_NONE.to_string(),
    }
}

fn online_failed() -> OnlineDelete {
    OnlineDelete {
        deleted: false,
        missing: false,
        message: DELETE_FAILED.to_string(),
    }
}

/// True when a shared folder already has this document on its current tip.
pub fn online_copy_exists(path: &Path) -> bool {
    let Some((root, rel)) = prepare_repo_file(path) else {
        return false;
    };
    if !has_publish_target(&root) {
        return false;
    }
    if let Some(upstream) = upstream_ref(&root) {
        return path_in_tree(&root, &upstream, &rel);
    }
    git_output(&root, &["ls-files", "--error-unmatch", "--", &rel])
        .ok()
        .is_some_and(|output| output.status.success())
}

/// Remove the current online copy without uploading this document's bytes.
/// Older copies can remain. The file on this Mac stays.
pub fn delete_online_copy(path: &Path) -> Result<OnlineDelete, AppError> {
    let Some((root, rel)) = prepare_repo_file(path) else {
        return Ok(online_missing());
    };
    if !has_publish_target(&root) {
        return Ok(online_missing());
    }
    if fetch_remote(&root).is_err() {
        return Ok(online_failed());
    }
    // A detached HEAD is refused; the push target comes from the upstream, not this branch.
    let Some(_branch) = current_branch(&root) else {
        return Ok(online_failed());
    };
    let Some(upstream) = upstream_ref(&root) else {
        return Ok(online_missing());
    };
    if !path_in_tree(&root, &upstream, &rel) {
        return Ok(online_missing());
    }
    let index = tempfile::NamedTempFile::new().map_err(|err| AppError::Io(err.to_string()))?;
    let read = git_indexed(&root, index.path(), &["read-tree", &upstream])?;
    if !read.status.success() {
        return Ok(online_failed());
    }
    let remove = git_indexed(
        &root,
        index.path(),
        &["rm", "--cached", "--ignore-unmatch", "--", &rel],
    )?;
    if !remove.status.success() {
        return Ok(online_failed());
    }
    let tree_out = git_indexed(&root, index.path(), &["write-tree"])?;
    if !tree_out.status.success() {
        return Ok(online_failed());
    }
    let tree = stdout_trim(&tree_out);
    if tree_has_path(&root, &tree, &rel) {
        return Ok(online_failed());
    }
    let commit_out = git_output(
        &root,
        &[
            "commit-tree",
            &tree,
            "-p",
            &upstream,
            "-m",
            DELETE_COMMIT_MESSAGE,
        ],
    )?;
    if !commit_out.status.success() {
        return Ok(online_failed());
    }
    let commit = stdout_trim(&commit_out);
    let file_bytes = fs::read(path).unwrap_or_default();
    if let Some(hash) = hash_bytes(&root, &file_bytes) {
        if new_objects_include(&root, &commit, &upstream, &hash) {
            return Ok(online_failed());
        }
    }
    let Some(target) = upstream_branch(&root, &upstream) else {
        return Ok(online_failed());
    };
    let spec = format!("{commit}:refs/heads/{target}");
    if origin_push(&root, &spec, false).is_err() {
        return Ok(online_failed());
    }
    Ok(OnlineDelete {
        deleted: true,
        missing: false,
        message: DELETE_DONE.to_string(),
    })
}

fn is_transient_git_failure(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "index.lock",
        "another git process",
        "unable to lock",
        "cannot lock ref",
        "resource temporarily unavailable",
        "could not resolve host",
        "name or service not known",
        "nodename nor servname",
        "temporary failure in name resolution",
        "failed to connect",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "connection reset",
        "connection closed",
        "network is unreachable",
        "network unreachable",
        "no route to host",
        "the remote end hung up",
        "early eof",
        "could not read from remote",
        "recv failure",
        "ssl_error",
        "ssl connection",
        "could not resolve proxy",
        "transfer closed with outstanding",
        "rpc failed",
    ];
    MARKERS.iter().any(|marker| error.contains(marker))
}

fn commit_failure(error: String) -> GitCommitResult {
    let error = if error.is_empty() {
        "git commit failed".to_string()
    } else {
        error
    };
    let retry = is_transient_git_failure(&error);
    GitCommitResult {
        committed: false,
        commit_sha: None,
        error: Some(error),
        retry,
    }
}

/// `git add` + `git commit -- <file>`. Does not push. A failed commit leaves
/// the working tree bytes alone.
fn stage_and_commit(root: &Path, rel: &str, message: &str) -> Result<GitCommitResult, AppError> {
    let add = git_output(root, &["add", "--", rel])?;
    if !add.status.success() {
        return Ok(commit_failure(stderr_trim(&add)));
    }

    let commit = git_output(root, &["commit", "-m", message, "--", rel])?;
    if !commit.status.success() {
        let err = stderr_trim(&commit);
        let err = if err.is_empty() {
            stdout_trim(&commit)
        } else {
            err
        };
        return Ok(commit_failure(err));
    }

    let sha_out = git_output(root, &["rev-parse", "HEAD"])?;
    Ok(GitCommitResult {
        committed: true,
        commit_sha: Some(stdout_trim(&sha_out)).filter(|s| !s.is_empty()),
        error: None,
        retry: false,
    })
}

fn prepare_repo_file(path: &Path) -> Option<(PathBuf, String)> {
    if !path.exists() {
        return None;
    }
    let root = repo_root_from_file(path)?;
    let rel = relative_to_repo(path, &root);
    Some((root, rel.to_string_lossy().into_owned()))
}

/// Accept: commit this one file. Message is `Accept: <repo-relative path>`.
pub fn commit_file(path: &Path) -> Result<GitCommitResult, AppError> {
    let Some((root, rel)) = prepare_repo_file(path) else {
        return Ok(commit_failure(if path.exists() {
            "not a git repository".into()
        } else {
            "file not found".into()
        }));
    };
    stage_and_commit(&root, &rel, &format!("Accept: {rel}"))
}

fn publish_stopped(committed: bool, commit_sha: Option<String>, error: String) -> GitPublishResult {
    let retry = is_transient_git_failure(&error);
    GitPublishResult {
        committed,
        pushed: false,
        commit_sha,
        error: Some(error),
        retry,
    }
}

#[cfg(test)]
fn publish_file(path: &Path, message: &str) -> Result<GitPublishResult, AppError> {
    publish_file_with(path, message, &MacOnlySet::open())
}

pub fn publish_file_with(
    path: &Path,
    message: &str,
    set: &MacOnlySet,
) -> Result<GitPublishResult, AppError> {
    let Some((root, rel)) = prepare_repo_file(path) else {
        return Ok(publish_stopped(
            false,
            None,
            if path.exists() {
                "not a git repository".into()
            } else {
                "file not found".into()
            },
        ));
    };
    let message = if message.trim().is_empty() {
        let file = Path::new(&rel)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("file");
        format!("Accepted suggestion in {file}")
    } else {
        message.to_string()
    };

    let committed = stage_and_commit(&root, &rel, &message)?;
    // Accept may already have committed. A clean file still needs the push.
    if !committed.committed {
        let status = file_status(path)?;
        if status.error.is_some() || !status.clean {
            return Ok(GitPublishResult {
                committed: false,
                pushed: false,
                commit_sha: None,
                error: committed.error,
                retry: committed.retry,
            });
        }
    }

    let commit_sha = committed.commit_sha.or_else(|| {
        git_output(&root, &["rev-parse", "HEAD"])
            .ok()
            .map(|output| stdout_trim(&output))
            .filter(|sha| !sha.is_empty())
    });

    match push_origin(&root, set, path) {
        Ok(()) => Ok(GitPublishResult {
            committed: committed.committed,
            pushed: true,
            commit_sha,
            error: None,
            retry: false,
        }),
        Err(error) => Ok(publish_stopped(committed.committed, commit_sha, error)),
    }
}

fn command_text(output: &std::process::Output) -> String {
    let err = stderr_trim(output);
    let out = stdout_trim(output);
    if err.is_empty() {
        out
    } else if out.is_empty() {
        err
    } else {
        format!("{err}\n{out}")
    }
}

fn command_error(output: &std::process::Output, fallback: &str) -> String {
    let text = command_text(output);
    if text.is_empty() {
        fallback.to_string()
    } else {
        text
    }
}

fn publish_remote(root: &Path) -> Option<String> {
    let output = git_output(root, &["remote"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let names: Vec<String> = stdout_trim(&output)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    if names.iter().any(|name| name == "origin") {
        Some("origin".to_string())
    } else {
        names.into_iter().next()
    }
}

fn remote_url(root: &Path, name: &str) -> Option<String> {
    // `--` so a remote named like an option (`--upload-pack=...`) stays a name.
    let output = git_output(root, &["remote", "get-url", "--", name]).ok()?;
    if !output.status.success() {
        return None;
    }
    let url = stdout_trim(&output);
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

fn fetch_remote(root: &Path) -> Result<(), String> {
    let _background = BackgroundGit::enter();
    let name = publish_remote(root).ok_or_else(|| "no origin remote".to_string())?;
    let url = remote_url(root, &name).ok_or_else(|| "no origin remote".to_string())?;
    let mut cmd = git_cmd(root);
    cmd.args(["-c", "http.connectTimeout=2"]);
    if let Some(token) = github_token() {
        if let Some(header) = github_bearer_config(&url, &token) {
            cmd.args(["-c", &header]);
        }
    }
    let output = cmd
        .args(["fetch", "--", &name])
        .output()
        .map_err(|e| format!("git fetch: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(&output, "git fetch failed"))
    }
}

fn would_clobber(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("would be overwritten") || error.contains("please commit your changes or stash")
}

fn fast_forward_refused(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("not possible to fast-forward") || error.contains("diverging branches")
}

fn merge_left_conflicts(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("conflict") || error.contains("unmerged")
}

/// Only the background pull merges, so no hook or fsmonitor program runs here.
fn git_merge(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let _background = BackgroundGit::enter();
    git_cmd(root)
        .args(args)
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .output()
        .map_err(|e| format!("git merge: {e}"))
}

fn has_unmerged(root: &Path) -> bool {
    git_output(root, &["ls-files", "-u"])
        .ok()
        .is_some_and(|output| output.status.success() && !stdout_trim(&output).is_empty())
}

/// Undo a merge this call started. Never `reset --hard` or `checkout --theirs`.
fn abort_merge_if_started(root: &Path) {
    let Ok(output) = git_output(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]) else {
        return;
    };
    if output.status.success() {
        let _ = git_output(root, &["merge", "--abort"]);
    }
}

fn histories_conflict(root: &Path) -> Result<bool, String> {
    let _background = BackgroundGit::enter();
    let output = git_cmd(root)
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "HEAD",
            "FETCH_HEAD",
        ])
        .output()
        .map_err(|e| format!("git merge-tree: {e}"))?;
    match output.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(command_error(&output, "git merge-tree failed")),
    }
}

fn skipped_pull(error: Option<String>) -> GitPullResult {
    GitPullResult {
        updated: false,
        skipped: true,
        conflict: false,
        error,
        retry: false,
    }
}

fn failed_pull(error: String) -> GitPullResult {
    let retry = is_transient_git_failure(&error);
    GitPullResult {
        updated: false,
        skipped: false,
        conflict: false,
        error: Some(error),
        retry,
    }
}

fn conflict_pull() -> GitPullResult {
    GitPullResult {
        updated: false,
        skipped: false,
        conflict: true,
        error: None,
        retry: false,
    }
}

fn updated_pull(updated: bool) -> GitPullResult {
    GitPullResult {
        updated,
        skipped: false,
        conflict: false,
        error: None,
        retry: false,
    }
}

fn stopped_pull(error: String) -> GitPullResult {
    GitPullResult {
        updated: false,
        skipped: false,
        conflict: false,
        error: Some(error),
        retry: false,
    }
}

/// Kept documents inside this repository, read before the pull.
fn snapshot_kept_in(set: &MacOnlySet, root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    set.paths()
        .iter()
        .filter(|path| path.starts_with(&root))
        .filter_map(|path| Some((path.clone(), fs::read(path).ok()?)))
        .collect()
}

/// Put back a kept document only when the merge rewrote it. A save made
/// while the pull was fetching is left as it is.
fn restore_kept(snaps: &[(PathBuf, Vec<u8>)], changed: &HashSet<PathBuf>) -> Result<(), AppError> {
    let mut failed = None;
    for (path, bytes) in snaps {
        if !changed.contains(path) {
            continue;
        }
        if fs::read(path).ok().as_ref() == Some(bytes) {
            continue;
        }
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(error) = fs::write(path, bytes) {
            failed = Some(AppError::Io(format!("restore kept: {error}")));
        }
    }
    failed.map_or(Ok(()), Err)
}

/// Paths the pull moved HEAD across, as canonical absolute paths. Empty when HEAD did not move.
fn changed_by_pull(root: &Path, before: Option<&str>) -> HashSet<PathBuf> {
    let Some(before) = before else {
        return HashSet::new();
    };
    let Ok(after) = git_output(root, &["rev-parse", "HEAD"]) else {
        return HashSet::new();
    };
    let after = stdout_trim(&after);
    if after.is_empty() || after == before {
        return HashSet::new();
    }
    let Ok(diff) = git_output(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            before,
            &after,
        ],
    ) else {
        return HashSet::new();
    };
    let base = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    diff.stdout
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(|name| {
            let joined = base.join(String::from_utf8_lossy(name).as_ref());
            joined.canonicalize().unwrap_or(joined)
        })
        .collect()
}

/// Fetch, then fast-forward or merge. A kept document is copied aside first
/// and put back after, so a folder sync cannot replace it.
#[cfg(test)]
fn pull_folder(path: &Path) -> Result<GitPullResult, AppError> {
    pull_folder_with(path, &MacOnlySet::open())
}

fn pull_folder_with(path: &Path, set: &MacOnlySet) -> Result<GitPullResult, AppError> {
    let _background = BackgroundGit::enter();
    if set.is_unreadable() {
        return Ok(stopped_pull(UNREADABLE_LINE.to_string()));
    }
    let Some(root) = repo_root_from_file(path) else {
        return pull_folder_inner(path);
    };
    let snaps = snapshot_kept_in(set, &root);
    let before = git_output(&root, &["rev-parse", "HEAD"])
        .ok()
        .map(|output| stdout_trim(&output))
        .filter(|sha| !sha.is_empty());
    let result = pull_folder_inner(path);
    let changed = changed_by_pull(&root, before.as_deref());
    restore_kept(&snaps, &changed)?;
    result
}

fn pull_folder_inner(path: &Path) -> Result<GitPullResult, AppError> {
    let Some(root) = repo_root_from_file(path) else {
        return Ok(skipped_pull(Some(if path.exists() {
            "not a git repository".into()
        } else {
            "file not found".into()
        })));
    };
    if local_command_config(&root).is_some() {
        // ponytail: a folder whose own git config runs programs is synced only when the writer acts.
        return Ok(skipped_pull(Some(
            "background sync is off for this folder".into(),
        )));
    }
    if !has_publish_target(&root) {
        return settle_pull(&root, skipped_pull(None));
    }
    if let Err(error) = fetch_remote(&root) {
        return settle_pull(&root, failed_pull(error));
    }
    if has_unmerged(&root) {
        return settle_pull(&root, conflict_pull());
    }

    let ff = match git_merge(&root, &["merge", "--ff-only", "--no-edit", "FETCH_HEAD"]) {
        Ok(output) => output,
        Err(error) => return settle_pull(&root, failed_pull(error)),
    };
    if ff.status.success() {
        let updated = !command_text(&ff)
            .to_ascii_lowercase()
            .contains("already up to date");
        return settle_pull(&root, updated_pull(updated));
    }

    let error = command_error(&ff, "git merge failed");
    if would_clobber(&error) {
        abort_merge_if_started(&root);
        return settle_pull(&root, stopped_pull(error));
    }
    if is_transient_git_failure(&error) {
        return settle_pull(&root, failed_pull(error));
    }
    if !fast_forward_refused(&error) {
        abort_merge_if_started(&root);
        return settle_pull(&root, failed_pull(error));
    }

    match histories_conflict(&root) {
        Ok(true) => {
            abort_merge_if_started(&root);
            settle_pull(&root, conflict_pull())
        }
        Ok(false) => {
            let merged = match git_merge(&root, &["merge", "--no-edit", "FETCH_HEAD"]) {
                Ok(output) => output,
                Err(error) => return settle_pull(&root, failed_pull(error)),
            };
            if merged.status.success() {
                return settle_pull(&root, updated_pull(true));
            }
            let error = command_error(&merged, "git merge failed");
            abort_merge_if_started(&root);
            if would_clobber(&error) {
                return settle_pull(&root, stopped_pull(error));
            }
            if merge_left_conflicts(&error) {
                return settle_pull(&root, conflict_pull());
            }
            settle_pull(&root, failed_pull(error))
        }
        Err(error) => {
            abort_merge_if_started(&root);
            settle_pull(&root, failed_pull(error))
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingKind {
    Commit,
    Push,
    Pull,
}

#[derive(Clone)]
struct PendingGit {
    kind: PendingKind,
    path: PathBuf,
    message: String,
}

fn with_git_queue<T>(f: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
    let _guard = GIT_QUEUE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

fn git_dir(root: &Path) -> Option<PathBuf> {
    let output = git_output(root, &["rev-parse", "--absolute-git-dir"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let dir = stdout_trim(&output);
    if dir.is_empty() {
        None
    } else {
        Some(PathBuf::from(dir))
    }
}

const QUEUE_FILE: &str = "desk-queue";
/// Previous queue name. Renamed the next time the queue is read.
const PREVIOUS_QUEUE_FILE: &str = "redline-queue";

fn queue_file(root: &Path) -> Option<PathBuf> {
    let dir = git_dir(root)?;
    let path = dir.join(QUEUE_FILE);
    let previous = dir.join(PREVIOUS_QUEUE_FILE);
    // ponytail: if both files exist, the new one wins and the old one is left.
    // Upgrade path is a line merge, which this queue does not need yet.
    // The adoption runs under the queue lock, so two callers cannot both try
    // the rename and leave one of them writing the old name.
    with_git_queue(|| {
        if !path.exists() && previous.is_file() && fs::rename(&previous, &path).is_err() {
            eprintln!("[git] the previous queue file could not be renamed; using it");
            return Ok(previous.clone());
        }
        Ok(path.clone())
    })
    .ok()
}

fn path_in_repo(root: &Path, file: &Path) -> bool {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let file = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
    file.starts_with(root)
}

fn parse_pending(line: &str) -> Option<PendingGit> {
    let mut parts = line.splitn(3, '\t');
    let kind = match parts.next()? {
        "commit" => PendingKind::Commit,
        "push" => PendingKind::Push,
        "pull" => PendingKind::Pull,
        _ => return None,
    };
    let path = parts.next()?;
    if path.is_empty() || path.contains('\n') {
        return None;
    }
    let message = parts.next().unwrap_or("").replace(['\t', '\n'], " ");
    Some(PendingGit {
        kind,
        path: PathBuf::from(path),
        message,
    })
}

fn read_queue(path: &Path) -> Vec<PendingGit> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines().filter_map(parse_pending).collect()
}

fn write_queue(path: &Path, ops: &[PendingGit]) -> Result<(), AppError> {
    if ops.is_empty() {
        if path.exists() {
            fs::remove_file(path).map_err(|err| AppError::Io(err.to_string()))?;
        }
        return Ok(());
    }
    let mut body = String::new();
    for op in ops {
        let path_str = op.path.to_string_lossy();
        if path_str.contains('\t') || path_str.contains('\n') {
            continue;
        }
        match op.kind {
            PendingKind::Commit => {
                body.push_str("commit\t");
                body.push_str(&path_str);
                body.push('\n');
            }
            PendingKind::Push => {
                body.push_str("push\t");
                body.push_str(&path_str);
                body.push('\t');
                body.push_str(&op.message.replace(['\t', '\n'], " "));
                body.push('\n');
            }
            PendingKind::Pull => {
                body.push_str("pull\t");
                body.push_str(&path_str);
                body.push('\n');
            }
        }
    }
    fs::write(path, body).map_err(|err| AppError::Io(err.to_string()))
}

fn upsert_pending(ops: &mut Vec<PendingGit>, next: PendingGit) {
    if next.kind == PendingKind::Pull {
        if let Some(existing) = ops.iter_mut().find(|op| op.kind == PendingKind::Pull) {
            *existing = next;
            return;
        }
        ops.push(next);
        return;
    }
    if let Some(existing) = ops
        .iter_mut()
        .find(|op| op.path == next.path && op.kind != PendingKind::Pull)
    {
        if existing.kind == PendingKind::Push && next.kind == PendingKind::Commit {
            return;
        }
        *existing = next;
        return;
    }
    ops.push(next);
}

/// Record one git CLI op for this file. Does not copy the file. A missing
/// repo records nothing.
fn enqueue_op(path: &Path, op: &str, message: Option<&str>) -> Result<bool, AppError> {
    let kind = match op {
        "commit" => PendingKind::Commit,
        "push" => PendingKind::Push,
        "pull" => PendingKind::Pull,
        _ => return Ok(false),
    };
    let Some(root) = repo_root_from_file(path) else {
        return Ok(false);
    };
    if !path_in_repo(&root, path) {
        return Ok(false);
    }
    let Some(queue_path) = queue_file(&root) else {
        return Ok(false);
    };
    with_git_queue(|| {
        let mut ops = read_queue(&queue_path);
        upsert_pending(
            &mut ops,
            PendingGit {
                kind,
                path: path.to_path_buf(),
                message: message.unwrap_or("").to_string(),
            },
        );
        write_queue(&queue_path, &ops)?;
        Ok(true)
    })
}

fn keep_after(result: Result<bool, AppError>) -> bool {
    match result {
        Ok(retry) => retry,
        Err(error) => is_transient_git_failure(&error.to_string()),
    }
}

fn drop_pull_ops(root: &Path) -> Result<(), AppError> {
    let Some(queue_path) = queue_file(root) else {
        return Ok(());
    };
    with_git_queue(|| {
        let ops = read_queue(&queue_path);
        let keep: Vec<_> = ops
            .into_iter()
            .filter(|op| op.kind != PendingKind::Pull)
            .collect();
        write_queue(&queue_path, &keep)
    })
}

/// Drop a finished pull. A transient miss stays so the next reconnect can
/// try the fetch again. A conflict is not a miss.
fn settle_pull(root: &Path, result: GitPullResult) -> Result<GitPullResult, AppError> {
    if !result.retry {
        let _ = drop_pull_ops(root);
    }
    Ok(result)
}

/// Replay pending ops in this repo once. A commit op does not push. A push
/// op pushes. A pull line stays for `pull_folder`, which runs after this
/// flush. Permanent failures are dropped. Transient ones stay for the next
/// reconnect or folder open.
#[cfg(test)]
fn flush_queue(path: &Path) -> Result<(), AppError> {
    flush_queue_with(path, &MacOnlySet::open())
}

fn flush_queue_with(path: &Path, set: &MacOnlySet) -> Result<(), AppError> {
    let _background = BackgroundGit::enter();
    let Some(root) = repo_root_from_file(path) else {
        return Ok(());
    };
    if local_command_config(&root).is_some() {
        // ponytail: a folder whose own git config runs programs is synced only when the writer acts.
        return Ok(());
    }
    let Some(queue_path) = queue_file(&root) else {
        return Ok(());
    };
    with_git_queue(|| {
        let ops = read_queue(&queue_path);
        if ops.is_empty() {
            return Ok(());
        }
        let mut keep = Vec::new();
        for op in ops {
            if !path_in_repo(&root, &op.path) {
                continue;
            }
            let retry = match op.kind {
                PendingKind::Commit => {
                    let result = commit_file(&op.path);
                    keep_after(result.map(|item| !item.committed && item.retry))
                }
                PendingKind::Push => {
                    let result = publish_file_with(&op.path, &op.message, set);
                    keep_after(result.map(|item| !item.pushed && item.retry))
                }
                PendingKind::Pull => {
                    keep.push(op);
                    continue;
                }
            };
            if retry {
                keep.push(op);
            }
        }
        write_queue(&queue_path, &keep)
    })
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

#[tauri::command]
pub async fn git_file_status(path: String) -> Result<GitFileStatus, AppError> {
    blocking(move || file_status(Path::new(&path))).await
}

#[tauri::command]
pub async fn git_commit_file(path: String) -> Result<GitCommitResult, AppError> {
    blocking(move || commit_file(Path::new(&path))).await
}

fn set_for(app: &tauri::AppHandle) -> MacOnlySet {
    MacOnlySet::load_or_block(app.path().app_data_dir().ok().as_deref())
}

#[tauri::command]
pub async fn git_publish_file(
    app: tauri::AppHandle,
    path: String,
    message: String,
) -> Result<GitPublishResult, AppError> {
    let set = set_for(&app);
    blocking(move || publish_file_with(Path::new(&path), &message, &set)).await
}

#[tauri::command]
pub async fn git_enqueue_op(
    app: tauri::AppHandle,
    path: String,
    op: String,
    message: Option<String>,
) -> Result<bool, AppError> {
    let set = set_for(&app);
    blocking(move || {
        // A share retry must not sit in the queue. A local commit retry may.
        if op == "push" {
            let file = PathBuf::from(&path);
            let text = fs::read_to_string(&file).unwrap_or_default();
            if depart(
                &set,
                &file,
                Channel::Share,
                &[(&file, text.as_str())],
                || Ok(()),
            )
            .is_err()
            {
                return Ok(false);
            }
        }
        enqueue_op(Path::new(&path), &op, message.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_flush_queue(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let set = set_for(&app);
    blocking(move || flush_queue_with(Path::new(&path), &set)).await
}

#[tauri::command]
pub async fn git_pull(app: tauri::AppHandle, path: String) -> Result<GitPullResult, AppError> {
    let set = set_for(&app);
    blocking(move || pull_folder_with(Path::new(&path), &set)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn git_in(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Redline")
            .env("GIT_AUTHOR_EMAIL", "redline@local")
            .env("GIT_COMMITTER_NAME", "Redline")
            .env("GIT_COMMITTER_EMAIL", "redline@local")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        git_in(dir.path(), &["init", "-b", "main"]);
        git_in(dir.path(), &["config", "user.email", "redline@local"]);
        git_in(dir.path(), &["config", "user.name", "Redline"]);
        let file = dir.path().join("note.md");
        fs::write(&file, "This is really very important.\n").unwrap();
        git_in(dir.path(), &["add", "--", "note.md"]);
        git_in(dir.path(), &["commit", "-m", "seed"]);
        (dir, file)
    }

    /// A folder behind a symlink (macOS `/var` -> `/private/var`): git reports
    /// the physical root, the caller passes the linked path.
    #[cfg(unix)]
    #[test]
    fn accept_through_a_symlinked_folder_uses_the_repo_relative_path() {
        let (dir, _file) = init_repo();
        let outer = TempDir::new().unwrap();
        let link = outer.path().join("linked");
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        let through = link.join("note.md");
        fs::write(&through, "This is important.\n").unwrap();

        let (root, rel) = prepare_repo_file(&through).unwrap();
        assert_eq!(rel, "note.md");
        assert_eq!(
            relative_to_repo(&link.join("not-yet.md"), &root),
            PathBuf::from("not-yet.md")
        );
        let result = commit_file(&through).unwrap();
        assert!(result.committed, "{result:?}");
        assert_eq!(head_subject(dir.path()), "Accept: note.md");
    }

    /// A note that is itself a symlink to a file outside the repo keeps its own path.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_note_keeps_its_own_repo_relative_path() {
        let (dir, _file) = init_repo();
        let outside = TempDir::new().unwrap();
        let target = outside.path().join("real.md");
        fs::write(&target, "outside\n").unwrap();
        fs::create_dir(dir.path().join("notes")).unwrap();
        let note = dir.path().join("notes/a.md");
        std::os::unix::fs::symlink(&target, &note).unwrap();
        let root = repo_root_from_file(&note).unwrap();
        assert_eq!(relative_to_repo(&note, &root), PathBuf::from("notes/a.md"));
        let (_, rel) = prepare_repo_file(&note).unwrap();
        assert_eq!(rel, "notes/a.md");
    }

    #[test]
    fn missing_file_is_not_a_panic() {
        let status = file_status(Path::new("/tmp/redline-does-not-exist-xyz.md")).unwrap();
        assert_eq!(status.error.as_deref(), Some("file not found"));
        assert!(status.clean);
    }

    #[test]
    fn non_repo_is_clean_with_error() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, "hi\n").unwrap();
        let status = file_status(&file).unwrap();
        assert_eq!(status.error.as_deref(), Some("not a git repository"));
        assert!(status.clean);
        assert!(status.porcelain.is_empty());
    }

    #[test]
    fn tracked_edit_is_dirty_with_diff() {
        let (_dir, file) = init_repo();
        assert!(file_status(&file).unwrap().clean);

        fs::write(&file, "This is important.\n").unwrap();
        let status = file_status(&file).unwrap();
        assert!(!status.clean);
        assert!(!status.sharing, "a local repo has no publish target");
        assert!(status.porcelain.contains("note.md"));
        assert!(status.diff.contains("really very") || status.diff.contains("important"));
        assert!(
            status.diff.contains("+This is important") || status.diff.contains("This is important")
        );
    }

    #[test]
    fn publish_commits_and_pushes_to_local_origin() {
        let (dir, file) = init_repo();
        fs::write(&file, "This is important.\n").unwrap();

        let remote = TempDir::new().unwrap();
        git_in(remote.path(), &["init", "--bare", "-b", "main"]);
        git_in(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );

        assert!(
            file_status(&file).unwrap().sharing,
            "origin is a publish target"
        );
        let result = publish_file(&file, "Accepted suggestion in note.md").unwrap();
        assert!(result.committed, "{result:?}");
        assert!(result.pushed, "{result:?}");
        assert!(result.error.is_none(), "{result:?}");
        assert!(result.commit_sha.is_some());

        let after = file_status(&file).unwrap();
        assert!(after.clean, "{after:?}");
    }

    fn head_subject(dir: &Path) -> String {
        let output = Command::new("git")
            .args(["log", "-1", "--format=%s"])
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success());
        stdout_trim(&output)
    }

    fn head_files(dir: &Path) -> String {
        let output = Command::new("git")
            .args(["show", "--name-only", "--pretty=format:", "HEAD"])
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success());
        stdout_trim(&output)
    }

    #[test]
    fn commit_file_commits_only_that_file_and_does_not_push() {
        let (dir, file) = init_repo();
        let other = dir.path().join("other.md");
        fs::write(&other, "other\n").unwrap();
        git_in(dir.path(), &["add", "--", "other.md"]);
        git_in(dir.path(), &["commit", "-m", "other"]);

        fs::write(&file, "This is important.\n").unwrap();
        fs::write(&other, "other changed\n").unwrap();

        let remote = TempDir::new().unwrap();
        git_in(remote.path(), &["init", "--bare", "-b", "main"]);
        git_in(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );

        let result = commit_file(&file).unwrap();
        assert!(result.committed, "{result:?}");
        assert!(result.error.is_none(), "{result:?}");
        assert_eq!(head_subject(dir.path()), "Accept: note.md");
        assert_eq!(head_files(dir.path()), "note.md");

        let after = file_status(&file).unwrap();
        assert!(after.clean, "{after:?}");
        assert!(!file_status(&other).unwrap().clean);

        let remote_head = Command::new("git")
            .args([
                "--git-dir",
                remote.path().to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ])
            .output()
            .unwrap();
        assert!(
            !remote_head.status.success(),
            "Accept must not push: {}",
            String::from_utf8_lossy(&remote_head.stdout)
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "This is important.\n");
    }

    #[test]
    fn commit_file_uses_the_repo_relative_path() {
        let (dir, _file) = init_repo();
        let nested = dir.path().join("notes");
        fs::create_dir(&nested).unwrap();
        let file = nested.join("note.md");
        fs::write(&file, "nested\n").unwrap();

        let result = commit_file(&file).unwrap();
        assert!(result.committed, "{result:?}");
        assert_eq!(head_subject(dir.path()), "Accept: notes/note.md");
        assert_eq!(head_files(dir.path()), "notes/note.md");
    }

    #[test]
    fn empty_share_message_names_the_file() {
        let (dir, _file) = init_repo();
        let nested = dir.path().join("notes");
        fs::create_dir(&nested).unwrap();
        let file = nested.join("draft.md");
        fs::write(&file, "shared\n").unwrap();
        let result = publish_file(&file, " ").unwrap();
        assert!(result.committed, "{result:?}");
        assert_eq!(head_subject(dir.path()), "Accepted suggestion in draft.md");
    }

    #[test]
    fn commit_file_leaves_bytes_when_not_a_repo() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, "kept\n").unwrap();
        let result = commit_file(&file).unwrap();
        assert!(!result.committed);
        assert_eq!(result.error.as_deref(), Some("not a git repository"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "kept\n");
    }

    #[cfg(unix)]
    #[test]
    fn commit_file_leaves_bytes_when_hook_rejects() {
        use std::os::unix::fs::PermissionsExt;

        let (dir, file) = init_repo();
        fs::write(&file, "kept on disk\n").unwrap();
        let hook = dir.path().join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        let mut perms = fs::metadata(&hook).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&hook, perms).unwrap();

        let result = commit_file(&file).unwrap();
        assert!(!result.committed, "{result:?}");
        assert!(result.error.is_some());
        assert_eq!(fs::read_to_string(&file).unwrap(), "kept on disk\n");
        assert_eq!(head_subject(dir.path()), "seed");
    }

    #[test]
    fn commit_file_leaves_bytes_when_nothing_to_commit() {
        let (dir, file) = init_repo();
        let before = fs::read_to_string(&file).unwrap();
        let result = commit_file(&file).unwrap();
        assert!(!result.committed, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), before);
        assert!(file_status(&file).unwrap().clean);
        assert_eq!(head_subject(dir.path()), "seed");
    }

    #[test]
    fn publish_pushes_when_accept_already_committed() {
        let (dir, file) = init_repo();
        fs::write(&file, "This is important.\n").unwrap();

        let remote = TempDir::new().unwrap();
        git_in(remote.path(), &["init", "--bare", "-b", "main"]);
        git_in(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );

        let committed = commit_file(&file).unwrap();
        assert!(committed.committed, "{committed:?}");

        let published = publish_file(&file, "should not be the message").unwrap();
        assert!(!published.committed, "{published:?}");
        assert!(published.pushed, "{published:?}");
        assert!(published.error.is_none(), "{published:?}");

        let log = Command::new("git")
            .args([
                "--git-dir",
                remote.path().to_str().unwrap(),
                "log",
                "-1",
                "--format=%s",
            ])
            .output()
            .unwrap();
        assert!(
            log.status.success(),
            "{}",
            String::from_utf8_lossy(&log.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&log.stdout).trim(),
            "Accept: note.md"
        );
        assert_eq!(head_subject(dir.path()), "Accept: note.md");
    }

    #[test]
    fn publish_without_remote_commits_and_skips_push() {
        let (_dir, file) = init_repo();
        fs::write(&file, "This is important.\n").unwrap();

        let result = publish_file(&file, "Accepted suggestion in note.md").unwrap();
        assert!(result.committed, "{result:?}");
        assert!(!result.pushed);
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|e| e.contains("no origin remote")),
            "{result:?}"
        );
        assert!(!result.retry, "{result:?}");
    }

    fn queue_body(dir: &Path) -> String {
        let Some(path) = queue_file(dir) else {
            return String::new();
        };
        if !path.exists() {
            return String::new();
        }
        fs::read_to_string(path).unwrap()
    }

    fn remote_subject(remote: &Path) -> String {
        let output = Command::new("git")
            .args([
                "--git-dir",
                remote.to_str().unwrap(),
                "log",
                "-1",
                "--format=%s",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        stdout_trim(&output)
    }

    #[test]
    fn transient_markers_are_locks_and_network_only() {
        assert!(is_transient_git_failure(
            "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running"
        ));
        assert!(is_transient_git_failure(
            "fatal: unable to access 'http://127.0.0.1:1/no.git/': Failed to connect to 127.0.0.1 port 1"
        ));
        assert!(is_transient_git_failure(
            "ssh: connect to host github.com port 22: Connection refused"
        ));
        assert!(!is_transient_git_failure("not a git repository"));
        assert!(!is_transient_git_failure("file not found"));
        assert!(!is_transient_git_failure(
            "nothing to commit, working tree clean"
        ));
        assert!(!is_transient_git_failure(
            "no origin remote (GitHub publish skipped)"
        ));
        assert!(!is_transient_git_failure(
            "IO error: git: No such file or directory (os error 2)"
        ));
        assert!(!is_transient_git_failure("git commit failed"));
        assert!(!is_transient_git_failure(
            "error: failed to push some refs to origin"
        ));
        assert!(!is_transient_git_failure("Authentication failed"));
    }

    #[test]
    fn lookalike_hosts_do_not_get_the_github_bearer() {
        for url in [
            "https://github.com.evil.test/owner/repo.git",
            "https://github.com.evil.test",
            "https://evil.github.com/owner/repo.git",
            "https://notgithub.com/owner/repo.git",
            "https://github.com%2eevil.test/owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
        ] {
            assert!(github_bearer_config(url, "dummy-token").is_none(), "{url}");
        }
    }

    #[test]
    fn http_github_does_not_get_the_github_bearer() {
        for url in [
            "http://github.com",
            "http://github.com/owner/repo.git",
            "http://github.com/owner/github.com.git",
        ] {
            assert!(github_bearer_config(url, "dummy-token").is_none(), "{url}");
        }
    }

    #[test]
    fn github_com_in_the_path_does_not_get_the_github_bearer() {
        for url in [
            "https://evil.test/github.com",
            "https://evil.test/owner/github.com/repo.git",
        ] {
            assert!(github_bearer_config(url, "dummy-token").is_none(), "{url}");
        }
    }

    #[test]
    fn https_github_com_gets_the_scoped_bearer() {
        let url = "https://github.com/example/notes.git";
        let header = github_bearer_config(url, "dummy-token").unwrap();
        assert_eq!(
            header,
            "http.https://github.com/.extraHeader=AUTHORIZATION: bearer dummy-token"
        );
        assert_eq!(
            github_bearer_config("https://git@github.com/example/notes.git", "dummy-token")
                .as_deref(),
            Some(header.as_str())
        );

        let dir = TempDir::new().unwrap();
        let matched = Command::new("git")
            .arg("-c")
            .arg(&header)
            .args(["config", "--get-urlmatch", "http.extraHeader", url])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("HOME", dir.path())
            .output()
            .unwrap();
        assert!(
            matched.status.success(),
            "{}",
            String::from_utf8_lossy(&matched.stderr)
        );
        assert_eq!(stdout_trim(&matched), "AUTHORIZATION: bearer dummy-token");

        for url in [
            "https://github.com.evil.test/owner/repo.git",
            "https://evil.test/github.com",
            "http://github.com/owner/repo.git",
        ] {
            let missed = Command::new("git")
                .arg("-c")
                .arg(&header)
                .args(["config", "--get-urlmatch", "http.extraHeader", url])
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .env("HOME", dir.path())
                .output()
                .unwrap();
            assert!(
                !missed.status.success() || stdout_trim(&missed).is_empty(),
                "{url} got {}",
                stdout_trim(&missed)
            );
        }
    }

    #[test]
    fn locked_commit_is_retryable_and_does_not_write_the_queue_or_the_bytes() {
        let (dir, file) = init_repo();
        fs::write(&file, "This is important.\n").unwrap();
        fs::write(dir.path().join(".git/index.lock"), "locked\n").unwrap();

        let result = commit_file(&file).unwrap();
        assert!(!result.committed, "{result:?}");
        assert!(result.retry, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "This is important.\n");
        assert!(
            queue_body(dir.path()).is_empty(),
            "{}",
            queue_body(dir.path())
        );
        assert_eq!(head_subject(dir.path()), "seed");
    }

    #[test]
    fn enqueue_stores_the_op_not_the_document() {
        let (dir, file) = init_repo();
        fs::write(&file, "This is important.\n").unwrap();
        assert!(enqueue_op(&file, "commit", None).unwrap());
        let body = queue_body(dir.path());
        assert!(body.starts_with("commit\t"), "{body}");
        assert!(body.contains(file.to_str().unwrap()), "{body}");
        assert!(!body.contains("This is important"), "{body}");

        assert!(enqueue_op(&file, "push", Some("Accepted suggestion in note.md")).unwrap());
        let body = queue_body(dir.path());
        assert_eq!(body.lines().count(), 1, "{body}");
        assert!(body.starts_with("push\t"), "{body}");
        assert!(body.contains("Accepted suggestion in note.md"), "{body}");

        assert!(enqueue_op(&file, "commit", None).unwrap());
        let body = queue_body(dir.path());
        assert!(
            body.starts_with("push\t"),
            "commit must not downgrade a push: {body}"
        );
        assert_eq!(body.lines().count(), 1, "{body}");
    }

    #[test]
    fn enqueue_outside_a_repo_records_nothing() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, "kept\n").unwrap();
        assert!(!enqueue_op(&file, "commit", None).unwrap());
        assert!(!dir.path().join(".git/desk-queue").exists());
        assert!(!dir.path().join(".git/redline-queue").exists());
        assert_eq!(fs::read_to_string(&file).unwrap(), "kept\n");
    }

    #[test]
    fn queue_adopts_the_previous_file_name() {
        let (dir, _file) = init_repo();
        let old = dir.path().join(".git/redline-queue");
        fs::write(&old, "pull\t.\t\n").unwrap();
        assert_eq!(queue_body(dir.path()), "pull\t.\t\n");
        assert!(!old.exists());
        assert_eq!(
            fs::read_to_string(dir.path().join(".git/desk-queue")).unwrap(),
            "pull\t.\t\n"
        );
    }

    #[test]
    fn concurrent_reads_all_adopt_the_new_queue_name() {
        let (dir, _file) = init_repo();
        fs::write(dir.path().join(".git/redline-queue"), "pull\t.\t\n").unwrap();
        let root = dir.path().to_path_buf();
        let found: Vec<PathBuf> = (0..8)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || queue_file(&root).unwrap())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|reader| reader.join().unwrap())
            .collect();
        assert!(
            found.iter().all(|path| path.ends_with("desk-queue")),
            "{found:?}"
        );
        assert!(!dir.path().join(".git/redline-queue").exists());
    }

    #[test]
    fn flush_of_a_queued_commit_does_not_push() {
        let (dir, file) = init_repo();
        fs::write(&file, "This is important.\n").unwrap();
        let remote = TempDir::new().unwrap();
        git_in(remote.path(), &["init", "--bare", "-b", "main"]);
        git_in(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        assert!(enqueue_op(&file, "commit", None).unwrap());

        flush_queue(dir.path()).unwrap();

        assert!(queue_body(dir.path()).is_empty());
        assert_eq!(head_subject(dir.path()), "Accept: note.md");
        assert_eq!(fs::read_to_string(&file).unwrap(), "This is important.\n");
        let remote_head = Command::new("git")
            .args([
                "--git-dir",
                remote.path().to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ])
            .output()
            .unwrap();
        assert!(
            !remote_head.status.success(),
            "Accept flush must not push: {}",
            String::from_utf8_lossy(&remote_head.stdout)
        );
    }

    #[test]
    fn flush_keeps_a_locked_commit_then_commits_without_pushing() {
        let (dir, file) = init_repo();
        fs::write(&file, "This is important.\n").unwrap();
        let remote = TempDir::new().unwrap();
        git_in(remote.path(), &["init", "--bare", "-b", "main"]);
        git_in(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        let lock = dir.path().join(".git/index.lock");
        fs::write(&lock, "locked\n").unwrap();
        assert!(enqueue_op(&file, "commit", None).unwrap());

        flush_queue(dir.path()).unwrap();
        assert!(
            queue_body(dir.path()).contains("commit\t"),
            "{}",
            queue_body(dir.path())
        );
        assert_eq!(head_subject(dir.path()), "seed");
        assert_eq!(fs::read_to_string(&file).unwrap(), "This is important.\n");

        flush_queue(dir.path()).unwrap();
        assert_eq!(
            head_subject(dir.path()),
            "seed",
            "a second flush must not spin"
        );
        assert!(queue_body(dir.path()).contains("commit\t"));

        fs::remove_file(&lock).unwrap();
        flush_queue(dir.path()).unwrap();
        assert!(queue_body(dir.path()).is_empty());
        assert_eq!(head_subject(dir.path()), "Accept: note.md");
        assert_eq!(fs::read_to_string(&file).unwrap(), "This is important.\n");
        let remote_head = Command::new("git")
            .args([
                "--git-dir",
                remote.path().to_str().unwrap(),
                "rev-parse",
                "HEAD",
            ])
            .output()
            .unwrap();
        assert!(!remote_head.status.success());
    }

    #[test]
    fn flush_drops_a_clean_file_and_a_rejected_hook() {
        let (dir, file) = init_repo();
        assert!(enqueue_op(&file, "commit", None).unwrap());
        flush_queue(dir.path()).unwrap();
        assert!(queue_body(dir.path()).is_empty());
        assert_eq!(head_subject(dir.path()), "seed");

        fs::write(&file, "kept on disk\n").unwrap();
        let marker = dir.path().join("hook-ran");
        let hook = dir.path().join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&hook).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&hook, perms).unwrap();
        }
        assert!(enqueue_op(&file, "commit", None).unwrap());
        flush_queue(dir.path()).unwrap();
        assert!(!marker.exists(), "a background flush ran the commit hook");
        assert!(
            queue_body(dir.path()).is_empty(),
            "{}",
            queue_body(dir.path())
        );
        assert_eq!(head_subject(dir.path()), "Accept: note.md");
        assert_eq!(fs::read_to_string(&file).unwrap(), "kept on disk\n");
    }

    #[test]
    fn flush_of_a_queued_push_pushes_and_a_dead_origin_stays_queued() {
        let (dir, file) = init_repo();
        fs::write(&file, "This is important.\n").unwrap();
        git_in(
            dir.path(),
            &["remote", "add", "origin", "http://127.0.0.1:1/no.git"],
        );
        assert!(enqueue_op(&file, "push", Some("Accepted suggestion in note.md")).unwrap());

        flush_queue(dir.path()).unwrap();
        let body = queue_body(dir.path());
        assert!(body.starts_with("push\t"), "{body}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "This is important.\n");
        assert_ne!(head_subject(dir.path()), "seed");

        let remote = TempDir::new().unwrap();
        git_in(remote.path(), &["init", "--bare", "-b", "main"]);
        git_in(
            dir.path(),
            &[
                "remote",
                "set-url",
                "origin",
                remote.path().to_str().unwrap(),
            ],
        );
        flush_queue(dir.path()).unwrap();
        assert!(queue_body(dir.path()).is_empty());
        assert_eq!(remote_subject(remote.path()), head_subject(dir.path()));
        assert_eq!(fs::read_to_string(&file).unwrap(), "This is important.\n");
    }

    #[test]
    fn flush_drops_a_non_fast_forward_push_without_merging() {
        let (dir, file) = init_repo();
        let remote = TempDir::new().unwrap();
        git_in(remote.path(), &["init", "--bare", "-b", "main"]);
        git_in(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        git_in(dir.path(), &["push", "-u", "origin", "HEAD"]);

        let other = TempDir::new().unwrap();
        git_in(
            other.path(),
            &["clone", remote.path().to_str().unwrap(), "."],
        );
        git_in(other.path(), &["config", "user.email", "redline@local"]);
        git_in(other.path(), &["config", "user.name", "Redline"]);
        fs::write(other.path().join("note.md"), "other side\n").unwrap();
        git_in(other.path(), &["add", "--", "note.md"]);
        git_in(other.path(), &["commit", "-m", "other side"]);
        git_in(other.path(), &["push", "origin", "HEAD"]);

        fs::write(&file, "local side\n").unwrap();
        let committed = commit_file(&file).unwrap();
        assert!(committed.committed, "{committed:?}");
        let published = publish_file(&file, "Accepted suggestion in note.md").unwrap();
        assert!(!published.pushed, "{published:?}");
        assert!(!published.retry, "{published:?}");

        assert!(enqueue_op(&file, "push", Some("Accepted suggestion in note.md")).unwrap());
        flush_queue(dir.path()).unwrap();
        assert!(
            queue_body(dir.path()).is_empty(),
            "{}",
            queue_body(dir.path())
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "local side\n");
        assert_eq!(remote_subject(remote.path()), "other side");
        assert_eq!(head_subject(dir.path()), "Accept: note.md");
        flush_queue(dir.path()).unwrap();
        assert_eq!(remote_subject(remote.path()), "other side");
    }

    fn bare_origin(dir: &Path) -> TempDir {
        let remote = TempDir::new().unwrap();
        git_in(remote.path(), &["init", "--bare", "-b", "main"]);
        git_in(
            dir,
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        git_in(dir, &["push", "-u", "origin", "HEAD"]);
        remote
    }

    fn clone_remote(remote: &Path) -> TempDir {
        let other = TempDir::new().unwrap();
        git_in(other.path(), &["clone", remote.to_str().unwrap(), "."]);
        other
    }

    #[test]
    fn directory_status_reports_a_remote_and_not_the_file() {
        let (dir, file) = init_repo();
        fs::write(&file, "secret bytes\n").unwrap();
        let status = file_status(dir.path()).unwrap();
        assert!(!status.sharing);
        assert!(status.diff.is_empty());
        let _remote = bare_origin(dir.path());
        let status = file_status(dir.path()).unwrap();
        assert!(status.sharing);
        assert!(status.diff.is_empty());
        assert!(!format!("{status:?}").contains("secret bytes"));
    }

    #[test]
    fn pull_fast_forwards_collaborator_edits_into_the_working_tree() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        let other = clone_remote(remote.path());
        fs::write(other.path().join("note.md"), "collaborator edit\n").unwrap();
        git_in(other.path(), &["add", "--", "note.md"]);
        git_in(other.path(), &["commit", "-m", "collaborator"]);
        git_in(other.path(), &["push", "origin", "HEAD"]);

        assert!(enqueue_op(dir.path(), "pull", None).unwrap());
        let result = pull_folder(dir.path()).unwrap();
        assert!(result.updated, "{result:?}");
        assert!(!result.conflict, "{result:?}");
        assert!(!result.retry, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "collaborator edit\n");
        assert!(
            queue_body(dir.path()).is_empty(),
            "{}",
            queue_body(dir.path())
        );
    }

    #[test]
    fn pull_merges_a_non_overlapping_edit() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        let other = clone_remote(remote.path());
        fs::write(&file, "local note\n").unwrap();
        git_in(dir.path(), &["add", "--", "note.md"]);
        git_in(dir.path(), &["commit", "-m", "local note"]);
        fs::write(other.path().join("side.md"), "from the other copy\n").unwrap();
        git_in(other.path(), &["add", "--", "side.md"]);
        git_in(other.path(), &["commit", "-m", "side"]);
        git_in(other.path(), &["push", "origin", "HEAD"]);

        let result = pull_folder(dir.path()).unwrap();
        assert!(result.updated, "{result:?}");
        assert!(!result.conflict, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "local note\n");
        assert_eq!(
            fs::read_to_string(dir.path().join("side.md")).unwrap(),
            "from the other copy\n"
        );
    }

    #[test]
    fn pull_does_not_overwrite_a_diverged_file() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        let other = clone_remote(remote.path());
        fs::write(&file, "local side\n").unwrap();
        git_in(dir.path(), &["add", "--", "note.md"]);
        git_in(dir.path(), &["commit", "-m", "local side"]);
        fs::write(other.path().join("note.md"), "other side\n").unwrap();
        git_in(other.path(), &["add", "--", "note.md"]);
        git_in(other.path(), &["commit", "-m", "other side"]);
        git_in(other.path(), &["push", "origin", "HEAD"]);

        assert!(enqueue_op(dir.path(), "pull", None).unwrap());
        let result = pull_folder(&file).unwrap();
        assert!(result.conflict, "{result:?}");
        assert!(!result.retry, "{result:?}");
        assert!(!result.updated, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "local side\n");
        assert!(
            queue_body(dir.path()).is_empty(),
            "{}",
            queue_body(dir.path())
        );
        let again = pull_folder(&file).unwrap();
        assert!(again.conflict, "{again:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "local side\n");
        assert_eq!(head_subject(dir.path()), "local side");
    }

    #[test]
    fn pull_fetches_a_remote_whose_name_starts_with_a_dash() {
        let (dir, file) = init_repo();
        let remote = TempDir::new().unwrap();
        git_in(remote.path(), &["init", "--bare", "-b", "main"]);
        // `git fetch <name>` would read this as an option and run it.
        let name = "--upload-pack=/usr/bin/echo";
        git_in(
            dir.path(),
            &["remote", "add", "--", name, remote.path().to_str().unwrap()],
        );
        git_in(dir.path(), &["push", "--", name, "HEAD"]);

        let result = pull_folder(dir.path()).unwrap();
        assert!(result.error.is_none(), "{result:?}");
        assert!(!result.retry, "{result:?}");
        assert!(!result.conflict, "{result:?}");
        assert!(!result.updated, "{result:?}");
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "This is really very important.\n"
        );
    }

    #[test]
    fn pull_without_a_remote_is_a_no_op() {
        let (dir, file) = init_repo();
        fs::write(&file, "local only\n").unwrap();
        let result = pull_folder(dir.path()).unwrap();
        assert!(result.skipped, "{result:?}");
        assert!(!result.updated, "{result:?}");
        assert!(!result.conflict, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "local only\n");
        assert_eq!(head_subject(dir.path()), "seed");
    }

    #[test]
    fn pull_leaves_accepted_bytes_when_fetch_fails() {
        let (dir, file) = init_repo();
        fs::write(&file, "accepted local\n").unwrap();
        let committed = commit_file(&file).unwrap();
        assert!(committed.committed, "{committed:?}");
        git_in(
            dir.path(),
            &["remote", "add", "origin", "http://127.0.0.1:1/no.git"],
        );
        let result = pull_folder(&file).unwrap();
        assert!(result.retry, "{result:?}");
        assert!(!result.updated, "{result:?}");
        assert!(!result.conflict, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "accepted local\n");
        assert_eq!(head_subject(dir.path()), "Accept: note.md");
    }

    #[test]
    fn pull_does_not_clobber_an_uncommitted_accept() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        let other = clone_remote(remote.path());
        fs::write(other.path().join("note.md"), "collaborator\n").unwrap();
        git_in(other.path(), &["add", "--", "note.md"]);
        git_in(other.path(), &["commit", "-m", "other"]);
        git_in(other.path(), &["push", "origin", "HEAD"]);
        fs::write(&file, "just accepted\n").unwrap();

        let result = pull_folder(dir.path()).unwrap();
        assert!(!result.updated, "{result:?}");
        assert!(!result.conflict, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "just accepted\n");
        assert_eq!(head_subject(dir.path()), "seed");
    }

    #[test]
    fn flush_keeps_a_pull_line_and_does_not_change_the_file() {
        let (dir, file) = init_repo();
        fs::write(&file, "kept\n").unwrap();
        assert!(enqueue_op(dir.path(), "pull", None).unwrap());
        let body = queue_body(dir.path());
        assert!(body.starts_with("pull\t"), "{body}");
        assert!(!body.contains("kept"), "{body}");

        flush_queue(dir.path()).unwrap();
        assert!(queue_body(dir.path()).starts_with("pull\t"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "kept\n");
        assert_eq!(head_subject(dir.path()), "seed");
    }

    fn bare_blobs_contain(remote: &Path, text: &str) -> bool {
        let git_dir = remote.to_str().unwrap();
        let list = Command::new("git")
            .args(["--git-dir", git_dir, "rev-list", "--all", "--objects"])
            .output()
            .unwrap();
        assert!(
            list.status.success(),
            "{}",
            String::from_utf8_lossy(&list.stderr)
        );
        let needle = text.as_bytes();
        if needle.is_empty() {
            return false;
        }
        for line in String::from_utf8_lossy(&list.stdout).lines() {
            let Some(sha) = line.split_whitespace().next() else {
                continue;
            };
            if sha.len() < 7 {
                continue;
            }
            let kind = Command::new("git")
                .args(["--git-dir", git_dir, "cat-file", "-t", sha])
                .output()
                .unwrap();
            if String::from_utf8_lossy(&kind.stdout).trim() != "blob" {
                continue;
            }
            let body = Command::new("git")
                .args(["--git-dir", git_dir, "cat-file", "-p", sha])
                .output()
                .unwrap();
            if body.stdout.len() >= needle.len()
                && body
                    .stdout
                    .windows(needle.len())
                    .any(|window| window == needle)
            {
                return true;
            }
        }
        false
    }

    fn bare_tip_names(remote: &Path) -> String {
        let output = Command::new("git")
            .args([
                "--git-dir",
                remote.to_str().unwrap(),
                "ls-tree",
                "-r",
                "--name-only",
                "HEAD",
            ])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn a_kept_document_is_not_uploaded() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        let secret = "NEVER-UPLOAD-SECRET-9cab\n";
        fs::write(&file, secret).unwrap();
        let set = MacOnlySet::holding(vec![file.clone()]);

        let result = publish_file_with(&file, "share the note", &set).unwrap();
        assert!(!result.pushed, "{result:?}");
        assert!(!result.retry, "{result:?}");
        assert_eq!(result.error.as_deref(), Some(crate::mac_only::SHARE_LINE));
        assert!(!bare_blobs_contain(remote.path(), secret));
        assert_eq!(fs::read_to_string(&file).unwrap(), secret);

        assert!(enqueue_op(&file, "push", Some("share the note")).unwrap());
        flush_queue_with(dir.path(), &set).unwrap();
        assert!(!bare_blobs_contain(remote.path(), secret));
    }

    #[test]
    fn a_kept_document_blocks_the_rest_of_the_folder_upload() {
        let (dir, file) = init_repo();
        let other = dir.path().join("other.md");
        fs::write(&other, "other\n").unwrap();
        git_in(dir.path(), &["add", "--", "other.md"]);
        git_in(dir.path(), &["commit", "-m", "other"]);
        let remote = bare_origin(dir.path());
        let secret = "FOLDER-SECRET-9cab stays here\n";
        fs::write(&file, secret).unwrap();
        git_in(dir.path(), &["add", "--", "note.md"]);
        git_in(dir.path(), &["commit", "-m", "local only"]);
        fs::write(&other, "other changed\n").unwrap();
        let set = MacOnlySet::holding(vec![file.clone()]);

        let result = publish_file_with(&other, "share the other file", &set).unwrap();
        assert!(!result.pushed, "{result:?}");
        assert_eq!(result.error.as_deref(), Some(crate::mac_only::FOLDER_LINE));
        assert!(!bare_blobs_contain(remote.path(), secret));
        assert!(!bare_blobs_contain(remote.path(), "other changed"));
    }

    #[test]
    fn an_untracked_kept_file_does_not_ride_along() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        let private = dir.path().join("private.md");
        let secret = "UNTRACKED-SECRET-9cab\n";
        fs::write(&private, secret).unwrap();
        fs::write(&file, "shared edit\n").unwrap();
        let set = MacOnlySet::holding(vec![private]);

        let result = publish_file_with(&file, "share the note", &set).unwrap();
        assert!(result.pushed, "{result:?}");
        assert!(bare_blobs_contain(remote.path(), "shared edit"));
        assert!(!bare_blobs_contain(remote.path(), secret.trim()));
    }

    #[test]
    fn deleting_the_online_copy_does_not_upload_the_new_text() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        assert!(bare_tip_names(remote.path()).contains("note.md"));
        let secret = "DELETE-PATH-SECRET-9cab\n";
        fs::write(&file, secret).unwrap();

        let report = delete_online_copy(&file).unwrap();
        assert!(report.deleted, "{report:?}");
        assert_eq!(report.message, crate::mac_only::DELETE_DONE);
        assert!(
            !bare_tip_names(remote.path()).contains("note.md"),
            "{}",
            bare_tip_names(remote.path())
        );
        assert!(!bare_blobs_contain(remote.path(), secret.trim()));
        assert_eq!(fs::read_to_string(&file).unwrap(), secret);
    }

    #[test]
    fn deleting_the_online_copy_on_another_default_branch_removes_it_there() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        git_in(dir.path(), &["remote", "set-head", "origin", "main"]);
        git_in(dir.path(), &["checkout", "-b", "draft"]);

        let report = delete_online_copy(&file).unwrap();
        assert!(report.deleted, "{report:?}");
        let remote_path = remote.path().to_str().unwrap();
        let listing = Command::new("git")
            .args([
                "--git-dir",
                remote_path,
                "ls-tree",
                "-r",
                "--name-only",
                "main",
            ])
            .output()
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&listing.stdout).contains("note.md"),
            "main still has the document"
        );
        let draft = Command::new("git")
            .args([
                "--git-dir",
                remote_path,
                "rev-parse",
                "--verify",
                "--quiet",
                "refs/heads/draft",
            ])
            .output()
            .unwrap();
        assert!(!draft.status.success(), "a remote draft branch was created");
    }

    #[test]
    fn restore_puts_back_only_files_the_merge_changed() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let a = root.join("a.md");
        let b = root.join("b.md");
        fs::write(&a, "kept a\n").unwrap();
        fs::write(&b, "kept b\n").unwrap();
        let snaps = snapshot_kept_in(&MacOnlySet::holding(vec![a.clone(), b.clone()]), &root);
        fs::write(&a, "merged\n").unwrap();
        fs::write(&b, "typed during fetch\n").unwrap();
        let changed: HashSet<PathBuf> = [a.clone()].into_iter().collect();
        restore_kept(&snaps, &changed).unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "kept a\n");
        assert_eq!(fs::read_to_string(&b).unwrap(), "typed during fetch\n");
    }

    #[test]
    fn snapshot_skips_kept_files_outside_the_repo() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let a = root.join("a.md");
        let z = outside.path().canonicalize().unwrap().join("z.md");
        fs::write(&a, "a\n").unwrap();
        fs::write(&z, "z\n").unwrap();
        let set = MacOnlySet::holding(vec![a.clone(), z]);
        let snaps = snapshot_kept_in(&set, &root);
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].0, a);
    }

    #[test]
    fn pull_restores_a_kept_file_the_merge_changed_and_nothing_else() {
        let (dir, file) = init_repo();
        fs::write(dir.path().join("other.md"), "other base\n").unwrap();
        git_in(dir.path(), &["add", "--", "other.md"]);
        git_in(dir.path(), &["commit", "-m", "other"]);
        let remote = bare_origin(dir.path());
        let clone = clone_remote(remote.path());
        fs::write(clone.path().join("note.md"), "from the other copy\n").unwrap();
        fs::write(clone.path().join("other.md"), "other from remote\n").unwrap();
        git_in(clone.path(), &["add", "--", "note.md", "other.md"]);
        git_in(clone.path(), &["commit", "-m", "theirs"]);
        git_in(clone.path(), &["push", "origin", "HEAD"]);

        let local = fs::read_to_string(&file).unwrap();
        let set = MacOnlySet::holding(vec![file.canonicalize().unwrap()]);
        let result = pull_folder_with(dir.path(), &set).unwrap();
        assert!(result.updated, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), local);
        assert_eq!(
            fs::read_to_string(dir.path().join("other.md")).unwrap(),
            "other from remote\n"
        );
    }

    #[test]
    fn pull_does_not_replace_or_upload_a_kept_document() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        let other = clone_remote(remote.path());
        fs::write(other.path().join("note.md"), "from the other copy\n").unwrap();
        git_in(other.path(), &["add", "--", "note.md"]);
        git_in(other.path(), &["commit", "-m", "theirs"]);
        fs::write(other.path().join("side.md"), "side file\n").unwrap();
        git_in(other.path(), &["add", "--", "side.md"]);
        git_in(other.path(), &["commit", "-m", "side"]);
        git_in(other.path(), &["push", "origin", "HEAD"]);

        let local = fs::read_to_string(&file).unwrap();
        let set = MacOnlySet::holding(vec![file.clone()]);

        let result = pull_folder_with(dir.path(), &set).unwrap();
        assert!(result.updated, "{result:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), local);
        assert_ne!(local, "from the other copy\n");
        assert_eq!(
            fs::read_to_string(dir.path().join("side.md")).unwrap(),
            "side file\n"
        );
        let tip = Command::new("git")
            .args([
                "--git-dir",
                remote.path().to_str().unwrap(),
                "log",
                "-1",
                "--format=%s",
            ])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&tip.stdout).trim(), "side");
    }

    #[test]
    fn a_removed_kept_document_is_not_uploaded_from_history() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        let secret = "HISTORY-SECRET-9cab was saved and then removed\n";
        fs::write(&file, secret).unwrap();
        git_in(dir.path(), &["add", "--", "note.md"]);
        git_in(dir.path(), &["commit", "-m", "local only"]);
        fs::write(&file, "This is really very important.\n").unwrap();
        git_in(dir.path(), &["add", "--", "note.md"]);
        git_in(dir.path(), &["commit", "-m", "put the old words back"]);
        let other = dir.path().join("other.md");
        fs::write(&other, "other changed\n").unwrap();
        let set = MacOnlySet::holding(vec![file]);

        let result = publish_file_with(&other, "share the other file", &set).unwrap();
        assert!(!result.pushed, "{result:?}");
        assert_eq!(result.error.as_deref(), Some(crate::mac_only::FOLDER_LINE));
        assert!(!bare_blobs_contain(remote.path(), "HISTORY-SECRET-9cab"));
        assert!(!bare_blobs_contain(remote.path(), "other changed"));
    }

    #[test]
    fn a_repository_at_home_is_not_used() {
        let home = TempDir::new().unwrap();
        git_in(home.path(), &["init", "-b", "main"]);
        let notes = home.path().join("notes");
        fs::create_dir(&notes).unwrap();
        let file = notes.join("a.md");
        fs::write(&file, "hi\n").unwrap();
        let ceiling = home.path().as_os_str();
        assert_eq!(repo_root_with_ceiling(&file, Some(ceiling)), None);
        let found = repo_root_with_ceiling(&file, None).unwrap();
        assert_eq!(
            found.canonicalize().unwrap(),
            home.path().canonicalize().unwrap()
        );
    }

    fn head_of(dir: &Path) -> String {
        let output = git_output(dir, &["rev-parse", "HEAD"]).unwrap();
        stdout_trim(&output)
    }

    /// A repo with a remote that has one commit the local copy lacks.
    fn behind_remote() -> (TempDir, PathBuf, TempDir, String) {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        let other = clone_remote(remote.path());
        fs::write(other.path().join("new.md"), "from remote\n").unwrap();
        git_in(other.path(), &["add", "--", "new.md"]);
        git_in(other.path(), &["commit", "-m", "theirs"]);
        git_in(other.path(), &["push", "origin", "HEAD"]);
        let before = head_of(dir.path());
        (dir, file, remote, before)
    }

    #[test]
    fn a_folder_with_a_local_ssh_command_is_not_synced_in_the_background() {
        let (dir, _file, _remote, before) = behind_remote();
        git_in(
            dir.path(),
            &["config", "--local", "core.sshCommand", "false"],
        );
        let result = pull_folder_with(dir.path(), &MacOnlySet::open()).unwrap();
        assert!(result.skipped, "{result:?}");
        assert!(!result.updated, "{result:?}");
        assert_eq!(head_of(dir.path()), before);
        assert!(!dir.path().join("new.md").exists());
        // Nothing was fetched either.
        let fetched =
            git_output(dir.path(), &["rev-parse", "-q", "--verify", "FETCH_HEAD"]).unwrap();
        assert!(!fetched.status.success());
    }

    #[test]
    fn a_folder_with_a_local_smudge_filter_is_not_synced() {
        let (dir, _file, _remote, before) = behind_remote();
        git_in(
            dir.path(),
            &["config", "--local", "filter.x.smudge", "false"],
        );
        let result = pull_folder_with(dir.path(), &MacOnlySet::open()).unwrap();
        assert!(result.skipped, "{result:?}");
        assert_eq!(head_of(dir.path()), before);
        assert!(!dir.path().join("new.md").exists());
    }

    #[test]
    fn a_folder_with_a_local_command_does_not_flush_its_queue() {
        let (dir, file) = init_repo();
        let remote = bare_origin(dir.path());
        git_in(
            dir.path(),
            &["config", "--local", "credential.helper", "false"],
        );
        fs::write(&file, "queued edit\n").unwrap();
        assert!(enqueue_op(&file, "commit", Some("queued")).unwrap());
        flush_queue_with(dir.path(), &MacOnlySet::open()).unwrap();
        let status = git_output(dir.path(), &["status", "--porcelain"]).unwrap();
        assert!(
            stdout_trim(&status).contains("note.md"),
            "commit was replayed"
        );
        assert!(!bare_blobs_contain(remote.path(), "queued edit"));
    }

    #[test]
    fn a_background_merge_does_not_run_post_merge_hooks() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, _file, _remote, before) = behind_remote();
        let hook = dir.path().join(".git/hooks/post-merge");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        // GIT_DIR is not set for this hook, so the marker path is absolute.
        let marker = dir.path().join("hook-ran");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let result = pull_folder_with(dir.path(), &MacOnlySet::open()).unwrap();
        assert!(result.updated, "{result:?}");
        assert_ne!(head_of(dir.path()), before);
        assert!(!marker.exists());
    }

    #[test]
    fn a_background_fetch_does_not_run_a_hook_or_an_ext_command() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, _file, _remote, before) = behind_remote();
        let marker = dir.path().join("hook-ran");
        let hook = dir.path().join(".git/hooks/reference-transaction");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let result = pull_folder_with(dir.path(), &MacOnlySet::open()).unwrap();
        assert!(result.updated, "{result:?}");
        assert_ne!(head_of(dir.path()), before);
        assert!(!marker.exists(), "fetch ran a hook");

        let script = dir.path().join("pwn.sh");
        let ran = dir.path().join("ext-ran");
        fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", ran.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        git_in(dir.path(), &["config", "protocol.ext.allow", "always"]);
        let url = format!("ext::{} %S", script.display());
        git_in(dir.path(), &["remote", "set-url", "origin", &url]);
        let _ = pull_folder_with(dir.path(), &MacOnlySet::open());
        assert!(!ran.exists(), "fetch ran the ext transport");
    }

    #[test]
    fn a_background_fetch_uses_ssh_instead_of_a_repo_command() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, _file, _remote, _before) = behind_remote();
        let ran = dir.path().join("ssh-ran");
        let script = dir.path().join("ssh.sh");
        fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", ran.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        git_in(
            dir.path(),
            &[
                "config",
                "--local",
                "core.sshCommand",
                script.to_str().unwrap(),
            ],
        );
        git_in(
            dir.path(),
            &[
                "remote",
                "set-url",
                "origin",
                "ssh://example.invalid/repo.git",
            ],
        );
        let error = fetch_remote(dir.path()).expect_err("ssh host does not exist");
        assert!(!ran.exists(), "repo sshCommand ran: {error}");
        assert!(!error.contains("cannot run :"), "empty sshCommand: {error}");
        assert!(
            error.to_ascii_lowercase().contains("example.invalid"),
            "{error}"
        );
    }

    #[test]
    fn a_planted_push_queue_does_not_use_ssh() {
        let (dir, file) = init_repo();
        git_in(
            dir.path(),
            &["remote", "add", "origin", "ssh://example.invalid/repo.git"],
        );
        fs::write(&file, "queued push\n").unwrap();
        assert!(enqueue_op(&file, "push", Some("share")).unwrap());
        flush_queue_with(dir.path(), &MacOnlySet::open()).unwrap();
        let queue = dir.path().join(".git/desk-queue");
        assert!(
            !queue.exists(),
            "ssh push stayed queued: {}",
            fs::read_to_string(&queue).unwrap_or_default()
        );
    }

    #[test]
    fn a_worktree_upload_pack_is_not_synced_in_the_background() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, _file, _remote, before) = behind_remote();
        let ran = dir.path().join("upload-ran");
        let script = dir.path().join("up.sh");
        fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", ran.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        git_in(dir.path(), &["config", "extensions.worktreeConfig", "true"]);
        git_in(
            dir.path(),
            &[
                "config",
                "--worktree",
                "remote.origin.uploadpack",
                script.to_str().unwrap(),
            ],
        );
        let result = pull_folder_with(dir.path(), &MacOnlySet::open()).unwrap();
        assert!(result.skipped, "{result:?}");
        assert_eq!(head_of(dir.path()), before);
        assert!(!dir.path().join("new.md").exists());
        assert!(!ran.exists(), "worktree upload-pack ran");
    }

    #[test]
    fn a_folder_with_gpg_program_does_not_flush_its_queue() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, file) = init_repo();
        let ran = dir.path().join("gpg-ran");
        let script = dir.path().join("gpg.sh");
        fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\nexit 1\n", ran.display()),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        git_in(dir.path(), &["config", "--local", "commit.gpgsign", "true"]);
        git_in(
            dir.path(),
            &["config", "--local", "gpg.program", script.to_str().unwrap()],
        );
        fs::write(&file, "queued edit\n").unwrap();
        assert!(enqueue_op(&file, "commit", Some("queued")).unwrap());
        flush_queue_with(dir.path(), &MacOnlySet::open()).unwrap();
        let status = git_output(dir.path(), &["status", "--porcelain"]).unwrap();
        assert!(
            stdout_trim(&status).contains("note.md"),
            "commit was replayed"
        );
        assert!(!ran.exists(), "gpg.program ran");
    }

    fn included_config(dir: &Path, key: &str, value: &str) -> PathBuf {
        let path = dir.join("included.gitconfig");
        git_in(
            dir,
            &["config", "--file", path.to_str().unwrap(), key, value],
        );
        path
    }

    fn assert_background_sync_skipped(dir: &Path, before: &str) {
        let result = pull_folder_with(dir, &MacOnlySet::open()).unwrap();
        assert!(result.skipped, "{result:?}");
        assert!(!result.updated, "{result:?}");
        assert_eq!(head_of(dir), before);
        assert!(!dir.join("new.md").exists());
    }

    #[test]
    fn an_include_path_that_sets_gpg_program_is_not_synced() {
        let (dir, _file, _remote, before) = behind_remote();
        let included = included_config(dir.path(), "gpg.program", "false");
        git_in(
            dir.path(),
            &[
                "config",
                "--local",
                "include.path",
                included.to_str().unwrap(),
            ],
        );
        assert_background_sync_skipped(dir.path(), &before);
    }

    #[test]
    fn an_include_if_gitdir_is_not_synced() {
        let (dir, _file, _remote, before) = behind_remote();
        let included = included_config(dir.path(), "gpg.program", "false");
        git_in(
            dir.path(),
            &[
                "config",
                "--local",
                "includeIf.gitdir:/no/such/.path",
                included.to_str().unwrap(),
            ],
        );
        assert_background_sync_skipped(dir.path(), &before);
    }

    #[test]
    fn a_smudge_filter_in_an_included_file_is_not_synced() {
        let (dir, _file, _remote, before) = behind_remote();
        let included = included_config(dir.path(), "filter.x.smudge", "false");
        git_in(
            dir.path(),
            &[
                "config",
                "--local",
                "include.path",
                included.to_str().unwrap(),
            ],
        );
        assert_background_sync_skipped(dir.path(), &before);
    }

    #[test]
    fn a_plain_repo_still_syncs() {
        let (dir, _file, _remote, before) = behind_remote();
        let result = pull_folder_with(dir.path(), &MacOnlySet::open()).unwrap();
        assert!(result.updated, "{result:?}");
        assert!(!result.skipped, "{result:?}");
        assert_ne!(head_of(dir.path()), before);
        assert_eq!(
            fs::read_to_string(dir.path().join("new.md")).unwrap(),
            "from remote\n"
        );
    }

    #[test]
    fn git_commands_set_safe_bare_repository() {
        for args in [GIT_SECURE, GIT_SECURE_BACKGROUND] {
            assert!(
                args.windows(2)
                    .any(|pair| { pair[0] == "-c" && pair[1] == "safe.bareRepository=explicit" }),
                "{args:?}"
            );
        }
        let dir = TempDir::new().unwrap();
        git_in(dir.path(), &["init", "-b", "main"]);
        let foreground = git_output(
            dir.path(),
            &["config", "--show-origin", "--get", "safe.bareRepository"],
        )
        .unwrap();
        assert!(foreground.status.success(), "{}", stderr_trim(&foreground));
        assert_eq!(stdout_trim(&foreground), "command line:\texplicit");
        let _background = BackgroundGit::enter();
        let background = git_output(
            dir.path(),
            &["config", "--show-origin", "--get", "safe.bareRepository"],
        )
        .unwrap();
        assert!(background.status.success(), "{}", stderr_trim(&background));
        assert_eq!(stdout_trim(&background), "command line:\texplicit");
    }
}
