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
  acceptNote,
  askAgentAtRange,
  buildRedlineDecorations,
  editAskOnNote,
  isToolCautionHold,
  noteShowsLocus,
  redlineGutterBody,
  cautionNoteText,
  redlineInkTickField,
  redlineNoteLabel,
  redlineNotesField,
  rejectNote,
  TOOL_CAUTION_NOTE,
} from "../src/features/redline-spike";
import type { RedlineIntent, RedlineNote } from "../src/features/redline-spike";
import { rememberWritingSession } from "../src/lib/account-session";

const mockedInvoke = vi.mocked(invoke);
const ORIGINAL = "The economy grew last year.";
const POLISH = "Growth was strong last year.";
const CITATION = " (Smith, 2020)";

/** Notes the server can send in place of a suggestion. */
const SERVER_NOTE =
  "Alkuin couldn't give you a suggestion for this one. Your text is unchanged. Try again, or select a different passage.";
const LEFT_AS_WRITTEN_NOTE =
  "The paragraph was left as written. Sources were not added, because that would have replaced it.";

function dispatchView(doc: string) {
  let state = EditorState.create({
    doc,
    extensions: [redlineNotesField, redlineInkTickField],
    selection: EditorSelection.range(0, doc.length),
  });
  const view = {
    get state() {
      return state;
    },
    dom: { isConnected: true },
    scrollDOM: {
      querySelector() {
        return {
          value: "",
          focus() {},
        };
      },
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  };
  return view as unknown as EditorView;
}

function pending(view: EditorView): RedlineNote {
  const note = view.state.field(redlineNotesField)[0];
  if (!note) throw new Error("missing note");
  return note;
}

function markClasses(doc: string, item: RedlineNote) {
  const classes: string[] = [];
  buildRedlineDecorations(Text.of([doc]), [item]).between(0, doc.length, (_a, _b, value) => {
    const cls = value.spec.class as string | undefined;
    if (cls) classes.push(cls);
  });
  return classes;
}

function insertAfter(doc: string, item: RedlineNote) {
  const found: string[] = [];
  buildRedlineDecorations(Text.of([doc]), [item]).between(
    0,
    doc.length + 1,
    (_from, _to, value) => {
      const widget = value.spec.widget as { kind?: string; text?: string } | undefined;
      if (widget?.kind === "insert") found.push(widget.text ?? "");
    },
  );
  return found;
}

function proposeCalls() {
  return mockedInvoke.mock.calls.filter(([cmd]) => cmd === "redline_propose");
}

async function ask(
  view: EditorView,
  instruction: string,
  result: { suggested_text: string; intent: RedlineIntent; caution?: string | null },
) {
  mockedInvoke.mockResolvedValue(result);
  expect(askAgentAtRange(view, 0, view.state.doc.length, instruction)).toBe(true);
  await vi.waitFor(() => {
    expect(pending(view).intent).toBe(result.intent);
    expect(pending(view).proposed).toBe(result.suggested_text);
  });
}

beforeEach(() => {
  rememberWritingSession(true);
  vi.clearAllMocks();
});

describe("cloud proof copy", () => {
  test("the caution and the two server notes stay three different gutter strings", () => {
    expect(SERVER_NOTE).not.toBe(TOOL_CAUTION_NOTE);
    expect(LEFT_AS_WRITTEN_NOTE).not.toBe(TOOL_CAUTION_NOTE);
    expect(SERVER_NOTE).not.toBe(LEFT_AS_WRITTEN_NOTE);
  });
});

describe("a polish ask", () => {
  test("rewrite paints replace, gutter is the ask, Accept does not search", async () => {
    const view = dispatchView(ORIGINAL);
    await ask(view, "@agent make this shorter", {
      suggested_text: POLISH,
      intent: "replace",
    });
    const note = pending(view);
    expect(proposeCalls()).toEqual([
      [
        "redline_propose",
        { path: "", original: ORIGINAL, instruction: "@agent make this shorter" },
      ],
    ]);
    expect(noteShowsLocus(note)).toBe(true);
    expect(isToolCautionHold(note)).toBe(false);
    expect(redlineGutterBody(note)).toBe("@agent make this shorter");
    expect(redlineGutterBody(note)).not.toBe(POLISH);
    expect(markClasses(ORIGINAL, note)).toContain("cm-redline-del");
    expect(insertAfter(ORIGINAL, note)).toEqual([POLISH]);
    expect(view.state.doc.toString()).toBe(ORIGINAL);

    mockedInvoke.mockClear();
    await acceptNote(view, note.id);
    expect(view.state.doc.toString()).toBe(POLISH);
    expect(proposeCalls()).toEqual([]);
    expect(mockedInvoke).toHaveBeenCalledWith("redline_learn", {
      path: "",
      source: "accept",
      before: ORIGINAL,
      suggested: POLISH,
      finalText: POLISH,
    });
  });

  test("Edit ask reopens compose and does not propose again", async () => {
    const view = dispatchView(ORIGINAL);
    await ask(view, "@agent make this shorter", {
      suggested_text: POLISH,
      intent: "replace",
    });
    mockedInvoke.mockClear();
    expect(editAskOnNote(view, pending(view).id)).toBe(true);
    const reopened = pending(view);
    expect(reopened.status).toBe("open");
    expect(reopened.intent).toBeNull();
    expect(reopened.proposed).toBeNull();
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(proposeCalls()).toEqual([]);
  });
});

describe("cite-shaped insert desk", () => {
  test("short citation inserts beside the paragraph and does not rewrite it", async () => {
    const view = dispatchView(ORIGINAL);
    await ask(view, "@agent add a citation", {
      suggested_text: CITATION,
      intent: "insert",
    });
    const note = pending(view);
    expect(proposeCalls()[0]?.[1]).toEqual({
      path: "",
      original: ORIGINAL,
      instruction: "@agent add a citation",
    });
    expect(noteShowsLocus(note)).toBe(true);
    expect(isToolCautionHold(note)).toBe(false);
    expect(redlineGutterBody(note)).toBe("@agent add a citation");
    expect(redlineGutterBody(note)).not.toContain("Smith");
    expect(markClasses(ORIGINAL, note)).not.toContain("cm-redline-del");
    expect(markClasses(ORIGINAL, note)).not.toContain("cm-redline-open");
    expect(insertAfter(ORIGINAL, note)).toEqual([CITATION]);
    expect(view.state.doc.toString()).toBe(ORIGINAL);

    mockedInvoke.mockClear();
    await acceptNote(view, note.id);
    expect(view.state.doc.toString()).toBe(ORIGINAL + CITATION);
    expect(view.state.doc.toString().startsWith(ORIGINAL)).toBe(true);
    expect(proposeCalls()).toEqual([]);
  });

  test("cite-replace block stays none: paragraph unchanged, no search", async () => {
    const view = dispatchView(ORIGINAL);
    await ask(view, "@agent add a citation", {
      suggested_text: LEFT_AS_WRITTEN_NOTE,
      intent: "none",
    });
    const note = pending(view);
    expect(isToolCautionHold(note)).toBe(false);
    expect(noteShowsLocus(note)).toBe(false);
    expect(redlineNoteLabel(note)).toBe("note");
    expect(redlineGutterBody(note)).toBe(LEFT_AS_WRITTEN_NOTE);
    expect(markClasses(ORIGINAL, note)).toContain("cm-redline-open");
    expect(markClasses(ORIGINAL, note)).not.toContain("cm-redline-del");
    expect(insertAfter(ORIGINAL, note)).toEqual([]);
    expect(editAskOnNote(view, note.id)).toBe(false);

    mockedInvoke.mockClear();
    await acceptNote(view, note.id);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(pending(view).status).toBe("accepted");
    expect(proposeCalls()).toEqual([]);
    expect(mockedInvoke).toHaveBeenCalledWith("redline_learn", {
      path: "",
      source: "accept",
      before: ORIGINAL,
      suggested: LEFT_AS_WRITTEN_NOTE,
      finalText: LEFT_AS_WRITTEN_NOTE,
    });
  });
});

describe("a server note in place of a suggestion", () => {
  test("the note is intent none plus the gutter text, and Accept sends no ask", async () => {
    const view = dispatchView(ORIGINAL);
    await ask(view, "@agent add a citation", {
      suggested_text: SERVER_NOTE,
      intent: "none",
    });
    const note = pending(view);
    expect(note.intent).toBe("none");
    expect(isToolCautionHold(note)).toBe(false);
    expect(noteShowsLocus(note)).toBe(false);
    expect(redlineGutterBody(note)).toBe(SERVER_NOTE);
    expect(markClasses(ORIGINAL, note)).toEqual(["cm-redline-open"]);
    expect(insertAfter(ORIGINAL, note)).toEqual([]);
    expect(editAskOnNote(view, note.id)).toBe(false);

    mockedInvoke.mockClear();
    await acceptNote(view, note.id);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(proposeCalls()).toEqual([]);
    expect(view.state.field(redlineInkTickField)).toBeNull();
  });

  test("Reject clears the note and does not propose", async () => {
    const view = dispatchView(ORIGINAL);
    await ask(view, "@agent add a citation", {
      suggested_text: SERVER_NOTE,
      intent: "none",
    });
    const id = pending(view).id;
    mockedInvoke.mockClear();
    expect(rejectNote(view, id)).toBe(true);
    expect(view.state.field(redlineNotesField)).toEqual([]);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(proposeCalls()).toEqual([]);
    expect(mockedInvoke).toHaveBeenCalledWith("redline_learn", {
      path: "",
      source: "reject",
      before: ORIGINAL,
      suggested: SERVER_NOTE,
      finalText: "",
    });
  });
});

describe("caution desk", () => {
  test("the note sits under the suggestion; Accept applies it; Reject clears; the next Ask omits search", async () => {
    const view = dispatchView(ORIGINAL);
    await ask(view, "@agent add a citation", {
      suggested_text: POLISH,
      intent: "replace",
      caution: TOOL_CAUTION_NOTE,
    });
    const held = pending(view);
    expect(isToolCautionHold(held)).toBe(false);
    expect(noteShowsLocus(held)).toBe(true);
    expect(cautionNoteText(held)).toBe(TOOL_CAUTION_NOTE);
    expect(redlineGutterBody(held)).toBe("@agent add a citation");
    expect(redlineGutterBody(held)).not.toBe(TOOL_CAUTION_NOTE);
    expect(redlineNoteLabel(held)).toBe("replace");
    expect(markClasses(ORIGINAL, held)).toContain("cm-redline-del");
    expect(insertAfter(ORIGINAL, held)).toEqual([POLISH]);

    mockedInvoke.mockClear();
    await acceptNote(view, held.id);
    expect(proposeCalls()).toEqual([]);
    expect(view.state.doc.toString()).toBe(POLISH);
    expect(pending(view).status).toBe("accepted");
    expect(pending(view).proposed).toBe(POLISH);
    expect(pending(view).caution).toBe(TOOL_CAUTION_NOTE);

    const again = dispatchView(ORIGINAL);
    mockedInvoke.mockClear();
    await ask(again, "@agent add a citation", {
      suggested_text: POLISH,
      intent: "replace",
      caution: TOOL_CAUTION_NOTE,
    });
    expect(proposeCalls()[0]?.[1]).toEqual({
      path: "",
      original: ORIGINAL,
      instruction: "@agent add a citation",
    });
    expect(isToolCautionHold(pending(again))).toBe(false);
    expect(cautionNoteText(pending(again))).toBe(TOOL_CAUTION_NOTE);

    mockedInvoke.mockClear();
    expect(rejectNote(again, pending(again).id)).toBe(true);
    expect(again.state.field(redlineNotesField)).toEqual([]);
    expect(again.state.doc.toString()).toBe(ORIGINAL);
    expect(proposeCalls()).toEqual([]);
  });
});
