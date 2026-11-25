import { draftChange, NO_LONGER_MATCHES, personName } from "./copy";
import { emptyGitStatus, type RedlineNote } from "@/features/redline-spike/model";
import { threadKey } from "@/features/note-mention/thread";

/**
 * A suggestion lands on the owner's copy of the words that changed.
 * Accept replaces that span. An insertion writes only the new text.
 * Reject leaves the document. When the sentence is no longer there, the
 * snapshot it was written against lines it up. A suggestion that cannot
 * be lined up says it no longer matches, and has no Accept. A comment
 * stays a margin note. Offsets only break a tie when the sentence
 * appears more than once.
 */

export interface SharePassage {
  id: string;
  start: number;
  end: number;
  original: string;
  /** Null is a margin note. A string is the text Accept would write. */
  proposed: string | null;
  sender: string;
  /** The collaborator's text when the suggestion was written. */
  snapshot?: string | null;
}

export type PlacedShare =
  | {
      kind: "replace";
      id: string;
      from: number;
      to: number;
      current: string;
      proposed: string;
      sender: string;
    }
  | {
      kind: "note";
      id: string;
      from: number;
      to: number;
      text: string;
      sender: string;
      accept: boolean;
    }
  | {
      kind: "insert";
      id: string;
      at: number;
      text: string;
      sender: string;
    }
  | {
      kind: "stale";
      id: string;
      at: number;
      sender: string;
    };

export interface PendingShareChange {
  id: string;
  start: number;
  end: number;
  original: string;
  body: string | null;
  sender_email: string;
  /** The collaborator's text when the suggestion was written. */
  snapshot?: string | null;
}

/** The cards the margin paints for a pending list. */
export function notesFromPending(
  doc: string,
  changes: readonly PendingShareChange[],
): RedlineNote[] {
  return changes.map((change) => {
    const placed = placeShareChange(doc, {
      id: change.id,
      start: change.start,
      end: change.end,
      original: change.original,
      proposed: change.body,
      sender: personName(change.sender_email),
      snapshot: change.snapshot,
    });
    const person = placed.sender;
    if (placed.kind === "insert") {
      return {
        id: placed.id,
        from: placed.at,
        to: placed.at,
        original: "",
        proposed: placed.text,
        intent: "insert",
        instruction: draftChange(placed.text),
        status: "pending",
        error: null,
        git: emptyGitStatus(),
        publish: null,
        person,
        shareAccept: true,
        shareChangeId: placed.id,
      };
    }
    if (placed.kind === "stale") {
      return {
        id: placed.id,
        from: placed.at,
        to: placed.at,
        original: "",
        proposed: null,
        intent: "replace",
        instruction: NO_LONGER_MATCHES,
        status: "pending",
        error: null,
        git: emptyGitStatus(),
        publish: null,
        person,
        shareAccept: false,
        shareChangeId: placed.id,
        shareStale: true,
      };
    }
    if (placed.kind === "note") {
      const quoted = placed.to > placed.from ? doc.slice(placed.from, placed.to) : placed.text;
      // The thread is named by the words the author's Mac sent, not by what
      // this copy has at that spot, which can be missing or already edited.
      const wire = change.body == null ? unpackComment(change.original) : null;
      return {
        ...(wire ? { threadId: threadKey(wire.anchor, wire.comment) } : {}),
        id: placed.id,
        from: placed.from,
        to: placed.to,
        original: quoted,
        proposed: placed.text,
        intent: "none",
        instruction: placed.text,
        status: "pending",
        error: null,
        git: emptyGitStatus(),
        publish: null,
        person,
        shareAccept: placed.accept,
        shareChangeId: placed.id,
      };
    }
    return {
      id: placed.id,
      from: placed.from,
      to: placed.to,
      original: placed.current,
      proposed: placed.proposed,
      intent: "replace",
      instruction: draftChange(placed.proposed),
      status: "pending",
      error: null,
      git: emptyGitStatus(),
      publish: null,
      person,
      shareAccept: true,
      shareChangeId: placed.id,
    };
  });
}

/** The original sentence in the owner's copy. Offsets break the tie. */
function locateOriginal(
  doc: string,
  original: string,
  hint: number,
): { from: number; to: number } | null {
  if (!original) return null;
  let best: number | null = null;
  let from = 0;
  while (from < doc.length) {
    const at = doc.indexOf(original, from);
    if (at < 0) break;
    if (best == null || Math.abs(at - hint) < Math.abs(best - hint)) best = at;
    from = at + original.length;
  }
  if (best == null) return null;
  return { from: best, to: best + original.length };
}

/**
 * Line a snapshot span up with the owner's text.
 * Equal token runs map character by character. A run that differs maps
 * only when the span covers that whole run. An insertion in the owner's
 * text counts when it sits inside the span, and not when it sits on the
 * edge, so a title added at the front is left alone.
 * ponytail: the walk is the same O(n*m) token scan as shareHunks. Upgrade
 * path is Myers if one share ever diffs a book.
 */
function mapSnapshotSpan(
  snapshot: string,
  doc: string,
  start: number,
  end: number,
): { from: number; to: number } | null {
  if (end <= start || start < 0 || end > snapshot.length) return null;
  const before = tokenize(snapshot);
  const after = tokenize(doc);
  interface Seg {
    snapFrom: number;
    snapTo: number;
    ownerFrom: number;
    ownerTo: number;
    equal: boolean;
  }
  const point = (tokens: readonly Tok[], index: number, length: number) => {
    if (index <= 0) return 0;
    if (index >= tokens.length) return length;
    return tokens[index]?.start ?? length;
  };
  const segs: Seg[] = [];
  const walk = (b0: number, b1: number, a0: number, a1: number) => {
    if (b0 === b1 && a0 === a1) return;
    const run = longestRun(before, b0, b1, after, a0, a1);
    if (!run || !isSplitter(before.slice(run.b, run.b + run.n))) {
      segs.push({
        snapFrom: point(before, b0, snapshot.length),
        snapTo: point(before, b1, snapshot.length),
        ownerFrom: point(after, a0, doc.length),
        ownerTo: point(after, a1, doc.length),
        equal: false,
      });
      return;
    }
    walk(b0, run.b, a0, run.a);
    segs.push({
      snapFrom: point(before, run.b, snapshot.length),
      snapTo: point(before, run.b + run.n, snapshot.length),
      ownerFrom: point(after, run.a, doc.length),
      ownerTo: point(after, run.a + run.n, doc.length),
      equal: true,
    });
    walk(run.b + run.n, b1, run.a + run.n, a1);
  };
  walk(0, before.length, 0, after.length);
  let from = -1;
  let to = -1;
  let covered = 0;
  const take = (ownerFrom: number, ownerTo: number) => {
    from = from < 0 ? ownerFrom : Math.min(from, ownerFrom);
    to = to < 0 ? ownerTo : Math.max(to, ownerTo);
  };
  for (const seg of segs) {
    const snapWidth = seg.snapTo - seg.snapFrom;
    if (snapWidth === 0) {
      if (seg.snapFrom > start && seg.snapFrom < end) take(seg.ownerFrom, seg.ownerTo);
      continue;
    }
    const overlapFrom = Math.max(seg.snapFrom, start);
    const overlapTo = Math.min(seg.snapTo, end);
    if (overlapTo <= overlapFrom) continue;
    if (!seg.equal && (overlapFrom > seg.snapFrom || overlapTo < seg.snapTo)) return null;
    if (seg.equal && seg.ownerTo - seg.ownerFrom !== snapWidth) return null;
    take(
      seg.equal ? seg.ownerFrom + (overlapFrom - seg.snapFrom) : seg.ownerFrom,
      seg.equal ? seg.ownerFrom + (overlapTo - seg.snapFrom) : seg.ownerTo,
    );
    covered += overlapTo - overlapFrom;
  }
  if (from < 0 || to < from || covered !== end - start) return null;
  return { from, to };
}

function missed(change: SharePassage, doc: string, text?: string): PlacedShare {
  const at = Math.min(Math.max(change.start, 0), doc.length);
  return {
    kind: "note",
    id: change.id,
    from: at,
    to: at,
    text: text ?? change.proposed ?? change.original,
    sender: change.sender,
    accept: false,
  };
}

export function placeShareChange(doc: string, change: SharePassage): PlacedShare {
  if (change.proposed == null) {
    const unpacked = unpackComment(change.original);
    const comment = unpacked?.comment ?? change.original;
    const span = locateOriginal(doc, unpacked?.anchor ?? change.original, change.start);
    if (!span) return missed(change, doc, comment);
    return {
      kind: "note",
      id: change.id,
      from: span.from,
      to: span.to,
      text: comment,
      sender: change.sender,
      accept: false,
    };
  }
  const inserted = unpackInsert(change.original, change.proposed);
  if (inserted) {
    const span = locateOriginal(doc, inserted.anchor, change.start);
    const hint = inserted.before ? change.start : change.end;
    const at = span
      ? inserted.before
        ? span.from
        : span.to
      : Math.min(Math.max(hint, 0), doc.length);
    return {
      kind: "insert",
      id: change.id,
      at,
      text: inserted.inserted,
      sender: change.sender,
    };
  }
  const span = locateOriginal(doc, change.original, change.start);
  if (span) {
    return {
      kind: "replace",
      id: change.id,
      from: span.from,
      to: span.to,
      current: doc.slice(span.from, span.to),
      proposed: change.proposed,
      sender: change.sender,
    };
  }
  const snapshot = change.snapshot ?? "";
  const slice =
    change.end > change.start && change.end <= snapshot.length
      ? snapshot.slice(change.start, change.end)
      : "";
  if (slice === change.original && slice.length > 0) {
    const mapped = mapSnapshotSpan(snapshot, doc, change.start, change.end);
    if (mapped) {
      if (mapped.to > mapped.from) {
        return {
          kind: "replace",
          id: change.id,
          from: mapped.from,
          to: mapped.to,
          current: doc.slice(mapped.from, mapped.to),
          proposed: change.proposed,
          sender: change.sender,
        };
      }
      return {
        kind: "insert",
        id: change.id,
        at: mapped.from,
        text: change.proposed,
        sender: change.sender,
      };
    }
  }
  return {
    kind: "stale",
    id: change.id,
    at: Math.min(Math.max(change.start, 0), doc.length),
    sender: change.sender,
  };
}

/** Accept replaces the current slice or writes the insertion. Reject leaves it. A note does not write. */
function ownerTextAfter(owner: string, placed: PlacedShare, accept: boolean): string {
  if (!accept || placed.kind === "note" || placed.kind === "stale") return owner;
  if (placed.kind === "insert") {
    return owner.slice(0, placed.at) + placed.text + owner.slice(placed.at);
  }
  return owner.slice(0, placed.from) + placed.proposed + owner.slice(placed.to);
}

/**
 * The collaborator's copy is a different string. A decision never writes it.
 */
export function copiesAfterDecision(
  owner: string,
  collaborator: string,
  placed: PlacedShare,
  accept: boolean,
): { owner: string; collaborator: string } {
  return { owner: ownerTextAfter(owner, placed, accept), collaborator };
}

export interface OutgoingPassage {
  payloadRef: string;
  passage: string;
  original: string;
  body: string;
  /**
   * The note's span in the collaborator's current text.
   * Used to drop the token diff of that same note. Not stored or sent.
   */
  live?: string;
  /**
   * A proposal whose wording is already in the collaborator's text (an
   * accepted Ask suggestion). The text, not the margin, keeps it. Stored with
   * the hold, not sent.
   */
  applied?: boolean;
}

export type ShareRefKind = "passage" | "proposal" | "comment";

/**
 * Which minting function made `ref`: `passageRef`, `proposalRef`, or
 * `noteRef`. The inverse of the three formats below, so it lives beside them.
 */
export function shareRefKind(shareId: string, ref: string): ShareRefKind {
  const head = `${shareId.slice(0, 8)}-`;
  const rest = ref.startsWith(head) ? ref.slice(head.length) : ref;
  if (rest.startsWith("note-")) return "comment";
  if (/^\d+-[0-9a-f]{8}(?:-\d+)?$/.test(rest)) return "passage";
  return "proposal";
}

/** Stable for one paragraph and one text. A later edit is a new ref so an
 * accepted row does not block the next send. `generation` bumps after a ref clash. */
export function passageRef(shareId: string, start: number, text: string, generation = 0): string {
  const nonce = generation > 0 ? `-${generation}` : "";
  return `${shareId.slice(0, 8)}-${start}-${fnv(text)}${nonce}`.slice(0, 200);
}

/** What the wire keeps of a suggestion's sentence and wording, and of a comment. */
const PROPOSAL_CHARS = 2000;
const COMMENT_ANCHOR_CHARS = 800;
const COMMENT_NOTE_CHARS = 1100;

/**
 * The words the wire keeps, as the margin reads them back: a cut text is
 * trimmed again on the way back in. Text under the limit is unchanged, so
 * refs minted before the cut existed stay the same.
 */
function kept(text: string, chars: number): string {
  return text.length > chars ? text.slice(0, chars).trim() : text;
}

/**
 * The sentence and the suggestion. An earlier edit must not mint a new id.
 * Hashed from the words the wire keeps, so a suggestion rebuilt from what
 * was sent gets the same id back.
 */
export function proposalRef(
  shareId: string,
  original: string,
  body: string,
  generation = 0,
): string {
  const nonce = generation > 0 ? `-${generation}` : "";
  const words = `${kept(original, PROPOSAL_CHARS)}\0${kept(body, PROPOSAL_CHARS)}`;
  return `${shareId.slice(0, 8)}-${fnv(words)}${nonce}`.slice(0, 200);
}

/**
 * The sentence the note marks, and the note. The offset is not part of the id.
 * Hashed from what `packComment` keeps, so a comment restored from the wire
 * after a reload sends the same id, however long its paragraph.
 */
export function noteRef(shareId: string, anchor: string, text: string, generation = 0): string {
  const nonce = generation > 0 ? `-${generation}` : "";
  const words = `${anchor.slice(0, COMMENT_ANCHOR_CHARS)}\0${kept(text, COMMENT_NOTE_CHARS)}`;
  return `${shareId.slice(0, 8)}-note-${fnv(words)}${nonce}`.slice(0, 200);
}

/** A comment carries the sentence it marks, then the note. Body stays empty. */
export function packComment(anchor: string, comment: string): string {
  const mark = anchor.slice(0, COMMENT_ANCHOR_CHARS);
  const note = comment.slice(0, COMMENT_NOTE_CHARS);
  return `note:${mark.length}:${mark}${note}`;
}

export function unpackComment(original: string): { anchor: string; comment: string } | null {
  const head = /^note:(\d+):/.exec(original);
  if (!head?.[1]) return null;
  const n = Number(head[1]);
  const rest = original.slice(head[0].length);
  if (!Number.isInteger(n) || n <= 0 || n >= rest.length) return null;
  const anchor = rest.slice(0, n);
  const comment = rest.slice(n);
  if (!comment.trim()) return null;
  return { anchor, comment };
}

const HUNK_CHARS = 2000;

/** The selection, then the new text. Accept splices that over the selection, which appends. */
function packInsertion(
  selection: string,
  inserted: string,
): { original: string; body: string } | null {
  if (!selection || !inserted) return null;
  const original = `ins:${selection.length}:${selection}${inserted}`;
  const body = selection + inserted;
  if (original.length > HUNK_CHARS || body.length > HUNK_CHARS) return null;
  return { original, body };
}

function closestIndex(doc: string, needle: string, hint: number): number {
  if (!needle) return -1;
  let best = -1;
  let from = 0;
  while (from < doc.length) {
    const at = doc.indexOf(needle, from);
    if (at < 0) break;
    if (best < 0 || Math.abs(at - hint) < Math.abs(best - hint)) best = at;
    from = at + needle.length;
  }
  return best;
}

/** An insertion is the anchor word plus the new text. The body is what the server splices over that word. */
function unpackInsert(
  original: string,
  body: string,
): { anchor: string; inserted: string; before: boolean } | null {
  const head = /^(ins-before|ins):(\d+):/.exec(original);
  if (!head?.[1] || !head[2]) return null;
  const n = Number(head[2]);
  const rest = original.slice(head[0].length);
  if (!Number.isInteger(n) || n <= 0 || n >= rest.length) return null;
  const anchor = rest.slice(0, n);
  const inserted = rest.slice(n);
  if (!inserted) return null;
  const expect = head[1] === "ins-before" ? inserted + anchor : anchor + inserted;
  if (body !== expect) return null;
  return { anchor, inserted, before: head[1] === "ins-before" };
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

interface Tok {
  text: string;
  start: number;
  end: number;
}

interface Hunk {
  baseFrom: number;
  baseTo: number;
  nextFrom: number;
  nextTo: number;
  original: string;
  body: string;
}

function tokenize(doc: string): Tok[] {
  const out: Tok[] = [];
  const re = /\S+|\s+/g;
  for (let match = re.exec(doc); match; match = re.exec(doc)) {
    const text = match[0] ?? "";
    out.push({ text, start: match.index, end: match.index + text.length });
  }
  return out;
}

/** A shared word such as "is" stays inside one redline. A sentence, a line break, or a longer run is a boundary. */
function isSplitter(tokens: readonly Tok[]): boolean {
  let words = 0;
  let length = 0;
  for (const tok of tokens) {
    length += tok.text.length;
    if (/[.!?\n]/.test(tok.text)) return true;
    if (/\S/.test(tok.text)) words += 1;
    if (words > 2 || length > 24) return true;
  }
  return false;
}

function wordFrom(tokens: readonly Tok[], index: number, dir: 1 | -1): Tok | null {
  for (let i = dir === 1 ? index : index - 1; dir === 1 ? i < tokens.length : i >= 0; i += dir) {
    const tok = tokens[i];
    if (tok && /\S/.test(tok.text)) return tok;
  }
  return null;
}

/**
 * ponytail: longest common token run is O(n*m). Fine for a shared note.
 * Upgrade path is Myers if one share ever diffs a book.
 */
function longestRun(
  before: readonly Tok[],
  b0: number,
  b1: number,
  after: readonly Tok[],
  a0: number,
  a1: number,
): { b: number; a: number; n: number } | null {
  const width = a1 - a0;
  const height = b1 - b0;
  if (width <= 0 || height <= 0) return null;
  let prev = new Uint32Array(width);
  let row = new Uint32Array(width);
  let best = 0;
  let bestB = 0;
  let bestA = 0;
  for (let i = 0; i < height; i++) {
    row.fill(0);
    const text = before[b0 + i]?.text;
    for (let j = 0; j < width; j++) {
      if (!text || text !== after[a0 + j]?.text) continue;
      const n = (i > 0 && j > 0 ? (prev[j - 1] ?? 0) : 0) + 1;
      row[j] = n;
      if (n > best) {
        best = n;
        bestB = b0 + i - n + 1;
        bestA = a0 + j - n + 1;
      }
    }
    const swap = prev;
    prev = row;
    row = swap;
  }
  if (best === 0) return null;
  return { b: bestB, a: bestA, n: best };
}

function sliceTokens(doc: string, tokens: readonly Tok[], from: number, to: number): string {
  const start = tokens[from];
  const end = tokens[to - 1];
  if (!start || !end || from >= to) return "";
  return doc.slice(start.start, end.end);
}

/** A deleted word has an empty body, and an empty body cannot be sent. Keep the next or previous word so Accept still removes only the deletion. */
function widenedDeletion(
  baseline: string,
  before: readonly Tok[],
  after: readonly Tok[],
  b0: number,
  b1: number,
  a0: number,
): Hunk | null {
  const wordAt = (tokens: readonly Tok[], index: number, dir: 1 | -1): number => {
    for (let i = index; dir === 1 ? i < tokens.length : i >= 0; i += dir) {
      if (/\S/.test(tokens[i]?.text ?? "")) return i;
    }
    return -1;
  };
  const followAt = wordAt(before, b1, 1);
  if (followAt >= 0) {
    const follow = before[followAt];
    const followNext = after[a0 + (followAt - b1)];
    const start = before[b0];
    if (follow && followNext && start && follow.text === followNext.text) {
      return {
        baseFrom: start.start,
        baseTo: follow.end,
        nextFrom: followNext.start,
        nextTo: followNext.end,
        original: baseline.slice(start.start, follow.end).slice(0, HUNK_CHARS),
        body: follow.text.slice(0, HUNK_CHARS),
      };
    }
  }
  const prevAt = wordAt(before, b0 - 1, -1);
  const tail = before[b1 - 1];
  if (prevAt >= 0 && tail) {
    const prev = before[prevAt];
    const prevNext = after[a0 - (b0 - prevAt)];
    if (prev && prevNext && prev.text === prevNext.text) {
      return {
        baseFrom: prev.start,
        baseTo: tail.end,
        nextFrom: prevNext.start,
        nextTo: prevNext.end,
        original: baseline.slice(prev.start, tail.end).slice(0, HUNK_CHARS),
        body: prev.text.slice(0, HUNK_CHARS),
      };
    }
  }
  return null;
}

function shareHunks(baseline: string, next: string): Hunk[] {
  if (baseline === next) return [];
  const before = tokenize(baseline);
  const after = tokenize(next);
  const hunks: Hunk[] = [];
  // Every hunk, not the first 20: a passage missing from this list is read
  // as a revert and withdrawn. The send batch is capped, not the diff.
  const push = (hunk: Hunk) => {
    if (!hunk.original.trim() || !hunk.body.trim()) return;
    if (hunk.baseTo <= hunk.baseFrom) return;
    hunks.push(hunk);
  };
  const emit = (b0: number, b1: number, a0: number, a1: number) => {
    if (b0 === b1 && a0 === a1) return;
    if (b0 === b1) {
      const inserted = sliceTokens(next, after, a0, a1);
      const startTok = after[a0];
      const endTok = after[a1 - 1];
      if (!inserted || !startTok || !endTok) return;
      const atWhitespace = b0 < before.length && !/\S/.test(before[b0]?.text ?? "");
      const follow = wordFrom(before, b0, 1);
      const prev = wordFrom(before, b0, -1);
      const anchor = !atWhitespace && follow ? follow : (prev ?? follow);
      if (!anchor) return;
      const atStart = anchor === follow;
      const kind = atStart ? "ins-before" : "ins";
      const head = `${kind}:${anchor.text.length}:`;
      const room = HUNK_CHARS - head.length - anchor.text.length;
      if (room <= 0) return;
      const cut = inserted.slice(0, room);
      if (!cut) return;
      push({
        baseFrom: anchor.start,
        baseTo: anchor.end,
        nextFrom: startTok.start,
        nextTo: endTok.end,
        original: `${head}${anchor.text}${cut}`.slice(0, HUNK_CHARS),
        body: (atStart ? cut + anchor.text : anchor.text + cut).slice(0, HUNK_CHARS),
      });
      return;
    }
    if (a0 === a1) {
      const widened = widenedDeletion(baseline, before, after, b0, b1, a0);
      if (widened) push(widened);
      return;
    }
    const baseFrom = before[b0]?.start ?? 0;
    const baseTo = before[b1 - 1]?.end ?? baseFrom;
    const nextFrom = after[a0]?.start ?? 0;
    const nextTo = after[a1 - 1]?.end ?? nextFrom;
    const original = baseline.slice(baseFrom, baseTo);
    const body = next.slice(nextFrom, nextTo);
    if (original === body) return;
    push({
      baseFrom,
      baseTo,
      nextFrom,
      nextTo,
      original: original.slice(0, HUNK_CHARS),
      body: body.slice(0, HUNK_CHARS),
    });
  };
  const walk = (b0: number, b1: number, a0: number, a1: number) => {
    if (b0 === b1 && a0 === a1) return;
    const run = longestRun(before, b0, b1, after, a0, a1);
    if (!run || !isSplitter(before.slice(run.b, run.b + run.n))) {
      emit(b0, b1, a0, a1);
      return;
    }
    walk(b0, run.b, a0, run.a);
    walk(run.b + run.n, b1, run.a + run.n, a1);
  };
  walk(0, before.length, 0, after.length);
  return hunks;
}

let lastHunks: { baseline: string; next: string; hunks: Hunk[] } | null = null;

/** The last answer is kept. Pushes ask the same question once per passage. Callers must not mutate it. */
function shareHunksCached(baseline: string, next: string): Hunk[] {
  if (lastHunks && lastHunks.baseline === baseline && lastHunks.next === next) {
    return lastHunks.hunks;
  }
  const hunks = shareHunks(baseline, next);
  lastHunks = { baseline, next, hunks };
  return hunks;
}

/** Words the collaborator changed, measured on the text they started from. A new paragraph is an insertion. */
export function passagesToSend(
  baseline: string,
  next: string,
  shareId: string,
  generation = 0,
): OutgoingPassage[] {
  return passagesWithSpans(baseline, next, shareId, generation).map(
    ({ here: _here, ...passage }) => passage,
  );
}

/**
 * The passages, each with its span in the current text (`here`) from the
 * same diff. `passage` is measured on the baseline and goes on the wire;
 * `here` is for comparing with a margin note, which lives in the current text.
 */
export function passagesWithSpans(
  baseline: string,
  next: string,
  shareId: string,
  generation = 0,
): (OutgoingPassage & { here: string | null })[] {
  return shareHunksCached(baseline, next).map((hunk) => ({
    payloadRef: passageRef(shareId, hunk.baseFrom, hunk.body, generation),
    passage: `${hunk.baseFrom}:${hunk.baseTo}`,
    original: hunk.original,
    body: hunk.body,
    here: hunk.nextTo > hunk.nextFrom ? `${hunk.nextFrom}:${hunk.nextTo}` : null,
  }));
}

/** The same edit in the collaborator's current text. Shared offsets stay on the wire. */
export function currentPassageSpan(baseline: string, next: string, passage: string): string | null {
  for (const hunk of shareHunksCached(baseline, next)) {
    if (`${hunk.baseFrom}:${hunk.baseTo}` !== passage) continue;
    if (hunk.nextTo <= hunk.nextFrom) return null;
    return `${hunk.nextFrom}:${hunk.nextTo}`;
  }
  return null;
}

export interface OwnNote {
  from: number;
  to: number;
  proposed: string | null;
  intent: string | null;
  status: string;
  instruction: string | null;
  /** The passage before this suggestion. A comment leaves it unset. */
  original?: string;
  /** Set on a card that arrived from the other person. Those are not sent back. */
  shareChangeId?: string;
}

/** A saved margin note on the collaborator's copy. Empty body means it is not a replacement. */
export function ownNotesToSend(
  notes: readonly OwnNote[],
  shareId: string,
  generation = 0,
  settled: ReadonlySet<string> = new Set(),
  doc = "",
): OutgoingPassage[] {
  const out: OutgoingPassage[] = [];
  for (const note of notes) {
    if (out.length >= 20) break;
    if (note.status !== "pending" || note.intent !== "none" || note.instruction != null) continue;
    const text = note.proposed?.trim() ?? "";
    if (!text || note.to <= note.from) continue;
    const anchor = doc.slice(note.from, note.to);
    const payloadRef = noteRef(shareId, anchor, text, generation);
    const root = noteRef(shareId, anchor, text, 0);
    if (
      settled.has(payloadRef) ||
      settled.has(root) ||
      [...settled].some((ref) => ref.startsWith(`${root}-`))
    ) {
      continue;
    }
    out.push({
      payloadRef,
      passage: `${note.from}:${note.to}`,
      original: (anchor.trim() ? packComment(anchor, text) : text).slice(0, PROPOSAL_CHARS),
      body: "",
    });
  }
  return out;
}

function passageEnds(passage: string): [number, number] | null {
  const match = /^(\d+):(\d+)$/.exec(passage);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
  return [start, end];
}

/** The words the suggestion replaces in the baseline. An insertion's wire
 * original is packed, so the anchor is the passage slice. */
function anchorOf(
  baseline: string,
  change: Pick<OutgoingPassage, "original" | "body" | "passage">,
): { start: number; text: string } | null {
  const hinted = passageEnds(change.passage);
  const hint = hinted?.[0] ?? 0;
  const packed = change.original.startsWith("ins:") || change.original.startsWith("ins-before:");
  if (packed) {
    const unpacked = unpackInsert(change.original, change.body);
    const needle = unpacked?.anchor ?? (hinted ? baseline.slice(hinted[0], hinted[1]) : "");
    if (!needle) return null;
    const at = closestIndex(baseline, needle, hint);
    if (at < 0) return null;
    return { start: at, text: needle };
  }
  if (!change.original) return null;
  const at = closestIndex(baseline, change.original, hint);
  if (at < 0) return null;
  return { start: at, text: change.original };
}

/**
 * The suggestion is still the edit between these two texts.
 * Other edits may sit outside that wording. An edit inside it is a new change.
 * ponytail: shareHunks drops a whitespace-only tweak inside the wording, so
 * that tweak keeps the hold. Upgrade is a character diff of the wording.
 */
export function suggestionIntact(
  baseline: string,
  next: string,
  change: Pick<OutgoingPassage, "original" | "body" | "passage">,
): boolean {
  const anchor = anchorOf(baseline, change);
  if (!anchor || !change.body) return false;
  const only =
    baseline.slice(0, anchor.start) +
    change.body +
    baseline.slice(anchor.start + anchor.text.length);
  if (only === next) return true;
  const end = anchor.start + change.body.length;
  return shareHunks(only, next).every(
    (hunk) => hunk.baseTo <= anchor.start || hunk.baseFrom >= end,
  );
}

function liveCover(baseline: string, next: string, change: OutgoingPassage): string | null {
  const anchor = anchorOf(baseline, change);
  if (!anchor || !suggestionIntact(baseline, next, change)) return null;
  const only =
    baseline.slice(0, anchor.start) +
    change.body +
    baseline.slice(anchor.start + anchor.text.length);
  const end = anchor.start + change.body.length;
  let shift = 0;
  const hunks = shareHunks(only, next)
    .slice()
    .sort((a, b) => a.baseFrom - b.baseFrom);
  for (const hunk of hunks) {
    if (hunk.baseFrom >= end) break;
    if (hunk.baseTo <= anchor.start) {
      shift += hunk.nextTo - hunk.nextFrom - (hunk.baseTo - hunk.baseFrom);
    }
  }
  return `${anchor.start + shift}:${end + shift}`;
}

/** A suggestion that was already sent, after the margin note that produced it is gone. */
export function restoreHeldProposals(
  baseline: string,
  next: string,
  held: readonly OutgoingPassage[],
  present: ReadonlySet<string>,
): OutgoingPassage[] {
  const out: OutgoingPassage[] = [];
  for (const change of held) {
    if (present.has(change.payloadRef) || !change.body) continue;
    const live = liveCover(baseline, next, change);
    if (!live) continue;
    out.push({ ...change, live, applied: true });
  }
  return out;
}

function coverAccepted(
  baseline: string,
  next: string,
  note: OwnNote,
  wire: OutgoingPassage,
): OutgoingPassage | null {
  if (note.status !== "accepted") return wire;
  const slice = next.slice(note.from, note.to);
  const proposed = note.proposed ?? "";
  const spanOk = note.intent === "replace" ? slice === proposed : slice.endsWith(proposed);
  if (spanOk) return wire;
  const live = liveCover(baseline, next, wire);
  if (!live) return null;
  return { ...wire, live };
}

/**
 * A replacement the collaborator still wants the owner to decide.
 * Ask Alkuin sets `instruction`. Suggest wording leaves it null. Both are
 * proposals. A comment (`intent: "none"`) stays in `ownNotesToSend`.
 * Accepting the suggestion on this Mac keeps that same change. The token
 * diff is not a second card, and the first card is not withdrawn.
 * An insertion is the selection plus the new text, so Accept appends.
 * A drifted span still counts when the baseline became that suggestion.
 * ponytail: the hold is the last sent wording. A later edit inside it drops
 * the hold. Upgrade is a diff that subtracts the suggestion span.
 */
export function proposalsToSend(
  notes: readonly OwnNote[],
  shareId: string,
  generation = 0,
  baseline = "",
  next = "",
): OutgoingPassage[] {
  const out: OutgoingPassage[] = [];
  for (const note of notes) {
    if (out.length >= 20) break;
    if (note.shareChangeId) continue;
    if (note.status !== "pending" && note.status !== "accepted") continue;
    if (note.intent !== "replace" && note.intent !== "insert") continue;
    const proposed = note.proposed ?? "";
    const original = note.original?.trim() ?? "";
    if (!proposed.trim() || !original || note.to <= note.from) continue;
    let wire: OutgoingPassage | null = null;
    if (note.intent === "insert") {
      const at = closestIndex(baseline, original, note.from);
      const packed = at >= 0 ? packInsertion(original, proposed) : null;
      if (packed) {
        wire = {
          payloadRef: proposalRef(shareId, packed.original, packed.body, generation),
          passage: `${at}:${at + original.length}`,
          original: packed.original,
          body: packed.body,
          live: `${note.from}:${note.to}`,
          applied: note.status === "accepted",
        };
      }
    }
    if (!wire) {
      const body = proposed.trim();
      let passage = `${note.from}:${note.to}`;
      if (note.status === "accepted") {
        const at = closestIndex(baseline, original, note.from);
        if (at >= 0) passage = `${at}:${at + original.length}`;
      }
      wire = {
        payloadRef: proposalRef(shareId, original, body, generation),
        passage,
        original: original.slice(0, PROPOSAL_CHARS),
        body: body.slice(0, PROPOSAL_CHARS),
        live: `${note.from}:${note.to}`,
        applied: note.status === "accepted",
      };
    }
    const covered = coverAccepted(baseline, next, note, wire);
    if (covered) out.push(covered);
  }
  return out;
}

/** The refs these margin notes send. Used to retire a note the user removed. */
export function noteRefs(
  notes: readonly OwnNote[],
  shareId: string,
  baseline: string,
  doc: string,
): string[] {
  return [
    ...proposalsToSend(notes, shareId, 0, baseline, doc),
    ...ownNotesToSend(notes, shareId, 0, new Set(), doc),
  ].map((change) => change.payloadRef);
}

/**
 * Margin notes for sent comments and pending suggestions the margin lost in
 * a reload. Each note sends the same ref again, so Dismiss withdraws it.
 * An accepted suggestion is not here: the text keeps it. A passage that is
 * no longer in the text stays sent and is not shown.
 */
export function notesFromHeld(
  doc: string,
  held: readonly Pick<
    OutgoingPassage,
    "payloadRef" | "passage" | "original" | "body" | "applied"
  >[],
): RedlineNote[] {
  const out: RedlineNote[] = [];
  for (const change of held) {
    if (change.applied) continue;
    const hint = passageEnds(change.passage)?.[0] ?? 0;
    const base = {
      id: `share-held-${change.payloadRef}`,
      instruction: null,
      status: "pending" as const,
      error: null,
      git: null,
      publish: null,
    };
    if (!change.body) {
      const comment = unpackComment(change.original);
      if (!comment) continue;
      const at = closestIndex(doc, comment.anchor, hint);
      if (at < 0) continue;
      out.push({
        ...base,
        // The id the other Mac reads back from the same words.
        threadId: threadKey(comment.anchor, comment.comment),
        from: at,
        to: at + comment.anchor.length,
        original: comment.anchor,
        proposed: comment.comment,
        intent: "none",
      });
      continue;
    }
    const inserted = unpackInsert(change.original, change.body);
    if (inserted) {
      if (inserted.before) continue;
      const at = closestIndex(doc, inserted.anchor, hint);
      if (at < 0) continue;
      out.push({
        ...base,
        from: at,
        to: at + inserted.anchor.length,
        original: inserted.anchor,
        proposed: inserted.inserted,
        intent: "insert",
      });
      continue;
    }
    const at = closestIndex(doc, change.original, hint);
    if (at < 0) continue;
    out.push({
      ...base,
      from: at,
      to: at + change.original.length,
      original: change.original,
      proposed: change.body,
      intent: "replace",
    });
  }
  return out;
}

/**
 * Sent comments and pending suggestions the margin no longer shows, sent
 * again as they were so they stay pending until the owner decides. A
 * comment moves to where its sentence is now. An accepted suggestion is not
 * carried: the text keeps it while the wording is intact.
 */
export function carryHeld(
  held: readonly OutgoingPassage[],
  next: string,
  skip: ReadonlySet<string>,
  proposals: boolean,
): OutgoingPassage[] {
  const out: OutgoingPassage[] = [];
  for (const change of held) {
    if (skip.has(change.payloadRef) || change.applied) continue;
    const { payloadRef, passage, original, body } = change;
    if (!body) {
      const comment = unpackComment(original);
      const hint = passageEnds(passage)?.[0] ?? 0;
      const at = comment ? closestIndex(next, comment.anchor, hint) : -1;
      out.push({
        payloadRef,
        passage: comment && at >= 0 ? `${at}:${at + comment.anchor.length}` : passage,
        original,
        body: "",
      });
      continue;
    }
    if (proposals) out.push({ payloadRef, passage, original, body });
  }
  return out;
}
