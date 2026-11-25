import { TOOL_CAUTION_NOTE, type AskErrorCode } from "./margin-copy";

export type RedlineNoteStatus = "open" | "pending" | "error" | "accepted";

/** Internal paint/apply intents. Public aliases add|rewrite|comment-only coerce here. */
export type RedlineIntent = "insert" | "replace" | "none";

/** ponytail: wording lives in margin-copy, and the server sends the same sentence. `requestRewrite`
 *  reads that sentence once and sets `hold`. The margin reads `hold`, never the copy.
 *  Do not add an IPC hold flag. Own notes have `instruction: null`. */
export { TOOL_CAUTION_NOTE };
export type { AskErrorCode };

/**
 * The one reading of a note's fields as a lifecycle. The predicates below,
 * the gutter, the decorations and the actions all derive from it.
 * - compose: open, the field is showing (a new note, Edit ask, Edit on your note).
 * - asking: Ask Alkuin is in flight.
 * - suggestion: a pending insert or replace with text, or a shared one that no
 *   longer lines up (`stale`). `deciding` while a shared Accept is being saved.
 * - hold: the ask came back as only the no-search caution sentence.
 * - own-comment: your saved note. comment: anyone else's note, or an ask that
 *   came back as a note.
 * - error: a failed ask. `code` says which kind; the line is only what it shows.
 * - not-applied: a shared Accept the server saved, but the text it was for
 *   changed here first, so nothing was written. It shows the suggestion and
 *   Dismiss, and it is never sent or decided again.
 */
export type NoteState =
  | { kind: "compose" }
  | { kind: "asking" }
  | { kind: "suggestion"; stale: boolean; deciding: boolean }
  | { kind: "hold" }
  | { kind: "own-comment" }
  | { kind: "comment" }
  | { kind: "error"; code: AskErrorCode }
  | { kind: "not-applied" }
  | { kind: "accepted" };

export type NoteStateFields = Pick<
  RedlineNote,
  | "status"
  | "intent"
  | "proposed"
  | "instruction"
  | "errorCode"
  | "hold"
  | "shareStale"
  | "deciding"
  | "notApplied"
>;

export function noteState(note: NoteStateFields): NoteState {
  switch (note.status) {
    case "accepted":
      return { kind: "accepted" };
    case "error":
      return { kind: "error", code: note.errorCode ?? "failed" };
    case "open":
      return { kind: "compose" };
    case "pending":
      break;
  }
  if (note.notApplied === true) return { kind: "not-applied" };
  const deciding = note.deciding === true;
  if (note.shareStale) return { kind: "suggestion", stale: true, deciding };
  if (note.intent == null) return { kind: "asking" };
  if (note.intent === "insert" || note.intent === "replace") {
    return note.proposed ? { kind: "suggestion", stale: false, deciding } : { kind: "comment" };
  }
  if (note.instruction == null) return { kind: "own-comment" };
  return note.hold === true ? { kind: "hold" } : { kind: "comment" };
}

export function isToolCautionHold(note: NoteStateFields): boolean {
  return noteState(note).kind === "hold";
}

/** Pending insert/replace with proposed text. Margin owns Accept / Reject / Edit ask.
 *  A suggestion that no longer matches still offers Reject. */
export function noteShowsLocus(note: NoteStateFields): boolean {
  return noteState(note).kind === "suggestion";
}

/** Saved human note. Margin owns Edit / Delete; never Accept / Reject. Caution holds keep instruction. */
export function isOwnCommentNote(note: NoteStateFields): boolean {
  return noteState(note).kind === "own-comment";
}

/** A decision on a card from the other person is being saved: an Accept or Reject of a
 *  suggestion, or the Dismiss of a comment. Nothing may send a second one until it settles. */
export function isDeciding(note: Pick<RedlineNote, "status" | "deciding">): boolean {
  return note.status === "pending" && note.deciding === true;
}

/** Ask Alkuin is waiting on the model. A second ask must not start. */
export function isAskInFlight(note: NoteStateFields): boolean {
  return noteState(note).kind === "asking";
}

/** The failed ask's code, or null when the note is not a failed ask. */
export function askErrorOf(note: NoteStateFields): AskErrorCode | null {
  const state = noteState(note);
  return state.kind === "error" ? state.code : null;
}

export interface GitFileStatus {
  repo_root: string | null;
  clean: boolean;
  porcelain: string;
  diff: string;
  error: string | null;
  /** True when the folder has a remote. The card must not render the other fields. */
  sharing?: boolean;
}

export interface GitPublishResult {
  committed: boolean;
  pushed: boolean;
  commit_sha: string | null;
  error: string | null;
  retry?: boolean;
}

export interface RedlineNote {
  id: string;
  from: number;
  to: number;
  original: string;
  proposed: string | null;
  intent: RedlineIntent | null;
  instruction: string | null;
  status: RedlineNoteStatus;
  /** The line the margin shows. `errorCode` is the state; this is never compared. */
  error: string | null;
  /** Set with `error` by `setAskError`. An error note without one reads as "failed". */
  errorCode?: AskErrorCode | null;
  notice?: string | null;
  /** Set when the suggestion was written without web search. No buttons of its own. */
  caution?: string | null;
  /** The ask came back as only TOOL_CAUTION_NOTE. `requestRewrite` sets it. */
  hold?: boolean;
  /** A shared Accept is being saved. The card cannot be decided or removed until it settles. */
  deciding?: boolean;
  /** The Ask Alkuin request this note waits on. An answer for an earlier ask is dropped. */
  askId?: string | null;
  /** Accepted on the server, not written here: the text changed while the decision saved.
   *  Set only by `markNotApplied`. The card has no `shareChangeId` from then on. */
  notApplied?: boolean;
  git: GitFileStatus | null;
  publish: GitPublishResult | null;
  /** Display name on a person's card. The assistant's cards leave this unset. */
  person?: string;
  /** False on a comment, and on a suggestion that no longer matches: no Accept. */
  shareAccept?: boolean;
  /** The suggestion could not be lined up. Reject only, and nothing is painted into the text. */
  shareStale?: boolean;
  /** Server id for Accept and Reject. */
  shareChangeId?: string;
  /** Sync-server id of an addition an AI chat suggested through the connector.
   *  The text waits there until this card is decided. See `features/agent-proposal`. */
  agentProposalId?: string;
  /** Account ids chosen from the @ list. The visible note still says @name. */
  mentions?: { id: string; name: string }[];
  replies?: { id: string; authorId: string; authorName: string; text: string }[];
  /** The signed-in person has an open mention on this note. */
  mentionOpen?: boolean;
  /** Mark done, a reply, or a suggestion addressed it. */
  mentionDone?: boolean;
  /** This suggestion answers the note with this id. */
  mentionOf?: string;
  /** The mention thread id both Macs derive for this note. See `note-mention/thread.ts`. */
  threadId?: string;
  /** Open mention rows this card was painted for. Done, a reply or a wording answers them. */
  mentionRows?: string[];
}

/** An AI chat sent this card through the connector. Nobody asked for it on this Mac. */
export function isAgentCard(note: Pick<RedlineNote, "agentProposalId">): boolean {
  return Boolean(note.agentProposalId);
}

/**
 * A card that someone or something else sent: a collaborator's change, or the
 * connector's addition. It is not one of the writer's own notes: it is matched
 * by its server id, it is never sent to anyone, and a pull paints it again.
 */
export function cameFromElsewhere(
  note: Pick<RedlineNote, "shareChangeId" | "agentProposalId">,
): boolean {
  return Boolean(note.shareChangeId) || isAgentCard(note);
}

export const emptyGitStatus = (): GitFileStatus => ({
  repo_root: null,
  clean: true,
  porcelain: "",
  diff: "",
  error: null,
  sharing: false,
});

/** Test-only filler-strip. The app's ask goes through `redline_propose`. */
export function proposeRewrite(original: string, instruction = ""): string {
  const body = original
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const noFiller = body
    .replace(/\b(just|really|very|actually|basically|simply)\b/gi, "")
    .replace(/ +/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim();
  const candidate = noFiller || body;
  if (instruction.toLowerCase().includes("shorter") && candidate.length > 48) {
    const shortened = candidate
      .slice(0, 48)
      .replace(/\s+\S*$/, "")
      .trim();
    if (shortened) return shortened;
  }
  return candidate;
}

export function coerceIntent(raw: unknown): RedlineIntent {
  if (typeof raw !== "string") return "replace";
  switch (raw.trim().toLowerCase()) {
    case "insert":
    case "add":
      return "insert";
    case "none":
    case "comment-only":
    case "comment_only":
      return "none";
    default:
      return "replace";
  }
}

export function proposalChange(
  from: number,
  to: number,
  proposed: string,
  intent: RedlineIntent,
): { from: number; to: number; insert: string } | null {
  if (intent === "none") return null;
  if (intent === "insert") return { from: to, to, insert: proposed };
  return { from, to, insert: proposed };
}

export function applyProposal(
  doc: string,
  from: number,
  to: number,
  proposed: string,
  intent: RedlineIntent,
): string {
  const change = proposalChange(from, to, proposed, intent);
  if (!change) return doc;
  return `${doc.slice(0, change.from)}${change.insert}${doc.slice(change.to)}`;
}

export function applySpanReplacement(
  doc: string,
  from: number,
  to: number,
  insert: string,
): string {
  return applyProposal(doc, from, to, insert, "replace");
}

export function selectionRange(from: number, to: number): { from: number; to: number } | null {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (start === end) return null;
  return { from: start, to: end };
}
