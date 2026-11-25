import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import {
  afterSendOutcome,
  createSendQueue,
  SHARE_RETRY_MS,
  type SendDecision,
  type SendOutcome,
} from "../src/features/document-share/send-queue";
import { blockedSendLine } from "../src/features/document-share/live";
import { SHARE_SEND_FULL } from "../src/features/document-share/copy";
import { copyIsPlain } from "../src/lib/keep-on-mac";

const live = readFileSync(
  new URL("../src/features/document-share/live.ts", import.meta.url),
  "utf8",
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((done) => setTimeout(done, 0));

const FAILED = "Couldn't send this change.";
const FULL = "The owner has too many changes to answer.";

test("retries never stop while the document is open, and the line shows once", () => {
  let state: { failures: number; notice: string | null } = { failures: 0, notice: null };
  const delays: (number | null)[] = [];
  const notices: SendDecision["notice"][] = [];
  for (let i = 0; i < 5; i += 1) {
    const next = afterSendOutcome(state, { outcome: "failed" }, FAILED);
    delays.push(next.retryIn);
    notices.push(next.notice);
    state = { failures: next.failures, notice: next.notice ?? state.notice };
  }
  // The old pipeline stopped after three tries while the line still said "will keep trying".
  expect(delays).toEqual([2000, 8000, 30000, 30000, 30000]);
  expect(SHARE_RETRY_MS.at(-1)).toBe(30000);
  expect(notices).toEqual([FAILED, undefined, undefined, undefined, undefined]);
  expect(afterSendOutcome(state, { outcome: "sent" }, FAILED)).toEqual({
    failures: 0,
    notice: null,
    retryIn: null,
    cancelRetry: true,
  });
  expect(afterSendOutcome(state, { outcome: "empty" }, FAILED).notice).toBeNull();
  expect(
    afterSendOutcome({ failures: 0, notice: null }, { outcome: "sent" }, FAILED),
  ).not.toHaveProperty("notice");
  expect(afterSendOutcome(state, { outcome: "stopped" }, FAILED)).toEqual({
    failures: state.failures,
    retryIn: null,
    cancelRetry: false,
  });
});

test("a refusal waiting cannot fix says why and sets no timer", () => {
  const after = afterSendOutcome(
    { failures: 2, notice: FAILED },
    { outcome: "blocked", line: FULL },
    FAILED,
  );
  // Honest line, no retry, and any retry already waiting is dropped.
  expect(after).toEqual({ failures: 0, notice: FULL, retryIn: null, cancelRetry: true });
  // The same refusal on the next edit does not show the line again.
  expect(
    afterSendOutcome({ failures: 0, notice: FULL }, { outcome: "blocked", line: FULL }, FAILED),
  ).toEqual({ failures: 0, retryIn: null, cancelRetry: true });
  // A transient failure after it goes back to the backoff and its own line.
  expect(afterSendOutcome({ failures: 0, notice: FULL }, { outcome: "failed" }, FAILED)).toEqual({
    failures: 1,
    notice: FAILED,
    retryIn: 2000,
    cancelRetry: false,
  });
  expect(blockedSendLine("This document stays on this Mac, so Alkuin didn't share it.")).toBe(
    "This document stays on this Mac, so Alkuin didn't share it.",
  );
  expect(blockedSendLine("send_cap")).toBe(SHARE_SEND_FULL);
  expect(blockedSendLine("change_cap")).toBe(SHARE_SEND_FULL);
  expect(blockedSendLine("unreachable")).toBeNull();
  expect(blockedSendLine(new Error("unauthorized"))).toBeNull();
  expect(copyIsPlain(SHARE_SEND_FULL)).toBe(true);
});

function harness() {
  let session: { id: number } | null = { id: 1 };
  let running = 0;
  let most = 0;
  const calls: number[] = [];
  const pending: { resolve: (outcome: SendOutcome) => void }[] = [];
  const settled: { session: { id: number } | null; decision: SendDecision }[] = [];
  const errors: unknown[] = [];
  const queue = createSendQueue<{ id: number }>({
    session: () => session,
    send: async (current) => {
      calls.push(current.id);
      running += 1;
      most = Math.max(most, running);
      const gate = deferred<SendOutcome>();
      pending.push(gate);
      const outcome = await gate.promise;
      running -= 1;
      if (outcome === ("throw" as SendOutcome)) throw new Error("boom");
      return outcome;
    },
    failedLine: FAILED,
    settle: (_path, current, _state, decision) => settled.push({ session: current, decision }),
    error: (_path, error) => errors.push(error),
  });
  return {
    queue,
    calls,
    pending,
    settled,
    errors,
    most: () => most,
    reopen: (id: number | null) => {
      session = id == null ? null : { id };
    },
  };
}

test("a send asked for during a send is queued once, and sends never overlap", async () => {
  const h = harness();
  void h.queue.run("/a.md");
  void h.queue.run("/a.md");
  void h.queue.run("/a.md");
  await tick();
  expect(h.calls).toEqual([1]);
  h.pending[0]!.resolve("sent");
  await tick();
  expect(h.calls).toEqual([1, 1]);
  h.pending[1]!.resolve("sent");
  await tick();
  expect(h.calls).toEqual([1, 1]);
  expect(h.most()).toBe(1);
  expect(h.queue.stateFor("/a.md").phase).toBe("idle");
});

test("a send asked for during an idle refresh runs after it, not never", async () => {
  const h = harness();
  const refresh = deferred<boolean>();
  const done = h.queue.exclusive("/a.md", () => refresh.promise, "busy" as const);
  void h.queue.run("/a.md");
  await tick();
  expect(h.calls).toEqual([]);
  refresh.resolve(true);
  expect(await done).toBe(true);
  await tick();
  expect(h.calls).toEqual([1]);
  h.pending[0]!.resolve("empty");
  await tick();
  // A refresh while a send holds the lock does not run at all.
  void h.queue.run("/a.md");
  await tick();
  let ran = false;
  expect(
    await h.queue.exclusive(
      "/a.md",
      async () => {
        ran = true;
        return true;
      },
      "busy" as const,
    ),
  ).toBe("busy");
  expect(ran).toBe(false);
  h.pending[1]!.resolve("sent");
  await tick();
});

test("a remount mid-send keeps one send, and the new session sends next", async () => {
  const h = harness();
  void h.queue.run("/a.md");
  await tick();
  h.reopen(2);
  void h.queue.run("/a.md");
  h.pending[0]!.resolve("failed");
  await tick();
  // The old attempt's failure moves the counter but schedules nothing for a closed session.
  expect(h.settled[0]).toEqual({
    session: null,
    decision: { failures: 1, notice: FAILED, retryIn: 2000, cancelRetry: false },
  });
  expect(h.calls).toEqual([1, 2]);
  expect(h.most()).toBe(1);
  h.pending[1]!.resolve("sent");
  await tick();
  expect(h.settled[1]?.session).toEqual({ id: 2 });
  expect(h.queue.stateFor("/a.md").failures).toBe(0);
});

test("a thrown send is a failed attempt, and a closed document stops the queue", async () => {
  const h = harness();
  void h.queue.run("/b.md");
  await tick();
  h.pending[0]!.resolve("throw" as SendOutcome);
  await tick();
  expect(h.errors).toHaveLength(1);
  expect(h.settled[0]?.decision.retryIn).toBe(2000);
  h.reopen(null);
  void h.queue.run("/b.md");
  await tick();
  expect(h.calls).toEqual([1]);
});

test("the pipeline has one listener per view, a per-document notice, and no module flag", () => {
  expect(live).not.toContain("let lastNotice");
  expect(live).not.toContain("retryN");
  expect(live).toContain("const viewSubscribers = new WeakMap");
  // The session re-checks itself after each await in the send.
  const sendAt = live.indexOf("async function sendOnce");
  const send = live.slice(sendAt, live.indexOf("\n}\n", sendAt));
  expect(send.match(/await /g)?.length).toBeGreaterThanOrEqual(3);
  expect(send.match(/if \(!alive\(session\) \|\| !open\(\)\) return "stopped";/g)?.length).toBe(2);
});
