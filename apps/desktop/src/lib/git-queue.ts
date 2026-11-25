import {
  showEditorNotice,
  useEditorNoticeStore,
} from "@/components/editor-area/editor-notice-store";
import { notePulledProposals } from "@/features/agent-proposal/store";
import { otherEditsLine } from "@/features/redline-spike/margin-copy";
import {
  getActiveFilePath,
  getOpenFile,
  getOpenFiles,
  closeFile,
  reloadFromDisk,
} from "@/hooks/editor-api";
import { getWorkspaceIdentity, isCurrentWorkspaceIdentity } from "@/hooks/workspace-api";
import { noteBackupOutcome } from "@/lib/history/backup-notice";
import { isSaveActive } from "@/lib/save";
import * as tauri from "@/lib/tauri";
import type { HistoryBringResult } from "@/lib/tauri";

/** Fail-open. A queue miss must not undo the disk write. */
export async function notePendingGitOp(
  path: string,
  op: "commit" | "push" | "pull",
  message?: string,
): Promise<void> {
  try {
    await tauri.gitEnqueueOp(path, op, message);
  } catch {
    // The file is already on disk.
  }
}

/** One attempt. Transient misses stay queued for the next call. */
async function flushGitQueue(root: string | null | undefined): Promise<void> {
  if (!root) return;
  try {
    await tauri.gitFlushQueue(root);
  } catch {
    // A later reconnect or folder open tries again.
  }
}

function historyOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function dirtyOpenPaths(): string[] {
  const paths: string[] = [];
  for (const file of getOpenFiles().values()) {
    if (file.isDirty) paths.push(file.path);
  }
  return paths;
}

/** One Accept/Reject suggestion. The active document wins. No compare screen. */
function showOneSuggestion(items: HistoryBringResult[]): void {
  const ready = items.filter(
    (item) => item.overlap && item.path && item.local_text != null && item.other_text != null,
  );
  if (ready.length === 0) return;
  const active = getActiveFilePath();
  const chosen = ready.find((item) => item.path === active) ?? ready[0];
  if (!chosen || chosen.local_text == null || chosen.other_text == null) return;
  useEditorNoticeStore.getState().showOverlap({
    path: chosen.path,
    localText: chosen.local_text,
    otherText: chosen.other_text,
    deleted: chosen.deleted === true,
    versionId: chosen.version_id ?? "",
  });
}

/**
 * Bring pulled files into the editor. A clean buffer takes the new disk text.
 * A file the pull removed closes, unless it has unsaved words: those stay open
 * and dirty, and saving them puts the file back. Losing typed words to a
 * remote delete is worse than the file returning.
 */
async function applyPulledFiles(
  wrote: string[],
  removed: string[],
  stillCurrent: () => boolean,
): Promise<void> {
  for (const path of removed) {
    const open = getOpenFile(path);
    if (open?.isDirty || isSaveActive(path)) continue;
    closeFile(path);
  }
  for (const path of wrote) {
    const open = getOpenFile(path);
    if (!open || open.isDirty) continue;
    try {
      const disk = await tauri.readFile(path);
      if (!stillCurrent()) return;
      // Typing or a save since the read keeps the buffer as it is.
      reloadFromDisk(path, disk.content, { policy: "if-clean", expectedDisk: open.diskContent });
    } catch {
      // A clean buffer can still reload from the file watcher.
    }
  }
}

/** Upload copies that were waiting, then fetch this folder. */
async function runHistorySync(root: string | null, stillCurrent: () => boolean): Promise<void> {
  try {
    const online = historyOnline();
    const flushed = await tauri.historyFlush(online);
    // A queued copy the server refused for good is out of the queue, and its backup did
    // not happen. The same once-per-file line a save gives.
    for (const path of flushed?.stopped ?? []) noteBackupOutcome(path, { stopped: true });
    const suggestions = [...(flushed?.overlaps ?? [])];
    if (root && online) {
      const pulled = await tauri.historyPull(root, dirtyOpenPaths(), online);
      if (!stillCurrent()) return;
      if (pulled) {
        notePulledProposals(root, pulled.proposals, pulled.proposals_unread);
        suggestions.push(...(pulled.suggestions ?? []));
        await applyPulledFiles(pulled.wrote ?? [], pulled.removed ?? [], stillCurrent);
      }
    }
    if (!stillCurrent()) return;
    showOneSuggestion(suggestions);
  } catch {
    // The bytes already on disk stay.
  }
}

/** Flush queued commits and pushes, then pull when the folder is shared. */
async function runGitSync(root: string, stillCurrent: () => boolean): Promise<void> {
  await flushGitQueue(root);
  let sharing = false;
  try {
    const status = await tauri.gitFileStatus(root);
    sharing = status?.sharing === true;
  } catch {
    return;
  }
  if (!sharing) return;
  try {
    const result = await tauri.gitPull(root);
    if (!result) return;
    if (result.conflict) {
      const line = otherEditsLine();
      if (line && stillCurrent()) showEditorNotice(line, { sticky: true });
      return;
    }
    if (result.retry) await notePendingGitOp(root, "pull");
  } catch {
    // The bytes already on disk stay.
  }
}

type SyncKind = "history" | "git";

interface SyncRequest {
  kind: SyncKind;
  root: string | null;
}

/**
 * Sync runs are single-flight: `idle`, or `running` with at most one merged
 * rerun waiting in `pendingSync`. Focus, the interval, `online` and folder
 * open all request; a git request wins over a history one, and the latest
 * root wins. A run captures the workspace identity when it starts and drops
 * its results if the folder was closed or switched meanwhile.
 */
let pendingSync: SyncRequest | null = null;
let syncLoop: Promise<void> | null = null;

function requestSync(kind: SyncKind, root: string | null): Promise<void> {
  const merged: SyncKind = pendingSync?.kind === "git" || kind === "git" ? "git" : "history";
  pendingSync = { kind: merged, root };
  if (!syncLoop) {
    syncLoop = (async () => {
      try {
        while (pendingSync) {
          const request = pendingSync;
          pendingSync = null;
          await runSync(request);
        }
      } finally {
        syncLoop = null;
      }
    })();
  }
  return syncLoop;
}

async function runSync(request: SyncRequest): Promise<void> {
  const identity = getWorkspaceIdentity();
  const stillCurrent = () => isCurrentWorkspaceIdentity(identity);
  if (request.kind === "git" && request.root) {
    try {
      await runGitSync(request.root, stillCurrent);
    } finally {
      // Waiting history copies flush after, including when the folder is not shared.
      await runHistorySync(request.root, stillCurrent);
    }
    return;
  }
  await runHistorySync(request.root, stillCurrent);
}

/**
 * Upload copies that were waiting, then fetch this folder.
 * An unchanged file is written. A conflict is one Accept/Reject suggestion.
 */
export function syncHistoryCopies(root?: string | null): Promise<void> {
  return requestSync("history", root ?? null);
}

/**
 * Flush queued commits and pushes, then bring in the other copy when a
 * remote exists. A conflict is shown and not retried. A network miss is
 * queued. Neither path rewrites the file from here. Waiting history copies
 * flush after, including when the folder is not shared.
 */
export function syncGitFolder(root: string | null | undefined): Promise<void> {
  if (!root) return Promise.resolve();
  return requestSync("git", root);
}

/** Browser online event. Returns the unsubscribe. No-op without `window`. */
export function armGitQueueOnlineFlush(currentRoot: () => string | null): () => void {
  if (typeof window === "undefined") return () => {};
  const onOnline = () => {
    void syncGitFolder(currentRoot());
  };
  window.addEventListener("online", onOnline);
  return () => window.removeEventListener("online", onOnline);
}
