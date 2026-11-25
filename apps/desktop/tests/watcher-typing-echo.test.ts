import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  readStoredAppearance: () => null,
}));

import { invoke } from "@tauri-apps/api/core";
import { headingDecorations } from "../src/components/editor-area/heading-decorations";
import { reloadEditorChange } from "../src/components/editor-area/editor-reload";
import { handleWatchedFileChange } from "../src/hooks/use-file-watcher";
import { cancelSave } from "../src/lib/save";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";

const mockedInvoke = vi.mocked(invoke);
const PATH = "/note.md";
const PREFIX = "# this is a ";
const FULL = `${PREFIX}test`;

function seed(content: string, diskContent = content) {
  useEditorStore.setState({
    openFiles: new Map([
      [
        PATH,
        {
          path: PATH,
          frontmatter: null,
          content,
          title: "",
          titleSource: "none",
          diskContent,
          isDirty: false,
          isLoading: false,
          saveError: null,
          reloadVersion: 0,
          scrollPos: 0,
          cursorPos: content.length,
          displayDate: null,
          stats: { words: 0, characters: 0, paragraphs: 0 },
        },
      ],
    ]),
    tabs: [],
    activeTabId: null,
    activeFilePath: PATH,
  });
}

function file() {
  const open = useEditorStore.getState().openFiles.get(PATH);
  if (!open) throw new Error("missing open file");
  return open;
}

function insertChar(state: EditorState, ch: string): EditorState {
  const head = state.selection.main.head;
  return state.update({
    changes: { from: head, insert: ch },
    selection: { anchor: head + ch.length },
    userEvent: "input.type",
  }).state;
}

function typeIntoStore(state: EditorState, text: string): EditorState {
  for (const ch of text) {
    state = insertChar(state, ch);
    useEditorStore.getState().updateContent(PATH, state.doc.toString());
    useEditorStore.getState().updateCursorPos(PATH, state.selection.main.head);
  }
  return state;
}

function pullReload(state: EditorState, seen: { n: number }): EditorState {
  const open = file();
  if (open.reloadVersion === seen.n) return state;
  seen.n = open.reloadVersion;
  return state.update(
    reloadEditorChange(state.doc.length, state.selection.main.head, open.content, "writer.reload"),
  ).state;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("watcher echo while typing", () => {
  const writes: string[] = [];
  const readQueue: string[] = [];
  let holdNextRead = false;
  let releaseHeld: ((content: string) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    writes.length = 0;
    readQueue.length = 0;
    holdNextRead = false;
    releaseHeld = null;

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

    mockedInvoke.mockImplementation((command: string, payload?: unknown) => {
      if (command === "write_file") {
        writes.push((payload as { content: string }).content);
        return Promise.resolve({ path: PATH, modified_at: writes.length });
      }
      if (command === "read_file") {
        if (holdNextRead) {
          holdNextRead = false;
          return new Promise((resolve) => {
            releaseHeld = (content: string) => resolve({ path: PATH, content, modified_at: 1 });
          });
        }
        const content = readQueue.shift();
        if (content === undefined) throw new Error("read_file called with an empty queue");
        return Promise.resolve({ path: PATH, content, modified_at: 1 });
      }
      return Promise.resolve(null);
    });
  });

  afterEach(async () => {
    cancelSave(PATH);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  test("rapid inserts keep the doc and caret when a watcher read returns the older save", async () => {
    seed("");
    let state = EditorState.create({
      doc: "",
      selection: EditorSelection.cursor(0),
      extensions: [markdown({ extensions: [GFM] }), headingDecorations],
    });

    state = typeIntoStore(state, PREFIX);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(file().content).toBe(PREFIX);
    expect(file().diskContent).toBe(PREFIX);
    expect(file().isDirty).toBe(false);
    expect(writes.at(-1)).toBe(PREFIX);

    holdNextRead = true;
    readQueue.push(PREFIX);
    const echo = handleWatchedFileChange(PATH);
    await flushMicrotasks();
    expect(releaseHeld).toBeTypeOf("function");

    state = typeIntoStore(state, "test");
    const seen = { n: file().reloadVersion };
    expect(state.doc.toString()).toBe(FULL);
    expect(state.selection.main.head).toBe(FULL.length);
    expect(file().isDirty).toBe(true);

    releaseHeld!("# ");
    releaseHeld = null;
    await echo;
    state = pullReload(state, seen);

    // A second echo of the prefix, the shape that leaves the caret in `tes|t`
    // if the first echo already shortened the document.
    readQueue.push(PREFIX, PREFIX);
    await handleWatchedFileChange(PATH);
    state = pullReload(state, seen);

    expect(file().content).toBe(FULL);
    expect(file().reloadVersion).toBe(0);
    expect(state.doc.toString()).toBe(FULL);
    expect(state.selection.main).toEqual(EditorSelection.cursor(FULL.length));

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(writes.at(-1)).toBe(FULL);
  });

  test("a stale older save then the real save does not leave the caret behind", async () => {
    seed(FULL);
    let state = EditorState.create({
      doc: FULL,
      selection: EditorSelection.cursor(FULL.length),
      extensions: [markdown({ extensions: [GFM] }), headingDecorations],
    });
    const seen = { n: 0 };

    readQueue.push(`${PREFIX}tes`, FULL);
    await handleWatchedFileChange(PATH);
    state = pullReload(state, seen);

    expect(file().content).toBe(FULL);
    expect(file().reloadVersion).toBe(0);
    expect(state.doc.toString()).toBe(FULL);
    expect(state.selection.main.head).toBe(FULL.length);
  });

  test("a clean file still reloads an external edit", async () => {
    seed("hello");
    readQueue.push("external edit", "external edit");
    await handleWatchedFileChange(PATH);
    expect(file().content).toBe("external edit");
    expect(file().diskContent).toBe("external edit");
    expect(file().isDirty).toBe(false);
    expect(file().reloadVersion).toBe(1);
  });

  test("an echo of the bytes just saved does not reload", async () => {
    seed("hello");
    readQueue.push("hello");
    await handleWatchedFileChange(PATH);
    expect(file().content).toBe("hello");
    expect(file().reloadVersion).toBe(0);
  });
});
