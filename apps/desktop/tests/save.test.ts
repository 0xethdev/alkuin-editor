import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  readStoredAppearance: () => null,
}));

import { invoke } from "@tauri-apps/api/core";
import {
  HISTORY_AFTER_SAVE_MS,
  SAVE_HELD,
  SAVE_TOO_SLOW,
  SAVE_WAIT_MS,
  SaveFailedError,
  cancelSave,
  discardSave,
  flushAllSaves,
  flushSave,
  isSaveActive,
  quiesceSave,
  relocateSave,
  resumeSave,
} from "../src/lib/save";
import { saveDirtyOpenDocuments } from "../src/lib/save-all";
import {
  resetEditorNoticesForTest,
  useEditorNoticeStore,
} from "../src/components/editor-area/editor-notice-store";
import { BACKUP_REFUSED_LINE, SAVED_BESIDE_LINE } from "../src/features/redline-spike/margin-copy";
import { resetBackupNoticesForTest } from "../src/lib/history/backup-notice";
import { settleSaved } from "../src/lib/history/desk";
import { settleOverlap } from "../src/lib/history/settle";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";

const mockedInvoke = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("autosave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetBackupNoticesForTest();
    resetEditorNoticesForTest();

    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
    });

    useSettingsStore.setState({
      settings: {
        "files.trim-trailing-whitespace": false,
        "files.insert-final-newline": false,
      },
      isLoaded: true,
    });
  });

  afterEach(async () => {
    // A failed write arms a retry. Drop it, so the next test starts from no save state.
    cancelSave("/test.md");
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  test("flushSave rejects when the disk write fails, and keeps the file dirty", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "read_file") {
        return { path: "/test.md", content: "initial", modified_at: 1 };
      }
      if (command === "write_file") throw new Error("disk full");
      return undefined;
    });

    await useEditorStore.getState().openFile("/test.md");
    useEditorStore.getState().updateContent("/test.md", "unsaved words");
    await flushMicrotasks();

    const flushed = flushSave("/test.md");
    await expect(flushed).rejects.toThrow("disk full");
    await expect(flushed).rejects.toBeInstanceOf(SaveFailedError);

    const file = useEditorStore.getState().openFiles.get("/test.md");
    expect(file?.isDirty).toBe(true);
    expect(file?.saveError).toBe("disk full");
  });

  test("keeps newer edits dirty until a follow-up save completes", async () => {
    const firstWrite = deferred<{ path: string; modified_at: number }>();
    const secondWrite = deferred<{ path: string; modified_at: number }>();
    const writePayloads: string[] = [];

    mockedInvoke.mockImplementation((command, payload) => {
      if (command === "read_file") {
        return Promise.resolve({
          path: "/test.md",
          content: "initial",
          modified_at: 1,
        });
      }

      if (command === "write_file") {
        writePayloads.push((payload as { content: string }).content);
        return writePayloads.length === 1 ? firstWrite.promise : secondWrite.promise;
      }

      return Promise.resolve(null);
    });

    await useEditorStore.getState().openFile("/test.md");

    useEditorStore.getState().updateContent("/test.md", "first draft");
    expect(writePayloads).toEqual(["first draft"]);

    useEditorStore.getState().updateContent("/test.md", "second draft");
    expect(writePayloads).toEqual(["first draft"]);

    firstWrite.resolve({ path: "/test.md", modified_at: 2 });
    await flushMicrotasks();

    const midSave = useEditorStore.getState().openFiles.get("/test.md");
    expect(midSave?.content).toBe("second draft");
    expect(midSave?.diskContent).toBe("first draft");
    expect(midSave?.isDirty).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(writePayloads).toEqual(["first draft", "second draft"]);

    secondWrite.resolve({ path: "/test.md", modified_at: 3 });
    await flushMicrotasks();

    const saved = useEditorStore.getState().openFiles.get("/test.md");
    expect(saved?.content).toBe("second draft");
    expect(saved?.diskContent).toBe("second draft");
    expect(saved?.isDirty).toBe(false);
  });

  test("a save sends a history copy after the disk write, without waiting on it", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "read_file") {
        return { path: "/test.md", content: "initial", modified_at: 1 };
      }
      if (command === "write_file") {
        return { path: "/test.md", modified_at: 2 };
      }
      if (command === "history_send") {
        return { sent: false, waiting: false, refused: false, unconfigured: true };
      }
      return null;
    });

    await useEditorStore.getState().openFile("/test.md");
    useEditorStore.getState().updateContent("/test.md", "saved line");
    await flushMicrotasks();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "write_file",
      expect.objectContaining({ path: "/test.md" }),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("history_send", expect.anything());

    await vi.advanceTimersByTimeAsync(HISTORY_AFTER_SAVE_MS - 1);
    expect(mockedInvoke).not.toHaveBeenCalledWith("history_send", expect.anything());

    useEditorStore.getState().updateContent("/test.md", "saved line again");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(HISTORY_AFTER_SAVE_MS - 1);
    expect(mockedInvoke).not.toHaveBeenCalledWith("history_send", expect.anything());

    await vi.advanceTimersByTimeAsync(1);
    const sends = mockedInvoke.mock.calls.filter((call) => call[0] === "history_send");
    expect(sends).toEqual([["history_send", { path: "/test.md", online: true }]]);
  });

  test("a save checks the file against the text it was built on", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "read_file") return { path: "/test.md", content: "initial", modified_at: 1 };
      if (command === "write_file") return { path: "/test.md", modified_at: 2 };
      return null;
    });

    await useEditorStore.getState().openFile("/test.md");
    useEditorStore.getState().updateContent("/test.md", "first");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    useEditorStore.getState().updateContent("/test.md", "second");
    await vi.advanceTimersByTimeAsync(1000);

    const writes = mockedInvoke.mock.calls.filter((call) => call[0] === "write_file");
    expect(writes.map((call) => call[1])).toEqual([
      { path: "/test.md", content: "first", expected: "initial" },
      // The disk text after the first save is what that save wrote.
      { path: "/test.md", content: "second", expected: "first" },
    ]);
    expect(useEditorNoticeStore.getState().toast).toBeNull();
  });

  test("every save is checked, and each new copy is named, after the first one too", async () => {
    // What Rust found on disk at each save: two different outside edits, then the same
    // bytes again, which it skips because they are already kept.
    const copies = ["/notes/a (other copy).md", "/notes/a (other copy 2).md", undefined];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "read_file") return { path: "/notes/a.md", content: "base", modified_at: 1 };
      if (command === "write_file") {
        const other_copy = copies.shift();
        return { path: "/notes/a.md", modified_at: 2, ...(other_copy ? { other_copy } : {}) };
      }
      return null;
    });
    const line = (copy: string) =>
      SAVED_BESIDE_LINE.replace("{document}", "a.md").replace("{copy}", copy);

    await useEditorStore.getState().openFile("/notes/a.md");
    useEditorStore.getState().updateContent("/notes/a.md", "one");
    await flushMicrotasks();
    expect(useEditorNoticeStore.getState().toast).toBe(line("a (other copy).md"));
    // The writer's words are saved: the buffer is clean.
    expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.isDirty).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    useEditorStore.getState().updateContent("/notes/a.md", "two");
    await vi.advanceTimersByTimeAsync(1000);
    // The second copy's line replaces the first: one line per document, the newest copy.
    expect(useEditorNoticeStore.getState().toast).toBe(line("a (other copy 2).md"));
    useEditorNoticeStore.getState().dismissNotice();
    expect(useEditorNoticeStore.getState().toast).toBeNull();

    useEditorStore.getState().updateContent("/notes/a.md", "three");
    await vi.advanceTimersByTimeAsync(1000);
    // Already kept: no copy, no line.
    expect(useEditorNoticeStore.getState().toast).toBeNull();

    const writes = mockedInvoke.mock.calls.filter((call) => call[0] === "write_file");
    expect(writes.map((call) => (call[1] as { expected?: string }).expected)).toEqual([
      "base",
      "one",
      "two",
    ]);
    cancelSave("/notes/a.md");
  });

  test("a program that writes new bytes after every save leaves one line, naming the newest copy", async () => {
    let saves = 0;
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "read_file") return { path: "/notes/a.md", content: "base", modified_at: 1 };
      if (command === "write_file") {
        saves += 1;
        const other_copy = `/notes/a (other copy${saves === 1 ? "" : ` ${saves}`}).md`;
        return { path: "/notes/a.md", modified_at: 2, other_copy, other_copies: [other_copy] };
      }
      return null;
    });
    await useEditorStore.getState().openFile("/notes/a.md");
    // The other Mac's copy is waiting for a decision while this happens.
    useEditorNoticeStore.getState().showOverlap({
      path: "/notes/b.md",
      localText: "ours",
      otherText: "theirs",
      deleted: false,
      versionId: "v2",
    });

    for (const words of ["one", "two", "three", "four", "five"]) {
      useEditorStore.getState().updateContent("/notes/a.md", words);
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(saves).toBe(5);
    expect(useEditorNoticeStore.getState().toast).toBe(
      SAVED_BESIDE_LINE.replace("{document}", "a.md").replace("{copy}", "a (other copy 5).md"),
    );
    // One dismissal reaches the decision: the four older lines are not waiting behind it.
    useEditorNoticeStore.getState().dismissNotice();
    expect(useEditorNoticeStore.getState().overlap?.path).toBe("/notes/b.md");
    cancelSave("/notes/a.md");
  });

  test("a passing toast does not take away the line naming the copy", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "read_file") return { path: "/notes/a.md", content: "base", modified_at: 1 };
      if (command === "write_file") {
        return { path: "/notes/a.md", modified_at: 2, other_copy: "/notes/a (other copy).md" };
      }
      return null;
    });
    const line = SAVED_BESIDE_LINE.replace("{document}", "a.md").replace(
      "{copy}",
      "a (other copy).md",
    );

    await useEditorStore.getState().openFile("/notes/a.md");
    useEditorStore.getState().updateContent("/notes/a.md", "one");
    await flushMicrotasks();
    expect(useEditorNoticeStore.getState().toast).toBe(line);

    useEditorNoticeStore.getState().showNotice("Diagnostics copied");
    expect(useEditorNoticeStore.getState().toast).toBe("Diagnostics copied");
    // When the passing line goes (its timer, or a click), the copy's line is back.
    useEditorNoticeStore.getState().dismissNotice();
    expect(useEditorNoticeStore.getState().toast).toBe(line);
    // The refused-backup line arriving now waits behind it instead of replacing it.
    useEditorNoticeStore.getState().showNotice("Another lasting line", true, true);
    expect(useEditorNoticeStore.getState().toast).toBe(line);
    useEditorNoticeStore.getState().dismissNotice();
    expect(useEditorNoticeStore.getState().toast).toBe("Another lasting line");
    cancelSave("/notes/a.md");
  });

  test("a refused backup is said once per file, and withdrawn when a later copy is stored", async () => {
    let refuse = true;
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "read_file") {
        return { path: "/notes/Q&A.md", content: "initial", modified_at: 1 };
      }
      if (command === "write_file") return { path: "/notes/Q&A.md", modified_at: 2 };
      if (command === "history_send") {
        return refuse
          ? { sent: false, waiting: false, refused: false, unconfigured: false, stopped: true }
          : { sent: true, waiting: false, refused: false, unconfigured: false };
      }
      return null;
    });
    const line = BACKUP_REFUSED_LINE.replace("{document}", "Q&A.md");

    await useEditorStore.getState().openFile("/notes/Q&A.md");
    useEditorStore.getState().updateContent("/notes/Q&A.md", "one");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(HISTORY_AFTER_SAVE_MS);
    expect(useEditorNoticeStore.getState().toast).toBe(line);

    // Read and dismissed. The next refused save does not say it again.
    useEditorNoticeStore.getState().dismissNotice();
    useEditorStore.getState().updateContent("/notes/Q&A.md", "two");
    await vi.advanceTimersByTimeAsync(1000 + HISTORY_AFTER_SAVE_MS);
    expect(useEditorNoticeStore.getState().toast).toBeNull();

    // A later copy is stored, then refused again: the line is true again and is said.
    refuse = false;
    useEditorStore.getState().updateContent("/notes/Q&A.md", "three");
    await vi.advanceTimersByTimeAsync(1000 + HISTORY_AFTER_SAVE_MS);
    refuse = true;
    useEditorStore.getState().updateContent("/notes/Q&A.md", "four");
    await vi.advanceTimersByTimeAsync(1000 + HISTORY_AFTER_SAVE_MS);
    expect(useEditorNoticeStore.getState().toast).toBe(line);

    // Stored again while it shows: the line is no longer true and leaves.
    refuse = false;
    useEditorStore.getState().updateContent("/notes/Q&A.md", "five");
    await vi.advanceTimersByTimeAsync(1000 + HISTORY_AFTER_SAVE_MS);
    expect(useEditorNoticeStore.getState().toast).toBeNull();
    cancelSave("/notes/Q&A.md");
  });

  test("quiesce then discard waits out an in-flight write and leaves no follow-up save", async () => {
    const write = deferred<{ path: string; modified_at: number }>();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "read_file") return { path: "/test.md", content: "initial", modified_at: 1 };
      if (command === "write_file") return write.promise;
      return undefined;
    });

    await useEditorStore.getState().openFile("/test.md");
    useEditorStore.getState().updateContent("/test.md", "first");
    await flushMicrotasks();
    // Newer keystrokes queue behind the in-flight write.
    useEditorStore.getState().updateContent("/test.md", "second");
    await flushMicrotasks();

    let settled = false;
    const quiet = quiesceSave("/test.md").then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);

    write.resolve({ path: "/test.md", modified_at: 2 });
    await vi.advanceTimersByTimeAsync(20);
    await quiet;
    // The trash went through: nothing is left at the path.
    discardSave("/test.md");

    expect(isSaveActive("/test.md")).toBe(false);
    const writesBefore = mockedInvoke.mock.calls.filter((call) => call[0] === "write_file").length;
    await vi.advanceTimersByTimeAsync(2000 * 2);
    const writesAfter = mockedInvoke.mock.calls.filter((call) => call[0] === "write_file").length;
    expect(writesAfter).toBe(writesBefore);
  });
});

describe("save controller lifecycle", () => {
  const writes: { path: string; content: string }[] = [];
  let nextWrite: (() => Promise<unknown>) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    writes.length = 0;
    nextWrite = null;

    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
    });
    useSettingsStore.setState({
      settings: {
        "files.trim-trailing-whitespace": false,
        "files.insert-final-newline": false,
      },
      isLoaded: true,
    });

    mockedInvoke.mockImplementation((command, payload) => {
      if (command === "read_file") {
        const path = (payload as { path: string }).path;
        return Promise.resolve({ path, content: "initial", modified_at: 1 });
      }
      if (command === "write_file") {
        const body = payload as { path: string; content: string };
        writes.push({ path: body.path, content: body.content });
        if (nextWrite) {
          const run = nextWrite;
          nextWrite = null;
          return run();
        }
        return Promise.resolve({ path: body.path, modified_at: 2 });
      }
      return Promise.resolve(null);
    });

    await useEditorStore.getState().openFile("/doc.md");
    // Past the throttle, so the next edit writes at once.
    await vi.advanceTimersByTimeAsync(1000);
  });

  afterEach(async () => {
    for (const path of ["/doc.md", "/moved.md", "/dir", "/dir/a.md", "/new/a.md"]) cancelSave(path);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  test("flushSave rejects when the write fails", async () => {
    nextWrite = () => Promise.reject(new Error("disk full"));
    useEditorStore.getState().updateContent("/doc.md", "words");
    await flushMicrotasks();
    nextWrite = () => Promise.reject(new Error("disk full"));

    await expect(flushSave("/doc.md")).rejects.toThrow("disk full");
    expect(useEditorStore.getState().openFiles.get("/doc.md")?.saveError).toBe("disk full");
    expect(useEditorStore.getState().openFiles.get("/doc.md")?.isDirty).toBe(true);
  });

  test("flushSave refuses a path a rename holds, as a failed save", async () => {
    await quiesceSave("/doc.md");
    useEditorStore.getState().updateContent("/doc.md", "held words");

    const flushing = flushSave("/doc.md");
    await expect(flushing).rejects.toThrow(SAVE_HELD);
    await expect(flushing).rejects.toBeInstanceOf(SaveFailedError);
    expect(writes).toEqual([]);
    expect(useEditorStore.getState().openFiles.get("/doc.md")?.isDirty).toBe(true);

    resumeSave("/doc.md");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([{ path: "/doc.md", content: "held words" }]);
  });

  test("Accept's save step does not commit when the write fails", async () => {
    nextWrite = () => Promise.reject(new Error("disk full"));
    useEditorStore.getState().updateContent("/doc.md", "accepted words");
    await flushMicrotasks();
    nextWrite = () => Promise.reject(new Error("disk full"));

    await expect(settleSaved("/doc.md")).rejects.toThrow("disk full");
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_commit_file", expect.anything());
  });

  test("flushSave waits for the write on its way, then writes the newer text", async () => {
    const first = deferred<unknown>();
    nextWrite = () => first.promise;
    useEditorStore.getState().updateContent("/doc.md", "one");
    useEditorStore.getState().updateContent("/doc.md", "one two");

    const flushing = flushSave("/doc.md");
    await flushMicrotasks();
    expect(writes.map((w) => w.content)).toEqual(["one"]);

    first.resolve({ path: "/doc.md", modified_at: 2 });
    await flushing;

    expect(writes.map((w) => w.content)).toEqual(["one", "one two"]);
    expect(useEditorStore.getState().openFiles.get("/doc.md")?.isDirty).toBe(false);
  });

  test("flushSave gives up on a write that never settles", async () => {
    const stuck = deferred<unknown>();
    nextWrite = () => stuck.promise;
    useEditorStore.getState().updateContent("/doc.md", "stuck");
    await flushMicrotasks();

    const flushing = flushSave("/doc.md");
    const settled = expect(flushing).rejects.toThrow(SAVE_TOO_SLOW);
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    await settled;
    await expect(flushing).rejects.toBeInstanceOf(SaveFailedError);

    // The write still lands later and reports normally.
    stuck.resolve({ path: "/doc.md", modified_at: 2 });
    await flushMicrotasks();
    expect(isSaveActive("/doc.md")).toBe(false);
  });

  test("a write that lands after a reload leaves the reloaded buffer clean and writes nothing more", async () => {
    const late = deferred<unknown>();
    nextWrite = () => late.promise;
    useEditorStore.getState().updateContent("/doc.md", "mine");
    await flushMicrotasks();
    expect(writes).toHaveLength(1);

    useEditorStore.getState().reloadFromDisk("/doc.md", "theirs");
    late.resolve({ path: "/doc.md", modified_at: 3 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5000);

    const file = useEditorStore.getState().openFiles.get("/doc.md");
    expect(file?.content).toBe("theirs");
    expect(file?.diskContent).toBe("theirs");
    expect(file?.isDirty).toBe(false);
    expect(writes).toHaveLength(1);
    expect(isSaveActive("/doc.md")).toBe(false);
  });

  test("quiesce waits for the write on its way and holds new edits until relocate", async () => {
    const inFlight = deferred<unknown>();
    nextWrite = () => inFlight.promise;
    useEditorStore.getState().updateContent("/doc.md", "before rename");
    await flushMicrotasks();

    let quiesced = false;
    const quiescing = quiesceSave("/doc.md").then(() => {
      quiesced = true;
    });
    await flushMicrotasks();
    expect(quiesced).toBe(false);

    inFlight.resolve({ path: "/doc.md", modified_at: 2 });
    await quiescing;

    // Typing while the rename is on disk must not write the old path.
    useEditorStore.getState().updateContent("/doc.md", "during rename");
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes.map((w) => w.path)).toEqual(["/doc.md"]);

    useEditorStore.getState().renameOpenFile("/doc.md", "/moved.md");
    await vi.advanceTimersByTimeAsync(1000);

    expect(writes).toEqual([
      { path: "/doc.md", content: "before rename" },
      { path: "/moved.md", content: "during rename" },
    ]);
    expect(useEditorStore.getState().openFiles.get("/moved.md")?.isDirty).toBe(false);
  });

  test("a write that fails while held is retried when the hold is released", async () => {
    const failing = deferred<unknown>();
    nextWrite = () => failing.promise;
    useEditorStore.getState().updateContent("/doc.md", "keep me");
    await flushMicrotasks();

    const quiescing = quiesceSave("/doc.md");
    failing.reject(new Error("disk full"));
    await quiescing;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(1);
    expect(isSaveActive("/doc.md")).toBe(true);

    // The rename failed, so the file stays where it is and its save runs again.
    resumeSave("/doc.md");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes.map((w) => w.content)).toEqual(["keep me", "keep me"]);
    expect(useEditorStore.getState().openFiles.get("/doc.md")?.isDirty).toBe(false);
  });

  test("a write that fails while held moves with a rename", async () => {
    const failing = deferred<unknown>();
    nextWrite = () => failing.promise;
    useEditorStore.getState().updateContent("/doc.md", "moving");
    await flushMicrotasks();

    const quiescing = quiesceSave("/doc.md");
    failing.reject(new Error("disk full"));
    await quiescing;
    useEditorStore.getState().renameOpenFile("/doc.md", "/moved.md");
    await vi.advanceTimersByTimeAsync(1000);

    expect(writes.map((w) => w.path)).toEqual(["/doc.md", "/moved.md"]);
  });

  test("a reload during a rename does not release the rename's hold", async () => {
    await quiesceSave("/doc.md");
    useEditorStore.getState().reloadFromDisk("/doc.md", "pulled");
    useEditorStore.getState().updateContent("/doc.md", "typed after the reload");
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveLength(0);

    useEditorStore.getState().renameOpenFile("/doc.md", "/moved.md");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([{ path: "/moved.md", content: "typed after the reload" }]);
  });

  test("two holds on one path need two releases", async () => {
    await quiesceSave("/doc.md");
    await quiesceSave("/doc.md");
    useEditorStore.getState().updateContent("/doc.md", "held twice");

    resumeSave("/doc.md");
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveLength(0);

    resumeSave("/doc.md");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([{ path: "/doc.md", content: "held twice" }]);
  });

  test("resume restarts held writes when the rename did not happen", async () => {
    await quiesceSave("/doc.md");
    useEditorStore.getState().updateContent("/doc.md", "held");
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveLength(0);

    resumeSave("/doc.md");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([{ path: "/doc.md", content: "held" }]);
  });

  test("an if-clean reload leaves a dirty buffer, a waiting save, or a stale compare alone", async () => {
    const store = useEditorStore.getState();
    expect(
      store.reloadFromDisk("/doc.md", "x", { policy: "if-clean", expectedDisk: "other" }),
    ).toBe(false);

    store.updateContent("/doc.md", "typing");
    expect(store.reloadFromDisk("/doc.md", "theirs", { policy: "if-clean" })).toBe(false);
    expect(useEditorStore.getState().openFiles.get("/doc.md")?.content).toBe("typing");

    await vi.advanceTimersByTimeAsync(1000);
    expect(useEditorStore.getState().openFiles.get("/doc.md")?.isDirty).toBe(false);
    expect(
      store.reloadFromDisk("/doc.md", "theirs", { policy: "if-clean", expectedDisk: "typing" }),
    ).toBe(true);
    expect(useEditorStore.getState().openFiles.get("/doc.md")?.content).toBe("theirs");
  });

  test("Accept of the other copy holds autosave until the buffer has it", async () => {
    let settle: (value: unknown) => void = () => {};
    mockedInvoke.mockImplementation((command, payload) => {
      if (command === "history_settle") return new Promise((resolve) => (settle = resolve));
      if (command === "write_file") {
        const body = payload as { path: string; content: string };
        writes.push({ path: body.path, content: body.content });
        return Promise.resolve({ path: body.path, modified_at: 2 });
      }
      return Promise.resolve(null);
    });
    const accepting = settleOverlap(
      {
        path: "/doc.md",
        localText: "initial",
        otherText: "theirs",
        deleted: false,
        versionId: "v",
      },
      "accept",
    );
    await flushMicrotasks();
    useEditorStore.getState().updateContent("/doc.md", "typed during settle");
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveLength(0);

    settle({ sent: true, conflict: false });
    await accepting;
    await vi.advanceTimersByTimeAsync(2000);

    const file = useEditorStore.getState().openFiles.get("/doc.md");
    expect(file?.content).toBe("theirs");
    expect(file?.isDirty).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("a failed save tries again on its own", async () => {
    nextWrite = () => Promise.reject(new Error("busy volume"));
    useEditorStore.getState().updateContent("/doc.md", "retry me");
    await flushMicrotasks();
    expect(writes).toHaveLength(1);
    expect(useEditorStore.getState().openFiles.get("/doc.md")?.saveError).toBe("busy volume");

    await vi.advanceTimersByTimeAsync(5000);

    expect(writes).toHaveLength(2);
    const file = useEditorStore.getState().openFiles.get("/doc.md");
    expect(file?.isDirty).toBe(false);
    expect(file?.saveError).toBeNull();
  });

  test("history copies follow a rename and stop after a delete", async () => {
    useEditorStore.getState().updateContent("/doc.md", "sent later");
    await flushMicrotasks();
    relocateSave("/doc.md", "/moved.md");
    await vi.advanceTimersByTimeAsync(HISTORY_AFTER_SAVE_MS);

    const sends = () =>
      mockedInvoke.mock.calls.filter((call) => call[0] === "history_send").map((call) => call[1]);
    expect(sends()).toEqual([{ path: "/moved.md", online: true }]);

    await vi.advanceTimersByTimeAsync(1000);
    useEditorStore.getState().updateContent("/doc.md", "deleted soon");
    await flushMicrotasks();
    discardSave("/doc.md");
    await vi.advanceTimersByTimeAsync(HISTORY_AFTER_SAVE_MS);
    expect(sends()).toEqual([{ path: "/moved.md", online: true }]);
  });
});

describe("saving every open document", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
    });
    useSettingsStore.setState({
      settings: {
        "files.trim-trailing-whitespace": false,
        "files.insert-final-newline": false,
      },
      isLoaded: true,
    });
  });

  afterEach(async () => {
    cancelSave("/a.md");
    cancelSave("/b.md");
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  /**
   * `/a.md` is dirty and its write is held at `gate`. `/b.md` is clean when
   * the save-all starts, and becomes dirty while `/a.md` is being written;
   * its own autosave fails once, so only the save-all can write it.
   */
  async function editedDuringTheWrites(saveAll: () => Promise<string[]>) {
    const gate = deferred<{ path: string; modified_at: number }>();
    const writes: Array<{ path: string; content: string }> = [];
    let aWrites = 0;
    let bWrites = 0;
    mockedInvoke.mockImplementation(async (command, payload) => {
      if (command === "read_file") {
        const { path } = payload as { path: string };
        return { path, content: `${path} on disk`, modified_at: 1 };
      }
      if (command === "write_file") {
        const write = payload as { path: string; content: string };
        writes.push(write);
        if (write.path === "/a.md") {
          aWrites += 1;
          if (aWrites === 1) return gate.promise;
        }
        if (write.path === "/b.md") {
          bWrites += 1;
          if (bWrites === 1) throw new Error("busy");
        }
        return { path: write.path, modified_at: 2 };
      }
      return null;
    });

    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFile("/b.md");
    useEditorStore.getState().updateContent("/a.md", "a edited");
    await flushMicrotasks();

    const result = saveAll();
    await flushMicrotasks();
    // Typed into /b.md while /a.md is still being written.
    useEditorStore.getState().updateContent("/b.md", "b edited");
    await flushMicrotasks();
    expect(useEditorStore.getState().openFiles.get("/b.md")?.isDirty).toBe(true);

    gate.resolve({ path: "/a.md", modified_at: 2 });
    const unsaved = await result;
    return { unsaved, writes };
  }

  test("flushAllSaves also writes a document that became dirty during the writes", async () => {
    const { unsaved, writes } = await editedDuringTheWrites(flushAllSaves);
    expect(unsaved).toEqual([]);
    const b = useEditorStore.getState().openFiles.get("/b.md");
    expect(b?.isDirty).toBe(false);
    expect(b?.diskContent).toBe("b edited");
    expect(writes.filter((write) => write.path === "/b.md").length).toBe(2);
  });

  test("saveDirtyOpenDocuments also writes a document that became dirty during the writes", async () => {
    const { unsaved } = await editedDuringTheWrites(saveDirtyOpenDocuments);
    expect(unsaved).toEqual([]);
    expect(useEditorStore.getState().openFiles.get("/b.md")?.isDirty).toBe(false);
    expect(useEditorStore.getState().openFiles.get("/a.md")?.isDirty).toBe(false);
  });
});
