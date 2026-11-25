import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import {
  createDeskLoader,
  createRowGuard,
  type DeskState,
} from "../src/features/shared-with-you/desk-loader";
import type { AccountStatus, ShareDesk } from "../src/lib/tauri";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const desk = (title: string): ShareDesk => ({
  shared: [{ id: title, title, owner: "Ada", open: 0, pending: true }],
  shared_count: 0,
  own: [],
  own_count: 0,
});

function harness() {
  const states: DeskState[] = [];
  const statuses: ReturnType<typeof deferred<AccountStatus>>[] = [];
  const desks: ReturnType<typeof deferred<ShareDesk>>[] = [];
  const loader = createDeskLoader({
    status: () => {
      const next = deferred<AccountStatus>();
      statuses.push(next);
      return next.promise;
    },
    desk: () => {
      const next = deferred<ShareDesk>();
      desks.push(next);
      return next.promise;
    },
    set: (state) => states.push(state),
  });
  return { loader, states, statuses, desks };
}

const flush = () => new Promise((done) => setTimeout(done, 0));
const ada: AccountStatus = { signed_in: true, email: "Ada@Example.com" };

test("signed out, loading and ready are three states", async () => {
  const h = harness();
  expect(h.loader.current()).toEqual({ kind: "loading" });
  void h.loader.load([]);
  h.statuses[0]!.resolve({ signed_in: false });
  await flush();
  expect(h.loader.current()).toEqual({ kind: "signedOut" });
  void h.loader.load([]);
  h.statuses[1]!.resolve(ada);
  await flush();
  h.desks[0]!.resolve(desk("Harbor"));
  await flush();
  expect(h.loader.current()).toMatchObject({
    kind: "ready",
    account: "ada@example.com",
    stale: false,
  });
});

test("an answer's refresh beats a poll that started before it", async () => {
  const h = harness();
  void h.loader.load([]); // the poll
  h.statuses[0]!.resolve(ada);
  await flush();
  void h.loader.load([]); // the refresh after Accept
  h.statuses[1]!.resolve(ada);
  await flush();
  h.desks[1]!.resolve(desk("answered"));
  await flush();
  // The poll's read still has the invite as pending. It must not bring the row back.
  h.desks[0]!.resolve(desk("stale"));
  await flush();
  const ready = h.loader.current();
  expect(ready.kind === "ready" && ready.desk.shared[0]?.title).toBe("answered");
});

test("a load running at sign-out does not show the old account's list", async () => {
  const h = harness();
  void h.loader.load([]);
  h.statuses[0]!.resolve(ada);
  await flush();
  h.loader.signedOut();
  h.desks[0]!.resolve(desk("Harbor"));
  await flush();
  expect(h.loader.current()).toEqual({ kind: "signedOut" });
});

test("another account hides the previous list before its own read", async () => {
  const h = harness();
  void h.loader.load([]);
  h.statuses[0]!.resolve(ada);
  await flush();
  h.desks[0]!.resolve(desk("Ada's"));
  await flush();
  void h.loader.load([]);
  h.statuses[1]!.resolve({ signed_in: true, email: "bob@example.com" });
  await flush();
  expect(h.loader.current()).toEqual({ kind: "loading" });
  h.desks[1]!.resolve(desk("Bob's"));
  await flush();
  expect(h.loader.current()).toMatchObject({ kind: "ready", account: "bob@example.com" });
});

test("a failed read keeps the last list and marks it stale", async () => {
  const h = harness();
  void h.loader.load([]);
  h.statuses[0]!.reject(new Error("unreachable"));
  await flush();
  expect(h.loader.current()).toEqual({ kind: "loading" });
  void h.loader.load([]);
  h.statuses[1]!.resolve(ada);
  await flush();
  h.desks[0]!.resolve(desk("Harbor"));
  await flush();
  void h.loader.load([]);
  h.statuses[2]!.resolve(ada);
  await flush();
  h.desks[1]!.reject(new Error("unreachable"));
  await flush();
  expect(h.loader.current()).toMatchObject({ kind: "ready", stale: true });
  // A stopped hook writes nothing.
  void h.loader.load([]);
  h.loader.stop();
  const before = h.states.length;
  h.statuses[3]!.resolve({ signed_in: false });
  await flush();
  expect(h.states.length).toBe(before);
});

test("one action per row at a time", async () => {
  const guard = createRowGuard();
  const gate = deferred<void>();
  let runs = 0;
  const first = guard.run("share-1", async () => {
    runs += 1;
    await gate.promise;
  });
  expect(await guard.run("share-1", async () => void (runs += 1))).toBe(false);
  expect(await guard.run("share-2", async () => void (runs += 1))).toBe(true);
  gate.resolve();
  expect(await first).toBe(true);
  expect(runs).toBe(2);
  expect(guard.has("share-1")).toBe(false);
  const hook = readFileSync(
    new URL("../src/features/shared-with-you/use-desk.ts", import.meta.url),
    "utf8",
  );
  for (const action of ["open", "answer", "leave", "restore"]) {
    const at = hook.indexOf(`async function ${action}(`);
    expect(hook.slice(at, at + 200)).toContain("await rows.run(");
  }
});
