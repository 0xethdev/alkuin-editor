import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  applyCssVarBindings: vi.fn(),
}));

import {
  applyWritingSession,
  reduceWritingSession,
  rememberAccountAnswer,
  rememberWritingOffline,
  rememberWritingPlan,
  rememberWritingSession,
  writingOffline,
  writingPlan,
  writingSession,
  writingSignedIn,
  type WritingSession,
} from "../src/lib/account-session";
import {
  confirmStoredSession,
  enterFromStoredSession,
  offlineRecheck,
  type DeskArrival,
} from "../src/lib/account-gate";
import { learnOnDecision } from "../src/features/redline-spike/entitlement";
import { MENU_EVENT_HANDLERS } from "../src/hooks/use-menu-events";
import { useEditorStore } from "../src/stores/editor-store";

const offlineDesk: WritingSession = { kind: "signedIn", reach: "offline", plan: "paid" };

describe("writing session", () => {
  // Runs first: the module state is fresh for this file.
  test("a fresh window is unknown, and a menu item does nothing before the gate", () => {
    expect(writingSession()).toEqual({ kind: "unknown" });
    expect(writingSignedIn()).toBe(false);
    expect(writingOffline()).toBe(false);
    expect(writingPlan()).toBeNull();
    rememberWritingPlan("paid");
    expect(writingPlan()).toBeNull();
    MENU_EVENT_HANDLERS["menu:open-preferences"]!();
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });

  test("an offline desk goes back online when an account check answers", () => {
    expect(reduceWritingSession(offlineDesk, { type: "reachable" })).toEqual({
      kind: "signedIn",
      reach: "online",
      plan: "paid",
    });
    rememberWritingSession(true);
    rememberWritingOffline(true);
    expect(writingOffline()).toBe(true);
    rememberAccountAnswer({ signed_in: true, offline: false, effective: "free" });
    expect(writingOffline()).toBe(false);
    expect(writingPlan()).toBe("free");
  });

  test("an answer that never reached the server keeps the plan and the reach", () => {
    applyWritingSession({ type: "signed-out" });
    applyWritingSession({ type: "signed-in", reach: "offline" });
    rememberWritingPlan("paid");
    rememberAccountAnswer({ signed_in: true, offline: true, effective: null });
    expect(writingSession()).toEqual(offlineDesk);
  });

  test("sign-out drops reach and plan; signing in again starts unknown", () => {
    rememberWritingSession(true);
    rememberWritingPlan("free");
    rememberWritingSession(false);
    expect(writingSession()).toEqual({ kind: "signedOut" });
    expect(writingPlan()).toBeNull();
    rememberWritingOffline(true);
    expect(writingOffline()).toBe(false);
    rememberWritingSession(true);
    expect(writingSession()).toEqual({ kind: "signedIn", reach: "online", plan: "unknown" });
  });

  test("signing in again keeps the reach and plan an open session has", () => {
    applyWritingSession({ type: "reset" });
    applyWritingSession({ type: "signed-in", reach: "offline" });
    rememberWritingPlan("founding");
    rememberWritingSession(true);
    expect(writingSession()).toEqual({ kind: "signedIn", reach: "offline", plan: "founding" });
    applyWritingSession({ type: "reset" });
    expect(writingSession()).toEqual({ kind: "unknown" });
  });

  test("an unknown plan still learns, and Free does not", () => {
    expect(learnOnDecision(null)).toBe(true);
    expect(learnOnDecision("free")).toBe(false);
    expect(learnOnDecision("paid")).toBe(true);
  });
});

describe("sign-in gate session answers", () => {
  test("a keychain that cannot be read shows welcome instead of a blank window", async () => {
    const seen: DeskArrival[] = [];
    await enterFromStoredSession(
      () => Promise.reject(new Error("keychain")),
      async () => ({ signed_in: true }),
      (entry) => seen.push(entry),
    );
    expect(seen).toEqual([{ step: "welcome", signedIn: false, offline: false, email: null }]);
  });

  test("an offline desk asks once at a time and lands online when Auth answers", async () => {
    let offline = true;
    let release: (value: { signed_in: boolean }) => void = () => {};
    const confirm = vi.fn(
      () =>
        new Promise<{ signed_in: boolean }>((resolve) => {
          release = resolve;
        }),
    );
    const check = offlineRecheck(confirm, () => offline);
    const seen: DeskArrival[] = [];
    const first = check((entry) => seen.push(entry));
    const second = check((entry) => seen.push(entry));
    expect(confirm).toHaveBeenCalledTimes(1);
    release({ signed_in: true });
    await Promise.all([first, second]);
    expect(seen).toEqual([{ step: "desk", signedIn: true, offline: false, email: null }]);
    offline = false;
    await check((entry) => seen.push(entry));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("a recheck that finds the session gone returns to welcome; a failure stays offline", async () => {
    const seen: DeskArrival[] = [];
    await confirmStoredSession(
      async () => ({ signed_in: false }),
      null,
      (entry) => seen.push(entry),
    );
    await confirmStoredSession(
      () => Promise.reject(new Error("timeout")),
      "ada@example.com",
      (entry) => seen.push(entry),
    );
    expect(seen).toEqual([
      { step: "welcome", signedIn: false, offline: false, email: null },
      { step: "desk", signedIn: true, offline: true, email: "ada@example.com" },
    ]);
  });
});
