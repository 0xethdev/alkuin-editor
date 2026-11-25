import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  applyCssVarBindings: vi.fn(),
  readStoredAppearance: () => null,
}));

import { invoke } from "@tauri-apps/api/core";
import {
  SAVE_FAILED_ONE_LINE,
  SAVE_FAILED_SOME_LINE,
  UPDATE_READY_BODY,
} from "../src/features/redline-spike/margin-copy";
import { MENU_EVENT_HANDLERS } from "../src/hooks/use-menu-events";
import { onUpdaterSaveBeforeRestart } from "../src/lib/update-restart";
import { useEditorStore, type OpenFile } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";

const mockedInvoke = vi.mocked(invoke);

function rustStr(name: string): string {
  const src = readFileSync(new URL("../src-tauri/src/updater.rs", import.meta.url), "utf8");
  const match = new RegExp(`const ${name}: &str =\\s*(?:\\n\\s*)?"([^"]*)"`).exec(src);
  if (!match?.[1]) throw new Error(`missing rust const ${name}`);
  return match[1];
}

function dirtyFile(path: string, content: string, title: string): OpenFile {
  return {
    path,
    frontmatter: null,
    content,
    title,
    titleSource: title ? "h1" : "none",
    diskContent: "previous",
    isDirty: true,
    isLoading: false,
    saveError: null,
    reloadVersion: 0,
    scrollPos: 0,
    cursorPos: 0,
    displayDate: null,
    stats: { words: 1, characters: content.length, paragraphs: 1 },
  };
}

function putFile(file: OpenFile) {
  useEditorStore.setState((state) => {
    const openFiles = new Map(state.openFiles);
    openFiles.set(file.path, file);
    return { openFiles };
  });
}

describe("update restart", () => {
  let dir = "";

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "redline-update-"));
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
    expect(UPDATE_READY_BODY).toBe(rustStr("UPDATE_READY_BODY"));
    expect(UPDATE_READY_BODY).toBe("You're on {current}. Alkuin will restart to finish.");
    expect(SAVE_FAILED_ONE_LINE).toBe(rustStr("SAVE_FAILED_ONE_LINE"));
    expect(SAVE_FAILED_SOME_LINE).toBe(rustStr("SAVE_FAILED_SOME_LINE"));
    expect(MENU_EVENT_HANDLERS["updater:save-before-restart"]).toBeTypeOf("function");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("unsaved edits are on disk after the update restart path", async () => {
    const path = join(dir, "chapter.md");
    const edited = "a sentence that was not saved yet";
    putFile(dirtyFile(path, edited, "Chapter"));

    mockedInvoke.mockImplementation((command, payload) => {
      if (command === "write_file") {
        const body = payload as { path: string; content: string };
        writeFileSync(body.path, body.content);
        return Promise.resolve({ path: body.path, modified_at: 2 });
      }
      if (command === "report_update_saves") {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    const result = await onUpdaterSaveBeforeRestart();

    expect(readFileSync(path, "utf8")).toBe(edited);
    expect(result.restart).toBe(true);
    expect(result.deferred).toBe(false);
    expect(result.line).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("report_update_saves", {
      failed: [],
      missed: false,
    });
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(false);
  });

  test("a failed save does not restart, defers the update, and shows the save-fail line", async () => {
    const onePath = join(dir, "essay.md");
    const oneEdited = "essay still only in the editor";
    writeFileSync(onePath, "essay on disk");
    putFile(dirtyFile(onePath, oneEdited, "Essay"));

    mockedInvoke.mockImplementation((command) => {
      if (command === "write_file") {
        return Promise.reject(new Error("disk full"));
      }
      return Promise.resolve(null);
    });

    const one = await onUpdaterSaveBeforeRestart();

    expect(one.restart).toBe(false);
    expect(one.deferred).toBe(true);
    expect(one.line).toBe(
      "Alkuin couldn't save Essay, so it didn't restart. The update will install the next time you open Alkuin.",
    );
    expect(one.line).not.toBe(SAVE_FAILED_SOME_LINE);
    expect(readFileSync(onePath, "utf8")).toBe("essay on disk");
    expect(useEditorStore.getState().openFiles.get(onePath)?.content).toBe(oneEdited);
    expect(useEditorStore.getState().openFiles.get(onePath)?.isDirty).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("report_update_saves", {
      failed: ["Essay"],
      missed: false,
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("updater_continue_install", expect.anything());

    vi.clearAllMocks();
    useEditorStore.setState({ openFiles: new Map() });
    const essayPath = join(dir, "a-essay.md");
    const notesPath = join(dir, "b-notes.md");
    writeFileSync(essayPath, "essay on disk");
    writeFileSync(notesPath, "notes on disk");
    putFile(dirtyFile(essayPath, "unsaved essay", "Essay"));
    putFile(dirtyFile(notesPath, "unsaved notes", "Notes"));

    const many = await onUpdaterSaveBeforeRestart();

    expect(many.restart).toBe(false);
    expect(many.deferred).toBe(true);
    expect(many.line).toBe(
      "Alkuin couldn't save some of your documents, so it didn't restart. The update will install the next time you open Alkuin.",
    );
    expect(many.line).toBe(SAVE_FAILED_SOME_LINE);
    expect(readFileSync(essayPath, "utf8")).toBe("essay on disk");
    expect(readFileSync(notesPath, "utf8")).toBe("notes on disk");
    expect(useEditorStore.getState().openFiles.get(essayPath)?.content).toBe("unsaved essay");
    expect(useEditorStore.getState().openFiles.get(notesPath)?.content).toBe("unsaved notes");
    expect(mockedInvoke).toHaveBeenCalledWith("report_update_saves", {
      failed: ["Essay", "Notes"],
      missed: false,
    });
  });
});
