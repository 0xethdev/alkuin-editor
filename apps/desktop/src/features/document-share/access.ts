import type { ShareRole } from "@/lib/tauri";

/** A share's status, as the server sends it. */
export type ShareStatus = "pending" | "accepted" | "declined" | "removed";

/**
 * What this Mac may do with one file's share. `share_role` is parsed into
 * this once, at the IPC boundary, so no caller compares role or status
 * strings. A role or status this build does not know is `none`.
 */
export type ShareAccess =
  | { role: "none"; documentId: string }
  | {
      role: "owner" | "invitee";
      shareId: string;
      documentId: string;
      status: ShareStatus;
    };

function statusOf(raw: string | null | undefined): ShareStatus | null {
  switch (raw) {
    case "pending":
    case "accepted":
    case "declined":
    case "removed":
      return raw;
    default:
      return null;
  }
}

export function parseShareAccess(raw: ShareRole): ShareAccess {
  const documentId = raw.document_id ?? "";
  const status = statusOf(raw.status);
  if ((raw.role === "owner" || raw.role === "invitee") && raw.share_id && status) {
    return { role: raw.role, shareId: raw.share_id, documentId, status };
  }
  return { role: "none", documentId };
}

/**
 * Edits sync while the share is live. The owner waits for the accept. The
 * invitee's first sync is the accept. A declined or removed row stops both.
 */
export function liveSyncs(access: ShareAccess): boolean {
  if (access.role === "none") return false;
  switch (access.status) {
    case "accepted":
      return true;
    case "pending":
      return access.role === "invitee";
    case "declined":
    case "removed":
      return false;
  }
}

const SHARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HostedCopy {
  /** Lowercase share id. */
  shareId: string;
  /** The folder that holds the copy, without a trailing separator. */
  dir: string;
  /** The file name as it is on disk. */
  name: string;
}

/**
 * A collaborator's local copy: `…/shares/<share id>.md`. The same rule as
 * `copy_share_id` in `shares.rs`: the parent folder is exactly `shares` and
 * the stem is a share id.
 */
export function hostedCopy(path: string): HostedCopy | null {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash < 0) return null;
  const name = path.slice(slash + 1);
  const dir = path.slice(0, slash);
  const parentAt = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
  if (dir.slice(parentAt + 1) !== "shares") return null;
  if (!/\.md$/i.test(name)) return null;
  const stem = name.slice(0, -3);
  if (!SHARE_ID.test(stem)) return null;
  return { shareId: stem.toLowerCase(), dir, name };
}
