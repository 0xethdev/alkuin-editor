import { expect, test } from "vite-plus/test";
import { NO_LONGER_MATCHES, readyLine, SHARE_COPY } from "../src/features/document-share/copy";
import {
  copiesAfterDecision,
  notesFromPending,
  passagesToSend,
  placeShareChange,
} from "../src/features/document-share/place";

test("an edited passage lands on the original sentence when the offsets have slid", () => {
  const owner = "# Harbor\n\nThe harbor stays quiet.\n\nThe ledger is in pencil.";
  const original = "The harbor stays quiet.";
  const stale = owner.indexOf("harbor stays");
  const placed = placeShareChange(owner, {
    id: "c1",
    start: stale,
    end: stale + "harbor stays quiet.\n\nThe ledger".length,
    original,
    proposed: "The harbor is quiet once the boats are in.",
    sender: "Maria",
  });
  expect(placed.kind).toBe("replace");
  if (placed.kind !== "replace") return;
  expect(placed.current).toBe(original);
  expect(placed.from).toBe(owner.indexOf(original));
  expect(placed.proposed).toBe("The harbor is quiet once the boats are in.");
  expect(owner.slice(placed.from, placed.to)).toBe(placed.current);
});

test("a deleted passage says it no longer matches and has no Accept", () => {
  const placed = placeShareChange("Short.", {
    id: "c2",
    start: 40,
    end: 80,
    original: "The weather was really very bad.",
    proposed: "The weather was bad.",
    sender: "Maria",
  });
  expect(placed).toMatchObject({ kind: "stale" });
  const [card] = notesFromPending("Short.", [
    {
      id: "c2",
      start: 40,
      end: 80,
      original: "The weather was really very bad.",
      body: "The weather was bad.",
      sender_email: "maria@example.com",
    },
  ]);
  expect(card?.shareAccept).toBe(false);
  expect(card?.shareStale).toBe(true);
  expect(card?.intent).toBe("replace");
  expect(card?.instruction).toBe(NO_LONGER_MATCHES);
  expect(card?.proposed).toBeNull();
});

test("a note never changes the owner's text and has no Accept", () => {
  const owner = "Leave the light as it is.";
  const collaborator = "B left the light.";
  const placed = placeShareChange(owner, {
    id: "note",
    start: 0,
    end: owner.length,
    original: owner,
    proposed: null,
    sender: "B",
  });
  expect(placed).toMatchObject({ kind: "note", accept: false, text: owner });
  const after = copiesAfterDecision(owner, collaborator, placed, true);
  expect(after.owner).toBe(owner);
  expect(after.collaborator).toBe(collaborator);
  const [card] = notesFromPending(owner, [
    {
      id: "note",
      start: 0,
      end: owner.length,
      original: owner,
      body: null,
      sender_email: "b@example.com",
    },
  ]);
  expect(card?.shareAccept).toBe(false);
  expect(card?.intent).toBe("none");
});

test("send measures the collaborator's copy against the text they started from", () => {
  const baseline = "The harbor stays quiet.\n\nThe ledger is in pencil.";
  const next = "The harbor is quiet.\n\nThe ledger is in pencil.";
  const sent = passagesToSend(baseline, next, "share-harbor");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.original).toBe("The harbor stays");
  expect(sent[0]?.body).toBe("The harbor is");
  expect(sent[0]?.passage).toBe("0:16");
  const [start, end] = sent[0]!.passage.split(":").map(Number);
  const placed = placeShareChange(baseline, {
    id: "harbor",
    start: start ?? 0,
    end: end ?? 0,
    original: sent[0]!.original,
    proposed: sent[0]!.body,
    sender: "B",
  });
  expect(copiesAfterDecision(baseline, next, placed, true).owner).toBe(next);
});

test("accepting one change leaves the other passage and B's copy", () => {
  const owner = "The harbor stays quiet.\n\nThe ledger stays short.";
  const collaborator = "The harbor is hushed.\n\nThe ledger is longer now.";
  const first = placeShareChange(owner, {
    id: "one",
    start: 0,
    end: "The harbor stays quiet.".length,
    original: "The harbor stays quiet.",
    proposed: "The harbor is hushed.",
    sender: "B",
  });
  const secondStart = owner.indexOf("The ledger stays short.");
  const second = placeShareChange(owner, {
    id: "two",
    start: secondStart,
    end: secondStart + "The ledger stays short.".length,
    original: "The ledger stays short.",
    proposed: "The ledger is longer now.",
    sender: "B",
  });
  const accepted = copiesAfterDecision(owner, collaborator, first, true);
  const rejected = copiesAfterDecision(accepted.owner, accepted.collaborator, second, false);
  expect(rejected.owner).toBe("The harbor is hushed.\n\nThe ledger stays short.");
  expect(rejected.collaborator).toBe(collaborator);
});

test("a sentence that cannot be lined up does not change the owner's text", () => {
  const started = "The harbor stays quiet.";
  const ownerNow = "The harbor is loud now.\n\nThe ledger stays short.";
  const collaborator = `${started}\n\nThe ledger stays short.`;
  const placed = placeShareChange(ownerNow, {
    id: "edit",
    start: 0,
    end: "The harbor is loud now.".length,
    original: started,
    proposed: "The harbor stays hushed.",
    sender: "B",
  });
  expect(placed.kind).toBe("stale");
  const accepted = copiesAfterDecision(ownerNow, collaborator, placed, true);
  expect(accepted.owner).toBe(ownerNow);
  expect(accepted.collaborator).toBe(collaborator);
  const deleted = placeShareChange("Short.", {
    id: "gone",
    start: 40,
    end: 80,
    original: "The weather was really very bad.",
    proposed: "The weather was bad.",
    sender: "B",
  });
  expect(deleted.kind).toBe("stale");
  const after = copiesAfterDecision("Short.", collaborator, deleted, true);
  expect(after.owner).toBe("Short.");
  expect(after.collaborator).toBe(collaborator);
});

test("an edit made after the invite still lands as a suggestion", () => {
  const invited = "We believe writing is thinking. The rest stays.";
  const ownerNow = "We believe writing is thought. The rest stays.";
  const next = "Writing helps us think. That's why we built Alkuin. The rest stays.";
  const sent = passagesToSend(invited, next, "share-essay");
  expect(sent).toHaveLength(1);
  const change = sent[0]!;
  const [start, end] = change.passage.split(":").map(Number);
  expect(invited.slice(start ?? 0, end ?? 0)).toBe(change.original);
  const placed = placeShareChange(ownerNow, {
    id: "essay",
    start: start ?? 0,
    end: end ?? 0,
    original: change.original,
    proposed: change.body,
    sender: "Paloma",
    snapshot: invited,
  });
  expect(placed.kind).toBe("replace");
  if (placed.kind !== "replace") return;
  expect(placed.current).toBe("We believe writing is thought.");
  const [card] = notesFromPending(ownerNow, [
    {
      id: "essay",
      start: start ?? 0,
      end: end ?? 0,
      original: change.original,
      body: change.body,
      sender_email: "paloma.reyes@example.com",
      snapshot: invited,
    },
  ]);
  expect(card?.intent).toBe("replace");
  expect(card?.shareAccept).toBe(true);
  expect(card?.person).toBe("Paloma");
  const accepted = copiesAfterDecision(ownerNow, next, placed, true);
  expect(accepted.owner.startsWith("Writing helps us think.")).toBe(true);
  expect(accepted.owner).toContain("The rest stays.");
  expect(copiesAfterDecision(ownerNow, next, placed, false).owner).toBe(ownerNow);
});

test("a deleted word in a long sentence and a trailing paragraph still sync", () => {
  const sentence = "Boats wait in the harbor until the really very late hour.";
  const dropped = "Boats wait in the harbor until the very late hour.";
  const baseline = `${sentence}\n\nBeta goes home.`;
  const next = `${dropped}\n\nBeta goes home.`;
  const removed = "Alpha stays.\n\nBeta goes.";
  const kept = "Alpha stays.";
  for (const [was, now] of [
    [baseline, next],
    [removed, kept],
  ] as const) {
    let owner: string = was;
    for (const change of passagesToSend(was, now, "share-cut")) {
      const [start, end] = change.passage.split(":").map(Number);
      const placed = placeShareChange(owner, {
        id: change.payloadRef,
        start: start ?? 0,
        end: end ?? 0,
        original: change.original,
        proposed: change.body,
        sender: "B",
      });
      owner = copiesAfterDecision(owner, now, placed, true).owner;
    }
    expect(owner).toBe(now);
  }
});

test("an insertion whose anchor is gone is still an insertion", () => {
  const placed = placeShareChange("Short.", {
    id: "gone-insert",
    start: 0,
    end: 5,
    original: "ins:4:Gone\n\nThis is why we built Alkuin!",
    proposed: "Gone\n\nThis is why we built Alkuin!",
    sender: "Paloma",
  });
  expect(placed.kind).toBe("insert");
  if (placed.kind !== "insert") return;
  expect(placed.text).toBe("\n\nThis is why we built Alkuin!");
  const [card] = notesFromPending("Short.", [
    {
      id: "gone-insert",
      start: 0,
      end: 5,
      original: "ins:4:Gone\n\nThis is why we built Alkuin!",
      body: "Gone\n\nThis is why we built Alkuin!",
      sender_email: "paloma@example.com",
    },
  ]);
  expect(card?.intent).toBe("insert");
  expect(card?.shareAccept).toBe(true);
  expect(card?.from).toBe(card?.to);
});

test("the margin cards are B's two changes and one note", () => {
  const owner = "Boats wait in the harbor.\n\nThe ledger stays short.\n\nLeave the light as it is.";
  const second = owner.indexOf("The ledger stays short.");
  const third = owner.indexOf("Leave the light as it is.");
  const notes = notesFromPending(owner, [
    {
      id: "one",
      start: 0,
      end: "Boats wait in the harbor.".length,
      original: "Boats wait in the harbor.",
      body: "Boats wait until morning.",
      sender_email: "b.1@example.com",
    },
    {
      id: "two",
      start: second,
      end: second + "The ledger stays short.".length,
      original: "The ledger stays short.",
      body: "The ledger runs long.",
      sender_email: "b.1@example.com",
    },
    {
      id: "note",
      start: third,
      end: third + "Leave the light as it is.".length,
      original: "Leave the light as it is.",
      body: null,
      sender_email: "b.1@example.com",
    },
  ]);
  expect(notes.map((note) => note.person)).toEqual(["B", "B", "B"]);
  expect(notes.filter((note) => note.intent === "replace")).toHaveLength(2);
  expect(notes.find((note) => note.intent === "none")).toMatchObject({
    shareAccept: false,
    proposed: "Leave the light as it is.",
  });
  expect(notes.filter((note) => note.intent === "replace").every((note) => note.shareAccept)).toBe(
    true,
  );
});

test("the ready line counts passages and notes", () => {
  expect(readyLine(2, 1)).toBe("2 passages and 1 note");
  expect(readyLine(1, 0)).toBe("1 passage");
  expect(readyLine(0, 1)).toBe("1 note");
  expect(readyLine(2, 2)).toBe("2 passages and 2 notes");
  expect(readyLine(0, 0)).toBe("");
});

test("share copy has no git words", () => {
  const banned =
    /\bgit\b|github|dirty|diff --git|\bcommit\b|\bbranch\b|\bmerge\b|\bpull\b|\bpush\b|\bconflict\b|\bremote\b|\brepository\b/i;
  for (const line of SHARE_COPY) expect(line).not.toMatch(banned);
});

function seededPairs(): { baseline: string; next: string }[] {
  const paras = [
    "The harbor stays quiet in the morning, and the boats wait by the long pier. Nobody hurries here.",
    "The ledger is in pencil, so every number can still change. Maria checks it twice before lunch.",
    "By evening the lamps come on one at a time, and the water turns the color of old brass.",
  ];
  const baseline = paras.join("\n\n");
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const pairs: { baseline: string; next: string }[] = [];
  for (let k = 0; k < 30; k++) {
    const ps = [...paras];
    const kind = rand(4);
    const at = rand(ps.length);
    if (kind === 0) {
      const words = (ps[at] ?? "").split(" ");
      words.splice(rand(words.length), 0, ["small", "grey", "late", "odd"][rand(4)] ?? "x");
      ps[at] = words.join(" ");
    } else if (kind === 1) {
      ps[at] = (ps[at] ?? "")
        .split(/(?<=\.) /)
        .slice(0, 1)
        .join(" ");
    } else if (kind === 2) {
      const other = (at + 1 + rand(ps.length - 1)) % ps.length;
      const tmp = ps[at] ?? "";
      ps[at] = ps[other] ?? "";
      ps[other] = tmp;
    } else {
      ps[at] = (ps[at] ?? "").replace(/[,.]/, rand(2) ? ";" : "!");
    }
    pairs.push({ baseline, next: ps.join("\n\n") });
  }
  return pairs;
}

test("passagesToSend output is stable across a seeded set of edits", () => {
  const results = seededPairs().map(({ baseline, next }) => passagesToSend(baseline, next, "s", 0));
  expect(results).toMatchSnapshot();
});
