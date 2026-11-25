import { hostedCopy } from "@/features/document-share/access";

/** Confirm, tombstone, and restore lines. */

export const DELETE_OWNER_TITLE = "Delete this document?";
export const DELETE_OWNER_BODY =
  "This removes it from your Mac and from Alkuin. Everyone you invited loses access. Their unsent words stay on their Mac only.";
export const DELETE_OWNER_CONFIRM = "Delete";
export const DELETE_OWNER_CANCEL = "Cancel";

export const DELETE_INVITEE_TITLE = "Remove this document?";
export const DELETE_INVITEE_BODY =
  "This only removes it from your list. The owner and anyone else invited keep their copy.";
export const DELETE_INVITEE_CONFIRM = "Remove";
export const DELETE_INVITEE_CANCEL = "Cancel";

export const MAC_ONLY_SHARED_TITLE = "Keep on this Mac only?";
/** The confirm names the deletion. */
export const MAC_ONLY_SHARED_BODY =
  "Turning it on removes existing sharing and deletes the online copy.";
export const MAC_ONLY_SHARED_CONFIRM = "Keep on this Mac only";
export const MAC_ONLY_SHARED_CANCEL = "Cancel";
export const MAC_ONLY_SHARED_LEFT = "Kept on this Mac only. Sharing is off.";

export const TOMBSTONE_REMOVED_BY_OWNER = "Removed by the owner.";

export const RESTORE_TITLE = "Restore this document?";
export const RESTORE_BODY =
  "Sharing comes back as it was. You have 30 days after it left your Mac.";
export const RESTORE_CONFIRM = "Restore";
export const RESTORE_CANCEL = "Cancel";

export const SHARED_REMOVE = "Remove";

export type DeleteKind = "owner" | "invitee";

/** Share id of a collaborator's local copy, or null when `path` is not one. */
export function hostedShareId(path: string): string | null {
  return hostedCopy(path)?.shareId ?? null;
}

export function isHostedShare(path: string): boolean {
  return hostedShareId(path) !== null;
}

/** An invitee's delete is only their list. Every other file uses the owner confirm. */
export function deleteKind(role: string, path: string): DeleteKind {
  if (role === "invitee" || isHostedShare(path)) return "invitee";
  return "owner";
}

export function confirmCopy(kind: DeleteKind | "mac-only" | "restore"): {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
} {
  if (kind === "invitee") {
    return {
      title: DELETE_INVITEE_TITLE,
      body: DELETE_INVITEE_BODY,
      confirm: DELETE_INVITEE_CONFIRM,
      cancel: DELETE_INVITEE_CANCEL,
    };
  }
  if (kind === "mac-only") {
    return {
      title: MAC_ONLY_SHARED_TITLE,
      body: MAC_ONLY_SHARED_BODY,
      confirm: MAC_ONLY_SHARED_CONFIRM,
      cancel: MAC_ONLY_SHARED_CANCEL,
    };
  }
  if (kind === "restore") {
    return {
      title: RESTORE_TITLE,
      body: RESTORE_BODY,
      confirm: RESTORE_CONFIRM,
      cancel: RESTORE_CANCEL,
    };
  }
  return {
    title: DELETE_OWNER_TITLE,
    body: DELETE_OWNER_BODY,
    confirm: DELETE_OWNER_CONFIRM,
    cancel: DELETE_OWNER_CANCEL,
  };
}
