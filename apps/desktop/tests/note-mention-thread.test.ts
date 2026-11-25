import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useEditorNoticeStore } from "../src/components/editor-area/editor-notice-store";
import { notesFromPending, ownNotesToSend } from "../src/features/document-share/place";
import { rememberMention } from "../src/features/note-mention/client";
import {
  finishMentionNote,
  sendMentionReply,
  sendMentionWording,
} from "../src/features/note-mention/desk";
import { MENTION_SEND_FAILED, PICKER_MAC_ONLY } from "../src/features/note-mention/strings";
import { refreshOpenMentions } from "../src/features/note-mention/sync";
import { noteThreadId, threadKey, threadPatch } from "../src/features/note-mention/thread";
import { addRedlineNote, leaveNoteOnNote, redlineNotesField } from "../src/features/redline-spike";
import type { RedlineNote } from "../src/features/redline-spike";

const mockedInvoke = vi.mocked(invoke);
const PATH = "/docs/harbor.md";
const DOC = "The harbor is narrow. Boats wait outside the wall.";
const ANCHOR = "The harbor is narrow.";
const SHARE_ID = "33333333-3333-4333-8333-333333333333";
const CHANGE_ID = "44444444-4444-4444-8444-444444444444";
const PAUL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOCUMENT_ID = "doc-harbor";

function viewOf(doc: string) {
  let state = EditorState.create({ doc, extensions: [redlineNotesField] });
  const view = {
    get state() {
      return state;
    },
    dom: { isConnected: true },
    scrollDOM: { querySelector: () => null },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  };
  return view as unknown as EditorView;
}

function card(overrides: Partial<RedlineNote> = {}): RedlineNote {
  return {
    id: "redline-1",
    from: 0,
    to: ANCHOR.length,
    original: ANCHOR,
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

function notes(view: EditorView): readonly RedlineNote[] {
  return view.state.field(redlineNotesField);
}

/** Records every mention_write and answers each with `answer`. */
function mentionWrites(answer: () => Promise<unknown> = async () => null) {
  const writes: Record<string, unknown>[] = [];
  mockedInvoke.mockImplementation(async (command, args) => {
    if (command === "mention_write") {
      writes.push(args as Record<string, unknown>);
      return answer();
    }
    return undefined;
  });
  return writes;
}

beforeEach(() => {
  vi.clearAllMocks();
  useEditorNoticeStore.getState().dismissNotice();
});

describe("a mention thread has one id on both Macs", () => {
  test("the author's note and the reader's card derive the same thread id", async () => {
    const writes = mentionWrites();
    const author = viewOf(DOC);
    author.dispatch({ effects: addRedlineNote.of(card()) });
    rememberMention("redline-1", { id: PAUL, name: "Paul" });
    expect(leaveNoteOnNote(author, "redline-1", "@Paul is this right?")).toBe(true);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const sent = writes[0]!.noteId as string;
    expect(sent).not.toMatch(/^redline-\d+$/);
    expect(notes(author)[0]?.threadId).toBe(sent);

    // What is sent for that note, and the card the other Mac paints from it.
    const [wire] = ownNotesToSend(notes(author), SHARE_ID, 0, new Set(), DOC);
    const [received] = notesFromPending(DOC, [
      {
        id: CHANGE_ID,
        start: 0,
        end: ANCHOR.length,
        original: wire!.original,
        body: null,
        sender_email: "ada@example.com",
      },
    ]);
    expect(received?.id).toBe(CHANGE_ID);
    expect(noteThreadId(received!)).toBe(sent);
  });

  test("the id is the content, not a launch counter", () => {
    expect(threadKey(ANCHOR, "Check this.")).toBe(threadKey(ANCHOR, "Check this."));
    expect(threadKey(ANCHOR, "Check this.")).not.toBe(threadKey(ANCHOR, "Check that."));
    expect(threadKey(ANCHOR, "Check this.")).not.toBe(threadKey("Boats wait.", "Check this."));
    expect(threadKey(ANCHOR, "Check this.").length).toBeLessThanOrEqual(80);
    // An own note with no mention has no thread yet.
    expect(noteThreadId(card({ status: "pending", intent: "none", proposed: "x" }))).toBeNull();
  });

  test("the reader's Mac paints the mention on the card that came from the author", async () => {
    const thread = threadKey(ANCHOR, "@Paul is this right?");
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "share_role") {
        return { role: "owner", share_id: SHARE_ID, document_id: DOCUMENT_ID };
      }
      if (command === "mention_open") {
        return [
          {
            id: "row-1",
            document_id: DOCUMENT_ID,
            note_id: thread,
            kind: "mention",
            author_id: "ada",
            quote: "@Paul is this right?",
          },
        ];
      }
      return undefined;
    });
    const reader = viewOf(DOC);
    reader.dispatch({
      effects: addRedlineNote.of(
        card({
          id: CHANGE_ID,
          status: "pending",
          intent: "none",
          proposed: "@Paul is this right?",
          instruction: "@Paul is this right?",
          person: "Ada",
          shareChangeId: CHANGE_ID,
        }),
      ),
    });
    await refreshOpenMentions(PATH, reader);
    const painted = notes(reader)[0]!;
    expect(painted.mentionOpen).toBe(true);
    expect(painted.threadId).toBe(thread);
    expect(painted.mentionRows).toEqual(["row-1"]);
  });
});

describe("mentionDone is not sticky", () => {
  const open = (id: string, kind = "mention", quote: string | null = "q") => ({
    id,
    document_id: DOCUMENT_ID,
    note_id: "note-t",
    kind,
    author_id: "ada",
    quote,
  });

  test("a row already answered stays answered; a new row opens the thread again", () => {
    const answered = card({
      status: "pending",
      intent: "none",
      proposed: "n",
      threadId: "note-t",
      mentionOpen: false,
      mentionDone: true,
      mentionRows: ["row-1"],
    });
    expect(threadPatch(answered, "note-t", [open("row-1")])).toBeNull();
    const reopened = threadPatch(answered, "note-t", [
      open("row-1"),
      open("row-2", "reply", "Yes"),
    ]);
    expect(reopened).toMatchObject({ mentionOpen: true, mentionDone: false });
    expect(reopened?.replies?.map((reply) => reply.text)).toEqual(["Yes"]);
  });

  test("nothing changes and nothing is dispatched when the rows are the ones painted", () => {
    const painted = card({
      status: "pending",
      intent: "none",
      proposed: "n",
      threadId: "note-t",
      mentionOpen: true,
      mentionRows: ["row-1"],
    });
    expect(threadPatch(painted, "note-t", [open("row-1")])).toBeNull();
  });
});

function threaded(view: EditorView, overrides: Partial<RedlineNote> = {}) {
  view.dispatch({
    effects: addRedlineNote.of(
      card({
        id: CHANGE_ID,
        status: "pending",
        intent: "none",
        proposed: "@Paul is this right?",
        instruction: "@Paul is this right?",
        person: "Ada",
        shareChangeId: CHANGE_ID,
        threadId: "note-t",
        mentionOpen: true,
        mentionRows: ["row-1"],
        ...overrides,
      }),
    ),
  });
}

describe("Suggest wording", () => {
  test("the suggestion lands on the same words, then the thread is done", async () => {
    const writes = mentionWrites();
    const view = viewOf(DOC);
    threaded(view);
    view.dispatch({ changes: { from: 0, insert: "Note. " } });
    await sendMentionWording(view, CHANGE_ID, PATH, "The harbor is tight.");
    const [original, wording] = notes(view);
    expect(wording).toMatchObject({
      intent: "replace",
      status: "pending",
      proposed: "The harbor is tight.",
      mentionOf: CHANGE_ID,
      original: ANCHOR,
    });
    // Current positions, not the ones the card was painted with.
    expect(wording?.from).toBe("Note. ".length);
    expect(original?.mentionDone).toBe(true);
    expect(writes).toEqual([expect.objectContaining({ action: "wording", noteId: "note-t" })]);
  });

  test("a failed send keeps the suggestion and leaves the thread open", async () => {
    mentionWrites(async () => {
      throw "unreachable";
    });
    const view = viewOf(DOC);
    threaded(view);
    await sendMentionWording(view, CHANGE_ID, PATH, "The harbor is tight.");
    expect(notes(view)).toHaveLength(2);
    expect(notes(view)[0]?.mentionDone).toBeFalsy();
    expect(notes(view)[0]?.mentionOpen).toBe(true);
    expect(useEditorNoticeStore.getState().message).toBe(MENTION_SEND_FAILED);
  });

  test("a plain second note on the same words is still refused", () => {
    const view = viewOf(DOC);
    view.dispatch({ effects: addRedlineNote.of(card()) });
    view.dispatch({ effects: addRedlineNote.of(card({ id: "redline-2" })) });
    expect(notes(view)).toHaveLength(1);
  });
});

describe("Reply and Done land only when sent", () => {
  test("a reply is added and the mention answered once the server has it", async () => {
    const writes = mentionWrites();
    const view = viewOf(DOC);
    threaded(view);
    await sendMentionReply(view, CHANGE_ID, PATH, "Yes, it is.");
    const note = notes(view)[0]!;
    expect(note.replies?.map((reply) => reply.text)).toEqual(["Yes, it is."]);
    expect(note.mentionDone).toBe(true);
    expect(note.mentionOpen).toBe(false);
    expect(writes).toEqual([
      expect.objectContaining({ action: "reply", noteId: "note-t", quote: "Yes, it is." }),
    ]);
  });

  test("a failed reply is not shown as sent and the thread stays open", async () => {
    mentionWrites(async () => {
      throw "unreachable";
    });
    const view = viewOf(DOC);
    threaded(view);
    await expect(sendMentionReply(view, CHANGE_ID, PATH, "Yes, it is.")).resolves.toBe(false);
    const note = notes(view)[0]!;
    expect(note.replies ?? []).toEqual([]);
    expect(note.mentionOpen).toBe(true);
    expect(note.mentionDone).toBeFalsy();
    expect(useEditorNoticeStore.getState().message).toBe(MENTION_SEND_FAILED);
  });

  test("a document kept on this Mac keeps the reply here", async () => {
    mentionWrites(async () => {
      throw "mac_only";
    });
    const view = viewOf(DOC);
    threaded(view);
    await expect(sendMentionReply(view, CHANGE_ID, PATH, "Noted.")).resolves.toBe(true);
    expect(notes(view)[0]?.replies?.map((reply) => reply.text)).toEqual(["Noted."]);
    expect(useEditorNoticeStore.getState().message).toBe(PICKER_MAC_ONLY);
  });

  test("Done keeps a threaded note when the server did not take it", async () => {
    mentionWrites(async () => {
      throw "unreachable";
    });
    const view = viewOf(DOC);
    threaded(view);
    await finishMentionNote(view, CHANGE_ID, PATH);
    expect(notes(view)).toHaveLength(1);

    mentionWrites();
    await finishMentionNote(view, CHANGE_ID, PATH);
    expect(notes(view)).toHaveLength(0);
  });

  test("Done on a note with no thread removes it without a request", async () => {
    const writes = mentionWrites();
    const view = viewOf(DOC);
    view.dispatch({
      effects: addRedlineNote.of(card({ status: "pending", intent: "none", proposed: "mine" })),
    });
    await finishMentionNote(view, "redline-1", PATH);
    expect(notes(view)).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  test("a reply that mentions someone on your own note mints the thread first", async () => {
    const writes = mentionWrites();
    const view = viewOf(DOC);
    view.dispatch({
      effects: addRedlineNote.of(card({ status: "pending", intent: "none", proposed: "Mine." })),
    });
    rememberMention("redline-1:reply", { id: PAUL, name: "Paul" });
    await sendMentionReply(view, "redline-1", PATH, "@Paul see above");
    expect(writes[0]?.noteId).toBe(threadKey(ANCHOR, "Mine."));
    expect(writes[0]?.mentionedIds).toEqual([PAUL]);
    expect(notes(view)[0]?.threadId).toBe(threadKey(ANCHOR, "Mine."));
  });
});
