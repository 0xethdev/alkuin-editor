import { ChangeSet, type ChangeDesc } from "@codemirror/state";
import { cameFromElsewhere, isAskInFlight, type RedlineNote } from "./model";

/**
 * Margin notes belong to a file, and an editor view shows one file at a time. When the
 * view moves on, or is torn down while the next file loads, the notes of the file it
 * left wait here until that file is shown again.
 *
 * shortcut: kept in memory for the run of the app, so a relaunch still drops them.
 * Upgrade is storage beside the document.
 */
const parked = new Map<string, { doc: string; notes: RedlineNote[] }>();

/** Tutorial seeds are recomputed from the text on every open (`tutorial-seeds.ts`). */
const TUTORIAL_SEED_ID = "tutorial-";

export function mapNote(note: RedlineNote, changes: ChangeDesc): RedlineNote | null {
  // A typed insertion is a caret (from === to). Mapping the two ends to
  // opposite sides of a keystroke collapses it and the card disappears.
  if (note.intent === "insert" && note.from === note.to) {
    const at = changes.mapPos(note.from, 1);
    return { ...note, from: at, to: at };
  }
  const from = changes.mapPos(note.from, 1);
  const to = changes.mapPos(note.to, note.intent === "insert" ? 1 : -1);
  // A collapsed span is gone, except under an Accept being saved (Accept reads it and says
  // so) and on a card that says an accepted change was not added (it stays until Dismiss).
  const kept = note.status === "accepted" || note.deciding === true || note.notApplied === true;
  if (from >= to && !kept) return null;
  return { ...note, from, to: Math.max(from, to) };
}

/** The writer's own note: kept through a reload of its file, where the view stays. */
export function ownNote(note: RedlineNote): boolean {
  // The other person's card, or the connector's: a pull paints it again, on the
  // document it belongs to. Kept here it would follow the path, not the document.
  if (cameFromElsewhere(note)) return false;
  // Its words are already in the document.
  if (note.status === "accepted") return false;
  return !note.id.startsWith(TUTORIAL_SEED_ID);
}

/** An own note in a state that still means something when its file comes back to a view. */
export function restorable(note: RedlineNote): boolean {
  // Mid-Ask: the card has no buttons, and the answer cannot reach a note that has left
  // its view, so it would wait forever.
  return ownNote(note) && !isAskInFlight(note);
}

/**
 * Place notes made on `before` in `after`. The two texts are compared as one change over
 * the middle that differs, and each note is mapped through it the way a keystroke maps
 * it. A note is kept only when its passage is exactly where that puts it. There is no
 * search: the same words elsewhere in the file are not this note's passage.
 */
export function relocateNotes(
  notes: readonly RedlineNote[],
  before: string,
  after: string,
): RedlineNote[] {
  if (before === after || notes.length === 0) return [...notes];
  const shorter = Math.min(before.length, after.length);
  let head = 0;
  while (head < shorter && before.charCodeAt(head) === after.charCodeAt(head)) head++;
  let tail = 0;
  while (
    tail < shorter - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail++;
  }
  const end = before.length - tail;
  const changes = ChangeSet.of(
    { from: head, to: end, insert: after.slice(head, after.length - tail) },
    before.length,
  );
  const insideChange = (pos: number) => pos > head && pos < end;
  const placed: RedlineNote[] = [];
  for (const note of notes) {
    if (note.from < 0 || note.from > note.to || note.to > before.length) continue;
    const moved = mapNote(note, changes);
    if (!moved) continue;
    // The passage as it read when these notes were parked, typing since the note included.
    const passage = before.slice(note.from, note.to);
    if (passage) {
      if (after.slice(moved.from, moved.to) !== passage) continue;
    } else if (insideChange(note.from)) {
      // A caret has no words to check, so a place inside the rewritten middle is a guess.
      continue;
    }
    placed.push(moved);
  }
  return placed;
}

/** Keep this file's notes for the next time it is shown. `doc` is read only when a note stays. */
export function parkNotes(
  path: string,
  doc: { toString(): string },
  notes: readonly RedlineNote[],
): void {
  if (!path) return;
  const keep = notes.filter(restorable);
  // A view takes its file's entry when it shows the file. One that is here now was
  // parked by another view since, and a view with nothing to add leaves it.
  if (keep.length === 0) return;
  const text = doc.toString();
  const earlier = parked.get(path);
  if (!earlier) {
    parked.set(path, { doc: text, notes: keep });
    return;
  }
  // Two views of one file: both views' notes wait. The earlier ones are placed in this
  // text first; a note both views hold is this view's copy.
  const ids = new Set(keep.map((note) => note.id));
  const others = relocateNotes(earlier.notes, earlier.doc, text).filter(
    (note) => !ids.has(note.id),
  );
  parked.set(path, { doc: text, notes: [...keep, ...others] });
}

/** The notes waiting for this file, placed in the text it has now. */
export function parkedNotes(path: string, doc: { toString(): string }): RedlineNote[] {
  const entry = parked.get(path);
  return entry ? relocateNotes(entry.notes, entry.doc, doc.toString()) : [];
}

/** A view shows this file again and holds its notes, so no second view picks up a stale copy. */
export function dropParkedNotes(path: string): void {
  parked.delete(path);
}

/** A file or folder was renamed or moved. Notes waiting under the old path wait under the new. */
export function moveParkedNotes(from: string, to: string): void {
  const under = `${from}/`;
  const moving = Array.from(parked).filter(([path]) => path === from || path.startsWith(under));
  for (const [path, entry] of moving) {
    parked.delete(path);
    parked.set(to + path.slice(from.length), entry);
  }
}

export function resetParkedNotesForTest(): void {
  parked.clear();
}
