import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  readStoredAppearance: () => null,
}));

import { invoke } from "@tauri-apps/api/core";
import { renameHoldingSaves } from "../src/components/sidebar/use-move-entry";
import { renameOpenFile, rewritePathPrefix } from "../src/hooks/editor-api";
import { cancelSave, resumeSave } from "../src/lib/save";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";
import {
  canMoveInto,
  computeMovePath,
  resolveDropDir,
  resolveDropRange,
} from "../src/components/sidebar/tree-move";
import type { DirEntry } from "../src/types/fs";

const ROOT = "/vault";

function entry(path: string, is_dir: boolean): DirEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { name, path, is_dir, is_markdown: !is_dir, modified_at: 0, created_at: 0, title: null };
}

describe("resolveDropDir", () => {
  test("a folder target resolves to itself", () => {
    expect(resolveDropDir(entry("/vault/notes", true), ROOT)).toBe("/vault/notes");
  });

  test("a file target resolves to its parent folder", () => {
    expect(resolveDropDir(entry("/vault/notes/todo.md", false), ROOT)).toBe("/vault/notes");
  });

  test("no target resolves to the workspace root", () => {
    expect(resolveDropDir(null, ROOT)).toBe(ROOT);
  });
});

describe("canMoveInto", () => {
  test("rejects moving an item into the folder it already lives in", () => {
    expect(canMoveInto("/vault/a.md", false, "/vault")).toBe(false);
    expect(canMoveInto("/vault/notes/a.md", false, "/vault/notes")).toBe(false);
  });

  test("allows moving a file into a different folder", () => {
    expect(canMoveInto("/vault/a.md", false, "/vault/notes")).toBe(true);
  });

  test("rejects dropping a folder onto itself", () => {
    expect(canMoveInto("/vault/notes", true, "/vault/notes")).toBe(false);
  });

  test("rejects dropping a folder into one of its descendants", () => {
    expect(canMoveInto("/vault/notes", true, "/vault/notes/sub")).toBe(false);
    expect(canMoveInto("/vault/notes", true, "/vault/notes/sub/deep")).toBe(false);
  });

  test("allows moving a folder into an unrelated folder", () => {
    expect(canMoveInto("/vault/notes", true, "/vault/archive")).toBe(true);
  });

  test("does not treat a sibling with a shared name prefix as a descendant", () => {
    // "/vault/notes-2" must not count as inside "/vault/notes".
    expect(canMoveInto("/vault/notes", true, "/vault/notes-2")).toBe(true);
  });
});

describe("computeMovePath", () => {
  test("joins the destination dir with the entry name", () => {
    expect(computeMovePath(entry("/vault/a.md", false), "/vault/notes")).toBe("/vault/notes/a.md");
    expect(computeMovePath(entry("/vault/notes", true), "/vault/archive")).toBe(
      "/vault/archive/notes",
    );
  });
});

describe("resolveDropRange", () => {
  // A flattened tree:
  //   notes/            depth 0   (expanded)
  //     todo.md         depth 1
  //     sub/            depth 1   (expanded)
  //       deep.md       depth 2
  //   archive/          depth 0   (collapsed)
  //   readme.md         depth 0
  const rows = [
    { path: "/vault/notes", depth: 0 },
    { path: "/vault/notes/todo.md", depth: 1 },
    { path: "/vault/notes/sub", depth: 1 },
    { path: "/vault/notes/sub/deep.md", depth: 2 },
    { path: "/vault/archive", depth: 0 },
    { path: "/vault/readme.md", depth: 0 },
  ];

  test("spans an expanded folder and all of its nested descendants", () => {
    expect(resolveDropRange(rows, "/vault/notes", ROOT)).toEqual({
      startPath: "/vault/notes",
      endPath: "/vault/notes/sub/deep.md",
    });
  });

  test("stops at the folder's own subtree (a nested folder)", () => {
    expect(resolveDropRange(rows, "/vault/notes/sub", ROOT)).toEqual({
      startPath: "/vault/notes/sub",
      endPath: "/vault/notes/sub/deep.md",
    });
  });

  test("a collapsed folder spans only itself", () => {
    expect(resolveDropRange(rows, "/vault/archive", ROOT)).toEqual({
      startPath: "/vault/archive",
      endPath: "/vault/archive",
    });
  });

  test("the root spans the whole tree", () => {
    expect(resolveDropRange(rows, ROOT, ROOT)).toEqual({
      startPath: "/vault/notes",
      endPath: "/vault/readme.md",
    });
  });

  test("returns null when the destination isn't visible or the tree is empty", () => {
    expect(resolveDropRange(rows, "/vault/missing", ROOT)).toBeNull();
    expect(resolveDropRange([], ROOT, ROOT)).toBeNull();
  });
});

describe("renameHoldingSaves", () => {
  const mockedInvoke = vi.mocked(invoke);
  const writes: { path: string; content: string }[] = [];
  const calls: string[] = [];
  let nextWrite: (() => Promise<unknown>) | null = null;
  let renameFails = false;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function file(path: string) {
    return useEditorStore.getState().openFiles.get(path);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    writes.length = 0;
    calls.length = 0;
    nextWrite = null;
    renameFails = false;
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
    });
    useSettingsStore.setState({
      settings: { "files.trim-trailing-whitespace": false, "files.insert-final-newline": false },
      isLoaded: true,
    });
    mockedInvoke.mockImplementation((command, args) => {
      calls.push(command);
      if (command === "read_file") {
        const path = (args as { path: string }).path;
        return Promise.resolve({ path, content: "old", modified_at: 1 });
      }
      if (command === "write_file") {
        const body = args as { path: string; content: string };
        writes.push({ path: body.path, content: body.content });
        if (nextWrite) {
          const run = nextWrite;
          nextWrite = null;
          return run();
        }
        return Promise.resolve({ path: body.path, modified_at: 2 });
      }
      if (command === "rename_entry") {
        return renameFails ? Promise.reject(new Error("disk full")) : Promise.resolve(null);
      }
      return Promise.resolve(null);
    });
  });

  afterEach(async () => {
    for (const path of [
      "/vault/a.md",
      "/vault/b.md",
      "/vault/notes",
      "/vault/notes/a.md",
      "/vault/notes-2/b.md",
      "/vault/moved/a.md",
    ]) {
      cancelSave(path);
      resumeSave(path);
    }
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  /** Open `path` and type twice: the first edit writes at once, the second
   *  waits behind it and then for the throttle, as a rename meets it. */
  async function openTyping(typed: Record<string, string>) {
    for (const path of Object.keys(typed)) await useEditorStore.getState().openFile(path);
    await vi.advanceTimersByTimeAsync(1000);
    for (const [path, text] of Object.entries(typed)) {
      useEditorStore.getState().updateContent(path, `${text} draft`);
      useEditorStore.getState().updateContent(path, text);
    }
    await vi.advanceTimersByTimeAsync(0);
    for (const path of Object.keys(typed)) expect(file(path)?.isDirty).toBe(true);
  }

  test("waits for the write on its way, then renames, and newer words follow the file", async () => {
    await useEditorStore.getState().openFile("/vault/a.md");
    await vi.advanceTimersByTimeAsync(1000);
    const first = deferred<unknown>();
    nextWrite = () => first.promise;
    useEditorStore.getState().updateContent("/vault/a.md", "one");
    useEditorStore.getState().updateContent("/vault/a.md", "one two");

    const moving = renameHoldingSaves("/vault/a.md", "/vault/b.md");
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).not.toContain("rename_entry");

    first.resolve({ path: "/vault/a.md", modified_at: 2 });
    await moving;
    expect(calls.indexOf("rename_entry")).toBeGreaterThan(calls.indexOf("write_file"));

    // Held: the newer words never land at the old path.
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toEqual([{ path: "/vault/a.md", content: "one" }]);

    renameOpenFile("/vault/a.md", "/vault/b.md");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([
      { path: "/vault/a.md", content: "one" },
      { path: "/vault/b.md", content: "one two" },
    ]);
    expect(file("/vault/b.md")?.isDirty).toBe(false);
  });

  test("holds every open file under a moved folder, and only those", async () => {
    await openTyping({ "/vault/notes/a.md": "a words", "/vault/notes-2/b.md": "b words" });
    writes.length = 0;

    await renameHoldingSaves("/vault/notes", "/vault/moved");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([{ path: "/vault/notes-2/b.md", content: "b words" }]);

    rewritePathPrefix("/vault/notes", "/vault/moved");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([
      { path: "/vault/notes-2/b.md", content: "b words" },
      { path: "/vault/moved/a.md", content: "a words" },
    ]);
  });

  test("a failed rename gives the hold back, so the words save at the old path", async () => {
    await openTyping({ "/vault/a.md": "typed just now" });
    writes.length = 0;
    renameFails = true;

    await expect(renameHoldingSaves("/vault/a.md", "/vault/b.md")).rejects.toThrow("disk full");
    await vi.advanceTimersByTimeAsync(1000);

    expect(writes).toEqual([{ path: "/vault/a.md", content: "typed just now" }]);
    expect(file("/vault/a.md")?.isDirty).toBe(false);
  });
});
