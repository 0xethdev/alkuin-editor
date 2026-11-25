import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { EditorSelection, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  addRedlineNote,
  applyProposal,
  askAgentAtRange,
  askAgentFromMenu,
  askAgentOnNote,
  askAlkuinOnNote,
  beginAskOnNote,
  leaveNoteOnNote,
  buildRedlineDecorations,
  askErrorMessage,
  markAsking,
  proposeRewrite,
  redlineNotesField,
  rejectNote,
  acceptNote,
  preferenceRecordArgs,
  requestRewrite,
  setAskError,
  setProposed,
  TOOL_CAUTION_NOTE,
  redlineInkTickField,
  redlineNoteLabel,
  noteShowsCompose,
} from "../src/features/redline-spike";
import type { RedlineNote } from "../src/features/redline-spike";
import { rememberWritingPlan, rememberWritingSession } from "../src/lib/account-session";
import { KEEP_ON_MAC_ASSISTANT } from "../src/lib/keep-on-mac";
import {
  ASK_CANCELLED_LINE,
  BAD_ASK_LINE,
  MODEL_UNREACHABLE_LINE,
  TRY_AGAIN_LABEL,
  FREE_MONTH_LINE,
  FREE_SLICE_LINE,
  PAID_CAP_LINE,
  SEE_PLANS_LABEL,
  HARD_CAP_LINE,
  isCalmStatusLine,
  CITATIONS_LINE,
  ASK_REFUSED_LINE,
  SIGNUP_CAP_LINE,
  SIGNUP_IP_LINE,
  ACCOUNT_PAUSED_LINE,
  DAILY_CAP_LINE,
  FREE_DAY_LINE,
  askErrorCode,
} from "../src/features/redline-spike/margin-copy";
import { fillHelpLine } from "../src/features/redline-spike/budget-status";

const mockedInvoke = vi.mocked(invoke);
const ORIGINAL = "This is really very important.";
const FIXTURE = proposeRewrite(ORIGINAL);
const MODEL_TEXT = "Clarity matters more than filler.";
const INSERT = " also true.";

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

/** A failed ask as the reducer stores it: the line, and the code read from it once. */
function failedAsk(line: string): RedlineNote {
  let state = EditorState.create({ doc: ORIGINAL, extensions: [redlineNotesField] });
  state = state.update({ effects: addRedlineNote.of(note()) }).state;
  state = state.update({ effects: setAskError.of({ id: "redline-1", error: line }) }).state;
  return state.field(redlineNotesField)[0]!;
}

function markClasses(doc: string, item: RedlineNote) {
  const classes: string[] = [];
  const set = buildRedlineDecorations(Text.of([doc]), [item]);
  set.between(0, doc.length, (_a, _b, value) => {
    const cls = value.spec.class as string | undefined;
    if (cls) classes.push(cls);
  });
  return classes;
}

function insertAfter(doc: string, item: RedlineNote) {
  const found: string[] = [];
  const set = buildRedlineDecorations(Text.of([doc]), [item]);
  set.between(0, doc.length + 1, (_from, _to, value) => {
    const widget = value.spec.widget as { kind?: string; text?: string } | undefined;
    if (widget?.kind === "insert") found.push(widget.text ?? "");
  });
  return found;
}

beforeEach(() => {
  rememberWritingSession(true);
  vi.clearAllMocks();
});

describe("requestRewrite calls the native command", () => {
  test("a failed ask is an error, not a filler-strip rewrite", async () => {
    mockedInvoke.mockRejectedValue(new Error("Writing help is not set up on this build."));
    await expect(requestRewrite(ORIGINAL, "improve")).rejects.toThrow(/not set up/);
    expect(FIXTURE).toBe("This is important.");
    expect(mockedInvoke).toHaveBeenCalledWith("redline_propose", {
      path: "",
      original: ORIGINAL,
      instruction: "improve",
    });
    const result = await requestRewrite(ORIGINAL, "improve").then(
      (value) => value,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(result).not.toEqual({ suggested_text: FIXTURE, intent: "replace" });
    expect(typeof result === "string" ? result : "").not.toBe(FIXTURE);
  });

  test("a mocked insert answer: original unmarked, proposed after, Accept keeps both", async () => {
    mockedInvoke.mockResolvedValue({ suggested_text: INSERT, intent: "insert" });
    const proposal = await requestRewrite(ORIGINAL, "any data points we can add?");
    expect(proposal).toEqual({ suggested_text: INSERT, intent: "insert" });
    expect(proposal.suggested_text).not.toBe(FIXTURE);

    let state = EditorState.create({ doc: ORIGINAL, extensions: [redlineNotesField] });
    state = state.update({ effects: addRedlineNote.of(note()) }).state;
    state = state.update({
      effects: setProposed.of({
        id: "redline-1",
        proposed: proposal.suggested_text,
        intent: proposal.intent,
        instruction: "any data points we can add?",
      }),
    }).state;
    const item = state.field(redlineNotesField)[0]!;
    expect(item.intent).toBe("insert");
    expect(markClasses(ORIGINAL, item)).not.toContain("cm-redline-del");
    expect(insertAfter(ORIGINAL, item)).toEqual([INSERT]);
    expect(state.doc.toString()).toBe(ORIGINAL);
    expect(applyProposal(ORIGINAL, item.from, item.to, item.proposed ?? "", item.intent!)).toBe(
      ORIGINAL + INSERT,
    );
  });

  test("a mocked replace answer: strike plus insert, Accept keeps new only", async () => {
    mockedInvoke.mockResolvedValue({ suggested_text: MODEL_TEXT, intent: "replace" });
    const proposal = await requestRewrite(ORIGINAL, "improve");
    expect(proposal.intent).toBe("replace");

    let state = EditorState.create({ doc: ORIGINAL, extensions: [redlineNotesField] });
    state = state.update({ effects: addRedlineNote.of(note()) }).state;
    state = state.update({
      effects: setProposed.of({
        id: "redline-1",
        proposed: proposal.suggested_text,
        intent: proposal.intent,
        instruction: "improve",
      }),
    }).state;
    const item = state.field(redlineNotesField)[0]!;
    expect(markClasses(ORIGINAL, item)).toContain("cm-redline-del");
    expect(insertAfter(ORIGINAL, item)).toEqual([MODEL_TEXT]);
    expect(applyProposal(ORIGINAL, item.from, item.to, item.proposed ?? "", item.intent!)).toBe(
      MODEL_TEXT,
    );
  });

  test("a mocked none answer: Accept does not change disk bytes", async () => {
    mockedInvoke.mockResolvedValue({ suggested_text: "", intent: "none" });
    const proposal = await requestRewrite(ORIGINAL, "looks off");
    expect(proposal.intent).toBe("none");

    let state = EditorState.create({ doc: ORIGINAL, extensions: [redlineNotesField] });
    state = state.update({ effects: addRedlineNote.of(note()) }).state;
    state = state.update({
      effects: setProposed.of({
        id: "redline-1",
        proposed: proposal.suggested_text,
        intent: proposal.intent,
        instruction: "looks off",
      }),
    }).state;
    const item = state.field(redlineNotesField)[0]!;
    expect(markClasses(ORIGINAL, item)).toContain("cm-redline-open");
    expect(markClasses(ORIGINAL, item)).not.toContain("cm-redline-del");
    expect(insertAfter(ORIGINAL, item)).toEqual([]);
    expect(applyProposal(ORIGINAL, item.from, item.to, item.proposed ?? "", item.intent!)).toBe(
      ORIGINAL,
    );
  });

  test("plaintext / missing intent coerces to replace", async () => {
    mockedInvoke.mockResolvedValue({ suggested_text: MODEL_TEXT });
    const proposal = await requestRewrite(ORIGINAL, "improve");
    expect(proposal.intent).toBe("replace");
    expect(proposal.suggested_text).toBe(MODEL_TEXT);
  });
});

/** A sentence the server can send in place of a suggestion. */
const SERVER_NOTE =
  "Alkuin couldn't give you a suggestion for this one. Your text is unchanged. Try again, or select a different passage.";

const ASK_FAILED = "Writing help is not set up on this build.";

function dispatchView(doc: string, selectionTo = doc.length) {
  let state = EditorState.create({
    doc,
    extensions: [redlineNotesField, redlineInkTickField],
    selection: EditorSelection.range(0, selectionTo),
  });
  const focused: string[] = [];
  const view = {
    get state() {
      return state;
    },
    dom: { isConnected: true },
    scrollDOM: {
      querySelector(sel: string) {
        const id = /data-redline-note="([^"]+)"/.exec(sel)?.[1];
        if (!id) return null;
        return {
          value: "",
          focus() {
            focused.push(id);
          },
        };
      },
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
    focus() {
      // EditorView.focus() writes CM selection to the DOM; on Mac after a
      // native menu that selection is often a caret. Collapse live state if
      // the helper still calls focus() before addNote.
      focused.push("view");
      state = state.update({ selection: EditorSelection.cursor(0) }).state;
    },
  };
  return { view: view as unknown as EditorView, focused };
}

describe("askErrorMessage", () => {
  test("unwraps strings, Errors, and Tauri IPC objects", () => {
    expect(askErrorMessage(ASK_FAILED)).toBe(ASK_FAILED);
    expect(askErrorMessage(new Error(ASK_FAILED))).toBe(ASK_FAILED);
    expect(askErrorMessage({ message: ASK_FAILED })).toBe(ASK_FAILED);
    expect(askErrorMessage({ payload: ASK_FAILED })).toBe(ASK_FAILED);
    expect(askErrorMessage({})).toBe("No suggestion this time. Try asking again.");
  });
});

describe("askAgentAtRange click path", () => {
  test("empty selection is a no-op and does not invoke the command", () => {
    const { view } = dispatchView(ORIGINAL, 0);
    expect(askAgentAtRange(view, 0, 0)).toBe(false);
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(view.state.field(redlineNotesField)).toEqual([]);
  });

  test("click without instruction opens compose and does not propose", () => {
    const { view, focused } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();
    const item = view.state.field(redlineNotesField)[0];
    expect(item?.status).toBe("open");
    expect(item?.proposed).toBeNull();
    expect(item?.original).toBe(ORIGINAL);
    expect(focused).toEqual([item?.id]);
  });

  test("instruction with @agent submits redline_propose and paints replace", async () => {
    mockedInvoke.mockResolvedValue({ suggested_text: MODEL_TEXT, intent: "replace" });
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length, "@agent make this clearer")).toBe(true);
    await vi.waitFor(() => {
      expect(view.state.field(redlineNotesField)[0]?.proposed).toBe(MODEL_TEXT);
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("redline_propose", {
      path: "",
      original: ORIGINAL,
      instruction: "@agent make this clearer",
    });
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.intent).toBe("replace");
    expect(item.status).toBe("pending");
    expect(markClasses(ORIGINAL, item)).toContain("cm-redline-del");
    expect(insertAfter(ORIGINAL, item)).toEqual([MODEL_TEXT]);
  });

  test("a 501-character @agent instruction is blocked with the refusal line", async () => {
    expect(BAD_ASK_LINE).toBe("That ask is too long or has extra fields. Try a shorter ask.");
    const instruction = `@agent ${"x".repeat(494)}`;
    expect(instruction.trim().length).toBe(501);
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length, instruction)).toBe(true);
    await vi.waitFor(() => {
      expect(view.state.field(redlineNotesField)[0]?.status).toBe("error");
    });
    expect(view.state.field(redlineNotesField)[0]?.error).toBe(
      "That ask is too long or has extra fields. Try a shorter ask.",
    );
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  test("budget lines stay pinned and read as a status", () => {
    expect(BAD_ASK_LINE).toBe("That ask is too long or has extra fields. Try a shorter ask.");
    expect(HARD_CAP_LINE).toBe("You've used this month's writing help.");
    expect(PAID_CAP_LINE).toBe(
      "You've used all your help for now. It comes back on {date}. To keep going before then, buy $10 of credit. Tax is added at checkout.",
    );
    expect(FREE_SLICE_LINE).toBe(
      "Today's free help has run out. It comes back at {time}. A paid plan gives you more help every month.",
    );
    expect(FREE_MONTH_LINE).toBe(
      "You've used all your free help. It comes back on {date}. A paid plan gives you more help every month.",
    );
    expect(SEE_PLANS_LABEL).toBe("See paid plans");
    expect(SIGNUP_CAP_LINE).toBe(
      "Alkuin isn't taking new accounts right now. Try again tomorrow. If you already have an account, check the email you entered.",
    );
    expect(SIGNUP_IP_LINE).toBe(
      "Too many sign-ups from this network. Try again later. If you already have an account, check the email you entered.",
    );
    const screen = readFileSync(
      new URL("../src/components/sign-in-screen.tsx", import.meta.url),
      "utf8",
    );
    expect(screen).not.toContain("trial_used");
    const palette = readFileSync(
      new URL("../src/components/command-palette/index.tsx", import.meta.url),
      "utf8",
    );
    const preferences = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    const accountDelete = readFileSync(
      new URL("../src/lib/account-delete.ts", import.meta.url),
      "utf8",
    );
    expect(accountDelete).toContain("deleteAccountConfirmText()");
    expect(palette).toContain("runDeleteAccount(");
    expect(preferences).toContain("runDeleteAccount(");
    const dated = PAID_CAP_LINE;
    for (const line of [
      HARD_CAP_LINE,
      dated,
      ASK_REFUSED_LINE,
      CITATIONS_LINE,
      SIGNUP_CAP_LINE,
      SIGNUP_IP_LINE,
      fillHelpLine(FREE_DAY_LINE, "2026-10-17T00:00:00Z"),
      ACCOUNT_PAUSED_LINE,
      DAILY_CAP_LINE,
    ]) {
      expect(isCalmStatusLine(line)).toBe(true);
      expect(askErrorCode(line)).toBe("calm");
      expect(redlineNoteLabel(failedAsk(line))).toBe("");
      expect(noteShowsCompose(failedAsk(line))).toBe(false);
    }
    expect(isCalmStatusLine(BAD_ASK_LINE)).toBe(false);
    expect(redlineNoteLabel(failedAsk(BAD_ASK_LINE))).toBe("Couldn't finish");
    expect(noteShowsCompose(failedAsk(BAD_ASK_LINE))).toBe(true);
    // The code is the state. A reworded line on a coded card does not change the card.
    const reworded = note({ status: "error", error: "Reworded cap line.", errorCode: "calm" });
    expect(redlineNoteLabel(reworded)).toBe("");
    expect(noteShowsCompose(reworded)).toBe(false);
    expect(ASK_CANCELLED_LINE).toBe(
      "Alkuin couldn't run this ask right now, so it was cancelled. You weren't charged. Try again in a moment.",
    );
    expect(TRY_AGAIN_LABEL).toBe("Try again");
    expect(MODEL_UNREACHABLE_LINE).toBe(
      "Alkuin can't connect right now. Your text is unchanged. Check your connection and try again.",
    );
    expect(askErrorCode(ASK_CANCELLED_LINE)).toBe("cancelled");
    expect(noteShowsCompose(failedAsk(ASK_CANCELLED_LINE))).toBe(false);
    const gutter = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    expect(gutter).not.toContain("note.error === ASK_CANCELLED_LINE");
    expect(gutter).not.toContain("note.error === SIGN_IN_LABEL");
    expect(gutter).not.toContain("isCalmStatusLine(note.error)");
    const cancelledAt = gutter.lastIndexOf("if (isCancelledAsk(note))");
    const cancelled = gutter.slice(cancelledAt, cancelledAt + 700);
    expect(cancelled).toContain("TRY_AGAIN_LABEL");
    expect(cancelled).toContain('action: "try-again"');
    expect(cancelled).not.toContain("MODEL_UNREACHABLE_LINE");
  });

  test("a calm status note dismisses with the same note button and leaves nothing", () => {
    const gutter = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    const start = gutter.indexOf("if (note.error && isCalmStatusNote(note)) {");
    expect(start).toBeGreaterThan(-1);
    const calm = gutter.slice(start, gutter.indexOf('if (note.status === "accepted") {', start));
    expect(calm).toContain("SEE_PLANS_LABEL");
    expect(calm).toContain("PLANS_URL");
    expect(calm).toContain('action: "plans"');
    expect(calm).toContain(
      'inkButton(\n        view,\n        "cm-redline-btn",\n        "Dismiss"',
    );
    expect(calm).toContain("handlers.reject(view, note.id)");
    const { view } = dispatchView(ORIGINAL);
    view.dispatch({
      effects: addRedlineNote.of(note({ id: "cap", status: "error", error: HARD_CAP_LINE })),
    });
    expect(rejectNote(view, "cap")).toBe(true);
    expect(view.state.field(redlineNotesField)).toEqual([]);
  });

  test("missing-key IPC object lands on the note, not a filler strip", async () => {
    mockedInvoke.mockRejectedValue({ message: ASK_FAILED });
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length, "@agent improve")).toBe(true);
    await vi.waitFor(() => {
      expect(view.state.field(redlineNotesField)[0]?.status).toBe("error");
    });
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.proposed).toBeNull();
    expect(item.error).toBe(ASK_FAILED);
    expect(item.original).toBe(ORIGINAL);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(item.original).not.toBe(FIXTURE);
  });

  test("menu helper still asks after view.focus() collapses the live selection", async () => {
    mockedInvoke.mockResolvedValue({ suggested_text: INSERT, intent: "insert" });
    const { view, focused } = dispatchView(ORIGINAL);
    const captured = { from: 0, to: ORIGINAL.length };
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(view.state.selection.main.empty).toBe(true);
    expect(
      askAgentFromMenu(view, captured.from, captured.to, "@agent any data points we can add?"),
    ).toBe(true);
    const item = view.state.field(redlineNotesField)[0];
    expect(item?.original).toBe(ORIGINAL);
    expect(item?.from).toBe(captured.from);
    expect(item?.to).toBe(captured.to);
    expect(focused.filter((id) => id !== "view")).toEqual([]);
    await vi.waitFor(() => {
      expect(view.state.field(redlineNotesField)[0]?.intent).toBe("insert");
    });
    expect(mockedInvoke).toHaveBeenCalledWith("redline_propose", {
      path: "",
      original: ORIGINAL,
      instruction: "@agent any data points we can add?",
    });
  });

  test("menu Ask without instruction keeps captured span when focus() would collapse", () => {
    const { view, focused } = dispatchView(ORIGINAL);
    const captured = { from: 0, to: ORIGINAL.length };
    view.focus();
    expect(view.state.selection.main.empty).toBe(true);
    expect(askAgentFromMenu(view, captured.from, captured.to)).toBe(true);
    const item = view.state.field(redlineNotesField)[0];
    expect(item?.original).toBe(ORIGINAL);
    expect(item?.status).toBe("open");
    expect(item?.from).toBe(0);
    expect(item?.to).toBe(ORIGINAL.length);
    expect(focused).toEqual(["view", item?.id]);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

describe("beginAskOnNote comment routing", () => {
  test("text with no tag is stored and does not call the model", async () => {
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(beginAskOnNote(view, id, "this is muddy")).toBe(true);
    await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalled();
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.intent).toBe("none");
    expect(item.proposed).toBe("this is muddy");
    expect(item.instruction).toBeNull();
    expect(item.status).toBe("pending");
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(markClasses(ORIGINAL, item)).toContain("cm-redline-open");
    expect(markClasses(ORIGINAL, item)).not.toContain("cm-redline-del");
    expect(insertAfter(ORIGINAL, item)).toEqual([]);
  });

  test("Cancel drops the draft and leaves the document unchanged", () => {
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(rejectNote(view, id)).toBe(true);
    expect(view.state.field(redlineNotesField)).toEqual([]);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  test("beginAskOnNote stores @agent as a note and does not call the model", async () => {
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(beginAskOnNote(view, id, "@agent make this clearer")).toBe(true);
    await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalled();
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.intent).toBe("none");
    expect(item.proposed).toBe("@agent make this clearer");
    expect(item.instruction).toBeNull();
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(markClasses(ORIGINAL, item)).toContain("cm-redline-open");
    expect(markClasses(ORIGINAL, item)).not.toContain("cm-redline-del");
  });

  test("Ask Alkuin sends the note text with no tag", async () => {
    mockedInvoke.mockResolvedValue({ suggested_text: MODEL_TEXT, intent: "replace" });
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(askAlkuinOnNote(view, id, "make this clearer")).toBe(true);
    await vi.waitFor(() => {
      expect(view.state.field(redlineNotesField)[0]?.proposed).toBe(MODEL_TEXT);
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("redline_propose", {
      path: "",
      original: ORIGINAL,
      instruction: "make this clearer",
    });
    expect(view.state.doc.toString()).toBe(ORIGINAL);
  });

  test("Leave note stores the text and never calls the model", async () => {
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(leaveNoteOnNote(view, id, "make this clearer")).toBe(true);
    await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalled();
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.intent).toBe("none");
    expect(item.proposed).toBe("make this clearer");
    expect(item.instruction).toBeNull();
    expect(view.state.doc.toString()).toBe(ORIGINAL);
  });

  test("@Alkuin and @agent stay text on Leave note", async () => {
    for (const instruction of [
      "@Alkuin make this clearer",
      "@agent make this clearer",
      "@AGENT tighten",
    ]) {
      mockedInvoke.mockClear();
      const { view } = dispatchView(ORIGINAL);
      expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
      const id = view.state.field(redlineNotesField)[0]!.id;
      expect(leaveNoteOnNote(view, id, instruction)).toBe(true);
      await Promise.resolve();
      expect(mockedInvoke).not.toHaveBeenCalled();
      const item = view.state.field(redlineNotesField)[0]!;
      expect(item.intent).toBe("none");
      expect(item.proposed).toBe(instruction);
      expect(item.instruction).toBeNull();
      expect(view.state.doc.toString()).toBe(ORIGINAL);
    }
  });

  test("Ask Alkuin still sends text that contains @agent", async () => {
    mockedInvoke.mockResolvedValue({ suggested_text: MODEL_TEXT, intent: "replace" });
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(askAlkuinOnNote(view, id, "@agent make this clearer")).toBe(true);
    await vi.waitFor(() => {
      expect(view.state.field(redlineNotesField)[0]?.proposed).toBe(MODEL_TEXT);
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("redline_propose", {
      path: "",
      original: ORIGINAL,
      instruction: "@agent make this clearer",
    });
  });

  test("a person name after @ does not ask, including from Leave note", async () => {
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(leaveNoteOnNote(view, id, "@maria look at this")).toBe(true);
    await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalled();
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.intent).toBe("none");
    expect(item.proposed).toBe("@maria look at this");
  });

  test("Keep on this Mac only blocks an Ask and leaves the document", async () => {
    mockedInvoke.mockRejectedValue(new Error(KEEP_ON_MAC_ASSISTANT));
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(askAlkuinOnNote(view, id, "make this clearer")).toBe(true);
    await vi.waitFor(() => {
      expect(view.state.field(redlineNotesField)[0]?.status).toBe("error");
    });
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.error).toBe(KEEP_ON_MAC_ASSISTANT);
    expect(item.proposed).toBeNull();
    expect(item.intent).toBeNull();
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("redline_propose", {
      path: "",
      original: ORIGINAL,
      instruction: "make this clearer",
    });
  });

  test("an empty Ask does not call the model", async () => {
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(askAlkuinOnNote(view, id, "   ")).toBe(true);
    await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(view.state.field(redlineNotesField)[0]?.status).toBe("open");
  });

  test("@some-person does not call the model and does not open accounts", async () => {
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(leaveNoteOnNote(view, id, "@some-person looks off")).toBe(true);
    await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalled();
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.intent).toBe("none");
    expect(item.proposed).toBe("@some-person looks off");
    expect(item.instruction).toBeNull();
    expect(item.status).toBe("pending");
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(markClasses(ORIGINAL, item)).toContain("cm-redline-open");
    expect(markClasses(ORIGINAL, item)).not.toContain("cm-redline-del");
    expect(insertAfter(ORIGINAL, item)).toEqual([]);
  });
});

describe("askAgentOnNote", () => {
  test("in-flight pending note does not double-invoke", async () => {
    const { view } = dispatchView(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(note({ status: "pending" })) });
    await expect(askAgentOnNote(view, "redline-1", "again")).resolves.toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

describe("preference shell lessons", () => {
  test("Accept/Reject on an agent proposal records instruction, not the draft", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    view.dispatch({
      effects: setProposed.of({
        id,
        proposed: MODEL_TEXT,
        intent: "replace",
        instruction: "@agent make this clearer",
      }),
    });
    const item = view.state.field(redlineNotesField)[0]!;
    const args = preferenceRecordArgs(item, true);
    expect(args).toEqual({
      accepted: true,
      intent: "replace",
      instruction: "@agent make this clearer",
    });
    expect(JSON.stringify(args)).not.toContain(ORIGINAL);
    expect(JSON.stringify(args)).not.toContain(MODEL_TEXT);

    await acceptNote(view, id);
    expect(mockedInvoke).not.toHaveBeenCalledWith("redline_record_preference", expect.anything());
    expect(mockedInvoke).toHaveBeenCalledWith("redline_learn", {
      path: "",
      source: "accept",
      before: ORIGINAL,
      suggested: MODEL_TEXT,
      finalText: MODEL_TEXT,
    });
  });

  test("a free account does not send a learn call", async () => {
    rememberWritingPlan("free");
    try {
      mockedInvoke.mockResolvedValue(undefined);
      const { view } = dispatchView(ORIGINAL);
      expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
      const id = view.state.field(redlineNotesField)[0]!.id;
      view.dispatch({
        effects: setProposed.of({
          id,
          proposed: MODEL_TEXT,
          intent: "replace",
          instruction: "@agent make this clearer",
        }),
      });
      await acceptNote(view, id);
      expect(mockedInvoke).not.toHaveBeenCalledWith("redline_learn", expect.anything());
    } finally {
      rememberWritingPlan(null);
    }
  });

  test("a paid account still sends a learn call", async () => {
    rememberWritingPlan("paid");
    try {
      mockedInvoke.mockResolvedValue(undefined);
      const { view } = dispatchView(ORIGINAL);
      expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
      const id = view.state.field(redlineNotesField)[0]!.id;
      view.dispatch({
        effects: setProposed.of({
          id,
          proposed: MODEL_TEXT,
          intent: "replace",
          instruction: "@agent make this clearer",
        }),
      });
      await acceptNote(view, id);
      expect(mockedInvoke).toHaveBeenCalledWith("redline_learn", {
        path: "",
        source: "accept",
        before: ORIGINAL,
        suggested: MODEL_TEXT,
        finalText: MODEL_TEXT,
      });
    } finally {
      rememberWritingPlan(null);
    }
  });

  test("Reject records a lesson; compose Cancel and own notes do not", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    view.dispatch({
      effects: setProposed.of({
        id,
        proposed: MODEL_TEXT,
        intent: "insert",
        instruction: "@agent add a flourish",
      }),
    });
    expect(rejectNote(view, id)).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalledWith("redline_record_preference", expect.anything());
    expect(mockedInvoke).toHaveBeenCalledWith("redline_learn", {
      path: "",
      source: "reject",
      before: ORIGINAL,
      suggested: MODEL_TEXT,
      finalText: "",
    });

    mockedInvoke.mockClear();
    const { view: compose } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(compose, 0, ORIGINAL.length)).toBe(true);
    const composeId = compose.state.field(redlineNotesField)[0]!.id;
    expect(rejectNote(compose, composeId)).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();

    expect(preferenceRecordArgs(note({ instruction: null, intent: "none" }), true)).toBeNull();
  });

  test("Dismiss after Accept, in-flight Ask, and error do not record", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    view.dispatch({
      effects: setProposed.of({
        id,
        proposed: MODEL_TEXT,
        intent: "replace",
        instruction: "@agent make this clearer",
      }),
    });
    await acceptNote(view, id);
    expect(mockedInvoke).toHaveBeenCalledWith("redline_learn", {
      path: "",
      source: "accept",
      before: ORIGINAL,
      suggested: MODEL_TEXT,
      finalText: MODEL_TEXT,
    });
    mockedInvoke.mockClear();
    expect(rejectNote(view, id)).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();

    mockedInvoke.mockClear();
    const { view: asking } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(asking, 0, ORIGINAL.length)).toBe(true);
    const askingId = asking.state.field(redlineNotesField)[0]!.id;
    asking.dispatch({
      effects: markAsking.of({ id: askingId, instruction: "@agent make this clearer" }),
    });
    expect(rejectNote(asking, askingId)).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();

    const { view: failed } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(failed, 0, ORIGINAL.length)).toBe(true);
    const failedId = failed.state.field(redlineNotesField)[0]!.id;
    failed.dispatch({ effects: setAskError.of({ id: failedId, error: "no key" }) });
    expect(rejectNote(failed, failedId)).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();

    expect(
      preferenceRecordArgs(
        note({ instruction: "@agent x", intent: "replace", status: "accepted" }),
        false,
      ),
    ).toBeNull();
    expect(
      preferenceRecordArgs(
        note({ instruction: "@agent x", intent: null, status: "pending" }),
        false,
      ),
    ).toBeNull();
  });
});

describe("caution hold Accept / Reject", () => {
  const SUGGESTION = "This is important.";

  test("caution note sits under the suggestion; Accept does not ask again", async () => {
    expect(TOOL_CAUTION_NOTE).toBe("Alkuin didn't search the web for this one.");
    mockedInvoke.mockResolvedValue({
      suggested_text: SUGGESTION,
      intent: "replace",
      caution: TOOL_CAUTION_NOTE,
    });
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length, "@agent add a citation")).toBe(true);
    await vi.waitFor(() => {
      expect(view.state.field(redlineNotesField)[0]?.proposed).toBe(SUGGESTION);
    });
    const first = mockedInvoke.mock.calls.find(([cmd]) => cmd === "redline_propose");
    expect(first?.[1]).toEqual({
      path: "",
      original: ORIGINAL,
      instruction: "@agent add a citation",
    });
    const held = view.state.field(redlineNotesField)[0]!;
    expect(held.intent).toBe("replace");
    expect(held.caution).toBe(TOOL_CAUTION_NOTE);
    expect(held.status).toBe("pending");
    expect(held.instruction).toBe("@agent add a citation");
    expect(preferenceRecordArgs(held, true)?.instruction).toBe("@agent add a citation");
    expect(markClasses(ORIGINAL, held)).toContain("cm-redline-del");

    mockedInvoke.mockClear();
    await acceptNote(view, held.id);
    expect(mockedInvoke).not.toHaveBeenCalledWith("redline_propose", expect.anything());
    const after = view.state.field(redlineNotesField)[0]!;
    expect(after.status).toBe("accepted");
    expect(after.proposed).toBe(SUGGESTION);
    expect(view.state.doc.toString()).toBe(SUGGESTION);
  });

  test("Reject clears the suggestion without another ask", async () => {
    mockedInvoke.mockResolvedValue({
      suggested_text: SUGGESTION,
      intent: "replace",
      caution: TOOL_CAUTION_NOTE,
    });
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length, "@agent add a citation")).toBe(true);
    await vi.waitFor(() => {
      const note = view.state.field(redlineNotesField)[0];
      expect(note?.proposed).toBe(SUGGESTION);
      expect(note?.caution).toBe(TOOL_CAUTION_NOTE);
      expect(note?.intent).toBe("replace");
      expect(note?.status).toBe("pending");
      expect(note?.instruction).toBe("@agent add a citation");
    });
    expect(mockedInvoke).toHaveBeenCalledWith("redline_propose", {
      path: "",
      original: ORIGINAL,
      instruction: "@agent add a citation",
    });
    mockedInvoke.mockClear();
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(rejectNote(view, id)).toBe(true);
    expect(view.state.field(redlineNotesField)).toEqual([]);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(mockedInvoke).not.toHaveBeenCalledWith("redline_propose", expect.anything());
  });

  test("server notes and own notes still Accept without a call", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    view.dispatch({
      effects: setProposed.of({
        id,
        proposed: SERVER_NOTE,
        intent: "none",
        instruction: "@agent add a citation",
      }),
    });
    await acceptNote(view, id);
    expect(view.state.field(redlineNotesField)[0]?.status).toBe("accepted");
    expect(view.state.field(redlineInkTickField)).toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalledWith("redline_propose", expect.anything());
    expect(view.state.doc.toString()).toBe(ORIGINAL);

    mockedInvoke.mockClear();
    const { view: cite } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(cite, 0, ORIGINAL.length)).toBe(true);
    const citeId = cite.state.field(redlineNotesField)[0]!.id;
    cite.dispatch({
      effects: setProposed.of({
        id: citeId,
        proposed:
          "The paragraph was left as written. Sources were not added, because that would have replaced it.",
        intent: "none",
        instruction: "@agent add a citation",
      }),
    });
    await acceptNote(cite, citeId);
    expect(cite.state.field(redlineNotesField)[0]?.status).toBe("accepted");
    expect(mockedInvoke).not.toHaveBeenCalledWith("redline_propose", expect.anything());

    mockedInvoke.mockClear();
    const { view: own } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(own, 0, ORIGINAL.length)).toBe(true);
    const ownId = own.state.field(redlineNotesField)[0]!.id;
    expect(beginAskOnNote(own, ownId, "this is muddy")).toBe(true);
    await acceptNote(own, ownId);
    expect(own.state.field(redlineNotesField)[0]?.status).toBe("accepted");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  test("overlapping selection starts a second note instead of reusing the first", () => {
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 0, 12)).toBe(true);
    const first = view.state.field(redlineNotesField)[0]!;
    expect(beginAskOnNote(view, first.id, "first note")).toBe(true);
    expect(askAgentAtRange(view, 8, 20)).toBe(true);
    const notes = view.state.field(redlineNotesField);
    expect(notes).toHaveLength(2);
    expect(
      notes.some((item) => item.from === 0 && item.to === 12 && item.proposed === "first note"),
    ).toBe(true);
    const second = notes.find((item) => item.from === 8 && item.to === 20);
    expect(second?.status).toBe("open");
    expect(second?.id).not.toBe(first.id);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  test("overlapping selection in reverse order starts a second note", () => {
    const { view } = dispatchView(ORIGINAL);
    expect(askAgentAtRange(view, 8, 20)).toBe(true);
    const first = view.state.field(redlineNotesField)[0]!;
    expect(beginAskOnNote(view, first.id, "later span")).toBe(true);
    expect(askAgentAtRange(view, 0, 12)).toBe(true);
    const notes = view.state.field(redlineNotesField);
    expect(notes).toHaveLength(2);
    expect(
      notes.some((item) => item.from === 8 && item.to === 20 && item.proposed === "later span"),
    ).toBe(true);
    const second = notes.find((item) => item.from === 0 && item.to === 12);
    expect(second?.status).toBe("open");
    expect(second?.id).not.toBe(first.id);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

describe("Fact check this", () => {
  test("Accept keeps the correction on the sentence and lists references at the end", async () => {
    const doc = "The river was cold. People swam.";
    const claim = "The river was cold.";
    const from = doc.indexOf(claim);
    const proposed = `The river was 4 C [1].

## References

River log. n.d. https://example.com/river`;
    mockedInvoke.mockResolvedValue(undefined);
    const { view } = dispatchView(doc, from + claim.length);
    expect(askAgentAtRange(view, from, from + claim.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    view.dispatch({
      effects: setProposed.of({
        id,
        proposed,
        intent: "replace",
        instruction: "Fact check this",
      }),
    });
    await acceptNote(view, id);
    expect(view.state.doc.toString()).toBe(
      "The river was 4 C [1]. People swam.\n\n## References\n\nRiver log. n.d. https://example.com/river\n",
    );
  });
});
