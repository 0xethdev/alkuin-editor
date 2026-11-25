import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vite-plus/test";
import {
  addRetiredRefs,
  closeLedger,
  closeLedgerForPath,
  closeLedgersUnder,
  dropRetiredRefs,
  ensureBaseline,
  ledgerCloses,
  loadHeldProposals,
  loadRetiredRefs,
  loadSentRefs,
  loadShare,
  memoryStore,
  rememberOpenedText,
  rememberShare,
  saveHeldProposals,
  saveOutbox,
  saveSentRefs,
  shareKeepsCopy,
  type TextStore,
} from "../src/features/document-share/baseline";
import {
  attemptShareSend,
  marginRefs,
  mergeSharePlan,
  planSharePush,
  removedNoteRefs,
  type MarginLedger,
} from "../src/features/document-share/live";
import {
  noteRef,
  notesFromHeld,
  passageRef,
  proposalRef,
  shareRefKind,
} from "../src/features/document-share/place";
import { addRedlineNote, redlineNotesField } from "../src/features/redline-spike/notes";
import type { RedlineNote } from "../src/features/redline-spike/model";

const SHARE = "33333333-3333-4333-8333-333333333333";
const baseline = "The harbor stays quiet.\n\nThe ledger is in pencil.\n\nThe lamp is lit.";
const edited = baseline.replace("stays quiet", "is quiet");
const lampAt = edited.indexOf("The lamp is lit.");
const ledgerAt = edited.indexOf("The ledger is in pencil.");

const comment = {
  from: ledgerAt,
  to: ledgerAt + "The ledger is in pencil.".length,
  original: "The ledger is in pencil.",
  proposed: "Ink would last.",
  intent: "none" as const,
  status: "pending" as const,
  instruction: null,
};
const suggestion = {
  from: lampAt,
  to: lampAt + "The lamp is lit.".length,
  original: "The lamp is lit.",
  proposed: "The lamp burns.",
  intent: "replace" as const,
  status: "pending" as const,
  instruction: null,
};

const empty: MarginLedger = { seen: new Set(), retired: new Set() };

function firstSend() {
  const plan = planSharePush({
    baseline,
    next: edited,
    notes: [comment, suggestion],
    shareId: SHARE,
    sent: [],
    ledger: empty,
  });
  const ref = (body: string) => plan.changes.find((change) => change.body === body)!.payloadRef;
  return {
    plan,
    passage: ref("The harbor is"),
    note: ref(""),
    proposal: ref("The lamp burns."),
    sent: plan.changes.map((change) => change.payloadRef),
  };
}

test("each ref says which minting function made it", () => {
  for (const id of [SHARE, "share-harbor", "share-1"]) {
    for (const generation of [0, 2]) {
      expect(shareRefKind(id, passageRef(id, 146, "line was cut.", generation))).toBe("passage");
      expect(shareRefKind(id, proposalRef(id, "harbor", "bay", generation))).toBe("proposal");
      expect(shareRefKind(id, noteRef(id, "The ledger", "Ink", generation))).toBe("comment");
    }
  }
});

test("a reload does not withdraw a sent comment or a pending suggestion", () => {
  const first = firstSend();
  expect(first.plan.changes).toHaveLength(3);
  expect(first.plan.holds.map((hold) => hold.payloadRef).sort()).toEqual(
    [first.note, first.proposal].sort(),
  );
  // The margin came back empty: a reload, a file swap, or a relaunch.
  const reopened = planSharePush({
    baseline,
    next: edited,
    notes: [],
    shareId: SHARE,
    sent: first.sent,
    held: first.plan.holds,
    ledger: empty,
  });
  expect(reopened.withdraw).toEqual([]);
  // Both are sent again as they were, so they stay pending until the owner decides.
  expect(reopened.changes.map((change) => change.payloadRef).sort()).toEqual(
    [...first.sent].sort(),
  );
  expect(reopened.holds.map((hold) => hold.payloadRef).sort()).toEqual(
    [first.note, first.proposal].sort(),
  );
  // Without a ledger the margin is taken as complete, the old behaviour.
  const trusting = planSharePush({
    baseline,
    next: edited,
    notes: [],
    shareId: SHARE,
    sent: first.sent,
  });
  expect(trusting.withdraw.sort()).toEqual([first.note, first.proposal].sort());
});

test("dismiss, edit and revert are the only withdraws", () => {
  const first = firstSend();
  const dismissed = planSharePush({
    baseline,
    next: edited,
    notes: [suggestion],
    shareId: SHARE,
    sent: first.sent,
    held: first.plan.holds,
    ledger: { seen: new Set(), retired: new Set([first.note]) },
  });
  expect(dismissed.withdraw).toEqual([first.note]);
  expect(dismissed.changes.some((change) => change.payloadRef === first.note)).toBe(false);

  // The margin held the comment this session, and now holds new words.
  const rewritten = planSharePush({
    baseline,
    next: edited,
    notes: [{ ...comment, proposed: "Pencil fades." }, suggestion],
    shareId: SHARE,
    sent: first.sent,
    held: first.plan.holds,
    ledger: { seen: new Set(first.plan.margin), retired: new Set() },
  });
  expect(rewritten.withdraw).toEqual([first.note]);
  expect(rewritten.changes.some((change) => change.body === "")).toBe(true);

  // A passage is the text against the baseline, so a revert after a reload still withdraws it.
  const reverted = planSharePush({
    baseline,
    next: baseline,
    notes: [],
    shareId: SHARE,
    sent: first.sent,
    held: first.plan.holds,
    ledger: empty,
  });
  expect(reverted.withdraw).toEqual([first.passage]);
});

test("a comment open for Edit keeps its sent words until it is saved again", () => {
  const first = firstSend();
  const editing = planSharePush({
    baseline,
    next: edited,
    notes: [
      { ...comment, status: "open" as const, intent: null, instruction: comment.proposed },
      suggestion,
    ],
    shareId: SHARE,
    sent: first.sent,
    held: first.plan.holds,
    ledger: { seen: new Set(first.plan.margin), retired: new Set() },
  });
  expect(editing.withdraw).toEqual([]);
  expect(editing.margin).toContain(first.note);
});

test("an accepted suggestion edited after a reload is withdrawn, an intact one is kept", () => {
  const doc = "we believe to write is think and that good writing is good thinking.";
  const clause = "to write is think";
  const from = doc.indexOf(clause);
  const accepted = doc.replace(clause, "think");
  const sent = planSharePush({
    baseline: doc,
    next: accepted,
    notes: [
      {
        from,
        to: from + "think".length,
        original: clause,
        proposed: "think",
        intent: "replace",
        status: "accepted",
        instruction: "shorter",
      },
    ],
    shareId: SHARE,
    sent: [],
    ledger: empty,
  });
  const hold = sent.holds[0]!;
  expect(hold.applied).toBe(true);
  const kept = planSharePush({
    baseline: doc,
    next: accepted,
    notes: [],
    shareId: SHARE,
    sent: [hold.payloadRef],
    held: sent.holds,
    ledger: empty,
  });
  expect(kept.withdraw).toEqual([]);
  expect(kept.changes.map((change) => change.payloadRef)).toEqual([hold.payloadRef]);
  const tweaked = planSharePush({
    baseline: doc,
    next: accepted.replace("think and", "thought and"),
    notes: [],
    shareId: SHARE,
    sent: [hold.payloadRef],
    held: sent.holds,
    ledger: empty,
  });
  expect(tweaked.withdraw).toEqual([hold.payloadRef]);
});

test("held notes come back to the margin and send the same refs", () => {
  const first = firstSend();
  const notes = notesFromHeld(edited, first.plan.holds);
  expect(new Set(notes.map((note) => note.intent))).toEqual(new Set(["none", "replace"]));
  for (const note of notes) {
    expect(note.id.startsWith("share-held-")).toBe(true);
    expect(edited.slice(note.from, note.to)).toBe(note.original);
  }
  const again = planSharePush({
    baseline,
    next: edited,
    notes,
    shareId: SHARE,
    sent: first.sent,
    held: first.plan.holds,
    ledger: empty,
  });
  expect(again.margin.sort()).toEqual([first.note, first.proposal].sort());
  expect(again.withdraw).toEqual([]);
  // An accepted suggestion stays in the text and is not a margin note again.
  expect(notesFromHeld(edited, [{ ...first.plan.holds[0]!, applied: true }])).toEqual([]);
});

test("a removed note retires its refs, a reload and an accepted card do not", () => {
  const first = firstSend();
  const note = (fields: Partial<RedlineNote>): RedlineNote => ({
    id: "n1",
    error: null,
    git: null,
    publish: null,
    ...comment,
    ...fields,
  });
  const mine = note({});
  const incoming = note({ id: "n2", shareChangeId: "c1" });
  const accepted = note({ id: "n3", ...suggestion, status: "accepted" });
  expect(removedNoteRefs([mine, incoming, accepted], [], SHARE, baseline, edited)).toEqual([
    first.note,
  ]);
  expect(removedNoteRefs([mine], [mine], SHARE, baseline, edited)).toEqual([]);
  // A reload keeps the writer's own note where its words still are (`parked-notes.ts`),
  // and the listener skips that transaction either way, so it retires nothing.
  const state = EditorState.create({ doc: edited, extensions: [redlineNotesField] });
  const added = state.update({ effects: addRedlineNote.of(mine) }).state;
  const reloaded = added.update({
    changes: { from: 0, to: added.doc.length, insert: edited },
    userEvent: "writer.reload",
  });
  expect(reloaded.state.field(redlineNotesField)).toEqual([mine]);
  expect(reloaded.isUserEvent("writer")).toBe(true);
});

test("an unsent change whose note was removed is withdrawn, not sent", () => {
  const first = firstSend();
  const fresh = planSharePush({
    baseline,
    next: edited,
    notes: [suggestion],
    shareId: SHARE,
    sent: [first.passage, first.proposal],
    ledger: { seen: new Set(), retired: new Set([first.note]) },
  });
  const saved = { changes: first.plan.changes, withdraw: [] };
  const merged = mergeSharePlan(fresh, saved, edited, {
    seen: new Set(),
    retired: new Set([first.note]),
  });
  expect(merged.changes.some((change) => change.payloadRef === first.note)).toBe(false);
  expect(merged.withdraw).toContain(first.note);
  // Without a ledger an unsent change is kept, as before.
  expect(
    mergeSharePlan(fresh, saved, edited).changes.some((change) => change.payloadRef === first.note),
  ).toBe(true);
});

function seeded(): { box: TextStore; path: string; other: string } {
  const box = memoryStore();
  const path = `/Users/ada/Library/Application Support/app.alkuin/shares/${SHARE}.md`;
  const other = "/notes/own.md";
  rememberOpenedText(path, baseline, box);
  ensureBaseline(SHARE, path, baseline, box);
  rememberShare(SHARE, path, "invitee", box);
  rememberOpenedText(other, "Mine.", box);
  rememberShare("11111111-1111-1111-1111-111111111111", other, "owner", box);
  return { box, path, other };
}

test("opening again keeps this Mac's copy while a sent change is undecided", () => {
  const { box, path } = seeded();
  expect(shareKeepsCopy(SHARE, box)).toBe(false);
  saveSentRefs(SHARE, path, ["ref-a"], box);
  expect(shareKeepsCopy(SHARE, box)).toBe(true);
  saveSentRefs(SHARE, path, [], box);
  saveHeldProposals(
    SHARE,
    path,
    [{ payloadRef: "ref-b", passage: "0:3", original: "The", body: "A" }],
    box,
  );
  expect(shareKeepsCopy(SHARE, box)).toBe(true);
  saveHeldProposals(SHARE, path, [], box);
  saveOutbox(SHARE, path, { changes: [], withdraw: ["ref-c"] }, box);
  expect(shareKeepsCopy(SHARE, box)).toBe(true);
  expect(shareKeepsCopy("22222222-2222-2222-2222-222222222222", box)).toBe(false);
});

test("closeLedger forgets one share and leaves the others", () => {
  const { box, path, other } = seeded();
  saveSentRefs(SHARE, path, ["ref-a"], box);
  addRetiredRefs(SHARE, path, ["ref-a"], box);
  saveHeldProposals(
    SHARE,
    path,
    [{ payloadRef: "h", passage: "0:1", original: "T", body: "" }],
    box,
  );
  closeLedger(SHARE, box);
  expect(loadSentRefs(SHARE, path, box)).toEqual([]);
  expect(loadRetiredRefs(SHARE, path, box)).toEqual([]);
  expect(loadHeldProposals(SHARE, path, box)).toEqual([]);
  expect(loadShare(path, box)).toBeNull();
  expect(box.getItem(`alkuin-share-opened:${path}`)).toBeNull();
  expect(shareKeepsCopy(SHARE, box)).toBe(false);
  // A re-invite with the same id starts from the text it opens with.
  expect(ensureBaseline(SHARE, path, "Fresh.", box)).toBe("Fresh.");
  expect(loadShare(other, box)?.role).toBe("owner");
  expect(box.getItem(`alkuin-share-opened:${other}`)).toBe("Mine.");
  closeLedgerForPath(other, box);
  expect(loadShare(other, box)).toBeNull();
});

test("a deleted folder closes the ledgers of the shared files under it", () => {
  const box = memoryStore();
  const inside = "/notes/drafts/harbor.md";
  const outside = "/notes/draftsman.md";
  rememberShare(SHARE, inside, "owner", box);
  saveSentRefs(SHARE, inside, ["ref-a"], box);
  rememberShare("11111111-1111-1111-1111-111111111111", outside, "owner", box);
  closeLedgersUnder("/notes/drafts", box);
  expect(loadShare(inside, box)).toBeNull();
  expect(loadSentRefs(SHARE, inside, box)).toEqual([]);
  expect(loadShare(outside, box)?.role).toBe("owner");
});

test("retired refs are added once and dropped when the withdraw lands", () => {
  const box = memoryStore();
  addRetiredRefs(SHARE, "/a.md", ["a", "b"], box);
  addRetiredRefs(SHARE, "/a.md", ["b"], box);
  expect(loadRetiredRefs(SHARE, "/a.md", box)).toEqual(["a", "b"]);
  dropRetiredRefs(SHARE, "/a.md", ["a"], box);
  expect(loadRetiredRefs(SHARE, "/a.md", box)).toEqual(["b"]);
});

test("a comment or suggestion on a long paragraph keeps its ref after a reload", () => {
  // Reviewer probe: packComment keeps 800 + 1100 characters, and the ref used to hash all of them.
  const para = `${"Word ".repeat(200).trim()}.`;
  const doc = `${para}\n\nThe lamp is lit.`;
  const note = "Too long? ".repeat(150).trim();
  const comment = {
    from: 0,
    to: para.length,
    proposed: note,
    intent: "none" as const,
    status: "pending" as const,
    instruction: null,
  };
  const long = "The lamp is lit and the harbor is quiet. ".repeat(60).trim();
  const longDoc = `${doc}\n\n${long}`;
  const at = longDoc.indexOf(long);
  const suggestion = {
    from: at,
    to: at + long.length,
    original: long,
    proposed: long.replace(/quiet/g, "still"),
    intent: "replace" as const,
    status: "pending" as const,
    instruction: null,
  };
  expect(para.length).toBeGreaterThan(800);
  expect(long.length).toBeGreaterThan(2000);
  const first = planSharePush({
    baseline: longDoc,
    next: longDoc,
    notes: [comment, suggestion],
    shareId: SHARE,
    sent: [],
    ledger: empty,
  });
  const sent = first.changes.map((change) => change.payloadRef);
  expect(sent).toHaveLength(2);
  const restored = notesFromHeld(longDoc, first.holds);
  expect(restored).toHaveLength(2);
  const after = planSharePush({
    baseline: longDoc,
    next: longDoc,
    notes: restored,
    shareId: SHARE,
    sent,
    held: first.holds,
    ledger: empty,
  });
  // The restored notes send the refs that went out: nothing is posted twice or carried forever.
  expect([...after.margin].sort()).toEqual([...sent].sort());
  expect(after.changes.map((change) => change.payloadRef).sort()).toEqual([...sent].sort());
  expect(after.withdraw).toEqual([]);
});

test("an unrelated suggestion at overlapping offsets does not withdraw a delivered edit", () => {
  const base = "Alpha one.\n\nBeta two.\n\nGamma three.";
  const typed = base.replace("Beta two.", "Beta 2.");
  const first = planSharePush({
    baseline: base,
    next: typed,
    notes: [],
    shareId: SHARE,
    sent: [],
    ledger: empty,
  });
  const edit = first.changes.find((change) => change.body === "2.")!;
  const [start] = edit.passage.split(":").map(Number);
  // A paragraph typed at the top moves everything down. "Alpha one." now sits
  // where the edit's baseline offsets are, and the user asks about it.
  const next = `Intro.\n\n${typed}`;
  const at = next.indexOf("Alpha one.");
  expect(at).toBeLessThan(start!);
  expect(at + "Alpha one.".length).toBeGreaterThan(start!);
  const ask = {
    from: at,
    to: at + "Alpha one.".length,
    original: "Alpha one.",
    proposed: "Alpha first.",
    intent: "replace" as const,
    status: "pending" as const,
    instruction: "clearer",
  };
  const later = planSharePush({
    baseline: base,
    next,
    notes: [ask],
    shareId: SHARE,
    sent: [edit.payloadRef],
    ledger: empty,
  });
  expect(later.withdraw).toEqual([]);
  expect(later.changes.map((change) => change.payloadRef)).toContain(edit.payloadRef);
  // A typed edit inside the suggestion's words still waits for it.
  const inside = next.replace("Alpha one.", "Alpha 1.");
  const waits = planSharePush({
    baseline: base,
    next: inside,
    notes: [{ ...ask, to: ask.from + "Alpha 1.".length }],
    shareId: SHARE,
    sent: [],
    ledger: empty,
  });
  expect(waits.changes.some((change) => change.body === "1.")).toBe(false);
});

test("a 21st edit does not push a delivered edit out of the plan", () => {
  const lines = Array.from({ length: 25 }, (_, i) => `Line ${i} stays here.`);
  const base = lines.join("\n\n");
  const twenty = lines.map((line, i) => (i >= 2 && i < 22 ? line.replace("stays", "moves") : line));
  const first = planSharePush({
    baseline: base,
    next: twenty.join("\n\n"),
    notes: [],
    shareId: SHARE,
    sent: [],
    ledger: empty,
  });
  expect(first.changes).toHaveLength(20);
  const sent = first.changes.map((change) => change.payloadRef);
  const earlier = twenty.map((line, i) => (i === 0 ? line.replace("stays", "waits") : line));
  const later = planSharePush({
    baseline: base,
    next: earlier.join("\n\n"),
    notes: [],
    shareId: SHARE,
    sent,
    ledger: empty,
  });
  // The send batch is still 20; the plan knows all 21, so none of the 20 is withdrawn.
  expect(later.changes).toHaveLength(20);
  expect(later.withdraw).toEqual([]);
});

test("an edit reverted after a failed send is not posted from the outbox", () => {
  const typed = baseline.replace("The lamp is lit.", "The lamp is out.");
  const offline = planSharePush({
    baseline,
    next: typed,
    notes: [],
    shareId: SHARE,
    sent: [],
    ledger: empty,
  });
  const edit = offline.changes[0]!;
  // The send failed, so the plan stayed in the outbox. Then the user reverted the edit.
  const saved = { changes: offline.changes, withdraw: [] };
  const fresh = planSharePush({
    baseline,
    next: baseline,
    notes: [],
    shareId: SHARE,
    sent: [],
    ledger: empty,
  });
  const merged = mergeSharePlan(fresh, saved, baseline, empty, SHARE);
  expect(merged.changes).toEqual([]);
  expect(merged.withdraw).toEqual([edit.payloadRef]);
  // An unsent comment still goes: the outbox is its only record after a relaunch.
  const comment = {
    payloadRef: noteRef(SHARE, "The lamp", "Ink"),
    passage: "0:8",
    original: "note:8:The lampInk",
    body: "",
  };
  const kept = mergeSharePlan(fresh, { changes: [comment], withdraw: [] }, baseline, empty, SHARE);
  expect(kept.changes).toEqual([comment]);
  // A saved withdraw of a ref that is live again, past the 20-change cap, is not sent.
  const live = { changes: [], withdraw: [], live: [edit.payloadRef] };
  expect(
    mergeSharePlan(live, { changes: [], withdraw: [edit.payloadRef] }, typed, empty, SHARE)
      .withdraw,
  ).toEqual([]);
});

test("the margin's own refs are seen from the start of a session", () => {
  const first = firstSend();
  // The refs the margin holds when a session starts, a comment open for Edit included.
  const editing = {
    ...comment,
    status: "open" as const,
    intent: null,
    instruction: comment.proposed,
  };
  expect(marginRefs([editing, suggestion], SHARE, baseline, edited).sort()).toEqual(
    [first.note, first.proposal].sort(),
  );
  // Seeded, an edit made before the first plan withdraws the old words.
  const rewritten = planSharePush({
    baseline,
    next: edited,
    notes: [{ ...comment, proposed: "Pencil fades." }, suggestion],
    shareId: SHARE,
    sent: first.sent,
    held: first.plan.holds,
    ledger: {
      seen: new Set(marginRefs([comment, suggestion], SHARE, baseline, edited)),
      retired: new Set(),
    },
  });
  expect(rewritten.withdraw).toEqual([first.note]);
  const live = readFileSync(
    new URL("../src/features/document-share/live.ts", import.meta.url),
    "utf8",
  );
  expect(live.match(/restoreHeldNotes\([^)]*\);\n\s+seedSeen\(session\);/g)).toHaveLength(2);
});

test("a leave or delete during a send does not bring the ledger back", async () => {
  const box = memoryStore();
  const path = "/notes/shared.md";
  saveSentRefs(SHARE, path, ["ref-a"], box);
  const before = ledgerCloses();
  let release!: () => void;
  const writes: string[] = [];
  const sending = attemptShareSend({
    plan: { changes: firstSend().plan.changes, withdraw: [] },
    persist: () => writes.push("persist"),
    clear: () => writes.push("clear"),
    send: () =>
      new Promise((done) => {
        release = () => done({ posted: ["ref-a"], withdrawn: [], refused: [], error: null });
      }),
    open: () => ledgerCloses() === before,
  });
  closeLedger(SHARE, box);
  expect(ledgerCloses()).toBe(before + 1);
  release();
  expect((await sending).result).toBe("closed");
  // The plan was written before the request; nothing after the close.
  expect(writes).toEqual(["persist"]);
  expect(loadSentRefs(SHARE, path, box)).toEqual([]);
});
