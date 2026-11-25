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
  isSaveActive: () => false,
}));

import { invoke } from "@tauri-apps/api/core";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import {
  resetEditorNoticesForTest,
  showEditorNotice,
  useEditorNoticeStore,
} from "../src/components/editor-area/editor-notice-store";
import { agentCard, agentCardEffects } from "../src/features/agent-proposal/cards";
import { AGENT_CARD_LABEL, agentArrivalLine } from "../src/features/agent-proposal/copy";
import { paintAgentCards } from "../src/features/agent-proposal/desk";
import {
  notePulledProposals,
  resetAgentProposals,
  useAgentProposalStore,
} from "../src/features/agent-proposal/store";
import { SHARE_DECIDE_FAILED } from "../src/features/document-share/copy";
import { ownNotesToSend, proposalsToSend } from "../src/features/document-share/place";
import {
  acceptNote,
  addRedlineNote,
  aiWritten,
  buildRedlineDecorations,
  cameFromElsewhere,
  editAskOnNote,
  noteState,
  redlineFilePathFacet,
  redlineGutterBody,
  redlineInkTickField,
  redlineNoteLabel,
  redlineNotesField,
  rejectNote,
} from "../src/features/redline-spike";
import { preferenceRecordArgs } from "../src/features/redline-spike/actions";
import {
  ownNote,
  parkedNotes,
  parkNotes,
  resetParkedNotesForTest,
  restorable,
} from "../src/features/redline-spike/parked-notes";
import { ACCEPT_SAVE_FAILED_LINE } from "../src/features/redline-spike/margin-copy";
import { syncHistoryCopies } from "../src/lib/git-queue";
import type { HistoryDocumentIdentity, HistoryPulledProposal } from "../src/lib/tauri";

const mockedInvoke = vi.mocked(invoke);
const ROOT = "/repo/notes";
const PATH = "/repo/notes/draft.md";
const OTHER = "/repo/notes/other.md";
const BODY = "The river kept its bend.\n";
const ADDITION = "\nA line from the chat.\n";
const DRAFT: HistoryDocumentIdentity = { project_id: "project-1", document_id: "document-1" };
const SECOND: HistoryDocumentIdentity = { project_id: "project-1", document_id: "document-2" };

function wire(id: string, over: Partial<HistoryPulledProposal> = {}): HistoryPulledProposal {
  return { path: PATH, ...DRAFT, proposal_id: id, text: ADDITION, ...over };
}

function viewAt(path: string, doc = BODY) {
  let state = EditorState.create({
    doc,
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

type View = ReturnType<typeof viewAt>;

function cards(view: View) {
  return view.state.field(redlineNotesField);
}

/** The commands sent so far, in order. */
function commands(): string[] {
  return mockedInvoke.mock.calls.map((call) => String(call[0]));
}

function decides(): number {
  return commands().filter((name) => name === "history_proposal_decide").length;
}

/** Which synced document each path is, as the folder's notes would say. */
let identities: Record<string, HistoryDocumentIdentity | null> = {};
/** Per-command answers on top of the identity lookup. */
let answers: Record<string, (args: unknown) => unknown> = {};

function answerInvoke(): void {
  mockedInvoke.mockImplementation(async (command, args) => {
    const name = String(command);
    if (answers[name]) return answers[name](args);
    if (name === "history_document_identity") {
      return identities[(args as { path: string }).path] ?? null;
    }
    return undefined;
  });
}

async function flush(): Promise<void> {
  for (let n = 0; n < 5; n += 1) await Promise.resolve();
}

function paint(path: string, view: View): Promise<void> {
  return paintAgentCards(path, view as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  flushSave.mockResolvedValue(undefined);
  identities = { [PATH]: DRAFT, [OTHER]: SECOND };
  answers = {};
  answerInvoke();
  resetAgentProposals();
  resetEditorNoticesForTest();
  resetParkedNotesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the card for a suggested addition", () => {
  test("is an insertion at the end of the document that nobody asked for here", () => {
    const card = agentCard(BODY.length, wire("p1"));
    expect(card.from).toBe(BODY.length);
    expect(card.to).toBe(BODY.length);
    expect(card.intent).toBe("insert");
    expect(card.proposed).toBe(ADDITION);
    expect(card.instruction).toBeNull();
    expect(card.original).toBe("");
    expect(noteState(card)).toEqual({ kind: "suggestion", stale: false, deciding: false });
    expect(cameFromElsewhere(card)).toBe(true);
  });

  test("carries the AI badge and says where it came from", () => {
    const card = agentCard(BODY.length, wire("p1"));
    expect(aiWritten(card)).toBe(true);
    expect(redlineNoteLabel(card)).toBe(AGENT_CARD_LABEL);
    expect(AGENT_CARD_LABEL).toBe("From your AI chat");
    // The added text is painted in the document. The margin does not repeat it.
    expect(redlineGutterBody(card)).toBe("");
    expect(redlineNoteLabel({ ...card, status: "accepted" })).toBe("accepted");
  });

  test("paints exactly the text that was sent, references and all", () => {
    // Alkuin's own answers have a References block lifted and tidied. This is not one.
    const text =
      "\n\nA paragraph about std::vector [1]!!\n\n## References\n\n[1] Smith J. 2020. Rivers. https://example.com/a. A trailing sentence.\n";
    const state = EditorState.create({ doc: BODY });
    const set = buildRedlineDecorations(state.doc, [agentCard(BODY.length, wire("p1", { text }))]);
    const painted: { at: number; text: string }[] = [];
    set.between(0, BODY.length, (from, _to, value) => {
      painted.push({ at: from, text: (value.spec.widget as { text: string }).text });
    });
    expect(painted).toEqual([{ at: BODY.length, text }]);
  });

  test("is not a style lesson, and a shared document does not forward it", () => {
    const card = agentCard(BODY.length, wire("p1"));
    expect(preferenceRecordArgs(card, true)).toBeNull();
    expect(preferenceRecordArgs(card, false)).toBeNull();
    for (const status of ["pending", "accepted"] as const) {
      const note = { ...card, status };
      expect(proposalsToSend([note], "share-1", 0, BODY, BODY + ADDITION)).toEqual([]);
      expect(ownNotesToSend([note], "share-1", 0, new Set(), BODY)).toEqual([]);
    }
  });

  test("the arrival line names one document, or counts several", () => {
    expect(agentArrivalLine(["Draft"])).toBe("Your AI chat suggested an addition to Draft.");
    expect(agentArrivalLine(["Draft", "Other"])).toBe(
      "Your AI chat suggested additions to 2 documents.",
    );
  });

  test("a count of one is never the counted line", () => {
    // One document is always named.
    for (let count = 0; count <= 50; count += 1) {
      const line = agentArrivalLine(Array.from({ length: count }, (_, n) => `Doc ${n}`));
      expect(line).not.toMatch(/\b[01] documents\b/);
      if (count >= 2) expect(line).toBe(`Your AI chat suggested additions to ${count} documents.`);
    }
    expect(agentArrivalLine(["Draft"])).not.toContain("documents");
  });
});

describe("what the margin gains and loses", () => {
  test("a waiting suggestion for this document gets one card, and only one", () => {
    const list = [wire("p1"), wire("p2", { ...SECOND, path: OTHER })];
    const first = agentCardEffects(DRAFT, BODY.length, list, []);
    expect(first.add.map((note) => note.agentProposalId)).toEqual(["p1"]);
    expect(first.remove).toEqual([]);
    const again = agentCardEffects(DRAFT, BODY.length, list, first.add);
    expect(again).toEqual({ add: [], remove: [] });
  });

  test("a document is matched by its sync ids, never by where the pull last saw it", () => {
    // Renamed since the pull: the list still has the old path.
    const renamed = agentCardEffects(DRAFT, BODY.length, [wire("p1", { path: OTHER })], []);
    expect(renamed.add.map((note) => note.agentProposalId)).toEqual(["p1"]);
    // A different document now sits at the path the pull named, or one that never synced.
    expect(agentCardEffects(SECOND, BODY.length, [wire("p1")], []).add).toEqual([]);
    expect(agentCardEffects(null, BODY.length, [wire("p1")], []).add).toEqual([]);
    // The same document id in another folder is another document.
    const elsewhere = { project_id: "project-9", document_id: DRAFT.document_id };
    expect(agentCardEffects(elsewhere, BODY.length, [wire("p1")], []).add).toEqual([]);
  });

  test("a pending card decided on another Mac goes, and an accepted one stays", () => {
    const pending = agentCard(BODY.length, wire("p1"));
    const accepted = { ...agentCard(BODY.length, wire("p2")), status: "accepted" as const };
    const effects = agentCardEffects(DRAFT, BODY.length, [], [pending, accepted]);
    expect(effects.remove).toEqual([pending.id]);
    expect(effects.add).toEqual([]);
    // Not knowing which document this is does not take a waiting card away.
    expect(agentCardEffects(null, BODY.length, [wire("p1")], [pending]).remove).toEqual([]);
  });

  test("a card that is not the connector's is never touched", () => {
    const own = {
      ...agentCard(BODY.length, wire("p1")),
      id: "redline-own",
      agentProposalId: undefined,
    };
    expect(agentCardEffects(DRAFT, BODY.length, [], [own])).toEqual({ add: [], remove: [] });
  });

  test("two suggestions at the same caret are two cards", () => {
    const view = viewAt(PATH);
    view.dispatch({
      effects: [
        addRedlineNote.of(agentCard(BODY.length, wire("p1"))),
        addRedlineNote.of(agentCard(BODY.length, wire("p2", { text: "\nAnother.\n" }))),
        addRedlineNote.of(agentCard(BODY.length, wire("p1"))),
      ],
    });
    expect(cards(view).map((note) => note.agentProposalId)).toEqual(["p1", "p2"]);
  });

  test("a card of the writer's own at the same caret is a different card, either way round", () => {
    // A typed insertion the writer still holds is a caret too, with no server id.
    const own = {
      ...agentCard(BODY.length, wire("p1")),
      id: "redline-own",
      agentProposalId: undefined,
      proposed: "Typed here.\n",
    };
    const first = viewAt(PATH);
    first.dispatch({ effects: addRedlineNote.of(own) });
    first.dispatch({ effects: addRedlineNote.of(agentCard(BODY.length, wire("p1"))) });
    expect(cards(first).map((note) => note.id)).toEqual(["redline-own", "agent-p1"]);

    const second = viewAt(PATH);
    second.dispatch({ effects: addRedlineNote.of(agentCard(BODY.length, wire("p1"))) });
    second.dispatch({ effects: addRedlineNote.of(own) });
    expect(cards(second).map((note) => note.id)).toEqual(["agent-p1", "redline-own"]);
  });

  test("painting follows the list, and a reload that wipes the margin is painted again", async () => {
    const view = viewAt(PATH);
    notePulledProposals(ROOT, [wire("p1")]);
    await paint(PATH, view);
    expect(cards(view).map((note) => note.agentProposalId)).toEqual(["p1"]);
    await paint(PATH, view);
    expect(cards(view).length).toBe(1);
    // A reload is a covering replace tagged `writer`. Margin notes are not saved.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "Reloaded.\n" },
      userEvent: "writer",
    });
    expect(cards(view)).toEqual([]);
    await paint(PATH, view);
    expect(cards(view).map((note) => note.from)).toEqual(["Reloaded.\n".length]);
  });

  test("a reload keeps the writer's own note and drops the card, which is painted again", async () => {
    const view = viewAt(PATH);
    notePulledProposals(ROOT, [wire("p1")]);
    await paint(PATH, view);
    const own = {
      ...agentCard(4, wire("own")),
      id: "redline-own",
      agentProposalId: undefined,
      from: 4,
      to: 9,
      original: "river",
      proposed: "A note of mine.",
      intent: "none" as const,
    };
    view.dispatch({ effects: addRedlineNote.of(own) });
    expect(cards(view).map((note) => note.id)).toEqual(["agent-p1", "redline-own"]);
    // The same file with new text from disk. The margin keeps what is the writer's.
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "A line added on disk.\n" },
      userEvent: "writer.reload",
    });
    expect(cards(view).map((note) => note.id)).toEqual(["redline-own"]);
    await paint(PATH, view);
    expect(cards(view).map((note) => [note.id, note.from])).toEqual([
      ["redline-own", 4],
      ["agent-p1", view.state.doc.length],
    ]);
  });

  test("a card is not parked with the writer's notes when its file leaves the view", () => {
    const card = agentCard(BODY.length, wire("p1"));
    expect(ownNote(card)).toBe(false);
    expect(restorable(card)).toBe(false);
    const own = { ...card, id: "redline-own", agentProposalId: undefined };
    expect(ownNote(own)).toBe(true);
    // Parked by path. A different document opened at that path later must not get the card.
    parkNotes(PATH, BODY, [card, own]);
    expect(parkedNotes(PATH, "Another document.\n").map((note) => note.id)).toEqual([
      "redline-own",
    ]);
  });

  test("the folder's notes are asked which document this is, and only when something waits", async () => {
    const view = viewAt(PATH);
    await paint(PATH, view);
    expect(commands()).toEqual([]);
    notePulledProposals(ROOT, [wire("p1")]);
    await paint(PATH, view);
    expect(mockedInvoke).toHaveBeenCalledWith("history_document_identity", { path: PATH });
  });

  test("a renamed document keeps its card, and a new file under the old name gets none", async () => {
    notePulledProposals(ROOT, [wire("p1")]);
    // The document moved to essay.md after the pull. The notes follow it at once.
    const moved = "/repo/notes/essay.md";
    identities = { [moved]: DRAFT, [PATH]: null };
    const renamed = viewAt(moved);
    await paint(moved, renamed);
    expect(cards(renamed).map((note) => note.agentProposalId)).toEqual(["p1"]);
    // A different document was then made at the old name. It has never synced.
    const impostor = viewAt(PATH, "Another document.\n");
    await paint(PATH, impostor);
    expect(cards(impostor)).toEqual([]);
    // And one that synced under its own ids does not get it either.
    identities[PATH] = SECOND;
    await paint(PATH, impostor);
    expect(cards(impostor)).toEqual([]);
  });

  test("an answer that arrives after the view moved on, or was closed, paints nothing", async () => {
    notePulledProposals(ROOT, [wire("p1")]);
    const view = viewAt(PATH);
    let alive = true;
    const closing = paintAgentCards(PATH, view as never, () => alive);
    alive = false;
    await closing;
    expect(cards(view)).toEqual([]);
    // The lookup failing is not a reason to add, or to remove.
    answers.history_document_identity = () => {
      throw new Error("the notes could not be read");
    };
    await paint(PATH, view);
    expect(cards(view)).toEqual([]);
  });

  test("a decision made while the notes were being read is not painted", async () => {
    notePulledProposals(ROOT, [wire("p1"), wire("p2", { text: "\nSecond.\n" })]);
    const view = viewAt(PATH);
    let release: (value: HistoryDocumentIdentity) => void = () => {};
    answers.history_document_identity = () =>
      new Promise<HistoryDocumentIdentity>((resolve) => {
        release = resolve;
      });
    const painting = paint(PATH, view);
    // Decided in another pane of this window before the answer came back.
    notePulledProposals(ROOT, [wire("p2", { text: "\nSecond.\n" })]);
    release(DRAFT);
    await painting;
    expect(cards(view).map((note) => note.agentProposalId)).toEqual(["p2"]);
  });

  test("typing at the end keeps the card at the end", () => {
    const view = viewAt(PATH);
    view.dispatch({ effects: addRedlineNote.of(agentCard(BODY.length, wire("p1"))) });
    view.dispatch({ changes: { from: BODY.length, insert: "More of mine.\n" } });
    const card = cards(view)[0];
    expect(card?.from).toBe(view.state.doc.length);
    expect(card?.to).toBe(view.state.doc.length);
  });
});

describe("what a pull saw", () => {
  const ids = () => useAgentProposalStore.getState().waiting.map((item) => item.proposal_id);

  test("a pull that could not say changes nothing", () => {
    notePulledProposals(ROOT, [wire("p1")]);
    const before = useAgentProposalStore.getState().waiting;
    notePulledProposals(ROOT, null);
    notePulledProposals(ROOT, undefined);
    expect(useAgentProposalStore.getState().waiting).toBe(before);
  });

  test("the same list again keeps the same reference and says nothing", () => {
    notePulledProposals(ROOT, [wire("p1")]);
    const before = useAgentProposalStore.getState().waiting;
    useEditorNoticeStore.setState({ toast: null, message: null });
    notePulledProposals(ROOT, [wire("p1")]);
    expect(useAgentProposalStore.getState().waiting).toBe(before);
    expect(useEditorNoticeStore.getState().message).toBeNull();
  });

  test("a suggestion that left the server leaves the list", () => {
    notePulledProposals(ROOT, [wire("p1"), wire("p2")]);
    notePulledProposals(ROOT, [wire("p2")]);
    expect(ids()).toEqual(["p2"]);
  });

  test("a document that could not be read keeps what it had, whatever it is called now", () => {
    notePulledProposals(ROOT, [wire("p1"), wire("p2", { ...SECOND, path: OTHER })]);
    // Named by its sync id: the path in the list may be from before a rename.
    notePulledProposals(ROOT, [], [DRAFT.document_id]);
    expect(ids()).toEqual(["p1"]);
  });

  test("another folder's pull replaces the list", () => {
    notePulledProposals(ROOT, [wire("p1")]);
    notePulledProposals("/elsewhere", [], [DRAFT.document_id]);
    expect(useAgentProposalStore.getState()).toMatchObject({ root: "/elsewhere", waiting: [] });
  });

  test("new suggestions are announced once, by document", () => {
    notePulledProposals(ROOT, [wire("p1")]);
    expect(useEditorNoticeStore.getState().message).toBe(
      "Your AI chat suggested an addition to draft.md.",
    );
    useEditorNoticeStore.setState({ toast: null, message: null });
    // Two more, one of them for a second document. The known one is not news.
    notePulledProposals(ROOT, [wire("p1"), wire("p2"), wire("p3", { ...SECOND, path: OTHER })]);
    expect(useEditorNoticeStore.getState().message).toBe(
      "Your AI chat suggested additions to 2 documents.",
    );
    // Leaving the folder and coming back is not news either.
    useEditorNoticeStore.setState({ toast: null, message: null });
    notePulledProposals("/elsewhere", []);
    notePulledProposals(ROOT, [wire("p1"), wire("p2")]);
    expect(useEditorNoticeStore.getState().message).toBeNull();
  });

  test("several suggestions for one document name that document", () => {
    notePulledProposals(ROOT, [wire("p1"), wire("p2"), wire("p3")]);
    expect(useEditorNoticeStore.getState().message).toBe(
      "Your AI chat suggested an addition to draft.md.",
    );
  });

  test("the arrival line waits for a line that is already up", () => {
    showEditorNotice("Someone else's edits didn't fit. Your words are still here.", {
      sticky: true,
    });
    notePulledProposals(ROOT, [wire("p1")]);
    expect(useEditorNoticeStore.getState().message).toBe(
      "Someone else's edits didn't fit. Your words are still here.",
    );
    expect(ids()).toEqual(["p1"]);
    // Once that line is gone, the next pull says it.
    useEditorNoticeStore.setState({ toast: null, message: null });
    notePulledProposals(ROOT, [wire("p1")]);
    expect(useEditorNoticeStore.getState().message).toBe(
      "Your AI chat suggested an addition to draft.md.",
    );
  });

  test("a history sync hands the pull's suggestions to the margin", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    answers.history_flush = () => ({ sent: 0, waiting: false, overlaps: [] });
    answers.history_pull = () => ({
      suggestions: [],
      wrote: [],
      removed: [],
      proposals: [wire("p1")],
      proposals_unread: [],
    });
    await syncHistoryCopies(ROOT);
    expect(ids()).toEqual(["p1"]);
    // A pull that could not list (offline, signed out) leaves them where they are.
    answers.history_pull = () => ({ suggestions: [], wrote: [], removed: [], proposals: null });
    await syncHistoryCopies(ROOT);
    expect(ids()).toEqual(["p1"]);
  });
});

describe("Accept and Reject", () => {
  async function painted(doc = BODY, text = ADDITION): Promise<View> {
    const view = viewAt(PATH, doc);
    notePulledProposals(ROOT, [wire("p1", { text })]);
    await paint(PATH, view);
    vi.clearAllMocks();
    flushSave.mockResolvedValue(undefined);
    answerInvoke();
    return view;
  }

  test("Accept writes the text at the end, saves it, records the decision, then commits", async () => {
    const view = await painted();
    const order: string[] = [];
    flushSave.mockImplementation(async () => {
      order.push(`flush:${view.state.doc.toString() === BODY + ADDITION}`);
    });
    answers.history_proposal_decide = () => {
      order.push("decide");
    };
    answers.git_commit_file = () => {
      order.push("commit");
      return { committed: true, commit_sha: "abc", error: null };
    };
    expect(await acceptNote(view as never, "agent-p1")).toBe(true);
    expect(view.state.doc.toString()).toBe(BODY + ADDITION);
    // The words were on the page when the file was saved, and on disk when the decision was recorded.
    expect(order).toEqual(["flush:true", "decide", "commit"]);
    expect(flushSave).toHaveBeenCalledWith(PATH);
    expect(mockedInvoke).toHaveBeenCalledWith("git_commit_file", { path: PATH });
    expect(mockedInvoke).toHaveBeenCalledWith("history_proposal_decide", {
      projectId: "project-1",
      documentId: "document-1",
      proposalId: "p1",
    });
    expect(decides()).toBe(1);
    expect(commands()).not.toContain("redline_learn");
    expect(commands()).not.toContain("share_decide");
    expect(cards(view)[0]?.status).toBe("accepted");
    expect(useAgentProposalStore.getState().waiting).toEqual([]);
  });

  test("Accept writes exactly what was sent, including a References block", async () => {
    const text =
      "\n\nA paragraph about std::vector [1]!!\n\n## References\n\n[1] Smith J. 2020. Rivers. https://example.com/a. A trailing sentence.\n";
    const view = await painted(BODY, text);
    await acceptNote(view as never, "agent-p1");
    expect(view.state.doc.toString()).toBe(BODY + text);
  });

  test("Accept works on an empty document", async () => {
    const view = await painted("");
    expect(cards(view).map((note) => [note.from, note.to])).toEqual([[0, 0]]);
    await acceptNote(view as never, "agent-p1");
    expect(view.state.doc.toString()).toBe(ADDITION);
  });

  test("Accept lands after words typed at the end since the card was painted", async () => {
    const view = await painted();
    view.dispatch({ changes: { from: BODY.length, insert: "Mine.\n" } });
    await acceptNote(view as never, "agent-p1");
    expect(view.state.doc.toString()).toBe(`${BODY}Mine.\n${ADDITION}`);
  });

  test("a failed save keeps the suggestion on the server, and the words stay on the page", async () => {
    const view = await painted();
    flushSave.mockRejectedValue(new SaveFailedError("disk full"));
    await acceptNote(view as never, "agent-p1");
    expect(view.state.doc.toString()).toBe(BODY + ADDITION);
    expect(useEditorNoticeStore.getState().message).toBe(ACCEPT_SAVE_FAILED_LINE);
    // Nothing told the server to forget it: the words are in no file yet.
    expect(decides()).toBe(0);
    expect(commands()).not.toContain("git_commit_file");
    // In this window the card is still answered: a pull naming it does not paint it twice.
    notePulledProposals(ROOT, [wire("p1")]);
    await paint(PATH, view);
    expect(cards(view).filter((note) => note.status === "pending")).toEqual([]);
    expect(view.state.doc.toString()).toBe(BODY + ADDITION);
  });

  test("Reject leaves the document, drops the card, and records the decision", async () => {
    const view = await painted();
    expect(rejectNote(view as never, "agent-p1")).toBe(true);
    expect(view.state.doc.toString()).toBe(BODY);
    expect(cards(view)).toEqual([]);
    expect(commands()).toEqual(["history_proposal_decide"]);
    expect(flushSave).not.toHaveBeenCalled();
    expect(useAgentProposalStore.getState().waiting).toEqual([]);
  });

  test("a pull that started before the decision does not paint the card again", async () => {
    const view = await painted();
    rejectNote(view as never, "agent-p1");
    // The pull read the server before the decision was queued, and still names it.
    notePulledProposals(ROOT, [wire("p1")]);
    await paint(PATH, view);
    expect(cards(view)).toEqual([]);
    expect(useAgentProposalStore.getState().waiting).toEqual([]);

    const second = await painted();
    // Already decided above in this window, so the same id was never painted.
    expect(cards(second)).toEqual([]);
    expect(await acceptNote(second as never, "agent-p1")).toBe(false);
    expect(second.state.doc.toString()).toBe(BODY);
  });

  test("a decision that could not be recorded says so once, and the next pull tries again", async () => {
    const view = await painted();
    let failing = true;
    answers.history_proposal_decide = () => {
      if (failing) throw new Error("disk full");
    };
    rejectNote(view as never, "agent-p1");
    await flush();
    expect(decides()).toBe(1);
    expect(useEditorNoticeStore.getState().message).toBe(SHARE_DECIDE_FAILED);
    // Still failing: tried again, quietly.
    useEditorNoticeStore.setState({ toast: null, message: null });
    notePulledProposals(ROOT, null);
    await flush();
    expect(decides()).toBe(2);
    expect(useEditorNoticeStore.getState().message).toBeNull();
    // It lands, and is not sent a fourth time.
    failing = false;
    notePulledProposals(ROOT, []);
    await flush();
    expect(decides()).toBe(3);
    notePulledProposals(ROOT, []);
    await flush();
    expect(decides()).toBe(3);
  });

  test("Edit ask does nothing on the connector's card", async () => {
    const view = await painted();
    expect(editAskOnNote(view as never, "agent-p1")).toBe(false);
    expect(cards(view)[0]?.status).toBe("pending");
    expect(cards(view)[0]?.proposed).toBe(ADDITION);
  });

  test("a second click cannot accept the same addition twice", async () => {
    const view = await painted();
    await acceptNote(view as never, "agent-p1");
    expect(await acceptNote(view as never, "agent-p1")).toBe(false);
    expect(view.state.doc.toString()).toBe(BODY + ADDITION);
    expect(decides()).toBe(1);
  });
});
