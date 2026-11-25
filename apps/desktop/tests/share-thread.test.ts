import { expect, test } from "vite-plus/test";
import { planSharePush, threadRekeys } from "../src/features/document-share/live";
import { notesFromHeld, notesFromPending } from "../src/features/document-share/place";
import { noteThreadId, threadKey } from "../src/features/note-mention/thread";
import type { RedlineNote } from "../src/features/redline-spike/model";

const SHARE = "33333333-3333-4333-8333-333333333333";
const authorDoc = "The harbor stays quiet.\n\nThe ledger is in pencil.";
const anchor = "The ledger is in pencil.";
const words = "Ink would last.";

/** What the author's Mac minted when the comment was saved (actions.ts). */
const authorThread = threadKey(anchor, words);

function sent() {
  const from = authorDoc.indexOf(anchor);
  const plan = planSharePush({
    baseline: authorDoc,
    next: authorDoc,
    notes: [
      {
        from,
        to: from + anchor.length,
        proposed: words,
        intent: "none",
        status: "pending",
        instruction: null,
      },
    ],
    shareId: SHARE,
    sent: [],
  });
  return plan.changes[0]!;
}

function incoming(readerDoc: string) {
  const change = sent();
  const [start, end] = change.passage.split(":").map(Number);
  const [card] = notesFromPending(readerDoc, [
    {
      id: "change-1",
      start: start ?? 0,
      end: end ?? 0,
      original: change.original,
      body: null,
      sender_email: "ada@example.com",
    },
  ]);
  return card!;
}

test("the reader names the thread from the words that were sent", () => {
  expect(noteThreadId(incoming(authorDoc))).toBe(authorThread);
  // The reader's copy no longer has the marked sentence: the card used to
  // name the thread from the comment alone and missed the author's rows.
  const card = incoming("The harbor stays quiet.\n\nThe ledger was rewritten.");
  expect(card.from).toBe(card.to);
  expect(noteThreadId(card)).toBe(authorThread);
});

test("a comment restored after a relaunch keeps its thread", () => {
  const [note] = notesFromHeld(authorDoc, [sent()]);
  expect(note?.threadId).toBe(authorThread);
  expect(noteThreadId(note!)).toBe(authorThread);
});

test("typing inside the marked sentence moves the author's thread with the wire", () => {
  const from = authorDoc.indexOf(anchor);
  const note: RedlineNote = {
    id: "n1",
    from,
    to: from + anchor.length,
    original: anchor,
    proposed: words,
    intent: "none",
    instruction: null,
    status: "pending",
    error: null,
    git: null,
    publish: null,
    threadId: authorThread,
  };
  expect(threadRekeys([note], authorDoc)).toEqual([]);
  const typed = authorDoc.replace("in pencil", "in soft pencil");
  const moved = { ...note, to: note.to + "soft ".length };
  const rekeyed = threadRekeys([moved], typed);
  // The reader derives this same id from the new words it receives.
  const newWords = typed.slice(moved.from, moved.to);
  expect(rekeyed).toEqual([{ id: "n1", threadId: threadKey(newWords, words) }]);
  // A comment with no thread, one open for Edit, or a card from the other Mac is left alone.
  expect(threadRekeys([{ ...moved, threadId: undefined }], typed)).toEqual([]);
  expect(threadRekeys([{ ...moved, status: "open", instruction: words }], typed)).toEqual([]);
  expect(threadRekeys([{ ...moved, shareChangeId: "c1" }], typed)).toEqual([]);
});
