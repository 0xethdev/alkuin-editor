import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { inferTitle } from "../src/lib/frontmatter";
import { SHARE_SEND_FAILED } from "../src/features/document-share/copy";
import {
  adoptHostedText,
  advanceBaseline,
  applyHostStamp,
  clearOutbox,
  ensureBaseline,
  loadOutbox,
  outboxHasUnsent,
  loadSentRefs,
  loadShare,
  memoryStore,
  rememberOpenedText,
  rememberShare,
  saveOutbox,
  saveSentRefs,
  SHARE_OUTBOX,
} from "../src/features/document-share/baseline";
import {
  attemptShareSend,
  mergeSharePlan,
  offlinePlan,
  idleHostedText,
  planSharePush,
  pendingEffects,
  realtimeJoin,
  realtimeShouldPull,
  realtimeSocketUrl,
  sendFailureText,
  sentAfterReport,
  SHARE_POLL_MS,
  SHARE_SYNC_MS,
  shouldLiveSync,
  unsettledPlan,
} from "../src/features/document-share/live";
import {
  copiesAfterDecision,
  notesFromPending,
  passagesToSend,
  placeShareChange,
  unpackComment,
  type OutgoingPassage,
} from "../src/features/document-share/place";

const footer = readFileSync(
  new URL("../src/components/editor-area/document-footer.tsx", import.meta.url),
  "utf8",
);
const live = readFileSync(
  new URL("../src/features/document-share/live.ts", import.meta.url),
  "utf8",
);

test("the opened text is the baseline, not the text auto-save wrote", () => {
  const box = memoryStore();
  const path = "/Users/ada/notes/about.md";
  rememberOpenedText(path, "The harbor stays quiet.", box);
  const baseline = ensureBaseline("share-1", path, "The harbor is quiet.", box);
  expect(baseline).toBe("The harbor stays quiet.");
  const sent = passagesToSend(baseline, "The harbor is quiet.", "share-1");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.original).toBe("The harbor stays quiet.");
  advanceBaseline("share-1", path, "The harbor is quiet.", box);
  expect(ensureBaseline("share-1", path, "later", box)).toBe("The harbor is quiet.");
});

test("a reverted paragraph is withdrawn and a saved note is sent", () => {
  const first = planSharePush({
    baseline: "The harbor stays quiet.\n\nThe ledger is in pencil.",
    next: "The harbor is quiet.\n\nThe ledger is in pencil.",
    notes: [],
    shareId: "share-harbor",
    sent: [],
  });
  expect(first.changes).toHaveLength(1);
  expect(first.withdraw).toEqual([]);
  const reverted = planSharePush({
    baseline: "The harbor stays quiet.\n\nThe ledger is in pencil.",
    next: "The harbor stays quiet.\n\nThe ledger is in pencil.",
    notes: [
      {
        from: 4,
        to: 12,
        proposed: "Leave the lamp.",
        intent: "none",
        status: "pending",
        instruction: null,
      },
    ],
    shareId: "share-harbor",
    sent: [first.changes[0]!.payloadRef],
  });
  expect(reverted.changes).toHaveLength(1);
  expect(unpackComment(reverted.changes[0]?.original ?? "")).toEqual({
    anchor: "The harbor stays quiet.\n\nThe ledger is in pencil.".slice(4, 12),
    comment: "Leave the lamp.",
  });
  expect(reverted.changes[0]?.body).toBe("");
  expect(reverted.withdraw).toEqual([first.changes[0]!.payloadRef]);
});

test("sent refs round-trip and a second edit of the same text keeps the ref", () => {
  const box = memoryStore();
  saveSentRefs("share-1", "/a.md", ["ref-a"], box);
  expect(loadSentRefs("share-1", "/a.md", box)).toEqual(["ref-a"]);
  const once = passagesToSend("Same.\n\nNext.", "Edited.\n\nNext.", "share-1");
  const twice = passagesToSend("Same.\n\nNext.", "Edited.\n\nNext.", "share-1");
  expect(once[0]?.payloadRef).toBe(twice[0]?.payloadRef);
  const again = passagesToSend("Same.\n\nNext.", "Edited again.\n\nNext.", "share-1");
  expect(again[0]?.payloadRef).not.toBe(once[0]?.payloadRef);
});

test("incoming redlines paint once and leave when the server drops them", () => {
  const doc = "The harbor stays quiet.";
  const change = {
    id: "c1",
    share_id: "s",
    start: 0,
    end: doc.length,
    original: doc,
    body: "The harbor is quiet.",
    sender_email: "ada@example.com",
  };
  const first = pendingEffects(doc, [change], []);
  expect(first.add).toHaveLength(1);
  expect(first.remove).toEqual([]);
  const painted = pendingEffects(doc, [change], first.add);
  expect(painted.add).toEqual([]);
  expect(painted.remove).toEqual([]);
  const gone = pendingEffects(doc, [], first.add);
  expect(gone.remove).toEqual([first.add[0]!.id]);
});

test("live sync waits for an accepted share and listens on the share tables", () => {
  expect(SHARE_SYNC_MS).toBe(1500);
  expect(SHARE_POLL_MS).toBeGreaterThanOrEqual(3000);
  expect(SHARE_POLL_MS).toBeLessThanOrEqual(5000);
  expect(shouldLiveSync({ role: "invitee", share_id: "s", status: "accepted" })).toBe(true);
  expect(shouldLiveSync({ role: "owner", share_id: "s", status: "pending" })).toBe(false);
  expect(shouldLiveSync({ role: "none", share_id: null, status: null })).toBe(false);
  expect(realtimeSocketUrl("https://example.supabase.co", "anon")).toBe(
    "wss://example.supabase.co/realtime/v1/websocket?apikey=anon&vsn=1.0.0",
  );
  expect(realtimeShouldPull('{"event":"postgres_changes"}')).toBe(true);
  expect(realtimeShouldPull('{"event":"heartbeat"}')).toBe(false);
  const join = realtimeJoin("share-1", "doc-1", "token");
  expect(join).toContain("document_change");
  expect(join).toContain("document_proposal");
  expect(join).toContain("note_mention");
  expect(join).toContain("share_id=eq.share-1");
});

test("a typed replacement and an Ask suggestion are changes the owner can accept", () => {
  const doc = "The harbor stays quiet.";
  const typed = {
    from: 4,
    to: 10,
    original: "harbor",
    proposed: "bay",
    intent: "replace",
    status: "pending",
    instruction: null,
  };
  const asked = {
    from: 0,
    to: doc.length,
    original: doc,
    proposed: "The bay stays quiet.",
    intent: "replace",
    status: "pending",
    instruction: "improve",
  };
  const plan = planSharePush({
    baseline: doc,
    next: doc,
    notes: [typed, asked],
    shareId: "33333333-3333-4333-8333-333333333333",
    sent: [],
    proposals: true,
  });
  expect(plan.changes.map((change) => change.body)).toEqual(["bay", "The bay stays quiet."]);
  expect(plan.changes.every((change) => change.original.length > 0)).toBe(true);
  const painted = notesFromPending(
    doc,
    plan.changes.map((change, index) => {
      const [start, end] = change.passage.split(":").map(Number);
      return {
        id: `c${index}`,
        start: start ?? 0,
        end: end ?? 0,
        original: change.original,
        body: change.body,
        sender_email: "paloma.reyes@example.com",
      };
    }),
  );
  expect(painted.map((note) => note.intent)).toEqual(["replace", "replace"]);
  expect(painted.every((note) => note.shareAccept)).toBe(true);
  const incoming = planSharePush({
    baseline: doc,
    next: doc,
    notes: [{ ...asked, shareChangeId: "already" }],
    shareId: "share-1",
    sent: [],
  });
  expect(incoming.changes).toEqual([]);
});

test("a failed send stays in the outbox, then a retry, then it sends", async () => {
  const box = memoryStore();
  const path = "/Users/paloma/Library/Application Support/app.alkuin.desktop/shares/33333333.md";
  const shareId = "33333333-3333-4333-8333-333333333333";
  const plan = planSharePush({
    baseline: "The harbor stays quiet.",
    next: "The harbor stays quiet.",
    notes: [
      {
        from: 0,
        to: 23,
        original: "The harbor stays quiet.",
        proposed: "The bay stays quiet.",
        intent: "replace",
        status: "pending",
        instruction: "improve",
      },
    ],
    shareId,
    sent: [],
  });
  expect(plan.changes).toHaveLength(1);
  let calls = 0;
  const notices: string[] = [];
  const once = async () => {
    const saved = loadOutbox(shareId, path, box);
    const merged = mergeSharePlan(plan, saved, "The harbor stays quiet.");
    const attempt = await attemptShareSend({
      plan: merged,
      persist: (next) => saveOutbox(shareId, path, next, box),
      clear: () => clearOutbox(shareId, path, box),
      send: async (sending) => {
        calls += 1;
        // The first try never reaches the app; the second reaches it while the server is down.
        if (calls === 1) throw "offline";
        if (calls === 2) return { posted: [], withdrawn: [], refused: [], error: "unreachable" };
        return {
          posted: sending.changes.map((change) => change.payloadRef),
          withdrawn: sending.withdraw,
          refused: [],
          error: null,
        };
      },
    });
    if (attempt.result === "kept") notices.push(SHARE_SEND_FAILED);
    return attempt.result;
  };
  expect(await once()).toBe("kept");
  const stored = loadOutbox(shareId, path, box);
  expect(stored.changes).toEqual(plan.changes);
  expect(box.getItem(`${SHARE_OUTBOX}:${shareId}:${path}`)).toContain("The bay stays quiet.");
  expect(await once()).toBe("kept");
  expect(loadOutbox(shareId, path, box).changes).toHaveLength(1);
  expect(await once()).toBe("sent");
  expect(loadOutbox(shareId, path, box)).toEqual({ changes: [], withdraw: [] });
  expect(notices).toEqual([SHARE_SEND_FAILED, SHARE_SEND_FAILED]);
  expect(calls).toBe(3);
});

test("the next launch sends a proposal that was still in the outbox", () => {
  const doc = "The harbor stays quiet.";
  const shareId = "share-harbor";
  const fresh = planSharePush({
    baseline: doc,
    next: doc,
    notes: [],
    shareId,
    sent: [],
  });
  expect(fresh.changes).toEqual([]);
  const saved = planSharePush({
    baseline: doc,
    next: doc,
    notes: [
      {
        from: 4,
        to: 10,
        original: "harbor",
        proposed: "bay",
        intent: "replace",
        status: "pending",
        instruction: null,
      },
    ],
    shareId,
    sent: [],
  });
  const merged = mergeSharePlan(fresh, { changes: saved.changes, withdraw: [] }, doc);
  expect(merged.changes.map((change) => change.body)).toEqual(["bay"]);
});

test("reopening a shared copy resets the baseline", () => {
  const box = memoryStore();
  const path = "/tmp/shares/11111111-1111-1111-1111-111111111111.md";
  const shareId = "11111111-1111-1111-1111-111111111111";
  const opened = "We believe writing is thinking. The rest stays.";
  const typed = "We believe writing is thinking.. The rest stays.";
  rememberOpenedText(path, opened, box);
  expect(applyHostStamp(shareId, path, opened, "stamp-1", box)).toBe(opened);
  expect(applyHostStamp(shareId, path, typed, "stamp-1", box)).toBe(opened);
  expect(applyHostStamp(shareId, path, opened, "stamp-2", box)).toBe(opened);
  expect(ensureBaseline(shareId, path, "later", box)).toBe(opened);
  expect(live).toContain("applyHostStamp");
  expect(live).toContain("hostStamp");
  const shares = readFileSync(
    new URL("../src-tauri/src/commands/shares.rs", import.meta.url),
    "utf8",
  );
  const body = (name: string) => {
    const start = shares.indexOf(`pub async fn ${name}`);
    const next = shares.indexOf("pub async fn ", start + 10);
    return shares.slice(start, next === -1 ? undefined : next);
  };
  expect(body("share_open_link")).toContain("refresh_local_copy");
  expect(body("share_open_accepted")).toContain("refresh_local_copy");
  expect(shares).toContain("fn refresh_local_copy");
  expect(shares.slice(shares.indexOf("fn refresh_local_copy"))).toContain("reset_share_baseline");
  expect(live).toContain("shareLatest");
  expect(live).toContain("adoptHostedText");
  const save = readFileSync(new URL("../src/lib/save.ts", import.meta.url), "utf8");
  expect(save).toContain("sharePublish");
});

test("an idle invitee takes the owner's text and a pending edit does not", () => {
  const doc = "We believe writing is thinking. The rest stays.";
  const latest = "We believe writing is thought. The rest stays.";
  expect(idleHostedText({ role: "invitee", doc, baseline: doc, pending: 0, latest })).toBe(latest);
  expect(
    idleHostedText({ role: "invitee", doc: latest, baseline: doc, pending: 0, latest }),
  ).toBeNull();
  expect(idleHostedText({ role: "invitee", doc, baseline: doc, pending: 1, latest })).toBeNull();
  expect(idleHostedText({ role: "owner", doc, baseline: doc, pending: 0, latest })).toBeNull();
  expect(
    idleHostedText({ role: "invitee", doc, baseline: doc, pending: 0, latest: doc }),
  ).toBeNull();
  const box = memoryStore();
  const path = "/tmp/shares/11111111-1111-1111-1111-111111111111.md";
  adoptHostedText("share-1", path, latest, box);
  expect(ensureBaseline("share-1", path, doc, box)).toBe(latest);
  expect(outboxHasUnsent(null)).toBe(false);
  expect(outboxHasUnsent(JSON.stringify({ changes: [{ payloadRef: "a" }], withdraw: [] }))).toBe(
    true,
  );
  expect(outboxHasUnsent(JSON.stringify({ changes: [], withdraw: ["a"] }))).toBe(true);
});

test("a delivered edit stays pending until the collaborator reverts it", () => {
  expect(live).not.toContain("advanceBaseline");
  const baseline = "The harbor stays quiet.\n\nFourth stays.";
  const edited = "The harbor is quiet.\n\nFourth stays.";
  const shareId = "share-harbor";
  const sent = planSharePush({ baseline, next: edited, notes: [], shareId, sent: [] });
  expect(sent.changes).toHaveLength(1);
  expect(sent.withdraw).toEqual([]);
  const ref = sent.changes[0]!.payloadRef;
  const again = planSharePush({ baseline, next: edited, notes: [], shareId, sent: [ref] });
  expect(again.withdraw).toEqual([]);
  expect(again.changes.map((change) => change.payloadRef)).toEqual([ref]);
  const reverted = planSharePush({ baseline, next: baseline, notes: [], shareId, sent: [ref] });
  expect(reverted.changes).toEqual([]);
  expect(reverted.withdraw).toEqual([ref]);
});

test("the send report settles each ref, including when the send also failed", async () => {
  expect(sendFailureText("validation_failed")).toBe("validation_failed");
  const shareId = "share-harbor";
  const note = {
    from: 0,
    to: 16,
    proposed: "Leave the lamp.",
    intent: "none" as const,
    status: "pending" as const,
    instruction: null,
  };
  const baseline = "The harbor stays quiet.";
  const next = "The harbor is quiet.";
  const plan = planSharePush({ baseline, next, notes: [note], shareId, sent: [] });
  const comment = plan.changes.find((change) => change.body === "")!;
  const edit = plan.changes.find((change) => change.body !== "")!;
  expect(edit.body).toBe("The harbor is quiet.");
  const outbox: { value: unknown } = { value: null };
  const store = {
    persist: (value: unknown) => {
      outbox.value = value;
    },
    clear: () => {
      outbox.value = "cleared";
    },
  };
  const full = { changes: plan.changes, withdraw: ["old-ref", "gone-ref"] };

  // The app never answered: nothing is settled and the whole plan stays.
  const lost = await attemptShareSend({
    plan: full,
    ...store,
    send: async () => {
      throw "offline";
    },
  });
  expect(lost).toEqual({ result: "kept", report: null, error: "offline" });
  expect(outbox.value).toEqual(full);

  // The edit landed, one withdraw landed, then the server failed. Those two
  // count; the comment and the other withdraw stay for the next try.
  const partly = await attemptShareSend({
    plan: full,
    ...store,
    send: async () => ({
      posted: [edit.payloadRef],
      withdrawn: ["old-ref"],
      refused: [],
      error: "unreachable",
    }),
  });
  expect(partly.result).toBe("kept");
  expect(partly.error).toBe("unreachable");
  expect(outbox.value).toEqual({ changes: [comment], withdraw: ["gone-ref"] });
  expect(sentAfterReport(["old-ref", "gone-ref"], partly.report!)).toEqual([
    "gone-ref",
    edit.payloadRef,
  ]);

  // The owner already decided the comment: it is refused, settled, and not sent again.
  const done = await attemptShareSend({
    plan: { changes: [comment], withdraw: ["gone-ref"] },
    ...store,
    send: async () => ({
      posted: [],
      withdrawn: ["gone-ref"],
      refused: [comment.payloadRef],
      error: null,
    }),
  });
  expect(done.result).toBe("sent");
  expect(outbox.value).toBe("cleared");
  expect(sentAfterReport(["gone-ref", edit.payloadRef, comment.payloadRef], done.report!)).toEqual([
    edit.payloadRef,
  ]);
  const retry = planSharePush({
    baseline,
    next,
    notes: [note],
    shareId,
    sent: [edit.payloadRef],
    settled: done.report!.refused,
  });
  expect(retry.changes.map((change) => change.body)).toEqual(["The harbor is quiet."]);
  expect(retry.withdraw).toEqual([]);

  // A report with no error that leaves a ref out is not a success.
  expect(
    unsettledPlan(full, { posted: [edit.payloadRef], withdrawn: [], refused: [], error: null }),
  ).toEqual({ changes: [comment], withdraw: ["old-ref", "gone-ref"] });
  const odd = await attemptShareSend({
    plan: full,
    ...store,
    send: async () => ({ posted: [edit.payloadRef], withdrawn: [], refused: [], error: null }),
  });
  expect(odd.result).toBe("kept");
  expect(live).not.toContain("generation += 1");
  expect(live).not.toContain("afterKeptSend");
});

test("an offline role lookup keeps the plan and the failure is a plain string", () => {
  const box = memoryStore();
  const path = "/Users/ada/Library/Application Support/app.alkuin.desktop/shares/harbor.md";
  const shareId = "share-harbor";
  rememberShare(shareId, path, "invitee", box);
  expect(loadShare(path, box)).toEqual({ shareId, role: "invitee" });
  const plan = offlinePlan({
    baseline: "The harbor stays quiet.",
    next: "The harbor is quiet.",
    notes: [],
    shareId,
    sent: [],
    saved: { changes: [], withdraw: [] },
    proposals: true,
  });
  expect(plan.changes[0]?.body).toBe("The harbor is quiet.");
  saveOutbox(shareId, path, plan, box);
  expect(loadOutbox(shareId, path, box).changes).toHaveLength(1);
  // A failed role lookup plans on this Mac, writes the outbox, and counts as a
  // failed send, which shows the line and schedules the next try.
  expect(live).toContain("if (!raw) return keepOffline(session, closes);");
  const offlineAt = live.indexOf("async function keepOffline");
  const offline = live.slice(offlineAt, live.indexOf("\n}\n", offlineAt));
  expect(offline).toContain("planFor(");
  expect(offline).toContain("saveOutbox(");
  expect(offline).toContain('return "failed";');
  expect(sendFailureText("unreachable").includes("validation_failed")).toBe(false);
});

test("the owner's card anchors on the original sentence, not the collaborator's offsets", () => {
  const owner = "# Harbor\n\nA paragraph for a suggested wording.\n\nFourth stays.";
  const original = "A paragraph for a suggested wording.";
  const stale = owner.indexOf("agraph");
  const end = stale + "agraph for a suggested wording.\n\nFourth ".length;
  const [card] = notesFromPending(owner, [
    {
      id: "c1",
      start: stale,
      end,
      original,
      body: "A clearer paragraph.",
      sender_email: "ada@example.com",
    },
  ]);
  expect(card?.intent).toBe("replace");
  expect(card?.original).toBe(original);
  expect(card?.from).toBe(owner.indexOf(original));
  expect(owner.slice(card!.from, card!.to)).toBe(original);
  const [missing] = notesFromPending("Fourth stays.", [
    {
      id: "c2",
      start: 0,
      end: "Fourth".length,
      original,
      body: "A clearer paragraph.",
      sender_email: "ada@example.com",
    },
  ]);
  expect(missing?.intent).toBe("replace");
  expect(missing?.shareStale).toBe(true);
  expect(missing?.shareAccept).toBe(false);
  expect(missing?.from).toBe(missing?.to);
});

test("a longer title does not withdraw a pending edit or mint new ids", () => {
  const opening = "Opening lines stay exactly where the note was left by the writer today. Extra.";
  const marked = "Suggest a clearer wording for this line.";
  const fourth = "The fourth paragraph is.";
  const fourthNow = "The fourth line was cut.";
  const suggested = "A clearer wording for this line.";
  const comment = "Leave the lamp.";
  expect(opening).toHaveLength(78);
  expect(marked).toHaveLength(40);
  expect(fourth).toHaveLength(24);
  expect(fourthNow).toHaveLength(24);
  const shareId = "share-harbor";
  const baseline = ["# Field log", opening, marked, fourth].join("\n\n");
  const shared = ["# Field log", opening, marked, fourthNow].join("\n\n");
  const retitled = ["# Field log (reopen)", opening, marked, fourthNow].join("\n\n");
  expect("# Field log (reopen)".length - "# Field log".length).toBe(9);
  const proposal = {
    original: marked,
    proposed: suggested,
    intent: "replace" as const,
    status: "pending" as const,
    instruction: null,
  };
  const note = {
    proposed: comment,
    intent: "none" as const,
    status: "pending" as const,
    instruction: null,
  };
  const first = planSharePush({
    baseline,
    next: shared,
    notes: [
      { ...proposal, from: 93, to: 133 },
      { ...note, from: 13, to: 13 + opening.length },
    ],
    shareId,
    sent: [],
  });
  expect(first.changes.map((change) => change.passage)).toEqual([
    "146:159",
    "93:133",
    `13:${13 + opening.length}`,
  ]);
  expect(first.withdraw).toEqual([]);
  const paragraph = first.changes.find((change) => change.body === "line was cut.");
  const suggestion = first.changes.find((change) => change.body === suggested);
  const margin = first.changes.find((change) => change.body === "");
  expect(paragraph?.payloadRef).toContain("-146-");
  expect(suggestion?.payloadRef.includes("-93-")).toBe(false);
  expect(margin?.payloadRef.includes("-note-13")).toBe(false);
  const second = planSharePush({
    baseline,
    next: retitled,
    notes: [
      { ...proposal, from: 102, to: 142 },
      { ...note, from: 22, to: 22 + opening.length },
    ],
    shareId,
    sent: first.changes.map((change) => change.payloadRef),
  });
  expect(second.withdraw).toEqual([]);
  expect(second.changes.map((change) => change.passage)).toEqual([
    "8:11",
    "146:159",
    "102:142",
    `22:${22 + opening.length}`,
  ]);
  expect(second.changes.find((change) => change.body === "line was cut.")?.payloadRef).toBe(
    paragraph?.payloadRef,
  );
  expect(second.changes.find((change) => change.body === suggested)?.payloadRef).toBe(
    suggestion?.payloadRef,
  );
  expect(second.changes.find((change) => change.body === "")?.payloadRef).toBe(margin?.payloadRef);
  const owner = retitled.replace("# Field log (reopen)", "# Field log (reopen) now");
  const [card] = notesFromPending(owner, [
    {
      id: "c-note",
      start: 13,
      end: 13 + opening.length,
      original: margin?.original ?? "",
      body: null,
      sender_email: "ada@example.com",
    },
  ]);
  expect(card?.intent).toBe("none");
  expect(card?.shareAccept).toBe(false);
  expect(card?.proposed).toBe(comment);
  expect(card?.from).toBe(owner.indexOf(opening));
  expect(owner.slice(card!.from, card!.to)).toBe(opening);
  expect(card?.from).not.toBe(13);
});

test("a proposal that covers a paragraph edit is the only change sent", () => {
  const baseline = "Alpha.\n\nBeta stays.";
  const next = "Alpha.\n\nBeta moves.";
  const from = next.indexOf("Beta moves.");
  const plan = planSharePush({
    baseline,
    next,
    notes: [
      {
        from,
        to: from + "Beta moves.".length,
        original: "Beta stays.",
        proposed: "Beta moves.",
        intent: "replace",
        status: "pending",
        instruction: null,
      },
    ],
    shareId: "share-harbor",
    sent: [],
  });
  expect(plan.changes.map((change) => change.body)).toEqual(["Beta moves."]);
  expect(plan.withdraw).toEqual([]);
});

const essayHeading = "# Writing as Thinking";
const essayBody =
  "we believe to write is think and that therefore good writing is good thinking. and given you wouldn't outsource your thinking, why would you ever outsource your writing?";
const essayClause = "to write is think";
const essayRewrite = "that writing is thinking";
const essayParagraph = "This is why we built Alkuin!";
const essayNote = "we need to find better phrasing here";

function decided(owner: string, change: OutgoingPassage, accept: boolean): string {
  const [start, end] = change.passage.split(":").map(Number);
  const placed = placeShareChange(owner, {
    id: change.payloadRef,
    start: start ?? 0,
    end: end ?? 0,
    original: change.original,
    proposed: change.body ? change.body : null,
    sender: "Paloma",
  });
  return copiesAfterDecision(owner, owner, placed, accept).owner;
}

function paintOne(owner: string, change: OutgoingPassage, snapshot?: string) {
  const [start, end] = change.passage.split(":").map(Number);
  const [card] = notesFromPending(owner, [
    {
      id: "prop-1",
      start: start ?? 0,
      end: end ?? 0,
      original: change.original,
      body: change.body ? change.body : null,
      sender_email: "paloma@example.com",
      snapshot: snapshot ?? null,
    },
  ]);
  return card;
}

test("an accepted Ask suggestion stays the card the owner decides", () => {
  const baseline = `${essayHeading}\n\n${essayBody}`;
  const from = baseline.indexOf(essayClause);
  const to = from + essayClause.length;
  const shareId = "33333333-3333-4333-8333-333333333333";
  const pending = {
    from,
    to,
    original: essayClause,
    proposed: essayRewrite,
    intent: "replace" as const,
    status: "pending" as const,
    instruction: "improve",
  };
  const before = planSharePush({ baseline, next: baseline, notes: [pending], shareId, sent: [] });
  expect(before.changes).toHaveLength(1);
  expect(before.withdraw).toEqual([]);
  const ref = before.changes[0]!.payloadRef;
  const next = baseline.replace(essayClause, essayRewrite);
  const lamp = "The lamp stays.";
  const moved = "The lamp moved.";
  const withLamp = `${next}\n\n${lamp}`;
  const typed = withLamp.replace(lamp, moved);
  const accepted = {
    ...pending,
    status: "accepted" as const,
    from,
    to: from + essayRewrite.length,
  };
  const after = planSharePush({
    baseline: `${baseline}\n\n${lamp}`,
    next: typed,
    notes: [accepted],
    shareId,
    sent: [ref],
  });
  expect(after.withdraw).toEqual([]);
  const suggestion = after.changes.find((change) => change.payloadRef === ref);
  const typedEdit = after.changes.find((change) => change.body === "moved.");
  expect(suggestion).toMatchObject({
    original: essayClause,
    body: essayRewrite,
    passage: `${from}:${to}`,
  });
  expect(typedEdit?.payloadRef).not.toBe(ref);
  expect(after.changes.filter((change) => change.original === essayClause)).toHaveLength(1);
  const owner = `---\ntitle: Essay\n---\n${baseline}`;
  const card = paintOne(owner, suggestion!, baseline);
  expect(card).toMatchObject({
    intent: "replace",
    shareAccept: true,
    original: essayClause,
    proposed: essayRewrite,
  });
  expect(owner.slice(card!.from, card!.to)).toBe(essayClause);
  expect(card!.from).not.toBe(from);
  expect(decided(owner, suggestion!, true)).toBe(owner.replace(essayClause, essayRewrite));
  expect(decided(owner, suggestion!, false)).toBe(owner);
  const lampDoc = `${baseline}\n\n${lamp}`;
  const lampCard = paintOne(lampDoc, typedEdit!, lampDoc);
  expect(lampCard).toMatchObject({ intent: "replace", shareAccept: true });
  expect(decided(lampDoc, typedEdit!, true)).toContain(moved);
  expect(decided(lampDoc, typedEdit!, false)).toBe(lampDoc);
  const tweaked = "that writing is thought";
  const tweakedDoc = baseline.replace(essayClause, tweaked);
  const released = planSharePush({
    baseline,
    next: tweakedDoc,
    notes: [{ ...accepted, to: from + tweaked.length }],
    shareId,
    sent: [ref],
  });
  expect(released.changes.some((change) => change.payloadRef === ref)).toBe(false);
  expect(released.withdraw).toEqual([ref]);
  expect(released.changes[0]?.body).toBe(tweaked);
});

test("an accepted Ask insertion stays an insertion the owner can decide", () => {
  const baseline = `${essayHeading}\n\n${essayBody}`;
  const from = baseline.indexOf(essayClause);
  const to = from + essayClause.length;
  const inserted = " — a real claim";
  const shareId = "33333333-3333-4333-8333-333333333333";
  const pending = {
    from,
    to,
    original: essayClause,
    proposed: inserted,
    intent: "insert" as const,
    status: "pending" as const,
    instruction: "add a claim",
  };
  const before = planSharePush({ baseline, next: baseline, notes: [pending], shareId, sent: [] });
  expect(before.changes).toHaveLength(1);
  expect(before.withdraw).toEqual([]);
  const change = before.changes[0]!;
  expect(change.original.startsWith(`ins:${essayClause.length}:`)).toBe(true);
  expect(change.body).toBe(essayClause + inserted);
  expect(baseline.slice(...(change.passage.split(":").map(Number) as [number, number]))).toBe(
    essayClause,
  );
  const next = baseline.slice(0, to) + inserted + baseline.slice(to);
  const after = planSharePush({
    baseline,
    next,
    notes: [{ ...pending, status: "accepted" as const, to: to + inserted.length }],
    shareId,
    sent: [change.payloadRef],
  });
  expect(after.withdraw).toEqual([]);
  expect(after.changes.map((item) => item.payloadRef)).toEqual([change.payloadRef]);
  const owner = `---\ntitle: Essay\n---\n${baseline}`;
  const card = paintOne(owner, after.changes[0]!, baseline);
  expect(card).toMatchObject({ intent: "insert", shareAccept: true, proposed: inserted });
  expect(card?.from).toBe(card?.to);
  expect(owner.slice(0, card!.from).endsWith(essayClause)).toBe(true);
  const applied = decided(owner, after.changes[0]!, true);
  expect(applied).toContain(`${essayClause}${inserted}`);
  expect(applied).toContain("good writing is good thinking");
  expect(decided(owner, after.changes[0]!, false)).toBe(owner);
  expect(decided(baseline, after.changes[0]!, true)).toBe(next);
});

test("the token diff of an accepted Ask suggestion is not a second card", () => {
  const shareId = "33333333-3333-4333-8333-333333333333";
  const shortDoc = "we believe to write is think and that therefore good writing is good thinking.";
  const shortFrom = shortDoc.indexOf(essayClause);
  const shortNext = shortDoc.replace(essayClause, "think");
  const short = planSharePush({
    baseline: shortDoc,
    next: shortNext,
    notes: [
      {
        from: shortFrom,
        to: shortFrom + "think".length,
        original: essayClause,
        proposed: "think",
        intent: "replace",
        status: "accepted",
        instruction: "shorter",
      },
    ],
    shareId,
    sent: [],
  });
  expect(short.changes).toHaveLength(1);
  expect(short.changes[0]).toMatchObject({ original: essayClause, body: "think" });
  const shortOwner = `---\ntitle: Essay\n---\n${shortDoc}`;
  const shortCard = paintOne(shortOwner, short.changes[0]!, shortDoc);
  expect(shortCard).toMatchObject({ intent: "replace", shareAccept: true, proposed: "think" });
  expect(decided(shortOwner, short.changes[0]!, true)).toBe(
    shortOwner.replace(essayClause, "think"),
  );
  expect(decided(shortOwner, short.changes[0]!, false)).toBe(shortOwner);

  const paragraph = "Alpha.\n\nBeta stays here.\n\nGamma.";
  const sentence = "Beta stays here.";
  const added = "\n\nA new paragraph.";
  const at = paragraph.indexOf(sentence);
  const inserted =
    paragraph.slice(0, at + sentence.length) + added + paragraph.slice(at + sentence.length);
  const insertPlan = planSharePush({
    baseline: paragraph,
    next: inserted,
    notes: [
      {
        from: at,
        to: at + sentence.length + added.length,
        original: sentence,
        proposed: added,
        intent: "insert",
        status: "accepted",
        instruction: "add a paragraph",
      },
    ],
    shareId,
    sent: [],
  });
  expect(insertPlan.changes).toHaveLength(1);
  expect(insertPlan.changes[0]?.original.startsWith(`ins:${sentence.length}:`)).toBe(true);
  const insertOwner = `---\ntitle: Essay\n---\n${paragraph}`;
  const insertCard = paintOne(insertOwner, insertPlan.changes[0]!, paragraph);
  expect(insertCard).toMatchObject({ intent: "insert", shareAccept: true, proposed: added });
  expect(decided(insertOwner, insertPlan.changes[0]!, true)).toContain(`${sentence}${added}`);
  expect(decided(insertOwner, insertPlan.changes[0]!, false)).toBe(insertOwner);

  const baseline = `${essayHeading}\n\n${essayBody}`;
  const repeated = essayBody.replace(essayClause, essayRewrite);
  const from = baseline.indexOf(essayClause);
  const repeatedNext =
    baseline.slice(0, from) + repeated + baseline.slice(from + essayClause.length);
  const repeatedPlan = planSharePush({
    baseline,
    next: repeatedNext,
    notes: [
      {
        from,
        to: from + repeated.length,
        original: essayClause,
        proposed: repeated,
        intent: "replace",
        status: "accepted",
        instruction: "improve",
      },
    ],
    shareId,
    sent: [],
  });
  expect(repeatedPlan.changes.map((change) => change.original)).toEqual([essayClause]);
  const owner = `---\ntitle: Essay\n---\n${baseline}`;
  const card = paintOne(owner, repeatedPlan.changes[0]!, baseline);
  expect(card).toMatchObject({ intent: "replace", shareAccept: true });
  expect(decided(owner, repeatedPlan.changes[0]!, true)).toBe(owner.replace(essayClause, repeated));
  expect(decided(owner, repeatedPlan.changes[0]!, false)).toBe(owner);

  const lamp = "The lamp stays.";
  const beside = planSharePush({
    baseline: `${baseline}\n\n${lamp}`,
    next: `${repeatedNext}\n\nThe lamp moved.`,
    notes: [
      {
        from,
        to: from + repeated.length,
        original: essayClause,
        proposed: repeated,
        intent: "replace",
        status: "accepted",
        instruction: "improve",
      },
    ],
    shareId,
    sent: [],
  });
  expect(beside.changes.some((change) => change.body === "moved.")).toBe(true);
  expect(beside.changes.some((change) => change.original === essayClause)).toBe(true);
});

test("Paloma's accepted sentence, typed paragraph, and note arrive as three cards", () => {
  const baseline = `${essayHeading}\n\n${essayBody}`;
  const rewritten = essayBody.replace(essayClause, essayRewrite);
  const next = `${essayHeading}\n\n${rewritten}\n\n${essayParagraph}`;
  const marked = "good writing is good thinking";
  const from = next.indexOf(marked);
  const plan = planSharePush({
    baseline,
    next,
    notes: [
      {
        from,
        to: from + marked.length,
        proposed: essayNote,
        intent: "none",
        status: "pending",
        instruction: null,
      },
    ],
    shareId: "share-alkuin",
    sent: [],
  });
  expect(plan.changes).toHaveLength(3);
  for (const change of plan.changes) {
    expect(change.original).not.toBe(baseline);
    expect(change.body).not.toBe(next);
    const whole =
      change.original.includes(essayHeading) && change.original.includes("outsource your writing");
    const wholeBody =
      change.body.includes(essayHeading) && change.body.includes("outsource your writing");
    expect(whole).toBe(false);
    expect(wholeBody).toBe(false);
  }
  const replacement = plan.changes.find(
    (change) => change.original === essayClause && change.body === essayRewrite,
  );
  const insertion = plan.changes.find(
    (change) => change.original.startsWith("ins:") || change.original.startsWith("ins-before:"),
  );
  const comment = plan.changes.find((change) => change.body === "");
  expect(replacement?.passage.startsWith("0:")).toBe(false);
  expect(insertion).toBeTruthy();
  expect(unpackComment(comment?.original ?? "")?.comment).toBe(essayNote);
  const painted = notesFromPending(
    baseline,
    plan.changes.map((change, index) => {
      const [start, end] = change.passage.split(":").map(Number);
      return {
        id: `c${index}`,
        start: start ?? 0,
        end: end ?? 0,
        original: change.original,
        body: change.body ? change.body : null,
        sender_email: "paloma@example.com",
      };
    }),
  );
  const sentence = painted.find((note) => note.intent === "replace");
  const paragraph = painted.find((note) => note.intent === "insert");
  const note = painted.find((note) => note.intent === "none");
  expect(sentence?.intent).toBe("replace");
  expect(paragraph?.intent).toBe("insert");
  expect(note?.intent).toBe("none");
  expect(sentence).toMatchObject({
    shareAccept: true,
    original: essayClause,
    proposed: essayRewrite,
  });
  expect(sentence && sentence.from < sentence.to).toBe(true);
  expect(paragraph).toMatchObject({ shareAccept: true });
  expect(paragraph?.from).toBe(paragraph?.to);
  expect(paragraph?.proposed?.trim()).toBe(essayParagraph);
  expect(note).toMatchObject({ shareAccept: false, proposed: essayNote });
  expect(decided(baseline, replacement!, true)).toBe(`${essayHeading}\n\n${rewritten}`);
  expect(decided(baseline, replacement!, false)).toBe(baseline);
  const insertedOnly = decided(baseline, insertion!, true);
  expect(insertedOnly.startsWith(`${essayHeading}\n\n`)).toBe(true);
  expect(insertedOnly).toContain(essayClause);
  expect(insertedOnly).toContain(essayParagraph);
  expect(insertedOnly).not.toContain(essayRewrite);
  expect(decided(baseline, insertion!, false)).toBe(baseline);
  expect(decided(baseline, comment!, true)).toBe(baseline);
  expect(decided(`${essayHeading}\n\n${rewritten}`, insertion!, true)).toBe(next);

  const tight = `${essayHeading}\n${essayBody}`;
  const tightNext = `${essayHeading}\n${rewritten}\n\n${essayParagraph}`;
  const tightPlan = passagesToSend(tight, tightNext, "share-alkuin");
  expect(tightPlan.map((change) => change.body)).toContain(essayRewrite);
  expect(tightPlan.some((change) => change.original.startsWith("ins"))).toBe(true);
  expect(
    tightPlan.some((change) => change.original === tight || change.body.includes(essayHeading)),
  ).toBe(false);
});

test("a word edit and a heading edit stay separate redlines", () => {
  const baseline = `${essayHeading}\n\n${essayBody}`;
  const next = baseline
    .replace(essayHeading, "# Writing as Thought")
    .replace(essayClause, "to write is thinking");
  const plan = planSharePush({
    baseline,
    next,
    notes: [],
    shareId: "share-alkuin",
    sent: [],
  });
  expect(plan.changes).toHaveLength(2);
  const heading = plan.changes.find((change) => change.original === "Thinking");
  const word = plan.changes.find((change) => change.original === "think");
  expect(heading?.body).toBe("Thought");
  expect(word?.body).toBe("thinking");
  expect(heading?.original.includes(essayBody)).toBe(false);
  expect(word?.original.includes(essayHeading)).toBe(false);
  const painted = notesFromPending(
    baseline,
    plan.changes.map((change, index) => {
      const [start, end] = change.passage.split(":").map(Number);
      return {
        id: `w${index}`,
        start: start ?? 0,
        end: end ?? 0,
        original: change.original,
        body: change.body,
        sender_email: "paloma@example.com",
      };
    }),
  );
  expect(painted.every((note) => note.intent === "replace" && note.shareAccept)).toBe(true);
  expect(new Set(painted.map((note) => `${note.from}:${note.to}`)).size).toBe(2);
  const afterHeading = decided(baseline, heading!, true);
  expect(afterHeading.startsWith("# Writing as Thought\n\n")).toBe(true);
  expect(afterHeading).toContain(essayClause);
  expect(afterHeading).not.toContain("to write is thinking");
  expect(decided(afterHeading, word!, false)).toBe(afterHeading);
  const afterWord = decided(afterHeading, word!, true);
  expect(afterWord).toBe(next);
  expect(decided(baseline, word!, true)).toContain(essayHeading);
  expect(decided(baseline, word!, true)).not.toContain("# Writing as Thought");
});

test("the heading is the title and the footer has no send button", () => {
  expect(inferTitle("# **About**\n\nBody", null).title).toBe("About");
  expect(inferTitle("# The *harbor*\n", null).title).toBe("The harbor");
  expect(inferTitle("Just a paragraph.", null).title).toBe("");
  expect(footer).not.toContain("SendChangesControl");
  expect(footer).not.toContain("SEND_CHANGES");
  expect(live).toMatch(/shareSendReport\([\s\S]*plan\.withdraw,\s*baseline,/);
});

test("a save in flight cancels the idle refresh before the owner's text is adopted", () => {
  // Typing during the read or the write is covered in share-receive.test.ts.
  const refresh = live.slice(
    live.indexOf("async function refreshIdleCopy"),
    live.indexOf("function paintPending"),
  );
  const saving = refresh.indexOf("isSaveActive(path)");
  expect(saving).toBeGreaterThan(-1);
  expect(saving).toBeLessThan(refresh.indexOf("adoptHostedText(shareId, path, next)"));
});

test("the Realtime token is asked for the share the socket joins", () => {
  expect(live).toContain("tauri.shareRealtimeAuth(access.shareId)");
});
