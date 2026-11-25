/**
 * A mention thread is named by its comment, not by a card id. The local card
 * id is random on the author's Mac (`nextRedlineId`) and the server change id
 * on the reader's Mac, so neither names the same comment on both. Both Macs do
 * have the words: the sentence the note marks and the note itself, as the
 * share wire carries them (`packComment` in document-share/place.ts keeps
 * the first 800 and 1100 characters). The same comment gets the same id on
 * both Macs and after a relaunch, and a different comment gets a different one.
 * The share layer sets `threadId` from the words on the wire: on the reader's
 * card (`notesFromPending`), on a comment restored after a relaunch
 * (`notesFromHeld`), and on the author's card when typing inside the marked
 * sentence changes what is sent (`threadRekeys` in document-share/live.ts).
 * ponytail: an edit to the comment's words makes a new thread, as it makes a
 * new share change; rows opened under the old words keep the old id. An Ask
 * card's thread is named by its instruction, which the wire does not carry,
 * so the reader cannot match it. Upgrade is an id carried on the share change.
 */
const ANCHOR_CHARS = 800;
const NOTE_CHARS = 1100;

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** `anchor` is the marked text, `note` the saved note text. Under 80 characters, no `/`. */
export function threadKey(anchor: string, note: string): string {
  return `note-${fnv(`${anchor.slice(0, ANCHOR_CHARS)}\0${note.slice(0, NOTE_CHARS)}`)}`;
}

/** The card fields a thread reads. Structural, so this module has no imports. */
type ThreadFields = {
  threadId?: string;
  shareChangeId?: string;
  intent: string | null;
  original: string;
  proposed: string | null;
};

type Reply = { id: string; authorId: string; authorName: string; text: string };

/** One open row from `mention_open` (`OpenMention` in lib/tauri). */
type OpenRow = { id: string; kind: string; author_id: string; quote: string | null };

type ThreadCard = {
  id: string;
  threadId?: string;
  mentionOpen?: boolean;
  mentionDone?: boolean;
  mentionRows?: string[];
  replies?: Reply[];
};

/** The id this card's thread goes by, or null when it has none yet. A card from the
 *  other Mac is its anchor and its note as they were sent, so its id can be read back. */
export function noteThreadId(note: ThreadFields): string | null {
  if (note.threadId) return note.threadId;
  if (note.shareChangeId && note.intent === "none" && note.proposed) {
    return threadKey(note.original, note.proposed);
  }
  return null;
}

/** The thread id for a note on this Mac: its stored id, or one minted from the words now. */
export function threadIdFor(
  note: ThreadFields & { from: number; to: number; instruction: string | null },
  doc: { sliceString(from: number, to: number): string },
): string {
  return (
    noteThreadId(note) ??
    threadKey(doc.sliceString(note.from, note.to), note.proposed ?? note.instruction ?? "")
  );
}

export type ThreadPatch = {
  id: string;
  threadId: string;
  mentionOpen?: boolean;
  mentionDone?: boolean;
  mentionRows?: string[];
  replies?: Reply[];
};

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  const a = left ?? [];
  return a.length === right.length && a.every((id, index) => id === right[index]);
}

/**
 * The open rows the server lists for this person on one thread, as a change
 * to the card. Rows the card already answered (Done, a reply, a wording) stay
 * answered while the server catches up. Any other row opens it again, so a
 * later reply shows. No rows means nothing is waiting on this person.
 * Returns null when the card already shows exactly this.
 */
export function threadPatch(
  note: ThreadCard,
  threadId: string,
  rows: readonly OpenRow[],
): ThreadPatch | null {
  const ids = rows.map((row) => row.id);
  if (rows.length === 0) {
    if (!note.mentionOpen) return null;
    return { id: note.id, threadId, mentionOpen: false, mentionRows: [] };
  }
  const answered = new Set(note.mentionDone ? (note.mentionRows ?? []) : []);
  const waiting = rows.some((row) => !answered.has(row.id));
  const known = new Set((note.replies ?? []).map((reply) => reply.id));
  const added = rows
    .filter((row) => row.kind === "reply" && row.quote && !known.has(row.id))
    .map((row) => ({
      id: row.id,
      authorId: row.author_id,
      authorName: "Reply",
      text: row.quote ?? "",
    }));
  if (!waiting && added.length === 0) return null;
  const patch: ThreadPatch = { id: note.id, threadId };
  if (waiting) {
    if (note.mentionOpen && !note.mentionDone && sameIds(note.mentionRows, ids)) {
      if (added.length === 0 && note.threadId === threadId) return null;
    } else {
      patch.mentionOpen = true;
      patch.mentionDone = false;
      patch.mentionRows = ids;
    }
  }
  if (added.length > 0) patch.replies = [...(note.replies ?? []), ...added];
  return patch;
}
