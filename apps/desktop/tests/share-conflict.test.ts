import { expect, test } from "vite-plus/test";
import { placeConflict } from "../src/features/document-share/conflict";
import type { SharePassage } from "../src/features/document-share/place";

const SNAPSHOT =
  "# Harbor\n\nThe harbor stays quiet.\n\nThe ledger is in pencil.\n\nBoats leave at dawn.";

function passage(original: string, proposed: string | null, extra?: Partial<SharePassage>) {
  const start = SNAPSHOT.indexOf(original);
  return {
    id: "c1",
    start,
    end: start + original.length,
    original,
    proposed,
    sender: "Maria",
    snapshot: SNAPSHOT,
    ...extra,
  } satisfies SharePassage;
}

test("the owner rewrote the same sentence: the owner's span is found", () => {
  const owner = SNAPSHOT.replace("The harbor stays quiet.", "The harbor is calm tonight.");
  const found = placeConflict(owner, passage("The harbor stays quiet.", "The harbor sleeps."));
  expect(found).not.toBeNull();
  expect(found?.mine).toBe("The harbor is calm tonight.");
  expect(found?.theirs).toBe("The harbor sleeps.");
  expect(found?.sender).toBe("Maria");
  expect(owner.slice(found?.from, found?.to)).toBe(found?.mine);
});

test("the owner deleted the sentence: not found today, the passage stays stale", () => {
  // mapSnapshotSpan cannot place a deletion. The deleted run also takes the
  // blank line or space beside the sentence, so it is wider than the span and
  // the walk gives up. The build must widen that rule.
  const owner = SNAPSHOT.replace("The harbor stays quiet.\n\n", "");
  expect(placeConflict(owner, passage("The harbor stays quiet.", "The harbor sleeps."))).toBeNull();
  const inline = "A b c. The harbor stays quiet. D e f.";
  const start = inline.indexOf("The harbor");
  expect(
    placeConflict("A b c. D e f.", {
      id: "c3",
      start,
      end: start + "The harbor stays quiet.".length,
      original: "The harbor stays quiet.",
      proposed: "The harbor sleeps.",
      sender: "Maria",
      snapshot: inline,
    }),
  ).toBeNull();
});

test("the owner rewrote a different sentence: not a conflict", () => {
  const owner = SNAPSHOT.replace("The ledger is in pencil.", "The ledger is in ink.");
  expect(placeConflict(owner, passage("The harbor stays quiet.", "The harbor sleeps."))).toBeNull();
});

test("a comment and an insertion are not conflicts", () => {
  const owner = SNAPSHOT.replace("The harbor stays quiet.", "The harbor is calm tonight.");
  expect(placeConflict(owner, passage("The harbor stays quiet.", null))).toBeNull();
  const anchor = "harbor";
  const inserted = " old";
  const ins = passage(`ins:${anchor.length}:${anchor}${inserted}`, anchor + inserted, {
    start: SNAPSHOT.indexOf(anchor),
    end: SNAPSHOT.indexOf(anchor) + anchor.length,
  });
  expect(placeConflict(owner, ins)).toBeNull();
});

test("the sentence appears twice and one copy survives: null, the normal path places it", () => {
  const twice = "# Harbor\n\nThe tide turns.\n\nThe ledger is in pencil.\n\nThe tide turns.";
  const owner = twice.replace("The tide turns.", "The tide is slow.");
  const first = twice.indexOf("The tide turns.");
  const found = placeConflict(owner, {
    id: "c2",
    start: first,
    end: first + "The tide turns.".length,
    original: "The tide turns.",
    proposed: "The tide is late.",
    sender: "Maria",
    snapshot: twice,
  });
  // String.replace rewrote only the first copy. The second still matches.
  expect(owner.includes("The tide turns.")).toBe(true);
  expect(found).toBeNull();
});

test("one owner edit spans two of the collaborator's passages: null, not a guess", () => {
  const owner = SNAPSHOT.replace(
    "The harbor stays quiet.\n\nThe ledger is in pencil.",
    "Everything here is calm and written in ink.",
  );
  expect(placeConflict(owner, passage("The harbor stays quiet.", "The harbor sleeps."))).toBeNull();
  expect(
    placeConflict(owner, passage("The ledger is in pencil.", "The ledger is in ink.")),
  ).toBeNull();
});

test("the collaborator deleted the sentence and the owner rewrote it: theirs is empty", () => {
  const owner = SNAPSHOT.replace("The harbor stays quiet.", "The harbor is calm tonight.");
  const found = placeConflict(owner, passage("The harbor stays quiet.", ""));
  expect(found).not.toBeNull();
  expect(found?.mine).toBe("The harbor is calm tonight.");
  expect(found?.theirs).toBe("");
});

test("no snapshot: null, the passage stays stale", () => {
  const owner = SNAPSHOT.replace("The harbor stays quiet.", "The harbor is calm tonight.");
  expect(
    placeConflict(
      owner,
      passage("The harbor stays quiet.", "The harbor sleeps.", { snapshot: null }),
    ),
  ).toBeNull();
});
