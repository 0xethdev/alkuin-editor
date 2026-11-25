import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/components/editor-area/editor-notice-store", () => ({
  showEditorNotice: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const mockedInvoke = vi.mocked(invoke);
const appends: { lines: string; settle: (written: number | Error) => void }[] = [];
/** What the diagnostics file holds: only batches the backend finished writing. */
const file: string[] = [];
mockedInvoke.mockImplementation((command, args) => {
  if (command === "caret_diag_status") {
    return Promise.resolve({ enabled: true, pinned: false, path: "" });
  }
  if (command === "caret_diag_append") {
    return new Promise((resolve, reject) => {
      const lines = (args as { lines: string }).lines;
      appends.push({
        lines,
        settle: (written) => {
          if (written instanceof Error) return reject(written);
          file.push(lines);
          resolve(written);
        },
      });
    });
  }
  if (command === "caret_diag_copy") return Promise.resolve(file.join("\n"));
  return Promise.resolve(undefined);
});

const { enqueueCaretDiag, flushCaretDiag, readCaretDiagText, setCaretDiagLocal } =
  await import("../src/lib/caret-diag-log");

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("caret diagnostics buffer", () => {
  test("one flush at a time, and a failed batch goes out before later lines", async () => {
    setCaretDiagLocal(true);
    enqueueCaretDiag("a");
    const first = flushCaretDiag();
    await settle();
    enqueueCaretDiag("b");
    const second = flushCaretDiag();
    await settle();
    expect(appends.map((append) => append.lines)).toEqual(["a"]);
    appends[0]!.settle(new Error("disk"));
    await settle();
    expect(appends.map((append) => append.lines)).toEqual(["a", "a\nb"]);
    appends[1]!.settle(2);
    await Promise.all([first, second]);
  });

  test("copy waits for a flush already in flight", async () => {
    appends.length = 0;
    file.length = 0;
    enqueueCaretDiag("c");
    void flushCaretDiag();
    await settle();
    const copied = readCaretDiagText();
    await settle();
    expect(appends.map((append) => append.lines)).toEqual(["c"]);
    appends[0]!.settle(1);
    expect(await copied).toBe("c");
  });
});
