import { CITATIONS_LINE } from "./citations-line.mjs";

/** Copy will replace this wording. Keep the string in this one constant. */
export const SAVED_LINE = "Saved";

/** Composer kicker. The margin shows it small, above the field. */
export const COMPOSE_NOTE_LABEL = "NOTE";

/** Primary composer button. The button asks. Enter saves the note. */
export const ASK_ALKUIN_LABEL = "Ask Alkuin";
/** Badge on every card an AI model wrote. EU AI Act Art. 50: say it's AI at first contact. */
export const AI_BADGE = "AI";
export const AI_BADGE_TITLE =
  "Written by an AI model. Check it, and its sources, before you accept.";
/** On the Ask button, before anything is sent. */
export const ASK_AI_HINT =
  "Sends the passage and your instruction to an AI model, which writes a suggestion.";

/** Saves the text on the highlight. Does not call Alkuin. */
export const LEAVE_NOTE_LABEL = "Leave note";

export const COMPOSE_CANCEL_LABEL = "Cancel";

export const COMPOSE_PLACEHOLDER = "Make this clearer";

export const COMPOSE_ASK_ARIA = "Instruction for Alkuin";

export const COMPOSE_EMPTY_ASK = "Type an instruction, then Ask Alkuin";

export const COMPOSE_EMPTY_NOTE = "Type a note, then Leave note";

/** Empty desk, under the folder button. */
export const EMPTY_DESK_LINE =
  "Add a folder with your drafts, essays and notes. Alkuin works with Markdown (.md) files.";

/** Shown only when the folder already has a remote or publish target. */
export const SHARE_CHANGES_LABEL = "Share changes";

export const SHARE_FAILED_LINE = "Couldn't share this file.";

/** The other copy does not fit. The file on disk stays. */
export const OTHER_EDITS_LINE = "Someone else's edits didn't fit. Your words are still here.";

/** The other Mac changed this copy. Accept and Reject stay in the document. */
export const SYNC_CONFLICT_LINE =
  "This copy changed on your other Mac. Accept takes that copy. Reject keeps this one.";

/** The other Mac removed this document. Reject keeps the file and sends it. */
export const SYNC_REMOVED_LINE =
  "This document was removed on your other Mac. Accept removes it here. Reject keeps this copy and sends it.";

/** Accept was refused: the other copy came back empty with no version. The choice stays up. */
export const SYNC_EMPTY_COPY_LINE =
  "The other copy is empty, so Accept would erase this document. Reject keeps this one.";

/** The sync server would not store this copy. The file on this Mac is untouched. Copy's final line. */
export const BACKUP_REFUSED_LINE =
  "Alkuin couldn't back up {document}. It's still saved on this Mac.";

/**
 * A save found the file changed on disk. The writer's words went in the document and the
 * outside version in a file beside it (`write_file_expecting` in commands/fs.rs). Copy's
 * final line for that case.
 */
export const SAVED_BESIDE_LINE =
  "{document} changed outside Alkuin while you were typing. Your writing is still here, and the outside changes are saved as {copy}.";

/** Cite or research came back without a web search. Sits under the suggestion. */
export const TOOL_CAUTION_NOTE = "Alkuin didn't search the web for this one.";

/** Too many asks at once. Exactly 1 is singular. `{seconds}` is the wait. */
export const TOO_MANY_ASKS_ONE = "That's a lot at once. Try again in 1 second.";
export const TOO_MANY_ASKS_LINE = "That's a lot at once. Try again in {seconds} seconds.";
export const TOO_MANY_ASKS_FALLBACK = "That's a lot at once. Try again in a moment.";

export const PAUSED_LINE =
  "Writing help is paused for now. Your document is unchanged, and you can keep writing. Try again later.";

/**
 * `account_paused`, HTTP 429. The wait is hours, so it is not shown.
 * The margin shows the address as text, not a link.
 */
export const ACCOUNT_PAUSED_LINE =
  "This account's writing help is paused until midnight UTC. If you think this is a mistake, email support@alkuin.app.";
/**
 * `daily_asks`, HTTP 429: the ask count for the UTC day. The wait is not shown.
 */
export const DAILY_CAP_LINE = "You've used today's asks. They come back at midnight UTC.";

/** The account is frozen. Sign-in still works. */
export const FROZEN_LINE = "This account is frozen.";
/** The ask ran and no suggestion came back. */
export const ASK_REFUSED_LINE =
  "Alkuin ran this ask but couldn't finish a suggestion. Your text is unchanged.";
export { CITATIONS_LINE };
export const HARD_CAP_LINE = "You've used this month's writing help.";
/** Free daily slice. `{time}` is the reader's clock for the next 00:00 UTC, `HH:MM`. */
export const FREE_SLICE_LINE =
  "Today's free help has run out. It comes back at {time}. A paid plan gives you more help every month.";
/** Free month. `{date}` is the reader's local date for `resets_at`, like `1 Nov 2026`. */
export const FREE_MONTH_LINE =
  "You've used all your free help. It comes back on {date}. A paid plan gives you more help every month.";
/** Paid month, including after credit runs out. The button buys a credit pack. */
export const PAID_CAP_LINE =
  "You've used all your help for now. It comes back on {date}. To keep going before then, buy $10 of credit. Tax is added at checkout.";
/** Free per-user UTC day. `{time}` is the reader's clock for the next 00:00 UTC. */
export const FREE_DAY_LINE =
  "You've used today's free help. It comes back at {time}. A paid plan gives you more help every month.";
export const SEE_PLANS_LABEL = "See paid plans";
export const BUY_CREDIT_LABEL = "Buy $10 of credit + tax";
export const PLANS_URL = "https://alkuin.app/#pricing";

/** Free cap lines offer the pricing page. */
export function seePlansFor(line: string): boolean {
  return line.endsWith("A paid plan gives you more help every month.");
}

/** Paid cap line offers a $10 credit pack. */
export function buyCreditFor(line: string): boolean {
  return line.includes("buy $10 of credit");
}

/** 502, `cost_unparsed`, and any other server error. Not a connection failure. */
export const SERVER_ERROR_LINE =
  "Something went wrong on our side. Your text is unchanged. Try again in a moment.";

/** No HTTP answer. The document was not sent. */
export const MODEL_UNREACHABLE_LINE =
  "Alkuin can't connect right now. Your text is unchanged. Check your connection and try again.";

/** The ask did not run. Nothing is charged. */
export const ASK_CANCELLED_LINE =
  "Alkuin couldn't run this ask right now, so it was cancelled. You weren't charged. Try again in a moment.";

export const TRY_AGAIN_LABEL = "Try again";

export const SIGNUP_CAP_LINE =
  "Alkuin isn't taking new accounts right now. Try again tomorrow. If you already have an account, check the email you entered.";

export const SIGNUP_IP_LINE =
  "Too many sign-ups from this network. Try again later. If you already have an account, check the email you entered.";

/** The server could not tell where the sign-up came from. Not the per-network limit line. */
export const NO_CLIENT_IP_LINE =
  "Alkuin can't take a sign-up from this connection right now. Try again later, or from a different network.";

export const BAD_ASK_LINE = "That ask is too long or has extra fields. Try a shorter ask.";

export const SIGN_OUT_LABEL = "Sign out";
export const PLAN_FIELD_LABEL = "Plan";
export const PLAN_REDLINE = "Alkuin";
export const PLAN_FREE = "Free";
export const PLAN_FOUNDING = "Founding member";

export const RESET_ON_LINE = "Writing help resets on {date}.";

export const PLENTY_MONTH_LINE = "Plenty of writing help left this month.";
export const RUNNING_LOW_MONTH_LINE = "Running low on writing help this month.";

export const OFFLINE_PLAN_LINE =
  "You're offline. This is your plan as of the last time Alkuin connected.";
export const CLEAR_NEEDS_CONNECTION = "Clearing needs a connection.";
export const SIGNED_OUT_PLAN_LINE = "Sign in to see your plan and writing style.";

export const STYLE_HEADING = "Your writing style";
export const STYLE_SUBLINE =
  "What Alkuin has learned from the suggestions you accept, reject or change.";
export const STYLE_EMPTY =
  "Nothing learned yet. Accept or reject a few suggestions and Alkuin will start noting how you write.";
export const STYLE_FREE_LINE =
  "Upgrade to the Alkuin plan if you want Alkuin to learn your personal style and give more tailored suggestions.";
export const STYLE_FREE_SAVED =
  "Your earlier style notes are saved but not used. You can clear them below.";

/** Free hides the empty line. Saved notes, rows, and Clear show only when rows are already there. */
export function styleNotesVisible(
  plan: string | null,
  rowCount: number,
): { savedLine: boolean; rows: boolean; clear: boolean; empty: boolean } {
  const rows = rowCount > 0;
  const clear = plan !== "free" || rows;
  return {
    savedLine: plan === "free" && rows && clear,
    rows,
    clear,
    empty: !rows && plan !== "free",
  };
}

export const GROUP_HOUSE = "House style";
export const GROUP_POLISH = "Editing";
export const GROUP_CITE = "Sources";

export const FORGET_STYLE_BUTTON = "Forget my style";
export const CLEAR_STYLE_TITLE = "Clear your writing style?";
export const CLEAR_STYLE_BODY =
  "Alkuin will forget everything it has learned from your suggestions, starting with your next ask. Your documents, your plan and your remaining writing help aren't affected. This can't be undone.";
export const CLEAR_STYLE_CONFIRM = "Clear style";
export const CLEAR_STYLE_KEEP = "Keep style";

const CALM_STATUS_LINES = [
  "Today's free help has run out.",
  "You've used all your free help.",
  "You've used all your help for now.",
  "Today's free writing help is used up.",
  "You've used this month's free writing help.",
  "You've used today's free help.",
  HARD_CAP_LINE,
  PLENTY_MONTH_LINE,
  RUNNING_LOW_MONTH_LINE,
  PAUSED_LINE,
  ACCOUNT_PAUSED_LINE,
  DAILY_CAP_LINE,
  FROZEN_LINE,
  ASK_REFUSED_LINE,
  CITATIONS_LINE,
  SIGNUP_CAP_LINE,
  SIGNUP_IP_LINE,
];

/** A budget or pause line. The margin shows it as a status, not an agent error. */
export function isCalmStatusLine(line: string): boolean {
  return CALM_STATUS_LINES.some((prefix) => line.startsWith(prefix));
}

/** A shared Accept the server saved, while the text it was for changed on this page.
 *  Nothing was written over the change. The card keeps the suggestion. */
export const ACCEPTED_NOT_ADDED_LINE =
  "Accepted, but the text changed before Alkuin could add it. Your words are unchanged.";

/** What a failed ask is. The margin reads this code, never the line it shows. */
export type AskErrorCode = "sign-in" | "calm" | "cancelled" | "failed";

/** The word `redline.rs` sends when the session is gone. The wire value, not the button label. */
export const ASK_SIGN_IN_WIRE = "Sign in";

/** The one place a line from the ask IPC becomes a code. Rust sends the line, not a code. */
export function askErrorCode(line: string): AskErrorCode {
  if (line === ASK_SIGN_IN_WIRE) return "sign-in";
  if (line === ASK_CANCELLED_LINE) return "cancelled";
  if (isCalmStatusLine(line)) return "calm";
  return "failed";
}

/** Save-failure and install-ready lines. The same words are the Rust consts in `updater.rs`. */
export const UPDATE_READY_BODY = "You're on {current}. Alkuin will restart to finish.";
export const SAVE_FAILED_ONE_LINE =
  "Alkuin couldn't save {document}, so it didn't restart. The update will install the next time you open Alkuin.";
export const SAVE_FAILED_SOME_LINE =
  "Alkuin couldn't save some of your documents, so it didn't restart. The update will install the next time you open Alkuin.";

/**
 * A close or open that could not save first. Refused once; doing it again
 * within two minutes, with the same documents unsaved, discards them.
 */
export const CLOSE_SAVE_FAILED_ONE_LINE =
  "Alkuin couldn't save {document}, so the folder stayed open. Close it again to discard the unsaved edits.";
export const CLOSE_SAVE_FAILED_SOME_LINE =
  "Alkuin couldn't save some of your documents, so the folder stayed open. Close it again to discard the unsaved edits.";
export const CLOSE_WINDOW_SAVE_FAILED_ONE_LINE =
  "Alkuin couldn't save {document}, so the window stayed open. Close it again to discard the unsaved edits.";
export const CLOSE_WINDOW_SAVE_FAILED_SOME_LINE =
  "Alkuin couldn't save some of your documents, so the window stayed open. Close it again to discard the unsaved edits.";
export const OPEN_SAVE_FAILED_ONE_LINE =
  "Alkuin couldn't save {document}, so the folder didn't open. Open it again to discard the unsaved edits.";
export const OPEN_SAVE_FAILED_SOME_LINE =
  "Alkuin couldn't save some of your documents, so the folder didn't open. Open it again to discard the unsaved edits.";

/** Accept could not write the file. The words stay on the page and nothing was sent. */
export const ACCEPT_SAVE_FAILED_LINE =
  "Alkuin couldn't save this document, so nothing was sent. Your words are still on the page.";

/** Accept found the passage edited, or gone, since the suggestion was made. */
export const ACCEPT_TEXT_CHANGED_LINE =
  "The words this suggestion was for have changed. Ask again or edit by hand.";

/** A suggestion that did not come back. The margin shows this instead of a service name. */
export const NO_SUGGESTION_LINE = "No suggestion this time. Try asking again.";

/** ponytail: share stays hidden until an invite can be sent. Flip this on then. */
export const INVITES_ENABLED = false;

export function shareChangesOffered(sharing: boolean | undefined): boolean {
  return INVITES_ENABLED && sharing === true;
}

export function shareFailureLine(): string | null {
  return INVITES_ENABLED ? SHARE_FAILED_LINE : null;
}

export function otherEditsLine(): string | null {
  return INVITES_ENABLED ? OTHER_EDITS_LINE : null;
}
