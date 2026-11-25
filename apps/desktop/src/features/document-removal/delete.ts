import { openFileTabPaths, removePathReferences, removePathsWithPrefix } from "@/hooks/editor-api";
import {
  closeLedger,
  closeLedgerForPath,
  closeLedgersUnder,
} from "@/features/document-share/baseline";
import { confirmWarning } from "@/lib/native-dialog";
import { quiesceSave, resumeSave } from "@/lib/save";
import * as tauri from "@/lib/tauri";
import { confirmCopy, deleteKind, hostedShareId, type DeleteKind } from "./copy";

export { dialogAccepted } from "@/lib/native-dialog";

export function cloudRemovalFailure(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  if (text === "unreachable" || text === "unavailable") {
    return "Alkuin couldn't update the shared copy. It will try again.";
  }
  if (text === "unauthorized" || text === "bad_jwt") {
    return "Sign in again, then try removing this document.";
  }
  return null;
}

export async function confirmPlaceholder(
  kind: DeleteKind | "mac-only" | "restore",
): Promise<boolean> {
  return confirmWarning(confirmCopy(kind));
}

export async function deletionKind(path: string): Promise<DeleteKind> {
  try {
    const role = await tauri.shareRole(path);
    return deleteKind(role.role, path);
  } catch {
    return deleteKind("none", path);
  }
}

/** Close every open tab whose current file is this path, or lives under it
 *  when the path was a folder. Other tabs stay. */
function closeOpenDocument(path: string) {
  removePathReferences(path);
  // A trashed folder takes every document inside it, and their autosave.
  removePathsWithPrefix(path);
  // The file is gone, so its share ledger is too.
  closeLedgerForPath(path);
  closeLedgersUnder(path);
}

/** Close the tab for a Shared with you row, including an owner-removed tombstone. */
function closeOpenShare(id: string) {
  const want = id.toLowerCase();
  for (const path of openFileTabPaths()) {
    if (hostedShareId(path) === want) closeOpenDocument(path);
  }
}

/**
 * What one delete left behind, as `delete_entry_report` says it. The Trash
 * runs first: a rejection means it failed and nothing else ran. After it, a
 * failed shared-copy erase is `cloud_error` (Rust queues it and tries again).
 */
export type TrashOutcome =
  | { kind: "trashed" }
  | { kind: "trashedCloudFailed"; error: unknown }
  | { kind: "kept"; error: unknown };

async function attemptTrash(path: string): Promise<TrashOutcome> {
  // A write on its way must land before the trash, or it re-creates the file.
  await quiesceSave(path);
  let report: tauri.DeleteReport;
  try {
    report = await tauri.deleteEntryReport(path);
  } catch (error) {
    // The file is still there, so its autosave may run again.
    resumeSave(path);
    return { kind: "kept", error };
  }
  if (!report.trashed) {
    resumeSave(path);
    return { kind: "kept", error: new Error(`The Trash did not take ${path}.`) };
  }
  if (report.cloud_error != null) {
    return { kind: "trashedCloudFailed", error: new Error(report.cloud_error) };
  }
  return { kind: "trashed" };
}

const trashing = new Map<string, Promise<void>>();

/**
 * Trash the file, then close its tab.
 * A cloud error after the file is already gone still closes the tab, then throws.
 * A second call for a path already being trashed waits for the first.
 */
export function trashEntry(path: string): Promise<void> {
  const running = trashing.get(path);
  if (running) return running;
  const run = attemptTrash(path)
    .then((outcome) => {
      if (outcome.kind !== "kept") closeOpenDocument(path);
      if (outcome.kind !== "trashed") throw outcome.error;
    })
    .finally(() => trashing.delete(path));
  trashing.set(path, run);
  return run;
}

/** Ask, then trash the file. The server call is inside deleteEntry. */
export async function deleteDocument(path: string): Promise<boolean> {
  const kind = await deletionKind(path);
  if (!(await confirmPlaceholder(kind))) return false;
  await trashEntry(path);
  return true;
}

/** Confirm, leave the share, and close that document's tab. Cancel returns false. */
export async function leaveAcceptedShare(id: string): Promise<boolean> {
  if (!(await confirmPlaceholder("invitee"))) return false;
  await tauri.shareLeave(id);
  closeLedger(id);
  closeOpenShare(id);
  return true;
}
