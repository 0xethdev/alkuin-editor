/** The strings for mentions. Emails quote a note or a reply, never the document. */

export const PICKER_EMPTY = "Only people who have accepted your invite can be mentioned.";
export const PICKER_MAC_ONLY = "This document stays on this Mac, so there's no one to mention.";
export const MARKER_MENTIONED = "You were mentioned";
export const PREFERENCE_MENTION_EMAIL = "Email me when someone mentions me or replies to my note";
export const MARK_DONE_DONE = "Done";
export const OPEN_TAG_LABEL = "Waiting for your answer";
export const REPLY_SEND = "Reply";
export const REPLY_PLACEHOLDER = "Write a reply";
export const SUGGEST_WORDING = "Suggest wording";
export const SUGGEST_PLACEHOLDER = "Your wording";
export const SUGGEST_SEND = "Send suggestion";
export const YOU_LABEL = "You";
export const MENTION_SEND_FAILED = "Couldn't send that mention. Try again in a minute.";

/** The shared-documents list reads these. This card does not paint that list. */
export const SHARED_WITH_YOU = "Shared with you";
export const SHARED_EMPTY = "Nothing shared with you yet.";
export const SHARED_EMPTY_NEXT = "When someone invites you to a document, it shows up here.";

export function pickerLabel(name: string | null | undefined, email: string): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed) return trimmed;
  const local = email.split("@")[0]?.trim() ?? "";
  return local || email.trim() || "Someone";
}
