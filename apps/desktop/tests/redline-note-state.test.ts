import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { invoke } from "@tauri-apps/api/core";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useEditorNoticeStore } from "../src/components/editor-area/editor-notice-store";
import { SHARE_DECIDE_FAILED } from "../src/features/document-share/copy";
import {
  acceptNote,
  addRedlineNote,
  askAgentOnNote,
  isCalmStatusNote,
  isCancelledAsk,
  isSignInPrompt,
  isToolCautionHold,
  markAccepted,
  noteState,
  REDLINE_INK_TICK_MS,
  redlineInkTickField,
  redlineNotesField,
  rejectNote,
  removeRedlineNote,
  TOOL_CAUTION_NOTE,
} from "../src/features/redline-spike";
import type { RedlineNote } from "../src/features/redline-spike";
import {
  ACCEPT_TEXT_CHANGED_LINE,
  ACCEPTED_NOT_ADDED_LINE,
  ASK_CANCELLED_LINE,
  ASK_SIGN_IN_WIRE,
  HARD_CAP_LINE,
} from "../src/features/redline-spike/margin-copy";
import { rememberWritingOffline, rememberWritingSession } from "../src/lib/account-session";

const mockedInvoke = vi.mocked(invoke);
const ORIGINAL = "This is really very important.";
const CHANGE_ID = "22222222-2222-4222-8222-222222222222";

function viewOf(doc: string) {
  let state = EditorState.create({ doc, extensions: [redlineNotesField, redlineInkTickField] });
  const view = {
    get state() {
      return state;
    },
    dom: { isConnected: true },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  };
  return view as unknown as EditorView;
}

function shareCard(overrides: Partial<RedlineNote> = {}): RedlineNote {
  return {
    id: CHANGE_ID,
    from: 8,
    to: 19,
    original: "really very",
    proposed: "truly",
    intent: "replace",
    instruction: "truly",
    status: "pending",
    error: null,
    git: null,
    publish: null,
    person: "Paloma",
    shareAccept: true,
    shareChangeId: CHANGE_ID,
    ...overrides,
  };
}

/** share_decide waits until the test lets it finish. */
function holdDecide(): { release: () => void; calls: () => number } {
  let release = () => {};
  let calls = 0;
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "share_decide") {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return null;
    }
    return undefined;
  });
  return { release: () => release(), calls: () => calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  useEditorNoticeStore.getState().dismissNotice();
});

describe("Accept on a shared suggestion", () => {
  test("a second click while the decision is saving does not apply it twice", async () => {
    const decide = holdDecide();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(shareCard()) });
    const first = acceptNote(view, CHANGE_ID);
    const second = acceptNote(view, CHANGE_ID);
    await expect(second).resolves.toBe(false);
    decide.release();
    await expect(first).resolves.toBe(true);
    expect(decide.calls()).toBe(1);
    expect(view.state.doc.toString()).toBe("This is truly important.");
    expect(view.state.field(redlineNotesField)[0]?.status).toBe("accepted");
  });

  test("an edit before the span during the decision moves where Accept writes", async () => {
    const decide = holdDecide();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(shareCard()) });
    const accepted = acceptNote(view, CHANGE_ID);
    view.dispatch({ changes: { from: 0, insert: "Well. " } });
    decide.release();
    await expect(accepted).resolves.toBe(true);
    expect(view.state.doc.toString()).toBe("Well. This is truly important.");
  });

  test("an edit inside the span during the decision is not written over", async () => {
    const decide = holdDecide();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(shareCard()) });
    const accepted = acceptNote(view, CHANGE_ID);
    view.dispatch({ changes: { from: 9, to: 10, insert: "E" } });
    decide.release();
    await expect(accepted).resolves.toBe(false);
    expect(view.state.doc.toString()).toBe("This is rEally very important.");
    // The server has it as accepted, so the card stays to say it was not added here.
    const card = view.state.field(redlineNotesField)[0]!;
    expect(noteState(card).kind).toBe("not-applied");
    expect(card.proposed).toBe("truly");
    expect(card.shareChangeId).toBeUndefined();
    expect(useEditorNoticeStore.getState().message).toBe(ACCEPTED_NOT_ADDED_LINE);
  });

  test("a span already edited when Accept is clicked is not sent to the server", async () => {
    const decide = holdDecide();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(shareCard()) });
    view.dispatch({ changes: { from: 9, to: 10, insert: "E" } });
    await expect(acceptNote(view, CHANGE_ID)).resolves.toBe(false);
    expect(decide.calls()).toBe(0);
    expect(view.state.field(redlineNotesField)[0]?.status).toBe("pending");
    expect(useEditorNoticeStore.getState().message).toBe(ACCEPT_TEXT_CHANGED_LINE);
  });

  const PARAS = "First para.\n\nSecond para.";
  const insertCard = () =>
    shareCard({
      from: 11,
      to: 11,
      original: "",
      proposed: "\n\nNew para.",
      instruction: "\n\nNew para.",
      intent: "insert",
    });

  test("an insertion whose paragraph was deleted during the decision is not written", async () => {
    const decide = holdDecide();
    const view = viewOf(PARAS);
    view.dispatch({ effects: addRedlineNote.of(insertCard()) });
    const accepted = acceptNote(view, CHANGE_ID);
    view.dispatch({ changes: { from: 0, to: 13 } });
    decide.release();
    await expect(accepted).resolves.toBe(false);
    expect(view.state.doc.toString()).toBe("Second para.");
    const card = view.state.field(redlineNotesField)[0]!;
    expect(noteState(card).kind).toBe("not-applied");
    expect(card.proposed).toBe("\n\nNew para.");
    expect(useEditorNoticeStore.getState().message).toBe(ACCEPTED_NOT_ADDED_LINE);
  });

  test("an insertion lands when the edit during the decision was elsewhere", async () => {
    const decide = holdDecide();
    const view = viewOf(PARAS);
    view.dispatch({ effects: addRedlineNote.of(insertCard()) });
    const accepted = acceptNote(view, CHANGE_ID);
    view.dispatch({ changes: { from: 13, to: 19, insert: "Third" } });
    decide.release();
    await expect(accepted).resolves.toBe(true);
    expect(view.state.doc.toString()).toBe("First para.\n\nNew para.\n\nThird para.");
  });

  test("a file swap during the decision says the change was not added", async () => {
    const decide = holdDecide();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(shareCard()) });
    const accepted = acceptNote(view, CHANGE_ID);
    view.dispatch({
      changes: { from: 0, to: ORIGINAL.length, insert: "Another file." },
      userEvent: "writer.swap",
    });
    decide.release();
    await expect(accepted).resolves.toBe(false);
    expect(view.state.doc.toString()).toBe("Another file.");
    expect(useEditorNoticeStore.getState().message).toBe(ACCEPTED_NOT_ADDED_LINE);
  });

  test("Dismiss on a card that was not added clears it without a decision", async () => {
    const decide = holdDecide();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(shareCard()) });
    const accepted = acceptNote(view, CHANGE_ID);
    view.dispatch({ changes: { from: 9, to: 10, insert: "E" } });
    decide.release();
    await accepted;
    // A typed edit right where it was keeps the card until Dismiss.
    view.dispatch({ changes: { from: 8, to: 19 } });
    expect(view.state.field(redlineNotesField)).toHaveLength(1);
    expect(rejectNote(view, CHANGE_ID)).toBe(true);
    expect(view.state.field(redlineNotesField)).toEqual([]);
    expect(decide.calls()).toBe(1);
    expect(await acceptNote(view, CHANGE_ID)).toBe(false);
    const gutter = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    expect(gutter).toContain(
      'if (state.kind === "not-applied") root.append(calmStatus(ACCEPTED_NOT_ADDED_LINE));',
    );
  });

  test("the card stays while deciding, even when a pull would drop it", async () => {
    const decide = holdDecide();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(shareCard()) });
    const accepted = acceptNote(view, CHANGE_ID);
    view.dispatch({ effects: removeRedlineNote.of(CHANGE_ID) });
    expect(view.state.field(redlineNotesField)).toHaveLength(1);
    expect(view.state.field(redlineNotesField)[0]?.deciding).toBe(true);
    expect(rejectNote(view, CHANGE_ID)).toBe(false);
    decide.release();
    await expect(accepted).resolves.toBe(true);
    expect(view.state.doc.toString()).toBe("This is truly important.");
    const after = view.state.field(redlineNotesField)[0];
    expect(after?.status).toBe("accepted");
    expect(after?.deciding).toBeFalsy();
  });

  test("a failed decision leaves the card ready to try again", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "share_decide") throw new Error("unreachable");
      return undefined;
    });
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(shareCard()) });
    await expect(acceptNote(view, CHANGE_ID)).resolves.toBe(false);
    const card = view.state.field(redlineNotesField)[0];
    expect(card?.status).toBe("pending");
    expect(card?.deciding).toBeFalsy();
    expect(view.state.doc.toString()).toBe(ORIGINAL);
  });
});

describe("Dismiss on a comment from the other person", () => {
  const comment = () =>
    shareCard({
      intent: "none",
      proposed: "Is this right?",
      instruction: "Is this right?",
      original: "really very",
      shareAccept: false,
    });

  test("a second click while the dismiss is saving sends nothing and says nothing", async () => {
    const decide = holdDecide();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(comment()) });
    expect(rejectNote(view, CHANGE_ID)).toBe(true);
    expect(view.state.field(redlineNotesField)[0]?.deciding).toBe(true);
    expect(rejectNote(view, CHANGE_ID)).toBe(false);
    expect(decide.calls()).toBe(1);
    decide.release();
    await vi.waitFor(() => expect(view.state.field(redlineNotesField)).toEqual([]));
    expect(useEditorNoticeStore.getState().message).not.toBe(SHARE_DECIDE_FAILED);
  });

  test("the Dismiss button is off while the decision is saving", () => {
    const gutter = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    const at = gutter.indexOf('} else if (personNote && note.intent === "none") {');
    const branch = gutter.slice(at, gutter.indexOf("} else if", at + 10));
    expect(branch).toContain('{ action: "dismiss", disabled: isDeciding(note) }');
  });
});

function openNote(overrides: Partial<RedlineNote> = {}): RedlineNote {
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

/** redline_propose answers in the order the test resolves them. */
function heldAsks(): { answer: (value: unknown) => void; fail: (error: unknown) => void } {
  const waiting: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  mockedInvoke.mockImplementation(async (command) => {
    if (command !== "redline_propose") return undefined;
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  });
  return {
    answer: (value) => waiting.shift()?.resolve(value),
    fail: (error) => waiting.shift()?.reject(error),
  };
}

describe("Ask in flight", () => {
  beforeEach(() => {
    rememberWritingSession(true);
    rememberWritingOffline(false);
  });

  test("Cancel goes back to the field with the ask, and the late answer is dropped", async () => {
    const asks = heldAsks();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(openNote()) });
    const asked = askAgentOnNote(view, "redline-1", "tighten");
    expect(noteState(view.state.field(redlineNotesField)[0]!).kind).toBe("asking");
    expect(rejectNote(view, "redline-1")).toBe(true);
    const cancelled = view.state.field(redlineNotesField)[0]!;
    expect(noteState(cancelled).kind).toBe("compose");
    expect(cancelled.instruction).toBe("tighten");
    asks.answer({ suggested_text: "Tight.", intent: "replace" });
    await asked;
    const after = view.state.field(redlineNotesField)[0]!;
    expect(after.status).toBe("open");
    expect(after.proposed).toBeNull();
    expect(view.state.doc.toString()).toBe(ORIGINAL);
  });

  test("after Cancel and a second Ask, only the second answer lands", async () => {
    const asks = heldAsks();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(openNote()) });
    const first = askAgentOnNote(view, "redline-1", "first");
    rejectNote(view, "redline-1");
    const second = askAgentOnNote(view, "redline-1", "second");
    asks.answer({ suggested_text: "From the first ask.", intent: "replace" });
    await first;
    expect(noteState(view.state.field(redlineNotesField)[0]!).kind).toBe("asking");
    asks.answer({ suggested_text: "From the second ask.", intent: "replace" });
    await second;
    const landed = view.state.field(redlineNotesField)[0]!;
    expect(landed.proposed).toBe("From the second ask.");
    expect(landed.instruction).toBe("second");
  });

  test("a late failure for a cancelled ask does not turn the field into an error", async () => {
    const asks = heldAsks();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(openNote()) });
    const asked = askAgentOnNote(view, "redline-1", "tighten");
    rejectNote(view, "redline-1");
    asks.fail(HARD_CAP_LINE);
    await asked;
    expect(view.state.field(redlineNotesField)[0]?.status).toBe("open");
  });

  test("Rust's lines become codes once; the card reads the code", async () => {
    const asks = heldAsks();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(openNote()) });
    const signIn = askAgentOnNote(view, "redline-1", "tighten");
    asks.fail(ASK_SIGN_IN_WIRE);
    await signIn;
    const card = view.state.field(redlineNotesField)[0]!;
    expect(card.errorCode).toBe("sign-in");
    expect(isSignInPrompt(card)).toBe(true);

    for (const [line, check] of [
      [ASK_CANCELLED_LINE, isCancelledAsk],
      [HARD_CAP_LINE, isCalmStatusNote],
    ] as const) {
      const next = viewOf(ORIGINAL);
      next.dispatch({ effects: addRedlineNote.of(openNote()) });
      const asked = askAgentOnNote(next, "redline-1", "tighten");
      asks.fail(line);
      await asked;
      expect(check(next.state.field(redlineNotesField)[0]!)).toBe(true);
    }
  });

  test("the no-search sentence from Rust is a hold; the same words typed in a note are not", async () => {
    const asks = heldAsks();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(openNote()) });
    const asked = askAgentOnNote(view, "redline-1", "@agent add a citation");
    asks.answer({ suggested_text: TOOL_CAUTION_NOTE, intent: "none" });
    await asked;
    const held = view.state.field(redlineNotesField)[0]!;
    expect(held.hold).toBe(true);
    expect(isToolCautionHold(held)).toBe(true);
    expect(
      isToolCautionHold(
        openNote({
          status: "pending",
          intent: "none",
          proposed: TOOL_CAUTION_NOTE,
          instruction: "typed by hand",
        }),
      ),
    ).toBe(false);
  });

  test("an answer that comes back as a plain note can be dismissed", async () => {
    const asks = heldAsks();
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(openNote()) });
    const asked = askAgentOnNote(view, "redline-1", "is this clear?");
    asks.answer({ suggested_text: "This sentence already reads clearly.", intent: "none" });
    await asked;
    const answer = view.state.field(redlineNotesField)[0]!;
    expect(noteState(answer).kind).toBe("comment");
    expect(answer.person).toBeUndefined();
    const gutter = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    const at = gutter.indexOf('} else if (state.kind === "comment") {');
    expect(at).toBeGreaterThan(-1);
    const branch = gutter.slice(at, gutter.indexOf("\n  }\n", at));
    expect(branch).toContain("DISMISS");
    expect(branch).toContain("handlers.reject(view, note.id)");
    expect(branch).toContain('action: "dismiss"');
    expect(rejectNote(view, "redline-1")).toBe(true);
    expect(view.state.field(redlineNotesField)).toEqual([]);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
  });

  test("the margin offers Cancel while thinking and disables a deciding Accept", () => {
    const gutter = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    const asking = gutter.slice(gutter.indexOf('} else if (state.kind === "asking") {'));
    expect(asking).toContain("COMPOSE_CANCEL_LABEL");
    expect(asking).toContain("handlers.reject(view, note.id)");
    expect(asking).toContain('action: "cancel-ask"');
    expect(gutter).toContain('{ action: "accept", disabled: deciding }');
    expect(gutter).toContain('{ action: "reject", disabled: deciding }');
    const rust = readFileSync(
      new URL("../src-tauri/src/commands/redline.rs", import.meta.url),
      "utf8",
    );
    expect(rust).toContain(`=> "${ASK_SIGN_IN_WIRE}"`);
  });
});

describe("ink tick", () => {
  test("an Accept in another pane does not leave this pane's tick painted", async () => {
    vi.useFakeTimers();
    try {
      const suggestion = openNote({ status: "pending", intent: "replace", proposed: "Short." });
      const left = viewOf(ORIGINAL);
      const right = viewOf(ORIGINAL);
      left.dispatch({ effects: addRedlineNote.of(suggestion) });
      right.dispatch({ effects: addRedlineNote.of(suggestion) });
      await acceptNote(left, "redline-1");
      await acceptNote(right, "redline-1");
      expect(left.state.field(redlineInkTickField)).toBe("redline-1");
      expect(right.state.field(redlineInkTickField)).toBe("redline-1");
      await vi.advanceTimersByTimeAsync(REDLINE_INK_TICK_MS + 10);
      expect(left.state.field(redlineInkTickField)).toBeNull();
      expect(right.state.field(redlineInkTickField)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("transition guards", () => {
  test("markAccepted only moves a pending note", () => {
    const view = viewOf(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(openNote()) });
    view.dispatch({ effects: markAccepted.of("redline-1") });
    expect(view.state.field(redlineNotesField)[0]?.status).toBe("open");
  });
});
