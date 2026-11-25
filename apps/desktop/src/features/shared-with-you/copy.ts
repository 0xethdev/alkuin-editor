/** Sidebar lines for documents shared with the signed-in user. Copy owns these. */

export const SHARED_WITH_YOU = "Shared with you";

export const SHARED_EMPTY = "Nothing shared with you yet.";

/**
 * Shown under the empty line. A pending invite is a row in this section,
 * with Accept and Decline, before the email link is opened.
 */
export const SHARED_EMPTY_NEXT = "When someone invites you to a document, it shows up here.";

/** Dot tooltip and accessible name, on a shared row and on an own document. */
export const WAITING = "Waiting for your answer";

/** Header count tooltip and accessible name. n is the number of open mentions. */
export function waitingCount(n: number): string {
  return `${n} waiting for your answer`;
}
