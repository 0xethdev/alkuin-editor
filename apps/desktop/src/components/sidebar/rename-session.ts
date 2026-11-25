/**
 * One inline rename ends exactly once: Enter submits, Escape cancels, blur
 * submits — whichever comes first. Enter and Escape unmount the input, and
 * engines that fire focusout on removal would otherwise end it a second
 * time: a double rename, or an Escape that still commits.
 */
export type RenameEnd = { kind: "submit"; value: string } | { kind: "cancel" };

export interface RenameSession {
  ended: boolean;
}

export function startRenameSession(): RenameSession {
  return { ended: false };
}

/** The end to act on, or null when this session has already ended. */
export function endRename(session: RenameSession, end: RenameEnd): RenameEnd | null {
  if (session.ended) return null;
  session.ended = true;
  return end;
}
