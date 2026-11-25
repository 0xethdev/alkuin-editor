import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const { flushSave } = vi.hoisted(() => ({ flushSave: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/save", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/save")>();
  return { ...actual, flushSave };
});

import { invoke } from "@tauri-apps/api/core";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { armGitQueueOnlineFlush, syncGitFolder, syncHistoryCopies } from "../src/lib/git-queue";
import { cancelSave } from "../src/lib/save";
import { useEditorStore, type OpenFile } from "../src/stores/editor-store";
import {
  resetEditorNoticesForTest,
  useEditorNoticeStore,
} from "../src/components/editor-area/editor-notice-store";
import { BACKUP_REFUSED_LINE, otherEditsLine } from "../src/features/redline-spike/margin-copy";
import { resetBackupNoticesForTest } from "../src/lib/history/backup-notice";
import {
  acceptNote,
  addRedlineNote,
  publishNote,
  redlineFilePathFacet,
  redlineInkTickField,
  redlineNotesField,
  rejectNote,
} from "../src/features/redline-spike";
import type { RedlineNote } from "../src/features/redline-spike";
import { useWorkspaceStore } from "../src/stores/workspace-store";

const mockedInvoke = vi.mocked(invoke);
const mockedFlush = vi.mocked(flushSave);
const PATH = "/repo/notes/draft.md";
const ROOT = "/repo";
const ORIGINAL = "This is really very important.";
const PROPOSED = "This is important.";
const LOCK = "fatal: Unable to create '/repo/.git/index.lock': File exists.";
const SHARE_MESSAGE = "Accepted suggestion in draft.md";

function note(overrides: Partial<RedlineNote> = {}): RedlineNote {
  return {
    id: "redline-1",
    from: 0,
    to: ORIGINAL.length,
    original: ORIGINAL,
    proposed: null,
    intent: null,
    instruction: null,
    status: "open",
    error: null,
    git: null,
    publish: null,
    ...overrides,
  };
}

function viewAt(path: string) {
  let state = EditorState.create({
    doc: ORIGINAL,
    extensions: [redlineNotesField, redlineInkTickField, redlineFilePathFacet.of(() => path)],
  });
  return {
    get state() {
      return state;
    },
    dom: { isConnected: true },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  };
}

function installWindow(): EventTarget {
  const target = new EventTarget();
  Object.assign(target, {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  vi.stubGlobal("window", target);
  return target;
}

function gitStatus() {
  return {
    repo_root: ROOT,
    clean: false,
    porcelain: " M notes/draft.md",
    diff: "",
    error: null,
    sharing: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFlush.mockResolvedValue(undefined);
  useWorkspaceStore.setState({ root: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline git queue", () => {
  test("a transient Accept commit stays on disk, queues a commit, and does not push", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_commit_file") {
        return { committed: false, commit_sha: null, error: LOCK, retry: true };
      }
      if (command === "git_enqueue_op") return true;
      if (command === "git_file_status") return gitStatus();
      return undefined;
    });

    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    await acceptNote(view as never, "redline-1");

    expect(mockedFlush).toHaveBeenCalledWith(PATH);
    expect(view.state.doc.toString()).toBe(PROPOSED);
    expect(mockedInvoke).toHaveBeenCalledWith("git_commit_file", { path: PATH });
    expect(mockedInvoke).toHaveBeenCalledWith("git_enqueue_op", {
      path: PATH,
      op: "commit",
      message: null,
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      "git_enqueue_op",
      expect.objectContaining({ op: "push" }),
    );
  });

  test("reconnect flushes a queued Accept commit and still does not push", async () => {
    const win = installWindow();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_commit_file") {
        return { committed: false, commit_sha: null, error: LOCK, retry: true };
      }
      if (command === "git_enqueue_op") return true;
      if (command === "git_file_status") return gitStatus();
      if (command === "git_flush_queue") return undefined;
      return undefined;
    });

    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    await acceptNote(view as never, "redline-1");
    const stop = armGitQueueOnlineFlush(() => ROOT);
    win.dispatchEvent(new Event("online"));

    expect(mockedInvoke).toHaveBeenCalledWith("git_flush_queue", { path: ROOT });
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    expect(view.state.doc.toString()).toBe(PROPOSED);
    stop();
  });

  test("opening the folder flushes the queue and an Accept commit still does not push", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_commit_file") {
        return { committed: false, commit_sha: null, error: LOCK, retry: true };
      }
      if (command === "git_enqueue_op") return true;
      if (command === "git_file_status") return gitStatus();
      if (command === "open_workspace") {
        return { root: ROOT, name: "repo", file_count: 0, epoch: 1 };
      }
      if (command === "read_directory" || command === "get_recent_workspaces") return [];
      if (command === "git_flush_queue") return undefined;
      return null;
    });

    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    await acceptNote(view as never, "redline-1");
    await useWorkspaceStore.getState().openWorkspace(ROOT);
    await useWorkspaceStore.getState().restoreFromBundle({
      workspace: { root: ROOT, name: "repo", file_count: 0, epoch: 2 },
      entries: [],
      recent_workspaces: [],
      session: null,
      active_file: null,
      open_file: null,
    });

    // The second open's sync runs after the first one, not alongside it.
    const flushes = () =>
      mockedInvoke.mock.calls.filter(([command]) => command === "git_flush_queue");
    await vi.waitFor(() =>
      expect(flushes()).toEqual([
        ["git_flush_queue", { path: ROOT }],
        ["git_flush_queue", { path: ROOT }],
      ]),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    expect(view.state.doc.toString()).toBe(PROPOSED);
  });

  test("a transient Share push queues a push, and reconnect flushes that op", async () => {
    const win = installWindow();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_publish_file") {
        return {
          committed: true,
          pushed: false,
          commit_sha: "abc",
          error: "Failed to connect to 127.0.0.1 port 1",
          retry: true,
        };
      }
      if (command === "git_enqueue_op") return true;
      if (command === "git_flush_queue") return undefined;
      return undefined;
    });

    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "accepted" }),
      ),
    });
    await publishNote(view as never, "redline-1");
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(mockedInvoke).toHaveBeenCalledWith("git_publish_file", {
      path: PATH,
      message: SHARE_MESSAGE,
    });
    expect(mockedInvoke).toHaveBeenCalledWith("git_enqueue_op", {
      path: PATH,
      op: "push",
      message: SHARE_MESSAGE,
    });

    mockedInvoke.mockClear();
    const stop = armGitQueueOnlineFlush(() => ROOT);
    win.dispatchEvent(new Event("online"));
    expect(mockedInvoke).toHaveBeenCalledWith("git_flush_queue", { path: ROOT });
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      "git_enqueue_op",
      expect.objectContaining({ op: "commit" }),
    );
    stop();
  });

  test("permanent commit and share failures are not queued", async () => {
    installWindow();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_commit_file") {
        return { committed: false, commit_sha: null, error: "not a git repository", retry: false };
      }
      if (command === "git_file_status") {
        return { ...gitStatus(), repo_root: null, sharing: false, error: "not a git repository" };
      }
      return undefined;
    });

    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    await acceptNote(view as never, "redline-1");
    expect(mockedFlush).toHaveBeenCalledWith(PATH);
    expect(view.state.doc.toString()).toBe(PROPOSED);
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_enqueue_op", expect.anything());

    mockedInvoke.mockClear();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_publish_file") {
        return {
          committed: true,
          pushed: false,
          commit_sha: "abc",
          error: "no origin remote (GitHub publish skipped)",
          retry: false,
        };
      }
      return undefined;
    });
    const shared = viewAt(PATH);
    shared.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "accepted" }),
      ),
    });
    await publishNote(shared as never, "redline-1");
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_enqueue_op", expect.anything());
  });

  test("a thrown git failure and Reject or intent none enqueue nothing", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_commit_file") throw new Error("git: No such file or directory");
      if (command === "git_file_status") return gitStatus();
      return undefined;
    });
    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    await acceptNote(view as never, "redline-1");
    expect(mockedFlush).toHaveBeenCalledWith(PATH);
    expect(view.state.doc.toString()).toBe(PROPOSED);
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_enqueue_op", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());

    mockedInvoke.mockClear();
    mockedFlush.mockClear();
    const comment = viewAt(PATH);
    comment.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: "left as written", intent: "none", status: "pending" }),
      ),
    });
    await acceptNote(comment as never, "redline-1");
    const rejected = viewAt(PATH);
    rejected.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    expect(rejectNote(rejected as never, "redline-1")).toBe(true);
    expect(mockedFlush).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function pullResult(overrides: Record<string, unknown> = {}) {
  return {
    updated: false,
    skipped: false,
    conflict: false,
    error: null,
    retry: false,
    ...overrides,
  };
}

describe("sync runs", () => {
  function file(path: string, overrides: Partial<OpenFile> = {}): OpenFile {
    return {
      path,
      frontmatter: null,
      content: "here",
      title: "",
      titleSource: "none",
      diskContent: "here",
      isDirty: false,
      isLoading: false,
      saveError: null,
      reloadVersion: 0,
      scrollPos: 0,
      cursorPos: 0,
      displayDate: null,
      stats: { words: 1, characters: 4, paragraphs: 1 },
      ...overrides,
    };
  }

  function showFiles(files: OpenFile[]) {
    useEditorStore.setState({
      openFiles: new Map(files.map((entry) => [entry.path, entry])),
      tabs: files.map((entry, index) => ({
        id: `tab-${index}`,
        location: { kind: "file" as const, path: entry.path },
        back: [],
        forward: [],
      })),
      activeTabId: "tab-0",
      activeFilePath: files[0]?.path ?? null,
    });
  }

  beforeEach(() => {
    vi.stubGlobal("navigator", { onLine: true });
    useWorkspaceStore.setState({ root: ROOT, workspaceGeneration: 5 });
  });

  test("a request during a run waits for it, then runs once more", async () => {
    let releaseFlush: () => void = () => {};
    let flushCalls = 0;
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "history_flush") {
        flushCalls += 1;
        if (flushCalls === 1) await new Promise<void>((resolve) => (releaseFlush = resolve));
        return { overlaps: [] };
      }
      return null;
    });

    const first = syncHistoryCopies(ROOT);
    const second = syncHistoryCopies(ROOT);
    const third = syncHistoryCopies(ROOT);
    expect(flushCalls).toBe(1);
    releaseFlush();
    await Promise.all([first, second, third]);

    expect(flushCalls).toBe(2);
  });

  test("results are dropped when the folder closed during the pull", async () => {
    showFiles([file(PATH)]);
    let releasePull: () => void = () => {};
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "history_flush") return { overlaps: [] };
      if (command === "history_pull") {
        await new Promise<void>((resolve) => (releasePull = resolve));
        return { wrote: [PATH], removed: [], suggestions: [] };
      }
      if (command === "read_file") return { path: PATH, content: "pulled", modified_at: 2 };
      return null;
    });

    const syncing = syncHistoryCopies(ROOT);
    await vi.waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("history_pull", expect.anything()),
    );
    useWorkspaceStore.setState({ root: null, workspaceGeneration: 6 });
    releasePull();
    await syncing;

    expect(mockedInvoke).not.toHaveBeenCalledWith("read_file", expect.anything());
    expect(useEditorStore.getState().openFiles.get(PATH)?.content).toBe("here");
  });

  test("a pulled deletion leaves a document with unsaved words open", async () => {
    const other = "/repo/notes/clean.md";
    showFiles([file(PATH, { content: "unsaved", isDirty: true }), file(other)]);
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "history_flush") return { overlaps: [] };
      if (command === "history_pull") return { wrote: [], removed: [PATH, other], suggestions: [] };
      return null;
    });

    await syncHistoryCopies(ROOT);

    const paths = useEditorStore
      .getState()
      .tabs.flatMap((tab) => (tab.location.kind === "file" ? [tab.location.path] : []));
    expect(paths).toEqual([PATH]);
    expect(useEditorStore.getState().openFiles.get(PATH)?.content).toBe("unsaved");
    cancelSave(PATH);
  });

  test("each queued copy the server refused for good is named, once", async () => {
    resetBackupNoticesForTest();
    resetEditorNoticesForTest();
    const recipes = "/repo/notes/Mom's recipes.md";
    const answers = "/repo/notes/Q&A.md";
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "history_flush") {
        return { overlaps: [], dropped: [recipes, answers], stopped: [recipes, answers] };
      }
      return null;
    });
    const line = (name: string) => BACKUP_REFUSED_LINE.replace("{document}", name);

    await syncHistoryCopies(ROOT);
    // One slot: the second line waits until the first is read.
    expect(useEditorNoticeStore.getState().toast).toBe(line("Mom's recipes.md"));
    useEditorNoticeStore.getState().dismissNotice();
    expect(useEditorNoticeStore.getState().toast).toBe(line("Q&A.md"));
    useEditorNoticeStore.getState().dismissNotice();

    await syncHistoryCopies(ROOT);
    expect(useEditorNoticeStore.getState().toast).toBeNull();
  });

  test("lines naming files of a folder go when the folder changes", async () => {
    resetBackupNoticesForTest();
    resetEditorNoticesForTest();
    const refused = ["/repo/notes/a.md", "/repo/notes/b.md"];
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "history_flush") return { overlaps: [], dropped: refused, stopped: refused };
      return null;
    });
    await syncHistoryCopies(ROOT);
    expect(useEditorNoticeStore.getState().toast).not.toBeNull();

    useWorkspaceStore.setState((state) => ({
      workspaceGeneration: state.workspaceGeneration + 1,
    }));

    // Neither the line showing nor the one waiting is left for the next folder.
    expect(useEditorNoticeStore.getState().toast).toBeNull();
    useEditorNoticeStore.getState().dismissNotice();
    expect(useEditorNoticeStore.getState().toast).toBeNull();
  });
});

describe("pull on reconnect", () => {
  test("opening a folder with a remote flushes before the pull", async () => {
    const order: string[] = [];
    mockedInvoke.mockImplementation(async (command) => {
      order.push(String(command));
      if (command === "open_workspace") {
        return { root: ROOT, name: "repo", file_count: 0, epoch: 1 };
      }
      if (command === "read_directory" || command === "get_recent_workspaces") return [];
      if (command === "git_file_status") return gitStatus();
      if (command === "git_pull") return pullResult({ updated: true });
      if (command === "git_flush_queue") return undefined;
      return null;
    });

    await useWorkspaceStore.getState().openWorkspace(ROOT);
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith("git_pull", { path: ROOT });
    expect(order.indexOf("git_flush_queue")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("git_flush_queue")).toBeLessThan(order.indexOf("git_pull"));
    expect(order.indexOf("git_file_status")).toBeLessThan(order.indexOf("git_pull"));
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
  });

  test("opening a folder without a remote does not pull", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "open_workspace") {
        return { root: ROOT, name: "repo", file_count: 0, epoch: 1 };
      }
      if (command === "read_directory" || command === "get_recent_workspaces") return [];
      if (command === "git_file_status") return { ...gitStatus(), sharing: false };
      if (command === "git_flush_queue") return undefined;
      return null;
    });

    await useWorkspaceStore.getState().openWorkspace(ROOT);
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith("git_flush_queue", { path: ROOT });
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_pull", expect.anything());
  });

  test("reconnect with a remote flushes before the pull", async () => {
    const win = installWindow();
    const order: string[] = [];
    mockedInvoke.mockImplementation(async (command) => {
      order.push(String(command));
      if (command === "git_file_status") return gitStatus();
      if (command === "git_pull") return pullResult({ updated: true });
      if (command === "git_flush_queue") return undefined;
      return undefined;
    });

    const stop = armGitQueueOnlineFlush(() => ROOT);
    win.dispatchEvent(new Event("online"));
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith("git_pull", { path: ROOT });
    expect(order.indexOf("git_flush_queue")).toBeLessThan(order.indexOf("git_pull"));
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    stop();
  });

  test("a conflict is surfaced and does not clobber", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_file_status") return gitStatus();
      if (command === "git_pull") return pullResult({ conflict: true });
      if (command === "git_flush_queue") return undefined;
      return undefined;
    });

    useEditorNoticeStore.setState({ message: null });
    await syncGitFolder(ROOT);
    expect(mockedInvoke).toHaveBeenCalledWith("git_flush_queue", { path: ROOT });
    expect(mockedInvoke).toHaveBeenCalledWith("git_pull", { path: ROOT });
    const commands = mockedInvoke.mock.calls.map(([command]) => String(command));
    expect(commands).not.toContain("write_file");
    expect(commands).not.toContain("git_checkout");
    expect(commands.some((command) => /reset|theirs|checkout/i.test(command))).toBe(false);
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_enqueue_op", expect.anything());
    expect(otherEditsLine()).toBeNull();
    expect(useEditorNoticeStore.getState().message).toBeNull();
  });

  test("an Accept disk write survives a failed pull", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_commit_file") {
        return { committed: true, commit_sha: "abc", error: null, retry: false };
      }
      if (command === "git_file_status") return gitStatus();
      if (command === "git_pull") {
        return pullResult({
          error: "Failed to connect to 127.0.0.1 port 1",
          retry: true,
        });
      }
      if (command === "git_enqueue_op") return true;
      if (command === "git_flush_queue") return undefined;
      return undefined;
    });

    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    await acceptNote(view as never, "redline-1");
    expect(mockedFlush).toHaveBeenCalledTimes(1);
    expect(mockedFlush).toHaveBeenCalledWith(PATH);
    expect(view.state.doc.toString()).toBe(PROPOSED);

    await syncGitFolder(ROOT);
    expect(mockedFlush).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe(PROPOSED);
    expect(mockedInvoke).toHaveBeenCalledWith("git_pull", { path: ROOT });
    expect(mockedInvoke).toHaveBeenCalledWith("git_enqueue_op", {
      path: ROOT,
      op: "pull",
      message: null,
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("write_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    const commands = mockedInvoke.mock.calls.map(([command]) => String(command));
    expect(commands.some((command) => /reset|theirs|checkout/i.test(command))).toBe(false);
  });
});
