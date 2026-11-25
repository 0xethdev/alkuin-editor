import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@/lib/window-events", () => ({ listenInThisWindow: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ shareInviteRefusal: vi.fn() }));
// Only startup's flag is read from the workspace store.
const startup = vi.hoisted(() => {
  const watchers = new Set<(state: { isStartupResolved: boolean }) => void>();
  const state = { isStartupResolved: true };
  return {
    state,
    watchers,
    set(resolved: boolean) {
      state.isStartupResolved = resolved;
      for (const watcher of [...watchers]) watcher(state);
    },
  };
});
vi.mock("@/stores/workspace-store", () => ({
  useWorkspaceStore: {
    getState: () => startup.state,
    subscribe: (watcher: (state: { isStartupResolved: boolean }) => void) => {
      startup.watchers.add(watcher);
      return () => void startup.watchers.delete(watcher);
    },
  },
}));

import { readFileSync } from "node:fs";
import { listenInThisWindow } from "../src/lib/window-events";
import {
  resetEditorNoticesForTest,
  showEditorNotice,
  useEditorNoticeStore,
} from "../src/components/editor-area/editor-notice-store";
import { INVITE_NOT_ADMITTED_LINE, NOT_ADMITTED_AFTER_INVITE } from "../src/lib/account-copy";
import {
  inviteRefusalLine,
  watchInviteRefusals,
} from "../src/features/document-share/invite-arrival";
import * as tauri from "../src/lib/tauri";

const mockedListen = vi.mocked(listenInThisWindow);
const mockedRefusal = vi.mocked(tauri.shareInviteRefusal);

function readSrc(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A listener that records what happened in order, and hands back the handler to fire. */
function listening(order: string[]) {
  let fire: () => void = () => {};
  const stop = vi.fn(() => void order.push("stop"));
  mockedListen.mockImplementation((event, handler) => {
    order.push(`listen ${event}`);
    fire = () => (handler as () => void)();
    return Promise.resolve(stop);
  });
  return { fire: () => fire(), stop };
}

beforeEach(() => {
  mockedListen.mockReset();
  mockedRefusal.mockReset();
  startup.watchers.clear();
  startup.set(true);
});

describe("an invite link refused for the signed-in account", () => {
  test("only an account that is not on the list has a sentence", () => {
    expect(inviteRefusalLine(null)).toBeNull();
    expect(inviteRefusalLine("not_admitted")).toBe(INVITE_NOT_ADMITTED_LINE);
    for (const code of ["unreachable", "not_found", "unauthorized", "session_expired"]) {
      expect(inviteRefusalLine(code)).toBeNull();
    }
  });

  test("the window listens first, then reads what was kept, and reads again when told", async () => {
    const order: string[] = [];
    const { fire, stop } = listening(order);
    const kept: (string | null)[] = [null, "not_admitted", "unreachable"];
    mockedRefusal.mockImplementation(() => {
      order.push("read");
      return Promise.resolve(kept.shift() ?? null);
    });
    const said: string[] = [];
    const unwatch = watchInviteRefusals((line) => said.push(line));
    await settle();
    // Nothing was kept when the window opened. The read came after the listener existed.
    expect(order).toEqual(["listen share:invite-refused", "read"]);
    expect(said).toEqual([]);

    fire();
    await settle();
    expect(said).toEqual([INVITE_NOT_ADMITTED_LINE]);

    // A link that failed for another reason says nothing new.
    fire();
    await settle();
    expect(said).toEqual([INVITE_NOT_ADMITTED_LINE]);

    unwatch();
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("a cold start: the refusal kept before the window existed is shown on mount", async () => {
    listening([]);
    mockedRefusal.mockResolvedValueOnce("not_admitted").mockResolvedValue(null);
    const said: string[] = [];
    // The window mounts twice in development. Rust hands the refusal out once.
    watchInviteRefusals((line) => said.push(line))();
    watchInviteRefusals((line) => said.push(line));
    await settle();
    expect(said).toEqual([INVITE_NOT_ADMITTED_LINE]);
  });

  test("the refusal stays in Rust until startup has opened the last folder", async () => {
    // Opening a folder clears lasting lines. A line shown before that would be lost.
    startup.set(false);
    listening([]);
    mockedRefusal.mockResolvedValueOnce("not_admitted").mockResolvedValue(null);
    const said: string[] = [];
    watchInviteRefusals((line) => said.push(line));
    await settle();
    expect(mockedRefusal).not.toHaveBeenCalled();
    expect(said).toEqual([]);

    startup.set(true);
    await settle();
    expect(mockedRefusal).toHaveBeenCalledTimes(1);
    expect(said).toEqual([INVITE_NOT_ADMITTED_LINE]);
    expect(startup.watchers.size).toBe(0);
  });

  test("it is read even when the window cannot listen, and a failed read says nothing", async () => {
    mockedListen.mockImplementation(() => Promise.reject(new Error("no runtime")));
    mockedRefusal.mockResolvedValueOnce("not_admitted");
    const said: string[] = [];
    const unwatch = watchInviteRefusals((line) => said.push(line));
    await settle();
    expect(said).toEqual([INVITE_NOT_ADMITTED_LINE]);
    unwatch();
    await settle();

    listening([]);
    mockedRefusal.mockRejectedValue(new Error("gone"));
    watchInviteRefusals((line) => said.push(line));
    await settle();
    expect(said).toEqual([INVITE_NOT_ADMITTED_LINE]);
  });

  test("the sentence stays until it is dismissed, and a passing notice does not take it away", async () => {
    vi.useFakeTimers();
    // The store schedules a passing line's dismissal on `window`.
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    });
    try {
      resetEditorNoticesForTest();
      const { fire } = listening([]);
      mockedRefusal.mockResolvedValue("not_admitted");
      watchInviteRefusals();
      await settle();
      expect(useEditorNoticeStore.getState().message).toBe(INVITE_NOT_ADMITTED_LINE);
      vi.advanceTimersByTime(60_000);
      expect(useEditorNoticeStore.getState().message).toBe(INVITE_NOT_ADMITTED_LINE);
      // Rust hands the refusal over once. A passing notice shows over it and
      // gives the place back; it does not take the sentence away.
      showEditorNotice("Diagnostics copied");
      expect(useEditorNoticeStore.getState().message).toBe("Diagnostics copied");
      vi.advanceTimersByTime(4000);
      expect(useEditorNoticeStore.getState().message).toBe(INVITE_NOT_ADMITTED_LINE);
      // A second refused link does not queue the same sentence behind itself.
      fire();
      await settle();
      expect(useEditorNoticeStore.getState().message).toBe(INVITE_NOT_ADMITTED_LINE);
      useEditorNoticeStore.getState().dismissNotice();
      expect(useEditorNoticeStore.getState().message).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  test("Rust and the desk agree on the names", () => {
    const arrival = readSrc("../src-tauri/src/invite_arrival.rs");
    expect(arrival).toContain(
      `pub const NOT_ADMITTED_AFTER_INVITE: &str = "${NOT_ADMITTED_AFTER_INVITE}";`,
    );
    // The sign-in command is where the invite is added to a refusal, and settled.
    expect(readSrc("../src-tauri/src/commands/account.rs")).toContain(
      "INVITE_ARRIVAL.sign_in(signed)",
    );
    const lib = readSrc("../src-tauri/src/lib.rs");
    expect(lib).toMatch(/INVITE_ARRIVAL\.note\(&err\);\s*show_invite_refusal\(&app\);/);
    expect(lib).toContain('const EVENT: &str = "share:invite-refused";');
    expect(lib).toContain("commands::shares::share_invite_refusal,");
    expect(readSrc("../src/App.tsx")).toContain("useEffect(() => watchInviteRefusals(), []);");
  });
});
