import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const { flushSave, SaveFailedError } = vi.hoisted(() => ({
  flushSave: vi.fn(),
  SaveFailedError: class SaveFailedError extends Error {
    name = "SaveFailedError";
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/save", () => ({
  flushSave,
  SaveFailedError,
  registerSaveStore: () => {},
}));

import { invoke } from "@tauri-apps/api/core";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { useEditorNoticeStore } from "../src/components/editor-area/editor-notice-store";
import { SHARE_DECIDE_FAILED } from "../src/features/document-share/copy";
import {
  ACCEPT_SAVE_FAILED_LINE,
  ACCEPT_TEXT_CHANGED_LINE,
} from "../src/features/redline-spike/margin-copy";
import { SaveFailedError as MockedSaveFailedError } from "../src/lib/save";
import {
  acceptNote,
  addRedlineNote,
  redlineFilePathFacet,
  redlineInkTickField,
  redlineNotesField,
  rejectNote,
} from "../src/features/redline-spike";
import type { RedlineNote } from "../src/features/redline-spike";

const mockedInvoke = vi.mocked(invoke);
const mockedFlush = vi.mocked(flushSave);
const PATH = "/repo/notes/draft.md";
const ORIGINAL = "This is really very important.";
const PROPOSED = "This is important.";

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

beforeEach(() => {
  vi.clearAllMocks();
  mockedFlush.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Accept commits one file and does not push", () => {
  test("replace Accept flushes, commits that path, then refreshes status", async () => {
    const order: string[] = [];
    mockedFlush.mockImplementation(async () => {
      order.push("flush");
    });
    mockedInvoke.mockImplementation(async (command) => {
      order.push(String(command));
      if (command === "git_commit_file") {
        return { committed: true, commit_sha: "abc", error: null };
      }
      if (command === "git_file_status") {
        return {
          repo_root: "/repo",
          clean: true,
          porcelain: "",
          diff: "",
          error: null,
          sharing: true,
        };
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

    expect(view.state.doc.toString()).toBe(PROPOSED);
    expect(mockedFlush).toHaveBeenCalledWith(PATH);
    expect(mockedInvoke).toHaveBeenCalledWith("git_commit_file", { path: PATH });
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_enqueue_op", expect.anything());
    expect(order.indexOf("flush")).toBeLessThan(order.indexOf("git_commit_file"));
    expect(order.indexOf("git_commit_file")).toBeLessThan(order.indexOf("git_file_status"));
    const saved = view.state.field(redlineNotesField)[0];
    expect(saved?.status).toBe("accepted");
    expect(saved?.git?.clean).toBe(true);
    expect(saved?.git?.sharing).toBe(true);
  });

  test("a failed commit leaves the accepted text and samples status", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_commit_file") throw new Error("git: No such file or directory");
      if (command === "git_file_status") {
        return {
          repo_root: null,
          clean: false,
          porcelain: " M notes/draft.md",
          diff: "",
          error: "not a git repository",
          sharing: false,
        };
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
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_enqueue_op", expect.anything());
    const saved = view.state.field(redlineNotesField)[0];
    expect(saved?.git?.clean).toBe(false);
    expect(saved?.git?.error).toBe("not a git repository");
  });

  test("a commit error result leaves the accepted text and samples status", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_commit_file") {
        return { committed: false, commit_sha: null, error: "not a git repository" };
      }
      if (command === "git_file_status") {
        return {
          repo_root: null,
          clean: true,
          porcelain: "",
          diff: "",
          error: "not a git repository",
          sharing: false,
        };
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
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_enqueue_op", expect.anything());
    expect(view.state.field(redlineNotesField)[0]?.git?.error).toBe("not a git repository");
  });

  test("a failed disk write does not commit", async () => {
    vi.stubGlobal("window", globalThis);
    useEditorNoticeStore.getState().dismissNotice();
    mockedFlush.mockRejectedValue(new MockedSaveFailedError(PATH, "disk full"));
    mockedInvoke.mockResolvedValue({
      repo_root: "/repo",
      clean: false,
      porcelain: "",
      diff: "",
      error: null,
      sharing: false,
    });

    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    await acceptNote(view as never, "redline-1");

    expect(view.state.doc.toString()).toBe(PROPOSED);
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_commit_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("history_send", expect.anything());
    expect(useEditorNoticeStore.getState().message).toBe(ACCEPT_SAVE_FAILED_LINE);
  });

  test("intent none and Reject do not flush or commit", async () => {
    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: "left as written", intent: "none", status: "pending" }),
      ),
    });
    await acceptNote(view as never, "redline-1");
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(mockedFlush).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalled();

    const rejected = viewAt(PATH);
    rejected.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    expect(rejectNote(rejected as never, "redline-1")).toBe(true);
    expect(rejected.state.doc.toString()).toBe(ORIGINAL);
    expect(mockedFlush).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  test("insert Accept commits and does not publish", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "git_commit_file") return { committed: true, commit_sha: "def", error: null };
      if (command === "git_file_status") {
        return {
          repo_root: "/repo",
          clean: true,
          porcelain: "",
          diff: "",
          error: null,
          sharing: false,
        };
      }
      return undefined;
    });
    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({
          from: ORIGINAL.length,
          to: ORIGINAL.length,
          proposed: " also.",
          intent: "insert",
          status: "pending",
        }),
      ),
    });
    await acceptNote(view as never, "redline-1");
    expect(view.state.doc.toString()).toBe(`${ORIGINAL} also.`);
    expect(view.state.field(redlineNotesField)).toHaveLength(1);
    expect(view.state.field(redlineNotesField)[0]?.status).toBe("accepted");
    expect(mockedInvoke).toHaveBeenCalledWith("git_commit_file", { path: PATH });
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_publish_file", expect.anything());
  });

  test("a pending insertion stays in the margin when the writer types", () => {
    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({
          id: "typed",
          from: ORIGINAL.length,
          to: ORIGINAL.length,
          proposed: "\n\nThis is why we built Alkuin!",
          intent: "insert",
          status: "pending",
          person: "Paloma",
          shareAccept: true,
        }),
      ),
    });
    view.dispatch({ changes: { from: ORIGINAL.length, to: ORIGINAL.length, insert: "!" } });
    const saved = view.state.field(redlineNotesField);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.intent).toBe("insert");
    expect(saved[0]?.from).toBe(saved[0]?.to);
    expect(saved[0]?.proposed).toContain("This is why we built Alkuin!");
  });
});

const SHARE_ID = "11111111-1111-4111-8111-111111111111";

function shareNote(overrides: Partial<RedlineNote> = {}): RedlineNote {
  return note({
    id: SHARE_ID,
    proposed: PROPOSED,
    intent: "replace",
    status: "pending",
    shareChangeId: SHARE_ID,
    shareAccept: true,
    person: "Paloma",
    ...overrides,
  });
}

describe("owner decide on a collaborator redline", () => {
  test("accept saves the decision and writes the passage", async () => {
    useEditorNoticeStore.getState().dismissNotice();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "share_decide") return null;
      if (command === "git_commit_file") return { committed: true, commit_sha: "abc", error: null };
      if (command === "git_file_status") {
        return {
          repo_root: "/repo",
          clean: true,
          porcelain: "",
          diff: "",
          error: null,
          sharing: true,
        };
      }
      return undefined;
    });
    const view = viewAt(PATH);
    view.dispatch({ effects: addRedlineNote.of(shareNote()) });
    const saved = await acceptNote(view as never, SHARE_ID);
    expect(saved).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("share_decide", { id: SHARE_ID, accept: true });
    expect(view.state.doc.toString()).toBe(PROPOSED);
    expect(useEditorNoticeStore.getState().message).not.toBe(SHARE_DECIDE_FAILED);
  });

  test("a failed accept leaves the page and can be tried again", async () => {
    useEditorNoticeStore.getState().dismissNotice();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "share_decide") throw new Error("unreachable");
      return undefined;
    });
    const view = viewAt(PATH);
    view.dispatch({ effects: addRedlineNote.of(shareNote()) });
    const saved = await acceptNote(view as never, SHARE_ID);
    expect(saved).toBe(false);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(view.state.field(redlineNotesField)[0]?.status).toBe("pending");
    expect(useEditorNoticeStore.getState().message).toBe(SHARE_DECIDE_FAILED);
  });

  test("reject saves, and a failure leaves the card", async () => {
    useEditorNoticeStore.getState().dismissNotice();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "share_decide") return null;
      return undefined;
    });
    const view = viewAt(PATH);
    view.dispatch({ effects: addRedlineNote.of(shareNote()) });
    expect(rejectNote(view as never, SHARE_ID)).toBe(true);
    await vi.waitFor(() => {
      expect(view.state.field(redlineNotesField)).toHaveLength(0);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("share_decide", { id: SHARE_ID, accept: false });

    useEditorNoticeStore.getState().dismissNotice();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "share_decide") throw new Error("unavailable");
      return undefined;
    });
    const stuck = viewAt(PATH);
    stuck.dispatch({ effects: addRedlineNote.of(shareNote()) });
    expect(rejectNote(stuck as never, SHARE_ID)).toBe(true);
    await vi.waitFor(() => {
      expect(useEditorNoticeStore.getState().message).toBe(SHARE_DECIDE_FAILED);
    });
    expect(stuck.state.field(redlineNotesField)).toHaveLength(1);
    expect(stuck.state.doc.toString()).toBe(ORIGINAL);
  });
});

describe("Accept checks the words are still there", () => {
  test("Accept refuses when the original words changed", async () => {
    useEditorNoticeStore.getState().dismissNotice();
    mockedInvoke.mockImplementation(async () => undefined);
    const view = viewAt(PATH);
    view.dispatch({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    });
    view.dispatch({ changes: { from: 8, to: 8, insert: "XX" } });
    const edited = view.state.doc.toString();
    const saved = await acceptNote(view as never, "redline-1");
    expect(saved).toBe(false);
    expect(view.state.doc.toString()).toBe(edited);
    expect(mockedInvoke).not.toHaveBeenCalledWith("git_commit_file", expect.anything());
    expect(useEditorNoticeStore.getState().message).toBe(ACCEPT_TEXT_CHANGED_LINE);
  });

  test("a share Accept applies at the note's position after the decide call", async () => {
    useEditorNoticeStore.getState().dismissNotice();
    let release: () => void = () => {};
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "share_decide") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return null;
      }
      return undefined;
    });
    const view = viewAt(PATH);
    view.dispatch({ effects: addRedlineNote.of(shareNote()) });
    const pending = acceptNote(view as never, SHARE_ID);
    await vi.waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("share_decide", expect.anything()),
    );
    view.dispatch({ changes: { from: 0, to: 0, insert: "Intro. " } });
    release();
    expect(await pending).toBe(true);
    expect(view.state.doc.toString()).toBe(`Intro. ${PROPOSED}`);
  });
});
