import { SYNC_CONFLICT_LINE, SYNC_REMOVED_LINE } from "@/features/redline-spike/margin-copy";

/** Stable seam. A later history log replaces the storage behind these steps. */
export interface DocumentHistory {
  saveFile(path: string): Promise<void>;
  rememberVersion(path: string): Promise<{ id: string | null }>;
  sendWhenOnline(path: string, online: boolean): Promise<SendOutcome>;
  bringOtherVersion(path: string): Promise<BringOutcome>;
}

export interface SendOutcome {
  sent: boolean;
  waiting: boolean;
  refused: boolean;
  unconfigured: boolean;
}

export interface BringOutcome {
  path: string;
  overlap: boolean;
  otherText: string | null;
  localText: string | null;
  skipped: boolean;
  deleted: boolean;
  versionId: string;
}

export const ACCEPT_LABEL = "Accept";
export const REJECT_LABEL = "Reject";

export interface OverlapSuggestion {
  localText: string;
  otherText: string;
  line: string;
  acceptLabel: typeof ACCEPT_LABEL;
  rejectLabel: typeof REJECT_LABEL;
  /** Their words. */
  accept(): string;
  /** The words already here. */
  reject(): string;
}

export const quietSend: SendOutcome = {
  sent: false,
  waiting: false,
  refused: false,
  unconfigured: false,
};

/**
 * Save the file, remember a version, then send it when the Mac is online.
 * Bringing the other version back and showing an overlap are the other two steps.
 */
export async function deliverDocument(
  path: string,
  online: boolean,
  history: Pick<DocumentHistory, "saveFile" | "rememberVersion" | "sendWhenOnline">,
): Promise<SendOutcome> {
  await history.saveFile(path);
  await history.rememberVersion(path);
  return history.sendWhenOnline(path, online);
}

/**
 * The central guard is `staysOnThisMac`. A true result never queues and never transmits.
 */
export async function sendWhenOnline(
  path: string,
  online: boolean,
  staysOnThisMac: boolean,
  transport: {
    queue(path: string): Promise<void>;
    transmit(path: string): Promise<SendOutcome>;
  },
): Promise<SendOutcome> {
  if (staysOnThisMac) {
    return { sent: false, waiting: false, refused: true, unconfigured: false };
  }
  if (!online) {
    await transport.queue(path);
    return { sent: false, waiting: true, refused: false, unconfigured: false };
  }
  return transport.transmit(path);
}

/** An overlap is a suggestion in this document. Accept takes their words. Reject keeps yours. */
export function showOverlap(
  localText: string,
  otherText: string,
  deleted = false,
): OverlapSuggestion | null {
  if (!deleted && localText === otherText) return null;
  return {
    localText,
    otherText,
    line: deleted ? SYNC_REMOVED_LINE : SYNC_CONFLICT_LINE,
    acceptLabel: ACCEPT_LABEL,
    rejectLabel: REJECT_LABEL,
    accept: () => otherText,
    reject: () => localText,
  };
}

export function overlapPreview(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  if (line.length <= 80) return line;
  return `${line.slice(0, 80)}…`;
}
