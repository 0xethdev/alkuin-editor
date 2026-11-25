import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

import { createCloseGuard } from "../src/hooks/use-save-before-close";
import { DISCARD_CONFIRM_MS } from "../src/lib/save";

function guardWith(unsaved: string[][], visible = true) {
  const results = [...unsaved];
  const calls: string[] = [];
  const shown: string[][] = [];
  const clock = { now: 0 };
  const guard = createCloseGuard({
    flushAllSaves: async () => {
      calls.push("flush");
      return results.shift() ?? [];
    },
    isVisible: async () => visible,
    close: async () => {
      calls.push("close");
    },
    showUnsaved: (paths) => {
      shown.push(paths);
    },
    now: () => clock.now,
  });
  return { guard, calls, shown, clock };
}

describe("save before the window closes", () => {
  test("saves every document, then closes", async () => {
    const { guard, calls, shown } = guardWith([[]]);
    await guard();
    expect(calls).toEqual(["flush", "close"]);
    expect(shown).toEqual([]);
  });

  test("a failed save keeps the window open; the next close goes ahead", async () => {
    const { guard, calls, shown } = guardWith([["/a.md"], ["/a.md"]]);

    await guard();
    expect(calls).toEqual(["flush"]);
    expect(shown).toEqual([["/a.md"]]);

    await guard();
    expect(calls).toEqual(["flush", "flush", "close"]);
  });

  test("a close long after the warning warns again instead of discarding", async () => {
    const { guard, calls, shown, clock } = guardWith([["/a.md"], ["/a.md"]]);

    await guard();
    clock.now += DISCARD_CONFIRM_MS + 1;
    await guard();

    expect(calls).toEqual(["flush", "flush"]);
    expect(shown).toEqual([["/a.md"], ["/a.md"]]);
  });

  test("a different unsaved document warns again instead of discarding", async () => {
    const { guard, calls, shown } = guardWith([["/a.md"], ["/b.md"]]);

    await guard();
    await guard();

    expect(calls).toEqual(["flush", "flush"]);
    expect(shown).toEqual([["/a.md"], ["/b.md"]]);
  });

  test("a close that saved everything disarms the discard", async () => {
    const { guard, calls, shown } = guardWith([["/a.md"], [], ["/a.md"]], false);

    await guard();
    await guard();
    await guard();

    expect(calls).toEqual(["flush", "flush", "flush"]);
    expect(shown).toEqual([["/a.md"], ["/a.md"]]);
  });

  test("a window the native layer hid stays alive", async () => {
    const { guard, calls } = guardWith([[]], false);
    await guard();
    expect(calls).toEqual(["flush"]);
  });

  test("a second close request while saving is ignored", async () => {
    let finish: (paths: string[]) => void = () => {};
    const calls: string[] = [];
    const guard = createCloseGuard({
      flushAllSaves: () => {
        calls.push("flush");
        return new Promise((resolve) => (finish = resolve));
      },
      isVisible: async () => true,
      close: async () => {
        calls.push("close");
      },
      showUnsaved: () => {},
    });

    const first = guard();
    await guard();
    finish([]);
    await first;
    expect(calls).toEqual(["flush", "close"]);
  });
});
