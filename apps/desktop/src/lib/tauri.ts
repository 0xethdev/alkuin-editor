import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import sidebarEntryKinds from "@shared/sidebar-entry-kinds.json";
import type {
  DirEntry,
  FileContent,
  IndexStats,
  SearchResult,
  WriteResult,
  WorkspaceInfo,
} from "@/types/fs";

// Filesystem commands
export function readDirectory(path: string): Promise<DirEntry[]> {
  return invoke("read_directory", { path });
}

export function readRecentFiles(limit: number, offset: number): Promise<DirEntry[]> {
  return invoke("read_recent_files", { limit, offset });
}

export function readFileEntries(paths: string[]): Promise<DirEntry[]> {
  return invoke("read_file_entries", { paths });
}

export function readFile(path: string): Promise<FileContent> {
  return invoke("read_file", { path });
}

/**
 * `expected` is the text this app last read or wrote at `path`. When the file holds
 * something else by now, Rust keeps that version beside it before writing, and names
 * it in `other_copy`. Without `expected` the file is written without looking.
 */
export function writeFile(path: string, content: string, expected?: string): Promise<WriteResult> {
  return invoke("write_file", { path, content, expected });
}

/** Write a publisher PDF. `body` is the open document body, without frontmatter. */
export function exportPdf(
  path: string,
  title: string,
  body: string,
  notePath: string,
): Promise<void> {
  return invoke("export_pdf", { path, title, body, notePath });
}

/** Read a Word file into markdown. */
export function docxToMarkdown(path: string): Promise<string> {
  return invoke("docx_to_markdown", { path });
}

/** Download a link-shared Google Doc as Word and return markdown. */
export function googleDocToMarkdown(url: string): Promise<string> {
  return invoke("google_doc_to_markdown", { url });
}

/** Write the open note as a Word file. `body` has no frontmatter. */
export function exportDocx(
  path: string,
  title: string,
  body: string,
  notePath: string,
): Promise<void> {
  return invoke("export_docx", { path, title, body, notePath });
}

export function createFile(path: string): Promise<FileContent> {
  return invoke("create_file", { path });
}

export function createDirectory(path: string): Promise<DirEntry> {
  return invoke("create_directory", { path });
}

export type SidebarEntryKind = keyof typeof sidebarEntryKinds;

export function createSidebarEntry(parentPath: string, kind: SidebarEntryKind): Promise<DirEntry> {
  return invoke("create_sidebar_entry", { parentPath, kind });
}

export function renameEntry(oldPath: string, newPath: string): Promise<void> {
  return invoke("rename_entry", { oldPath, newPath });
}

export function deleteEntry(path: string): Promise<void> {
  return invoke("delete_entry", { path });
}

export interface DeleteReport {
  /** Always true: a failed Trash rejects and nothing else runs. */
  trashed: boolean;
  /** The shared-copy erase failed after the Trash. It is queued. */
  cloud_error: string | null;
}

/** Same steps as `deleteEntry`. Rejects only when the Trash failed. */
export function deleteEntryReport(path: string): Promise<DeleteReport> {
  return invoke("delete_entry_report", { path });
}

export function fileExists(path: string): Promise<boolean> {
  return invoke("file_exists", { path });
}

/** Case-insensitive basename lookup across the workspace (gitignore-aware
 *  walk; shortest path wins on duplicates). Used by wiki image embeds. */
export function findFileByName(root: string, fileName: string): Promise<string | null> {
  return invoke("find_file_by_name", { root, fileName });
}

export function revealInFileManager(path: string): Promise<void> {
  return invoke("reveal_in_file_manager", { path });
}

// Workspace commands
export function openWorkspace(path: string): Promise<WorkspaceInfo> {
  return invoke("open_workspace", { path });
}

export function closeWorkspace(root: string): Promise<void> {
  return invoke("close_workspace", { root });
}

export function openWorkspaceInFileManager(): Promise<void> {
  return invoke("open_workspace_in_file_manager");
}

export function openDirectoryInTerminal(path: string | null): Promise<void> {
  return invoke("open_workspace_in_terminal", { path });
}

/** Open a new in-process window for the given workspace. Each window owns
 *  its own per-window `WorkspaceState` on the Rust side (watcher, file
 *  index, settings layer) so two windows hosting different workspaces don't
 *  share file events or search results. Pass `file` to have the new window
 *  focus a specific markdown file inside the workspace. If another window
 *  already hosts `path`, that window is focused instead. */
export function openWorkspaceInNewWindow(path: string, file?: string | null): Promise<void> {
  return invoke("open_workspace_in_new_window", { path, file: file ?? null });
}

/** Bundled startup-restore IPC. Returns workspace info, root directory
 *  entries, the recents list, the persisted session, and (when available)
 *  the active tab's file content in a single round trip. */
export interface RestoreWorkspaceResponse {
  workspace: WorkspaceInfo;
  entries: DirEntry[];
  recent_workspaces: string[];
  session: SessionData | null;
  active_file: FileContent | null;
  open_file: string | null;
}

export function restoreWorkspace(path: string): Promise<RestoreWorkspaceResponse> {
  return invoke("restore_workspace", { path });
}

export async function pickWorkspace(): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: "Open Folder",
  });
  return selected;
}

export async function pickFile(): Promise<string | null> {
  const selected = await openDialog({
    directory: false,
    multiple: false,
    title: "Open File",
    filters: [{ name: "Markdown", extensions: ["md", "mdx", "markdown", "txt"] }],
  });
  return selected;
}

export function getRecentWorkspaces(): Promise<string[]> {
  return invoke("get_recent_workspaces");
}

export function removeRecentWorkspace(path: string): Promise<void> {
  return invoke("remove_recent_workspace", { path });
}

/**
 * Move a recent workspace folder, and everything in it, to the Trash and drop
 * it from the list. Only a listed folder no window uses. Resolves to the queued
 * shared-copy error, or null.
 */
export function trashRecentWorkspace(path: string): Promise<string | null> {
  return invoke("trash_recent_workspace", { path });
}

/** Open a markdown file in a standalone compact window (no workspace). If a
 *  standalone window already hosts the file, it is focused instead. */
export function openFileInStandaloneWindow(path: string): Promise<void> {
  return invoke("open_file_in_standalone_window", { path });
}

/** Point this window's watcher at a single standalone file (parent-dir,
 *  non-recursive). Call whenever the standalone compact window switches
 *  files. */
export function watchStandaloneFile(path: string): Promise<void> {
  return invoke("watch_standalone_file", { path });
}

// Global recents (persisted across workspaces in the app data dir)
/** A recently-opened file with its last-opened time. `opened_at` is unix
 *  seconds; `0` marks a legacy entry whose open time is unknown. */
export interface RecentFile {
  path: string;
  name: string;
  title: string | null;
  opened_at: number;
}

export function recordRecentFile(path: string): Promise<void> {
  return invoke("record_recent_file", { path });
}

export function removeRecentFile(path: string): Promise<void> {
  return invoke("remove_recent_file", { path });
}

export function getRecentFilesGlobal(limit?: number): Promise<RecentFile[]> {
  return invoke("get_recent_files_global", { limit: limit ?? null });
}

// Session commands
export interface SessionData {
  tabs?: SessionTabData[];
  active_index?: number | null;
}

export interface SerializedLocationData {
  kind: string;
  [key: string]: unknown;
}

export interface SessionTabData {
  location: SerializedLocationData;
  back: SerializedLocationData[];
  forward: SerializedLocationData[];
}

export function saveSession(
  workspaceRoot: string,
  tabs: SessionTabData[],
  activeIndex: number | null,
): Promise<void> {
  return invoke("save_session", { workspaceRoot, tabs, activeIndex });
}

export function loadSession(workspaceRoot: string): Promise<SessionData | null> {
  return invoke("load_session", { workspaceRoot });
}

// Search commands
export function indexWorkspace(): Promise<IndexStats> {
  return invoke("index_workspace");
}

export function fuzzySearch(query: string, limit?: number): Promise<SearchResult[]> {
  return invoke("fuzzy_search", { query, limit });
}

// Font commands
export function listSystemFonts(): Promise<string[]> {
  return invoke("list_system_fonts");
}

// Settings commands
export function getSettings(): Promise<Record<string, unknown>> {
  return invoke("get_settings");
}

export function getSetting(key: string): Promise<unknown> {
  return invoke("get_setting", { key });
}

export function setSetting(
  key: string,
  value: unknown,
  scope: "global" | "workspace" = "global",
): Promise<unknown> {
  return invoke("set_setting", { key, value, scope });
}

export function resetSetting(key: string, scope: "global" | "workspace" = "global"): Promise<void> {
  return invoke("reset_setting", { key, scope });
}

// Telemetry consent. After the first-run prompt, Preferences changes usage and
// the email through the normal `setSetting` path above. The prompt itself is
// answered once, through `telemetryAnswer`.
export function telemetryShouldPrompt(): Promise<boolean> {
  return invoke("telemetry_should_prompt");
}

export type TelemetryAnswer = "declined" | "email-only" | "usage";

/** Answer the first-run prompt. The backend writes the consent record and the
 *  matching `telemetry.enabled` / `telemetry.email` settings together, before
 *  anything is sent. "declined" clears any stored email and sends nothing; the
 *  other two need `email`. */
export function telemetryAnswer(choice: TelemetryAnswer, email: string | null): Promise<void> {
  return invoke("telemetry_answer", { choice, email });
}

/** Reply to `app:save-before-quit` (`{ round }`). Alkuin quits once every
 *  window has replied with `failed: false`; a failure asks before quitting. */
export function reportQuitSaves(round: number, failed: boolean): Promise<void> {
  return invoke("report_quit_saves", { round, failed });
}

// Pending open queue (drag-drop / CLI arg / dock open). A folder open
// carries `workspace`; a markdown-file open carries only `file` and opens
// standalone (compact window, no workspace).
export interface PendingOpenPayload {
  workspace: string | null;
  file: string | null;
}

export function takePendingOpen(): Promise<PendingOpenPayload | null> {
  return invoke("take_pending_open");
}

// Startup state (single IPC call for all initialization data). The settings
// schema is NOT included — it's a build-time constant that the frontend
// imports statically from `@/lib/settings-schema` rather than fetching over
// IPC. Rust still uses the JSON internally (config.rs::settings_schema) for
// defaults; the IPC just doesn't expose it to TS.
export interface StartupState {
  settings: Record<string, unknown>;
  recent_workspaces: string[];
  restore_bundle: RestoreWorkspaceResponse | null;
  /** Standalone compact-mode open (CLI arg / drag-drop of a markdown file).
   *  Mutually exclusive with `restore_bundle`; the single-file watcher is
   *  already running by the time this returns. */
  standalone_file: FileContent | null;
}

export function getStartupState(): Promise<StartupState> {
  return invoke("get_startup_state");
}

// Window commands
export function showMainWindow(): Promise<void> {
  return getCurrentWindow().show();
}

/** Request a close of this window. Goes through the close-requested event,
 *  so the main window is hidden rather than destroyed (`lib.rs`). */
export function closeWindow(): Promise<void> {
  return getCurrentWindow().close();
}

// Native git (Own-Git). Accept commits one file; Share pushes. Not a second store.
export interface GitFileStatus {
  repo_root: string | null;
  clean: boolean;
  porcelain: string;
  diff: string;
  error: string | null;
  sharing?: boolean;
}

export interface GitCommitResult {
  committed: boolean;
  commit_sha: string | null;
  error: string | null;
  /** Lock or network miss. The caller may queue a commit. Never a push. */
  retry?: boolean;
}

export interface GitPublishResult {
  committed: boolean;
  pushed: boolean;
  commit_sha: string | null;
  error: string | null;
  /** Lock or network miss. The caller may queue a push. */
  retry?: boolean;
}

export interface GitPullResult {
  updated: boolean;
  skipped: boolean;
  conflict: boolean;
  error: string | null;
  /** Network miss. The caller may queue a pull. A conflict is not a retry. */
  retry?: boolean;
}

export function gitFileStatus(path: string): Promise<GitFileStatus> {
  return invoke("git_file_status", { path });
}

/** `git add` + `git commit` of this file only. Does not push. */
export function gitCommitFile(path: string): Promise<GitCommitResult> {
  return invoke("git_commit_file", { path });
}

export function gitPublishFile(path: string, message: string): Promise<GitPublishResult> {
  return invoke("git_publish_file", { path, message });
}

/** Remember one git CLI op. The file bytes stay in the document, not here. */
export function gitEnqueueOp(
  path: string,
  op: "commit" | "push" | "pull",
  message?: string,
): Promise<boolean> {
  return invoke("git_enqueue_op", { path, op, message: message ?? null });
}

/** Replay queued git ops for this folder. A commit op does not push. */
export function gitFlushQueue(path: string): Promise<void> {
  return invoke("git_flush_queue", { path });
}

/** Fetch and fast-forward or merge. No remote is a no-op. Does not clobber. */
export function gitPull(path: string): Promise<GitPullResult> {
  return invoke("git_pull", { path });
}

export interface HistorySendResult {
  sent: boolean;
  waiting: boolean;
  refused: boolean;
  unconfigured: boolean;
  conflict?: boolean;
  deleted?: boolean;
  other_text?: string | null;
  local_text?: string | null;
  version_id?: string | null;
  /** The server refused this version for good. It is not queued again. */
  stopped?: boolean;
  /** The file is gone. Nothing was uploaded. */
  missing?: boolean;
}

export interface HistoryBringResult {
  path: string;
  overlap: boolean;
  other_text: string | null;
  local_text: string | null;
  skipped: boolean;
  deleted?: boolean;
  version_id?: string;
}

export interface HistoryFlushResult {
  sent: number;
  waiting: boolean;
  overlaps: HistoryBringResult[];
  /** Queued documents removed without an upload. */
  dropped?: string[];
  /** Queued documents kept after a local error. */
  failed?: string[];
  /** The part of `dropped` the server refused for good: their backup did not happen. */
  stopped?: string[];
}

/** Text an AI chat asked to add to the end of a document. It is not in the file. */
export interface HistoryPulledProposal {
  path: string;
  project_id: string;
  document_id: string;
  proposal_id: string;
  text: string;
}

export interface HistoryPullResult {
  suggestions: HistoryBringResult[];
  wrote: string[];
  removed: string[];
  /** Paths whose copy could not be applied. The next pull tries again. */
  failed?: string[];
  /** Suggested additions waiting on this folder. Null: not read this time. */
  proposals?: HistoryPulledProposal[] | null;
  /** Sync ids of documents whose suggestions could not be read this time. */
  proposals_unread?: string[];
}

/** The sync ids the folder's notes hold for one document. */
export interface HistoryDocumentIdentity {
  project_id: string;
  document_id: string;
}

/** Which synced document is open at `path`. Null when it has never synced. No request is made. */
export function historyDocumentIdentity(path: string): Promise<HistoryDocumentIdentity | null> {
  return invoke("history_document_identity", { path });
}

/** Upload when a destination exists. The central guard runs before any send. */
export function historySend(path: string, online: boolean): Promise<HistorySendResult> {
  return invoke("history_send", { path, online });
}

export function historyBring(path: string): Promise<HistoryBringResult> {
  return invoke("history_bring", { path });
}

export function historyFlush(online: boolean): Promise<HistoryFlushResult> {
  return invoke("history_flush", { online });
}

/** Fetch this account's copies. A dirty path is left for the next save. */
export function historyPull(
  root: string,
  dirty: string[],
  online: boolean,
): Promise<HistoryPullResult> {
  return invoke("history_pull", { root, dirty, online });
}

/** Accept writes their copy or removes the file. Reject keeps this copy and sends it. */
export function historySettle(
  path: string,
  choice: "accept" | "reject",
  versionId: string,
  otherText: string,
  deleted: boolean,
): Promise<HistorySendResult> {
  return invoke("history_settle", { path, choice, versionId, otherText, deleted });
}

/** The writer decided a suggested addition. Queued on this Mac first, then sent. */
export function historyProposalDecide(
  projectId: string,
  documentId: string,
  proposalId: string,
): Promise<void> {
  return invoke("history_proposal_decide", { projectId, documentId, proposalId });
}

export function historyDeleteProject(projectId: string): Promise<void> {
  return invoke("history_delete_project", { projectId });
}

/** The switch writes this. Send paths only read it. */
export function historySetStaysOnThisMac(path: string, stays: boolean): Promise<void> {
  return invoke("history_set_stays_on_this_mac", { path, stays });
}

export function historyStaysOnThisMac(path: string): Promise<boolean> {
  return invoke("history_stays_on_this_mac", { path });
}

export interface RedlineProposal {
  suggested_text: string;
  intent?: "insert" | "replace" | "none";
  notice?: string | null;
  caution?: string | null;
}

/** Ask for a suggestion on a selected span. The session stays in Rust.
 *  `path` stays on this Mac so a document that must not leave can be refused. */
export function redlinePropose(
  path: string,
  original: string,
  instruction: string,
): Promise<RedlineProposal> {
  return invoke("redline_propose", { path, original, instruction });
}

export interface StyleItemPayload {
  id?: string;
  rule: string;
  why: string;
  scope: string;
  seen: number;
}

export interface AccountPreferences {
  signed_in: boolean;
  offline: boolean;
  email?: string | null;
  effective?: string | null;
  spent: number;
  soft_cap: number;
  hard_cap: number;
  window_end?: string | null;
  status_line?: string | null;
  plan_label?: string | null;
  date_line?: string | null;
  margin_band?: string | null;
  items: StyleItemPayload[];
  eu_consent?: boolean;
  refund_open?: boolean;
  allowance_percent?: number | null;
  overage?: boolean;
  overage_maximum?: number | null;
  overage_default_dollars?: number | null;
  overage_prompt?: boolean;
  overage_ask_price?: string | null;
  allowance_resets?: string | null;
  used_pct?: number | null;
  account_id?: string | null;
  credit?: string | null;
  frozen?: boolean;
  referral_code?: string | null;
}

/** Plan, budget numbers, and learned items. The status line is not computed here. */
export function accountPreferences(): Promise<AccountPreferences> {
  return invoke("account_preferences");
}

/** Delete every learned item for this account. The plan and this month's help stay. */
export function accountClearStyle(): Promise<void> {
  return invoke("account_clear_style");
}

/** Delete one learned rule. A missing rule is success. */
export function accountForgetStyle(id: string): Promise<void> {
  return invoke("account_forget_style", { id });
}

export function accountSignOut(): Promise<void> {
  return invoke("account_sign_out");
}

export function accountCheckout(
  interval: "month" | "year" | "topup",
  serviceStartsNow: boolean,
  referral?: string | null,
): Promise<string> {
  return invoke("account_checkout", {
    interval,
    serviceStartsNow,
    referral: referral?.trim() ? referral.trim() : null,
  });
}

export function accountPortal(): Promise<string> {
  return invoke("account_portal");
}

export interface CancelResult {
  plan: string;
  line: string;
}

export function accountCancelPreview(): Promise<CancelResult> {
  return invoke("account_cancel_preview");
}

export function accountRefund(): Promise<CancelResult> {
  return invoke("account_refund");
}

export function accountUsage(
  overage: boolean,
  maximum: number | null,
  prompt = false,
): Promise<void> {
  return invoke("account_usage", { overage, maximum, prompt });
}

export interface AccountStatus {
  signed_in: boolean;
  email?: string | null;
}

/** Ask Auth to send a sign-in code. The code stays in the mailbox. */
export function accountSignInStart(email: string): Promise<void> {
  return invoke("account_sign_in_start", { email });
}

/**
 * Finish sign-in, with the code, or for a new account with the ticket the code
 * returned and the date of birth. The session tokens stay in the OS keychain,
 * not this result.
 */
export function accountSignInFinish(
  email: string,
  code: string,
  birthDate = "",
  ageTicket = "",
): Promise<AccountStatus> {
  return invoke("account_sign_in_finish", {
    email,
    code,
    birthDate: birthDate.trim(),
    ageTicket: ageTicket.trim(),
  });
}

/** Keychain only. Does not call Auth. */
export function accountStoredSession(): Promise<AccountStatus> {
  return invoke("account_stored_session");
}

export function accountStatus(): Promise<AccountStatus> {
  return invoke("account_status");
}

/** Delete the account. Does not take a document path. */
export function accountDelete(): Promise<void> {
  return invoke("account_delete");
}

/** Accept, Reject, or an edit. The server drops the three texts after the call.
 *  `path` stays on this Mac and is not sent with the lesson. */
export function redlineLearn(
  path: string,
  source: "accept" | "reject" | "edit",
  before: string,
  suggested: string,
  finalText: string,
): Promise<void> {
  return invoke("redline_learn", { path, source, before, suggested, finalText });
}

export interface MacOnlyView {
  kept: boolean;
  online: boolean;
}

export interface OnlineDeleteView {
  deleted: boolean;
  missing: boolean;
  message: string;
}

/** Every plan. The command does not read the account. */
export function macOnlyGet(path: string): Promise<boolean> {
  return invoke("mac_only_get", { path });
}

export function macOnlySet(path: string, kept: boolean): Promise<MacOnlyView> {
  return invoke("mac_only_set", { path, kept });
}

export function macOnlyDeleteOnline(path: string): Promise<OnlineDeleteView> {
  return invoke("mac_only_delete_online", { path });
}

export interface ShareRole {
  role: string;
  share_id: string | null;
  document_id: string;
  status?: string | null;
}

export interface ShareChangeView {
  id: string;
  share_id: string;
  start: number;
  end: number;
  original: string;
  body: string | null;
  sender_email: string;
  snapshot?: string | null;
}

export function shareRole(path: string): Promise<ShareRole> {
  return invoke("share_role", { path });
}

export interface SharedWithYouRow {
  id: string;
  title: string;
  owner: string;
  open: number;
  pending?: boolean;
  removed?: boolean;
}

export interface RestoreRow {
  document_id: string;
  title: string;
}

export interface OwnMention {
  path: string;
  open: number;
}

export interface ShareDesk {
  shared: SharedWithYouRow[];
  shared_count: number;
  own: OwnMention[];
  own_count: number;
  restore?: RestoreRow[];
}

export function shareDesk(paths: string[]): Promise<ShareDesk> {
  return invoke("share_desk", { paths });
}

export function shareOpenAccepted(id: string, keep = false): Promise<string> {
  return invoke("share_open_accepted", { id, keep });
}

/** Why the last invite link that arrived could not be opened. Read once, then gone. */
export function shareInviteRefusal(): Promise<string | null> {
  return invoke("share_invite_refusal");
}

export function shareLatest(id: string): Promise<string> {
  return invoke("share_latest", { id });
}

export function sharePublish(path: string): Promise<void> {
  return invoke("share_publish", { path });
}

export function shareEraseDocument(path: string): Promise<void> {
  return invoke("share_erase_document", { path });
}

export function shareRestoreDocument(documentId: string): Promise<void> {
  return invoke("share_restore_document", { document_id: documentId });
}

export function shareAnswer(id: string, accept: boolean): Promise<void> {
  return invoke("share_answer", { id, accept });
}

export function shareLeave(id: string): Promise<void> {
  return invoke("share_leave", { id });
}

export function shareInvite(path: string, email: string): Promise<{ id: string }> {
  return invoke("share_invite", { path, email });
}

export function sharePending(path: string): Promise<ShareChangeView[]> {
  return invoke("share_pending", { path });
}

export function shareSend(
  path: string,
  shareId: string,
  changes: Array<{ payload_ref: string; passage: string; original: string; body: string }>,
  withdraw: string[] = [],
  snapshot?: string,
): Promise<string[]> {
  return invoke("share_send", { path, shareId, changes, withdraw, snapshot });
}

/** Which refs one send settled. A ref in none of the lists can be sent again. */
export interface ShareSendReport {
  posted: string[];
  withdrawn: string[];
  /** Refused for good (already decided). */
  refused: string[];
  /** The first failure. The lists still say what was settled. */
  error: string | null;
}

/** Same send as `shareSend`, but never rejects for a server failure. */
export function shareSendReport(
  path: string,
  shareId: string,
  changes: Array<{ payload_ref: string; passage: string; original: string; body: string }>,
  withdraw: string[] = [],
  snapshot?: string,
): Promise<ShareSendReport> {
  return invoke("share_send_report", { path, shareId, changes, withdraw, snapshot });
}

export function shareRealtimeAuth(
  shareId: string,
): Promise<{ url: string; anon: string; token: string }> {
  return invoke("share_realtime_auth", { shareId });
}

export function shareDecide(id: string, accept: boolean): Promise<void> {
  return invoke("share_decide", { id, accept });
}

export function mentionPeople(
  path: string,
): Promise<{ mac_only?: boolean; people?: MentionPerson[] }> {
  return invoke("mention_people", { path });
}

export function mentionWrite(input: {
  path: string;
  action: "mention" | "reply" | "wording" | "done";
  noteId: string;
  quote?: string | null;
  mentionedIds: string[];
  noteAuthor?: string | null;
}): Promise<void> {
  return invoke("mention_write", {
    path: input.path,
    action: input.action,
    noteId: input.noteId,
    quote: input.quote ?? null,
    mentionedIds: input.mentionedIds,
    noteAuthor: input.noteAuthor ?? null,
  });
}

export interface OpenMention {
  id: string;
  document_id: string;
  note_id: string;
  kind: string;
  author_id: string;
  quote: string | null;
}

export function mentionOpen(): Promise<OpenMention[]> {
  return invoke("mention_open");
}

export function mentionEmailPref(enabled?: boolean): Promise<boolean> {
  return invoke("mention_email_pref", { enabled: enabled ?? null });
}

export function mentionDocumentIds(
  paths: string[],
): Promise<{ path: string; document_id: string }[]> {
  return invoke("mention_document_ids", { paths });
}

export interface MentionPerson {
  id: string;
  email: string;
  role: string;
  name?: string | null;
}

// Image commands
export function saveClipboardImage(
  markdownFilePath: string,
  imageData: number[],
  format: string,
): Promise<{ relative_path: string; absolute_path: string }> {
  return invoke("save_clipboard_image", { markdownFilePath, imageData, format });
}
