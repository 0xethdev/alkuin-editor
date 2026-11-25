import { ask } from "@tauri-apps/plugin-dialog";
import * as tauri from "@/lib/tauri";
import { confirmPlaceholder } from "@/features/document-removal/delete";
import { parseShareAccess, type ShareAccess } from "@/features/document-share/access";
import { SHARE_FAILED_LINE } from "@/features/redline-spike/margin-copy";

/** Same sentences as `apps/desktop/src-tauri/src/mac_only.rs`. */
export const KEEP_ON_MAC_LABEL = "Keep on this Mac only";

/** Invite leaves the footer while the document stays on this Mac. */
export function inviteHiddenWhileKept(kept: boolean): boolean {
  return kept;
}
export const KEEP_ON_MAC_ON = "This document stays on this Mac.";
export const KEEP_ON_MAC_OFF = "This document can leave this Mac again.";
export const KEEP_ON_MAC_ASSISTANT =
  "This document stays on this Mac, so Alkuin can't send it for writing help.";
export const KEEP_ON_MAC_SHARE = "This document stays on this Mac, so Alkuin didn't share it.";
export const KEEP_ON_MAC_FOLDER =
  "A document in this folder stays on this Mac, so Alkuin didn't send anything.";
export const KEEP_ON_MAC_BACKUP = "This document stays on this Mac, so Alkuin didn't back it up.";
export const KEEP_ON_MAC_UNREADABLE =
  "Alkuin couldn't read which documents stay on this Mac, so it didn't send this one.";
export const DELETE_ONLINE_TITLE = "Delete the online copy?";
export const DELETE_ONLINE_BODY =
  "This document is also saved online. Delete that copy? It will stay on this Mac either way, and nothing new will be sent. Copies saved earlier can remain.";
export const DELETE_ONLINE_CONFIRM = "Delete the online copy";
export const DELETE_ONLINE_CANCEL = "Leave the online copy";
export const DELETE_ONLINE_LEFT = "The online copy is still there. Nothing new will be sent.";
export const DELETE_ONLINE_DONE = "The online copy was deleted. This document stays on this Mac.";
export const DELETE_ONLINE_NONE = "There's no online copy. This document stays on this Mac.";
export const DELETE_ONLINE_FAILED = "Alkuin couldn't delete the online copy. Nothing new was sent.";
export const KEEP_ON_MAC_SETTING_FAILED = "Alkuin couldn't change this setting.";

export const MAC_ONLY_LINES = [
  KEEP_ON_MAC_LABEL,
  KEEP_ON_MAC_ON,
  KEEP_ON_MAC_OFF,
  KEEP_ON_MAC_ASSISTANT,
  KEEP_ON_MAC_SHARE,
  KEEP_ON_MAC_FOLDER,
  KEEP_ON_MAC_BACKUP,
  KEEP_ON_MAC_UNREADABLE,
  DELETE_ONLINE_TITLE,
  DELETE_ONLINE_BODY,
  DELETE_ONLINE_CONFIRM,
  DELETE_ONLINE_CANCEL,
  DELETE_ONLINE_LEFT,
  DELETE_ONLINE_DONE,
  DELETE_ONLINE_NONE,
  DELETE_ONLINE_FAILED,
  KEEP_ON_MAC_SETTING_FAILED,
] as const;

const BANNED =
  /\b(commit|branch|merge|repo|repository|push|pull|diff|checkout|rebase|fetch|clone|stash|git|remote)\b/i;

export function copyIsPlain(text: string): boolean {
  return !text.includes("\u2014") && !text.includes("\u2013") && !BANNED.test(text);
}

const SHOWN_SHARE_ERRORS = new Set<string>([
  KEEP_ON_MAC_SHARE,
  KEEP_ON_MAC_FOLDER,
  KEEP_ON_MAC_UNREADABLE,
]);

/** A stay-on-this-Mac sentence is shown as written. Other failures stay general. */
export function shareFailureLine(error: string): string {
  return SHOWN_SHARE_ERRORS.has(error) ? error : SHARE_FAILED_LINE;
}

export interface KeepOutcome {
  kept: boolean;
  /** The line to show. Null when nothing changed, so there is nothing to say. */
  line: string | null;
}

/** Turn the setting on or off. A shared document asks before anyone else loses it. */
export async function setKeepOnThisMac(path: string, kept: boolean): Promise<KeepOutcome> {
  if (!kept) {
    await tauri.macOnlySet(path, false);
    return { kept: false, line: KEEP_ON_MAC_OFF };
  }
  let role: ShareAccess["role"] = "none";
  try {
    role = parseShareAccess(await tauri.shareRole(path)).role;
  } catch {
    role = "none";
  }
  if (role === "owner") {
    // Ask first. The question is whether to turn this on at all ("Keep on this
    // Mac only?" / Cancel), so Cancel has to leave the switch off and the
    // sharing as it was. Turning it on before asking left a document marked
    // Mac-only that was still shared. A confirm that can't be shown throws:
    // the caller says the setting didn't change instead of guessing an answer.
    const accepted = await confirmPlaceholder("mac-only");
    if (!accepted) return { kept: false, line: null };
    // On first, so nothing new is sent while sharing and the online copy go.
    await tauri.macOnlySet(path, true);
    await tauri.shareEraseDocument(path);
    const result = await tauri.macOnlyDeleteOnline(path);
    return { kept: true, line: result.message };
  }
  const state = await tauri.macOnlySet(path, true);
  if (!state.online) return { kept: true, line: KEEP_ON_MAC_ON };
  let accepted = false;
  try {
    accepted = await ask(DELETE_ONLINE_BODY, {
      title: DELETE_ONLINE_TITLE,
      kind: "warning",
      okLabel: DELETE_ONLINE_CONFIRM,
      cancelLabel: DELETE_ONLINE_CANCEL,
    });
  } catch {
    accepted = false;
  }
  if (!accepted) return { kept: true, line: DELETE_ONLINE_LEFT };
  const result = await tauri.macOnlyDeleteOnline(path);
  return { kept: true, line: result.message };
}
