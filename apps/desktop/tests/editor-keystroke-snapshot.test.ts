import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EditorSelection, EditorState } from "@codemirror/state";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  readStoredAppearance: () => null,
}));

import {
  reloadEditorChange,
  resolveEditorReload,
} from "../src/components/editor-area/editor-reload";
import { cancelSave } from "../src/lib/save";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";

const PATH = "/notes/note.md";
const RENAMED = "/notes/this-is-a-test.md";
const OTHER = "/notes/other.md";
const KEY_MS = 20;
const HEADING = "# this is a test this";
const HEADING_SNAPSHOT = "# this is a test";
const BODY = "this is a test this is a test";
const BODY_SNAPSHOT = "this is a test";

function openFile(path: string, content: string) {
  return {
    path,
    frontmatter: null,
    content,
    title: "",
    titleSource: "none" as const,
    diskContent: content,
    isDirty: false,
    isLoading: false,
    saveError: null,
    reloadVersion: 0,
    scrollPos: 0,
    cursorPos: content.length,
    displayDate: null,
    stats: { words: 0, characters: 0, paragraphs: 0 },
  };
}

function seed(content: string, path = PATH) {
  useEditorStore.setState({
    openFiles: new Map([[path, openFile(path, content)]]),
    tabs: [],
    activeTabId: null,
    activeFilePath: path,
  });
}

function file(path = PATH) {
  const open = useEditorStore.getState().openFiles.get(path);
  if (!open) throw new Error(`missing open file ${path}`);
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

async function typeFast(state: EditorState, text: string, path = PATH): Promise<EditorState> {
  const gaps: number[] = [];
  for (const ch of text) {
    await vi.advanceTimersByTimeAsync(KEY_MS);
    gaps.push(KEY_MS);
    state = insertChar(state, ch);
    useEditorStore.getState().updateContent(path, state.doc.toString());
    useEditorStore.getState().updateCursorPos(path, state.selection.main.head);
  }
  expect(Math.max(...gaps)).toBeLessThan(30);
  return state;
}

function keepLive(
  state: EditorState,
  path: string,
  incoming: string,
  pathChanged: boolean,
  previousStillOpen: boolean,
) {
  const live = state.doc.toString();
  const liveHead = state.selection.main.head;
  const decision = resolveEditorReload({
    pathChanged,
    previousStillOpen,
    live,
    liveHead,
    incoming,
  });
  if (!decision.replace) {
    if (incoming !== live) {
      useEditorStore.getState().updateContent(path, live);
      useEditorStore.getState().updateCursorPos(path, liveHead);
    }
    return state;
  }
  return state.update(reloadEditorChange(state.doc.length, liveHead, incoming, "writer.reload"))
    .state;
}

describe("editor keystrokes across title and count updates", () => {
  beforeEach(() => {
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
    cancelSave(PATH);
    cancelSave(RENAMED);
    cancelSave(OTHER);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  test("a heading typed through the count refresh keeps every key and the caret", async () => {
    seed("");
    let state = EditorState.create({
      doc: "",
      selection: EditorSelection.cursor(0),
    });

    state = await typeFast(state, HEADING_SNAPSHOT);
    await vi.advanceTimersByTimeAsync(150);

    expect(file().title).toBe("this is a test");
    expect(file().stats).toEqual({ words: 4, characters: 14, paragraphs: 1 });
    const diskAtStart = file().diskContent;

    state = await typeFast(state, HEADING.slice(HEADING_SNAPSHOT.length));
    expect(state.doc.toString()).toBe(HEADING);
    expect(file().title).toBe("this is a test this");
    expect(file().stats).toEqual({ words: 4, characters: 14, paragraphs: 1 });

    // A stale disk snapshot (the watcher reading back an older save) is
    // refused by the store — the buffer has unsaved keys, a save is queued,
    // or the disk text moved on — so the editor never sees a reload. (The
    // editor no longer adopts a shorter same-path reload; see
    // `resolveEditorReload`.)
    const versionBefore = file().reloadVersion;
    expect(
      useEditorStore.getState().reloadFromDisk(PATH, HEADING_SNAPSHOT, {
        policy: "if-clean",
        expectedDisk: diskAtStart,
      }),
    ).toBe(false);
    expect(file().reloadVersion).toBe(versionBefore);
    expect(file().content).toBe(HEADING);
    await vi.advanceTimersByTimeAsync(150);

    expect(state.doc.toString()).toBe(HEADING);
    expect(state.selection.main).toEqual(EditorSelection.cursor(HEADING.length));
    expect(file().content).toBe(HEADING);
    expect(file().title).toBe("this is a test this");
    expect(file().stats).toEqual({ words: 5, characters: 19, paragraphs: 1 });
  });

  test("a body paragraph typed through the count refresh keeps every key", async () => {
    seed("");
    let state = EditorState.create({
      doc: "",
      selection: EditorSelection.cursor(0),
    });

    state = await typeFast(state, BODY_SNAPSHOT);
    await vi.advanceTimersByTimeAsync(150);
    expect(file().title).toBe("");
    expect(file().stats.words).toBe(4);
    const diskAtStart = file().diskContent;

    state = await typeFast(state, BODY.slice(BODY_SNAPSHOT.length));
    expect(
      useEditorStore.getState().reloadFromDisk(PATH, BODY_SNAPSHOT, {
        policy: "if-clean",
        expectedDisk: diskAtStart,
      }),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(150);

    expect(state.doc.toString()).toBe(BODY);
    expect(state.selection.main.head).toBe(BODY.length);
    expect(file().content).toBe(BODY);
    expect(file().stats).toEqual({ words: 8, characters: 29, paragraphs: 1 });
  });

  test("renaming on a heading change keeps keys typed during the reopen", async () => {
    seed("");
    let state = EditorState.create({
      doc: "",
      selection: EditorSelection.cursor(0),
    });
    state = await typeFast(state, HEADING_SNAPSHOT);
    state = insertChar(state, " ");
    state = insertChar(state, "t");
    const live = state.doc.toString();

    useEditorStore.getState().renameOpenFile(PATH, RENAMED);
    expect(useEditorStore.getState().openFiles.has(PATH)).toBe(false);
    expect(file(RENAMED).content).toBe(HEADING_SNAPSHOT);

    state = keepLive(state, RENAMED, file(RENAMED).content, true, false);

    expect(state.doc.toString()).toBe(live);
    expect(state.selection.main.head).toBe(live.length);
    expect(file(RENAMED).content).toBe(live);
    expect(file(RENAMED).title).toBe("this is a test t");
  });

  test("a tab switch still loads the other file when its text is a prefix", () => {
    const live = "hello world";
    const incoming = "hello";
    useEditorStore.setState({
      openFiles: new Map([
        [PATH, openFile(PATH, live)],
        [OTHER, openFile(OTHER, incoming)],
      ]),
      tabs: [],
      activeTabId: null,
      activeFilePath: OTHER,
    });
    const decision = resolveEditorReload({
      pathChanged: true,
      previousStillOpen: true,
      live,
      liveHead: live.length,
      incoming,
    });
    expect(decision).toEqual({ content: incoming, head: incoming.length, replace: true });
  });

  test("an external edit and a cleared document still replace the editor", () => {
    expect(
      resolveEditorReload({
        pathChanged: false,
        previousStillOpen: true,
        live: HEADING,
        liveHead: HEADING.length,
        incoming: "a different note",
      }),
    ).toEqual({
      content: "a different note",
      head: "a different note".length,
      replace: true,
    });
    expect(
      resolveEditorReload({
        pathChanged: false,
        previousStillOpen: true,
        live: HEADING,
        liveHead: 4,
        incoming: "",
      }),
    ).toEqual({ content: "", head: 0, replace: true });
  });

  test("a reload that shortens the end replaces the editor and doesn't write the old text back", () => {
    // Accept of the other copy, which deleted the last paragraph.
    const live = "# Note\n\nFirst paragraph.\n\nLast paragraph.\n";
    const accepted = "# Note\n\nFirst paragraph.\n";
    seed(live);
    expect(useEditorStore.getState().reloadFromDisk(PATH, accepted, { policy: "force" })).toBe(
      true,
    );
    let state = EditorState.create({ doc: live, selection: EditorSelection.cursor(live.length) });
    state = keepLive(state, PATH, file().content, false, true);
    expect(state.doc.toString()).toBe(accepted);
    expect(file().content).toBe(accepted);
    expect(file().isDirty).toBe(false);

    // A dropped trailing newline is the same case.
    expect(
      resolveEditorReload({
        pathChanged: false,
        previousStillOpen: true,
        live: "text\n",
        liveHead: 5,
        incoming: "text",
      }),
    ).toEqual({ content: "text", head: 4, replace: true });
  });

  test("an outside edit that removes the end of the document replaces the editor", () => {
    const full = "Para one.\n\nPara two.";
    seed(full);
    const state = EditorState.create({ doc: full, selection: EditorSelection.cursor(0) });

    useEditorStore.getState().reloadFromDisk(PATH, "Para one.");

    const decision = resolveEditorReload({
      pathChanged: false,
      previousStillOpen: true,
      live: state.doc.toString(),
      liveHead: 0,
      incoming: file().content,
    });
    expect(decision.replace).toBe(true);
    expect(decision.content).toBe("Para one.");
  });
});
