import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vite-plus/test";
import {
  REALTIME_JOIN_REF,
  realtimeJoin,
  realtimeSignal,
  removesIncomingCard,
} from "../src/features/document-share/live";
import {
  addRedlineNote,
  redlineNotesField,
  removeRedlineNote,
} from "../src/features/redline-spike/notes";
import type { RedlineNote } from "../src/features/redline-spike/model";

const live = readFileSync(
  new URL("../src/features/document-share/live.ts", import.meta.url),
  "utf8",
);

function body(name: string): string {
  const at = live.indexOf(name);
  return live.slice(at, live.indexOf("\n}\n", at));
}

const card: RedlineNote = {
  id: "c1",
  from: 4,
  to: 10,
  original: "harbor",
  proposed: "bay",
  intent: "replace",
  instruction: "bay",
  status: "pending",
  error: null,
  git: null,
  publish: null,
  shareChangeId: "c1",
};

test("a Reject or Dismiss of an incoming card is told apart from other margin changes", () => {
  const start = EditorState.create({
    doc: "The harbor stays quiet.",
    extensions: [redlineNotesField],
  });
  const painted = start.update({ effects: addRedlineNote.of(card) });
  expect(removesIncomingCard(painted)).toBe(false);
  const own = { ...card, id: "n1", from: 11, to: 16, shareChangeId: undefined };
  const withOwn = painted.state.update({ effects: addRedlineNote.of(own) });
  expect(removesIncomingCard(withOwn.state.update({ effects: removeRedlineNote.of("n1") }))).toBe(
    false,
  );
  expect(removesIncomingCard(withOwn.state.update({ effects: removeRedlineNote.of("c1") }))).toBe(
    true,
  );
});

test("the idle refresh re-checks the text after each await and waits for notes", () => {
  const refresh = body("async function refreshIdleCopy");
  expect(refresh).toContain("if (hasOwnNotes(view)) return false;");
  expect(refresh).toContain("sendQueue.exclusive(");
  // shareLatest, then writeFile: the text and the notes are checked after each.
  expect(refresh.match(/if \(!unchanged\(\) \|\| hasOwnNotes\(view\)/g)).toHaveLength(2);
  const writeAt = refresh.indexOf("await tauri.writeFile");
  const rollback = refresh.indexOf("adoptHostedText(shareId, path, baseline);", writeAt + 40);
  expect(rollback).toBeGreaterThan(writeAt);
  expect(refresh.indexOf("reloadFromDisk(path, raw)")).toBeGreaterThan(rollback);
});

test("pulls are ordered, and the socket follows role, sign-out and account changes", () => {
  const pull = body("async function pull(");
  expect(pull).toContain("const seq = session.pullSeq;");
  expect(pull.match(/if \(stale\(\)\) return;/g)?.length).toBeGreaterThanOrEqual(3);
  expect(pull).toContain("closeSocket(session)");
  const open = body("async function openSocket(");
  // The old code returned before closing the previous socket.
  expect(open.indexOf("closeSocket(session);")).toBeLessThan(open.indexOf("await "));
  expect(open).toContain("ws.onclose = () => socketDropped(session, seq);");
  expect(open).toContain("ws.onerror = () => socketDropped(session, seq);");
  const hook = body("export function useShareLive(");
  const signedOut = hook.slice(hook.indexOf('event === "signed-out"'));
  expect(signedOut.slice(0, 200)).toContain("closeSocket(session);");
  expect(hook).toContain("closeSocket(session);\n      releaseNotice(");
});

test("an expired token or a closed channel is a drop, not a quiet open socket", () => {
  const topic = "realtime:share:share-1";
  const join = JSON.parse(realtimeJoin("share-1", "doc-1", "token", REALTIME_JOIN_REF)) as {
    topic: string;
    ref: string;
  };
  expect(join.topic).toBe(topic);
  const frame = (body: object) => JSON.stringify(body);
  expect(realtimeSignal(frame({ event: "postgres_changes", topic }), topic, "1")).toBe("pull");
  expect(
    realtimeSignal(
      frame({ event: "phx_reply", topic, ref: join.ref, payload: { status: "ok" } }),
      topic,
      join.ref,
    ),
  ).toBe("joined");
  expect(
    realtimeSignal(
      frame({ event: "phx_reply", topic, ref: join.ref, payload: { status: "error" } }),
      topic,
      join.ref,
    ),
  ).toBe("dropped");
  // What Supabase sends when the access token runs out, then the close.
  expect(
    realtimeSignal(
      frame({
        event: "system",
        topic,
        payload: { status: "error", message: "Token has expired 0 seconds ago" },
      }),
      topic,
      "1",
    ),
  ).toBe("dropped");
  expect(realtimeSignal(frame({ event: "phx_close", topic, payload: {} }), topic, "1")).toBe(
    "dropped",
  );
  expect(realtimeSignal(frame({ event: "phx_error", topic, payload: {} }), topic, "1")).toBe(
    "dropped",
  );
  // A heartbeat reply, another topic, a subscription notice: nothing to do.
  expect(
    realtimeSignal(
      frame({ event: "phx_reply", topic: "phoenix", ref: "2", payload: { status: "ok" } }),
      topic,
      "1",
    ),
  ).toBeNull();
  expect(
    realtimeSignal(frame({ event: "phx_close", topic: "realtime:share:other" }), topic, "1"),
  ).toBeNull();
  expect(
    realtimeSignal(frame({ event: "system", topic, payload: { status: "ok" } }), topic, "1"),
  ).toBeNull();
  expect(realtimeSignal("not json", topic, "1")).toBeNull();
  const open = body("async function openSocket(");
  expect(open).toContain('else if (signal === "dropped") socketDropped(session, seq);');
  expect(open).toContain('else if (signal === "joined") session.socketTries = 0;');
});
