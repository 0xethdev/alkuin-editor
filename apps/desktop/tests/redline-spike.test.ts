import { describe, expect, test } from "vite-plus/test";
import { existsSync, readFileSync } from "node:fs";
import { EditorSelection, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import { Decoration, type EditorView } from "@codemirror/view";
import {
  addNoteAtRange,
  addRedlineNote,
  applyProposal,
  applySpanReplacement,
  beginAskOnNote,
  buildRedlineDecorations,
  coerceIntent,
  decorationCount,
  editAskOnNote,
  isOwnCommentNote,
  markAccepted,
  markAsking,
  noteAtExactRange,
  overlappingNote,
  GUTTER_STUB_WIDTH,
  composeStubSpan,
  gutterStubTop,
  proposeRewrite,
  proposalChange,
  redlineDecorationsField,
  redlineNoteClassName,
  aiWritten,
  redlineNoteLabel,
  redlineGutterBody,
  cautionNoteText,
  noteBodyConsumesDelta,
  isolateNoteBodyScroll,
  noteShowsCompose,
  composeKeyAction,
  composeMentionQuery,
  flashInkTick,
  isToolCautionHold,
  noteShowsLocus,
  rejectNote,
  TOOL_CAUTION_NOTE,
  REDLINE_GUTTER_WIDTH,
  REDLINE_INK_TICK_MS,
  redlineInkTickField,
  redlineNotesField,
  redlineSeedNotes,
  removeRedlineNote,
  reopenCompose,
  setAskError,
  setProposed,
  stackGutterTops,
} from "../src/features/redline-spike";
import type { RedlineNote } from "../src/features/redline-spike";
import { AI_BADGE, ASK_AI_HINT } from "../src/features/redline-spike/margin-copy";

const ORIGINAL = "This is really very important.";
const PROPOSED = "This is important.";
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

function stateWith(doc: string, notes: RedlineNote[] = []) {
  let state = EditorState.create({
    doc,
    extensions: [redlineNotesField],
    selection: EditorSelection.range(0, doc.length),
  });
  for (const item of notes) {
    state = state.update({ effects: addRedlineNote.of(item) }).state;
  }
  return state;
}

function markClasses(
  set: ReturnType<typeof buildRedlineDecorations>,
  from: number,
  to: number,
): string[] {
  const classes: string[] = [];
  set.between(from, to, (_a, _b, value) => {
    const cls = value.spec.class as string | undefined;
    if (cls) classes.push(cls);
  });
  return classes;
}

function blockWidgets(set: ReturnType<typeof buildRedlineDecorations>, docLength: number): number {
  let count = 0;
  set.between(0, docLength, (_from, _to, value) => {
    if (value.spec.block) count += 1;
  });
  return count;
}

function lineClasses(set: ReturnType<typeof buildRedlineDecorations>, docLength: number): string[] {
  const classes: string[] = [];
  set.between(0, docLength, (_from, _to, value) => {
    const cls = value.spec.class as string | undefined;
    if (cls) classes.push(cls);
  });
  return classes;
}

function insertWidgets(
  set: ReturnType<typeof buildRedlineDecorations>,
  docLength: number,
): { from: number; text: string }[] {
  const found: { from: number; text: string }[] = [];
  set.between(0, docLength, (from, _to, value) => {
    const widget = value.spec.widget as { kind?: string; text?: string } | undefined;
    if (widget?.kind === "insert") found.push({ from, text: widget.text ?? "" });
  });
  return found;
}

function widgetsOfKind(
  set: ReturnType<typeof buildRedlineDecorations>,
  docLength: number,
  kind: string,
): number {
  let count = 0;
  set.between(0, docLength, (_from, _to, value) => {
    const widget = value.spec.widget as { kind?: string } | undefined;
    if (widget?.kind === kind) count += 1;
  });
  return count;
}

function dispatchView(doc: string) {
  let state = EditorState.create({
    doc,
    extensions: [redlineNotesField, redlineDecorationsField],
  });
  const view = {
    get state() {
      return state;
    },
    dom: { isConnected: true },
    scrollDOM: {
      querySelector() {
        return null;
      },
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  };
  return view as unknown as EditorView;
}

describe("proposeRewrite local fixture", () => {
  test("strips filler words without a network call", () => {
    expect(proposeRewrite(ORIGINAL)).toBe(PROPOSED);
  });

  test("collapses whitespace", () => {
    expect(proposeRewrite("Hello    world")).toBe("Hello world");
  });
});

describe("composeMentionQuery", () => {
  test("the @ token at the caret is the query; a finished word or an email is not", () => {
    expect(composeMentionQuery("@", 1)).toBe("");
    expect(composeMentionQuery("say @", 5)).toBe("");
    expect(composeMentionQuery("@paul", 5)).toBe("paul");
    expect(composeMentionQuery("see @paul", 9)).toBe("paul");
    expect(composeMentionQuery("(@maria", 7)).toBe("maria");
    expect(composeMentionQuery("@Alkuin", 7)).toBe("Alkuin");
    expect(composeMentionQuery("@agent", 6)).toBe("agent");
    expect(composeMentionQuery("@paul look", 5)).toBe("paul");
    expect(composeMentionQuery("@paul look", 6)).toBeNull();
    expect(composeMentionQuery("paul.smith@ex", 13)).toBeNull();
    expect(composeMentionQuery("email@agent.com", 15)).toBeNull();
    expect(composeMentionQuery("no tag", 6)).toBeNull();
    expect(composeMentionQuery("@paul", -1)).toBeNull();
    expect(composeMentionQuery("@paul", 6)).toBeNull();
  });
});

describe("compose keys", () => {
  test("Enter saves, Shift+Enter stays in the field, Escape cancels", () => {
    expect(composeKeyAction({ key: "Enter" })).toBe("save");
    expect(composeKeyAction({ key: "Enter", shiftKey: false, altKey: false })).toBe("save");
    expect(composeKeyAction({ key: "Enter", shiftKey: true })).toBeNull();
    expect(composeKeyAction({ key: "Enter", altKey: true })).toBeNull();
    expect(composeKeyAction({ key: "Enter", isComposing: true })).toBeNull();
    expect(composeKeyAction({ key: "Process", keyCode: 229 })).toBeNull();
    expect(composeKeyAction({ key: "Enter", keyCode: 229 })).toBeNull();
    expect(composeKeyAction({ key: "Escape" })).toBe("cancel");
    expect(composeKeyAction({ key: "Escape", isComposing: true })).toBeNull();
    expect(composeKeyAction({ key: "a" })).toBeNull();
  });
});

describe("applyProposal paint-law Accept", () => {
  test("replace keeps the new text only", () => {
    expect(applyProposal(ORIGINAL, 0, ORIGINAL.length, PROPOSED, "replace")).toBe(PROPOSED);
    expect(applySpanReplacement(ORIGINAL, 0, ORIGINAL.length, PROPOSED)).toBe(PROPOSED);
  });

  test("insert keeps original plus proposed after", () => {
    expect(applyProposal(ORIGINAL, 0, ORIGINAL.length, INSERT, "insert")).toBe(ORIGINAL + INSERT);
    expect(proposalChange(0, ORIGINAL.length, INSERT, "insert")).toEqual({
      from: ORIGINAL.length,
      to: ORIGINAL.length,
      insert: INSERT,
    });
  });

  test("none does not change document bytes", () => {
    expect(applyProposal(ORIGINAL, 0, ORIGINAL.length, "looks off", "none")).toBe(ORIGINAL);
    expect(proposalChange(0, ORIGINAL.length, "", "none")).toBeNull();
  });
});

describe("coerceIntent", () => {
  test("maps public aliases and defaults unknown/plaintext to replace", () => {
    expect(coerceIntent("insert")).toBe("insert");
    expect(coerceIntent("add")).toBe("insert");
    expect(coerceIntent("replace")).toBe("replace");
    expect(coerceIntent("rewrite")).toBe("replace");
    expect(coerceIntent("none")).toBe("none");
    expect(coerceIntent("comment-only")).toBe("none");
    expect(coerceIntent("any data points we can add?")).toBe("replace");
    expect(coerceIntent(undefined)).toBe("replace");
  });
});

describe("redlineNotesField", () => {
  test("share notes on one range dedupe by change id, not by range", () => {
    const share = (id: string, shareChangeId: string) =>
      note({ id, shareChangeId, status: "pending" });
    const two = stateWith(ORIGINAL, [share("a", "c1"), share("b", "c2")]);
    expect(two.field(redlineNotesField)).toHaveLength(2);
    const same = stateWith(ORIGINAL, [share("a", "c1"), share("b", "c1")]);
    expect(same.field(redlineNotesField)).toHaveLength(1);
  });

  test("a share note over an own note on the same range both stay", () => {
    const state = stateWith(ORIGINAL, [
      note({ id: "own" }),
      note({ id: "s", shareChangeId: "c1", status: "pending" }),
    ]);
    expect(state.field(redlineNotesField)).toHaveLength(2);
  });

  test("two own notes on the same range still keep one", () => {
    const state = stateWith(ORIGINAL, [note({ id: "a" }), note({ id: "b" })]);
    expect(state.field(redlineNotesField)).toHaveLength(1);
  });

  test("stores a note on the selected span", () => {
    const state = stateWith(ORIGINAL, [note()]);
    const notes = state.field(redlineNotesField);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.original).toBe(ORIGINAL);
    expect(notes[0]?.status).toBe("open");
  });

  test("agent proposal marks the note pending with visible text", () => {
    let state = stateWith(ORIGINAL, [note()]);
    state = state.update({
      effects: setProposed.of({
        id: "redline-1",
        proposed: PROPOSED,
        intent: "replace",
        instruction: "improve",
      }),
    }).state;
    const item = state.field(redlineNotesField)[0];
    expect(item?.status).toBe("pending");
    expect(item?.proposed).toBe(PROPOSED);
    expect(item?.intent).toBe("replace");
    expect(item?.error).toBeNull();
  });

  test("missing-key error stays on the note without a fixture rewrite", () => {
    let state = stateWith(ORIGINAL, [note()]);
    state = state.update({
      effects: markAsking.of({ id: "redline-1", instruction: "improve" }),
    }).state;
    expect(state.field(redlineNotesField)[0]?.status).toBe("pending");
    expect(state.field(redlineNotesField)[0]?.proposed).toBeNull();

    const missingKey = "Writing help is not set up on this build.";
    state = state.update({
      effects: setAskError.of({ id: "redline-1", error: missingKey }),
    }).state;
    const item = state.field(redlineNotesField)[0];
    expect(item?.status).toBe("error");
    expect(item?.proposed).toBeNull();
    expect(item?.original).toBe(ORIGINAL);
    expect(item?.error).toMatch(/not set up/);
    expect(state.doc.toString()).toBe(ORIGINAL);
  });

  test("writer.swap drops a whole-doc pending note instead of mapping it onto the next file", () => {
    let state = stateWith(ORIGINAL, [note({ status: "pending" })]);
    state = state.update({
      changes: { from: 0, to: ORIGINAL.length, insert: "Other file entirely." },
      userEvent: "writer.swap",
    }).state;
    expect(state.doc.toString()).toBe("Other file entirely.");
    expect(state.field(redlineNotesField)).toEqual([]);
  });

  test("writer.reload keeps the writer's own note where its passage still reads the same", () => {
    const own = note({ proposed: PROPOSED, status: "pending" });
    let state = stateWith(ORIGINAL, [own]);
    state = state.update({
      changes: { from: 0, to: ORIGINAL.length, insert: ORIGINAL },
      userEvent: "writer.reload",
    }).state;
    expect(state.field(redlineNotesField)).toEqual([own]);
  });

  test("writer.reload drops the other person's card: the next pull brings it back", () => {
    let state = stateWith(ORIGINAL, [
      note({ proposed: PROPOSED, status: "pending", shareChangeId: "change-1" }),
    ]);
    state = state.update({
      changes: { from: 0, to: ORIGINAL.length, insert: ORIGINAL },
      userEvent: "writer.reload",
    }).state;
    expect(state.field(redlineNotesField)).toEqual([]);
  });

  test("setProposed errors if the live span no longer matches original", () => {
    let state = stateWith(ORIGINAL, [note({ status: "pending" })]);
    state = state.update({ changes: { from: 8, insert: "NOT " } }).state;
    state = state.update({
      effects: setProposed.of({
        id: "redline-1",
        proposed: PROPOSED,
        intent: "replace",
        instruction: "improve",
      }),
    }).state;
    const item = state.field(redlineNotesField)[0];
    expect(item?.status).toBe("error");
    expect(item?.proposed).toBeNull();
    expect(item?.error).toBe("The selected text changed while Alkuin was rewriting.");
    expect(state.doc.toString()).toContain("NOT");
  });

  test("replace Accept overwrites the span and keeps the note", () => {
    let state = stateWith(ORIGINAL, [
      note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
    ]);
    const change = proposalChange(0, ORIGINAL.length, PROPOSED, "replace")!;
    state = state.update({
      changes: change,
      effects: markAccepted.of("redline-1"),
    }).state;
    expect(state.doc.toString()).toBe(PROPOSED);
    expect(state.field(redlineNotesField)[0]?.status).toBe("accepted");
  });

  test("insert Accept keeps original and appends proposed", () => {
    let state = stateWith(ORIGINAL, [
      note({ proposed: INSERT, intent: "insert", status: "pending" }),
    ]);
    const change = proposalChange(0, ORIGINAL.length, INSERT, "insert")!;
    state = state.update({
      changes: change,
      effects: markAccepted.of("redline-1"),
    }).state;
    expect(state.doc.toString()).toBe(ORIGINAL + INSERT);
    const item = state.field(redlineNotesField)[0];
    expect(item?.status).toBe("accepted");
    expect(state.doc.sliceString(item!.from, item!.to)).toBe(ORIGINAL + INSERT);
  });

  test("none Accept does not change document bytes", () => {
    let state = stateWith(ORIGINAL, [note({ proposed: "", intent: "none", status: "pending" })]);
    expect(proposalChange(0, ORIGINAL.length, "", "none")).toBeNull();
    state = state.update({ effects: markAccepted.of("redline-1") }).state;
    expect(state.doc.toString()).toBe(ORIGINAL);
    expect(state.field(redlineNotesField)[0]?.status).toBe("accepted");
  });

  test("Reject drops the note and leaves the document unchanged for all intents", () => {
    for (const intent of ["replace", "insert", "none"] as const) {
      let state = stateWith(ORIGINAL, [
        note({ proposed: intent === "none" ? "" : PROPOSED, intent, status: "pending" }),
      ]);
      state = state.update({ effects: removeRedlineNote.of("redline-1") }).state;
      expect(state.doc.toString()).toBe(ORIGINAL);
      expect(state.field(redlineNotesField)).toEqual([]);
    }
  });

  test("maps the note through an insert before the span", () => {
    let state = stateWith(ORIGINAL, [note()]);
    state = state.update({ changes: { from: 0, insert: "Prefix " } }).state;
    const item = state.field(redlineNotesField)[0];
    expect(item?.from).toBe("Prefix ".length);
    expect(state.doc.sliceString(item!.from, item!.to)).toBe(ORIGINAL);
  });
});

describe("redlineDecorationsField with no notes", () => {
  test("a doc change yields Decoration.none", () => {
    const state = EditorState.create({
      doc: "hello",
      extensions: [redlineNotesField, redlineDecorationsField],
    });
    const next = state.update({ changes: { from: 5, insert: " world" } }).state;
    expect(next.field(redlineDecorationsField)).toBe(Decoration.none);
  });
});

describe("buildRedlineDecorations", () => {
  test("replace strikes the original and shows insert after, with no left tick or block card", () => {
    const doc = Text.of([ORIGINAL]);
    const set = buildRedlineDecorations(doc, [
      note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
    ]);
    expect(markClasses(set, 0, ORIGINAL.length)).toContain("cm-redline-del");
    expect(lineClasses(set, doc.length + 1)).not.toContain("cm-redline-anchor-line");
    expect(blockWidgets(set, doc.length + 1)).toBe(0);
    expect(insertWidgets(set, ORIGINAL.length + 1)).toEqual([
      { from: ORIGINAL.length, text: PROPOSED },
    ]);
    expect(widgetsOfKind(set, ORIGINAL.length + 1, "locus")).toBe(0);
    expect(decorationCount(set, doc.length + 1)).toBe(2);
  });

  test("insert leaves original unmarked and shows proposed after", () => {
    const doc = Text.of([ORIGINAL]);
    const set = buildRedlineDecorations(doc, [
      note({ proposed: INSERT, intent: "insert", status: "pending" }),
    ]);
    expect(markClasses(set, 0, ORIGINAL.length)).not.toContain("cm-redline-del");
    expect(markClasses(set, 0, ORIGINAL.length)).not.toContain("cm-redline-open");
    expect(lineClasses(set, doc.length + 1)).not.toContain("cm-redline-anchor-line");
    expect(blockWidgets(set, doc.length + 1)).toBe(0);
    expect(insertWidgets(set, ORIGINAL.length + 1)).toEqual([
      { from: ORIGINAL.length, text: INSERT },
    ]);
    expect(widgetsOfKind(set, ORIGINAL.length + 1, "locus")).toBe(0);
    expect(decorationCount(set, doc.length + 1)).toBe(1);
  });

  test("none highlights the span and does not strike or insert", () => {
    const doc = Text.of([ORIGINAL]);
    const set = buildRedlineDecorations(doc, [
      note({ proposed: "this is muddy", intent: "none", status: "pending" }),
    ]);
    expect(markClasses(set, 0, ORIGINAL.length)).toContain("cm-redline-open");
    expect(markClasses(set, 0, ORIGINAL.length)).not.toContain("cm-redline-del");
    expect(lineClasses(set, doc.length + 1)).not.toContain("cm-redline-anchor-line");
    expect(blockWidgets(set, doc.length + 1)).toBe(0);
    expect(insertWidgets(set, ORIGINAL.length + 1)).toEqual([]);
    expect(widgetsOfKind(set, ORIGINAL.length + 1, "locus")).toBe(0);
    expect(decorationCount(set, doc.length + 1)).toBe(1);
  });

  test("StateField decorations include the insert widget when a replace note is seeded", () => {
    const item = note({ proposed: PROPOSED, intent: "replace", status: "pending" });
    const state = EditorState.create({
      doc: ORIGINAL,
      extensions: [redlineSeedNotes.of([item]), redlineNotesField, redlineDecorationsField],
    });
    expect(state.field(redlineNotesField)).toHaveLength(1);
    expect(decorationCount(state.field(redlineDecorationsField), ORIGINAL.length + 1)).toBe(2);
  });

  test("rebuilds decorations on an effect-only add", () => {
    let state = EditorState.create({
      doc: ORIGINAL,
      extensions: [redlineNotesField, redlineDecorationsField],
    });
    expect(decorationCount(state.field(redlineDecorationsField), ORIGINAL.length + 1)).toBe(0);
    state = state.update({
      effects: addRedlineNote.of(
        note({ proposed: PROPOSED, intent: "replace", status: "pending" }),
      ),
    }).state;
    expect(decorationCount(state.field(redlineDecorationsField), ORIGINAL.length + 1)).toBe(2);
  });
});

describe("redlineGutterBody", () => {
  test("insert/replace show the instruction, not the proposal", () => {
    const item = note({
      intent: "replace",
      proposed: "Cite Smith 2024.",
      instruction: "add a citation",
      status: "pending",
    });
    expect(redlineGutterBody(item)).toBe("add a citation");
    expect(redlineGutterBody({ ...item, intent: "insert" })).toBe("add a citation");
  });

  test("a person's suggestion shows the proposed text", () => {
    expect(
      redlineGutterBody(
        note({
          intent: "replace",
          proposed: "Boats wait until morning.",
          instruction: "Boats wait until morning.",
          person: "B",
          status: "pending",
        }),
      ),
    ).toBe("Boats wait until morning.");
  });

  test("instruction equal to proposed is empty", () => {
    expect(
      redlineGutterBody(
        note({
          intent: "replace",
          proposed: "Cite Smith 2024.",
          instruction: "Cite Smith 2024.",
          status: "pending",
        }),
      ),
    ).toBe("");
    expect(
      redlineGutterBody(
        note({
          intent: "insert",
          proposed: "Cite Smith 2024.",
          instruction: "  Cite Smith 2024.  ",
          status: "pending",
        }),
      ),
    ).toBe("");
  });

  test("intent none still returns proposed", () => {
    expect(
      redlineGutterBody(
        note({
          intent: "none",
          proposed: "Cite Smith 2024.",
          instruction: "add a citation",
          status: "pending",
        }),
      ),
    ).toBe("Cite Smith 2024.");
    expect(
      redlineGutterBody(
        note({
          intent: "none",
          proposed: "this is muddy",
          instruction: null,
          status: "pending",
        }),
      ),
    ).toBe("this is muddy");
  });

  test("never echoes the highlighted span", () => {
    expect(redlineGutterBody(note())).toBe("");
    expect(redlineGutterBody(note({ status: "open", original: ORIGINAL }))).not.toBe(ORIGINAL);
    expect(
      redlineGutterBody(
        note({
          intent: "none",
          proposed: "this is muddy",
          instruction: null,
          status: "pending",
        }),
      ),
    ).not.toBe(ORIGINAL);
    expect(
      redlineGutterBody(
        note({
          intent: "replace",
          proposed: PROPOSED,
          instruction: "tighten",
          status: "pending",
        }),
      ),
    ).toBe("tighten");
  });

  test("error, pending wait, and accepted do not echo the proposal", () => {
    expect(redlineGutterBody(note({ error: "missing key", status: "error" }))).toBe("missing key");
    expect(redlineGutterBody(note({ status: "pending" }))).toBe("Thinking…");
    expect(
      redlineGutterBody(
        note({
          intent: "replace",
          proposed: "Cite Smith 2024.",
          instruction: "add a citation",
          status: "accepted",
        }),
      ),
    ).toBe("add a citation");
    expect(
      redlineGutterBody(
        note({
          intent: "replace",
          proposed: "Cite Smith 2024.",
          instruction: "Cite Smith 2024.",
          status: "accepted",
        }),
      ),
    ).toBe("");
  });

  test("renderRedlineNote uses the helper and has no del/ins proposal markup", () => {
    const src = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/redlineGutterBody\(note\)/);
    expect(src).not.toMatch(/cm-redline-proposed-ins/);
    expect(src).not.toMatch(/cm-redline-proposed-del/);
    expect(src).not.toMatch(/cm-redline-quote/);
    expect(src).not.toMatch(/return note\.original/);
  });
});

describe("note body nested scroll", () => {
  const bodyCss = readFileSync(
    new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
    "utf8",
  );
  const gutterSrc = readFileSync(
    new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
    "utf8",
  );

  test("CSS caps the note body and scrolls it, not the gutter overlay", () => {
    const block = bodyCss.slice(bodyCss.indexOf(".cm-editor .cm-redline-note-body {"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule).toMatch(/overflow-y:\s*auto/);
    expect(rule).toMatch(/max-height:\s*40vh/);
    expect(bodyCss).not.toMatch(/\.cm-redline-gutter\s*\{[^}]*overflow-y:\s*auto/);
  });

  test("gutter.ts stops wheel and touchmove on the note body", () => {
    expect(gutterSrc).toMatch(/body\.className = "cm-redline-note-body"/);
    expect(gutterSrc).toMatch(/body\.addEventListener\("wheel"/);
    expect(gutterSrc).toMatch(/body\.addEventListener\("touchmove"/);
    expect(gutterSrc).toMatch(/isolateNoteBodyScroll\(event, body\)/);
    const isolateAt = gutterSrc.indexOf("export function isolateNoteBodyScroll");
    const isolate = gutterSrc.slice(isolateAt, gutterSrc.indexOf("function noteFingerprint"));
    expect(isolate).toMatch(/stopPropagation/);
    expect(isolate).not.toMatch(/event\.preventDefault/);
    const bindAt = gutterSrc.indexOf('body.className = "cm-redline-note-body"');
    const bind = gutterSrc.slice(bindAt, gutterSrc.indexOf("const bodyText"));
    expect(bind).toMatch(/addEventListener\("wheel"/);
    expect(bind).toMatch(/addEventListener\("touchmove"/);
    expect(bind).not.toMatch(/preventDefault/);
  });

  test("wheel stopPropagation only while the note can still scroll", () => {
    const box = { scrollTop: 40, clientHeight: 100, scrollHeight: 400 };
    expect(noteBodyConsumesDelta(box, 24)).toBe(true);
    expect(noteBodyConsumesDelta(box, -24)).toBe(true);
    expect(noteBodyConsumesDelta({ ...box, scrollTop: 0 }, 24)).toBe(true);
    expect(noteBodyConsumesDelta({ ...box, scrollTop: 0 }, -24)).toBe(false);
    expect(noteBodyConsumesDelta({ ...box, scrollTop: 300 }, -24)).toBe(true);
    expect(noteBodyConsumesDelta({ ...box, scrollTop: 300 }, 24)).toBe(false);

    let stopped = false;
    isolateNoteBodyScroll(
      {
        type: "wheel",
        deltaY: 24,
        stopPropagation: () => {
          stopped = true;
        },
      },
      box,
    );
    expect(stopped).toBe(true);

    stopped = false;
    isolateNoteBodyScroll(
      {
        type: "wheel",
        deltaY: 24,
        stopPropagation: () => {
          stopped = true;
        },
      },
      { ...box, scrollTop: 0 },
    );
    expect(stopped).toBe(true);

    stopped = false;
    isolateNoteBodyScroll(
      {
        type: "wheel",
        deltaY: -24,
        stopPropagation: () => {
          stopped = true;
        },
      },
      { ...box, scrollTop: 300 },
    );
    expect(stopped).toBe(true);

    stopped = false;
    isolateNoteBodyScroll(
      {
        type: "wheel",
        deltaY: 24,
        stopPropagation: () => {
          stopped = true;
        },
      },
      { ...box, scrollTop: 300 },
    );
    expect(stopped).toBe(false);
  });

  test("overflowing touchmove stops; short body does not", () => {
    let stopped = false;
    isolateNoteBodyScroll(
      {
        type: "touchmove",
        stopPropagation: () => {
          stopped = true;
        },
      },
      { scrollTop: 0, clientHeight: 100, scrollHeight: 400 },
    );
    expect(stopped).toBe(true);

    stopped = false;
    isolateNoteBodyScroll(
      {
        type: "touchmove",
        stopPropagation: () => {
          stopped = true;
        },
      },
      { scrollTop: 0, clientHeight: 80, scrollHeight: 80 },
    );
    expect(stopped).toBe(false);
  });
});

describe("AI disclosure", () => {
  test("an Ask's answer is marked as AI; the writer's note and a person's card are not", () => {
    expect(aiWritten(note({ intent: "replace", proposed: PROPOSED, instruction: "tighten" }))).toBe(
      true,
    );
    expect(aiWritten(note({ status: "pending", instruction: "add a source" }))).toBe(true);
    expect(aiWritten(note({ intent: "none", proposed: "my own note", instruction: null }))).toBe(
      false,
    );
    expect(
      aiWritten(note({ intent: "none", proposed: "hi", instruction: "x", person: "Ada" })),
    ).toBe(false);
    expect(aiWritten(note({ instruction: "   " }))).toBe(false);
  });

  test("the card puts an AI badge before its label and the Ask button says a model writes it", () => {
    const gutterSrc = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    expect(gutterSrc).toContain("label.prepend(badge");
    expect(gutterSrc).toContain("badge.textContent = AI_BADGE");
    expect(gutterSrc).toContain("title: ASK_AI_HINT");
    expect(AI_BADGE).toBe("AI");
    expect(ASK_AI_HINT).toMatch(/AI model/);
  });
});

describe("right-gutter ink chrome", () => {
  test("note class is ink, not a card, and names the intent", () => {
    const replace = note({ intent: "replace", proposed: PROPOSED, status: "pending" });
    expect(redlineNoteClassName(replace)).toContain("cm-redline-ink");
    expect(redlineNoteClassName(replace)).toContain("cm-redline-note-replace");
    expect(redlineNoteLabel(replace)).toBe("replace");
    expect(redlineNoteLabel(note({ intent: "insert", proposed: INSERT, status: "pending" }))).toBe(
      "insert",
    );
    expect(redlineNoteLabel(note({ intent: "none", proposed: "", status: "pending" }))).toBe(
      "note",
    );
    expect(redlineNoteLabel(note())).toBe("note");
  });

  test("stackGutterTops pushes a later note below an overlapping neighbor", () => {
    expect(stackGutterTops([10, 20], [80, 40], 16)).toEqual([10, 106]);
    expect(stackGutterTops([10, 200], [80, 40], 16)).toEqual([10, 200]);
    expect(stackGutterTops([10, 10], [140, 80], 36)).toEqual([10, 186]);
  });

  test("the gutter link is a dot whose y tracks the last glyph", () => {
    expect(GUTTER_STUB_WIDTH).toBe(6);
    expect(gutterStubTop({ top: 100, bottom: 120 }, 40)).toBe(70);
    expect(composeStubSpan({ top: 200, height: 57 }, 25.3)).toEqual({ top: 200, bottom: 225.3 });
    expect(composeStubSpan({ top: 10, height: 20 }, 0)).toEqual({ top: 10, bottom: 30 });
    expect(gutterStubTop({ top: 10, bottom: 10 }, 10)).toBe(0);
    const src = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/pencilPath/);
    expect(src).not.toMatch(/cm-redline-note-connector/);
    expect(src).not.toMatch(/cm-redline-connector-dot/);
    expect(src).toMatch(/cm-redline-gutter-stub/);
    expect(src).toMatch(/scheduleStubLayout/);
    expect(src).toMatch(/cm-redline-instruction/);
    expect(src).toMatch(/fonts\s*\?\.load\(\s*'20px "Nothing You Could Do"'\s*\)/);
    expect(src).not.toMatch(/createElementNS\("http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  test("open notes show the Ask compose field", () => {
    expect(noteShowsCompose(note())).toBe(true);
    expect(noteShowsCompose(note({ status: "error", error: "missing key" }))).toBe(true);
    expect(noteShowsCompose(note({ status: "pending" }))).toBe(false);
    expect(
      noteShowsCompose(note({ intent: "replace", proposed: PROPOSED, status: "pending" })),
    ).toBe(false);
    expect(
      noteShowsCompose(note({ intent: "none", proposed: "this is muddy", status: "pending" })),
    ).toBe(false);
    expect(
      noteShowsCompose(note({ status: "accepted", proposed: PROPOSED, intent: "replace" })),
    ).toBe(false);
  });

  test("compose is Ask Alkuin / Leave note / Cancel; own notes Edit/Delete; proposal and caution decisions live in the gutter", () => {
    const src = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    const start = src.indexOf("const action = composeKeyAction(event)");
    expect(start).toBeGreaterThan(-1);
    const keydown = src.indexOf('prompt.addEventListener("keydown"');
    expect(src.slice(keydown, start)).toContain(
      "composeMentionQuery(prompt.value, prompt.selectionStart)",
    );
    const ownAt = src.indexOf("} else if (isOwnCommentNote(note)) {", start);
    expect(ownAt).toBeGreaterThan(start);
    const personAt = src.indexOf('personNote && note.intent === "none"', ownAt);
    expect(personAt).toBeGreaterThan(ownAt);
    const decideAt = src.indexOf("noteShowsLocus(note) ||", personAt);
    expect(decideAt).toBeGreaterThan(personAt);
    const person = src.slice(personAt, decideAt);
    expect(person).toContain("DISMISS");
    expect(person).not.toContain('"Accept"');
    expect(person).not.toContain('"Reject"');
    const chunk = src.slice(start, ownAt);
    expect(src).toContain("COMPOSE_NOTE_LABEL");
    expect(chunk).toContain("ASK_ALKUIN_LABEL");
    expect(chunk).toContain("LEAVE_NOTE_LABEL");
    expect(chunk).toContain("COMPOSE_CANCEL_LABEL");
    expect(chunk).toMatch(/handlers\.ask\(/);
    expect(chunk).toMatch(/handlers\.leave\(/);
    expect(chunk).toMatch(/handlers\.reject\(/);
    expect(chunk).toContain("composeKeyAction");
    const keyed = src.slice(
      src.indexOf("const action = composeKeyAction(event)"),
      src.indexOf("handlers.ask"),
    );
    expect(keyed).toContain("handlers.leave");
    expect(keyed).not.toContain("handlers.ask");
    expect(keyed).not.toContain("redline_propose");
    expect(chunk).not.toContain('"Submit"');
    expect(chunk).not.toContain("Ask agent");
    expect(chunk).not.toContain("Accept");
    expect(chunk).not.toContain('"Reject"');
    const own = src.slice(ownAt, decideAt);
    expect(own).toMatch(/inkButton\([\s\S]*?"Edit"[\s\S]*?handlers\.editAsk/);
    expect(own).toMatch(/inkButton\([\s\S]*?"Delete"[\s\S]*?handlers\.reject/);
    expect(own).not.toContain("Accept");
    expect(own).not.toContain('"Reject"');
    expect(own).not.toContain("Edit ask");
    expect(own).not.toContain("Edit note");
    expect(own).not.toContain("Delete note");
    expect(own).not.toContain("Revise");
    expect(own).not.toContain('"Remove"');
    expect(own).not.toMatch(/confirm\s*\(/);
    const decide = src.slice(decideAt, src.indexOf("\n  return root;", decideAt));
    expect(decide).toMatch(/"Accept"/);
    expect(decide).not.toMatch(/"Approve"/);
    expect(decide).toMatch(/"Reject"/);
    expect(decide).toMatch(/"Edit ask"/);
    expect(decide).toMatch(/handlers\.editAsk/);
    expect(decide).not.toMatch(/renderLocusPill/);
    expect(src.match(/"Accept"/g)?.length).toBe(1);
    expect(src).not.toMatch(/"Approve"/);
    expect(src.match(/"Edit ask"/g)?.length).toBe(1);
    expect(src.match(/"Edit"/g)?.length).toBe(1);
    expect(src.match(/"Delete"/g)?.length).toBe(1);
    expect(src.match(/"Reject"/g)?.length).toBe(1);
    expect(src).not.toMatch(/"Ask agent"/);
    expect(src).not.toMatch(/window\.confirm/);
    expect(src).not.toMatch(/"Edit note"/);
    expect(src).not.toMatch(/"Delete note"/);
    expect(decide).not.toMatch(/"Delete"/);
    expect(decide).not.toMatch(/"Edit"/);
    const actionsSrc = readFileSync(
      new URL("../src/features/redline-spike/actions.ts", import.meta.url),
      "utf8",
    );
    expect(actionsSrc).not.toMatch(/confirm\s*\(/);
    const deco = readFileSync(
      new URL("../src/features/redline-spike/decorations.ts", import.meta.url),
      "utf8",
    );
    expect(deco).not.toMatch(/RedlineLocusWidget/);
    expect(deco).not.toMatch(/renderLocusPill/);
    expect(deco).not.toMatch(/dissolveLocusThen/);
    expect(deco).not.toMatch(/textContent = "Accept"/);
    expect(deco).not.toMatch(/textContent = "Reject"/);
    expect(deco).not.toMatch(/textContent = "Edit ask"/);
    expect(deco).not.toMatch(/textContent = "Approve"/);
    expect(deco).not.toMatch(/placeholder/);
    expect(deco).toMatch(/createElementNS\("http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(deco).not.toMatch(/textContent = "✓"/);
  });

  test("caution hold is not a locus pill; human notes have no locus pill", () => {
    expect(TOOL_CAUTION_NOTE).toBe("Alkuin didn't search the web for this one.");
    const suggestion = note({
      intent: "replace",
      proposed: "This is important.",
      instruction: "@agent add a citation",
      caution: TOOL_CAUTION_NOTE,
      status: "pending",
    });
    expect(cautionNoteText(suggestion)).toBe(TOOL_CAUTION_NOTE);
    expect(noteShowsLocus(suggestion)).toBe(true);
    expect(isToolCautionHold(suggestion)).toBe(false);
    const gutterSrc = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    const cautionAt = gutterSrc.indexOf('caution.className = "cm-redline-caution"');
    expect(cautionAt).toBeGreaterThan(-1);
    const cautionChunk = gutterSrc.slice(cautionAt, cautionAt + 280);
    expect(cautionChunk).toMatch(/textContent = cautionText/);
    expect(cautionChunk).not.toMatch(/inkButton/);
    expect(cautionChunk).not.toMatch(/"Approve"/);
    const hold = note({
      intent: "none",
      proposed: TOOL_CAUTION_NOTE,
      instruction: "@agent add a citation",
      status: "pending",
      hold: true,
    });
    expect(isToolCautionHold(hold)).toBe(true);
    expect(noteShowsLocus(hold)).toBe(false);
    // `requestRewrite` sets `hold` from the Rust sentence. The copy on a card is not the state.
    expect(isToolCautionHold({ ...hold, hold: undefined })).toBe(false);
    expect(
      isToolCautionHold(
        note({
          intent: "none",
          proposed:
            "Alkuin couldn't give you a suggestion for this one. Your text is unchanged. Try again, or select a different passage.",
          instruction: "@agent add a citation",
          status: "pending",
        }),
      ),
    ).toBe(false);
    const own = note({
      intent: "none",
      proposed: "this is muddy",
      instruction: null,
      status: "pending",
    });
    expect(noteShowsLocus(own)).toBe(false);
    expect(isOwnCommentNote(own)).toBe(true);
    expect(isOwnCommentNote(hold)).toBe(false);
    expect(
      widgetsOfKind(
        buildRedlineDecorations(Text.of([ORIGINAL]), [hold]),
        ORIGINAL.length + 1,
        "locus",
      ),
    ).toBe(0);
    expect(
      widgetsOfKind(
        buildRedlineDecorations(Text.of([ORIGINAL]), [own]),
        ORIGINAL.length + 1,
        "locus",
      ),
    ).toBe(0);
    expect(
      markClasses(buildRedlineDecorations(Text.of([ORIGINAL]), [hold]), 0, ORIGINAL.length),
    ).toContain("cm-redline-open");
    expect(
      markClasses(buildRedlineDecorations(Text.of([ORIGINAL]), [hold]), 0, ORIGINAL.length),
    ).not.toContain("cm-redline-del");
  });

  test("open highlight is an ash fill, not a marker SVG or glow box", () => {
    const css = readFileSync(
      new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
      "utf8",
    );
    const openStart = css.indexOf(".cm-editor .cm-content .cm-redline-open,");
    const openRule = css.slice(openStart, css.indexOf("}", openStart) + 1);
    expect(openRule).toMatch(/\.cm-content/);
    expect(css).toMatch(/--redline-ash:\s*#9a948c/);
    expect(css).toMatch(/--redline-mark:\s*#d33c33/);
    expect(css).toMatch(/--redline-paper:\s*var\(--page-bg,\s*var\(--bg-base,\s*#f7f3ec\)\)/);
    expect(css).toMatch(/var\(--redline-mark\)\s*28%/);
    expect(openRule).toMatch(/var\(--redline-span\)/);
    expect(css).toMatch(
      /--redline-select:\s*color-mix\(in srgb, var\(--redline-ash\) 16%, transparent\)/,
    );
    expect(css).toMatch(/\.cm-redline-open \{\s*background-color:\s*var\(--redline-select\)/);
    expect(openRule).toMatch(/border-radius:\s*0\.42em/);
    expect(openRule).toMatch(/background-image:\s*none/);
    expect(openRule).toMatch(/box-decoration-break:\s*clone/);
    expect(openRule).toMatch(/padding:\s*0\.12em 0;/);
    expect(openRule).not.toMatch(/margin:\s*0 -0\.42em/);
    expect(openRule).not.toMatch(/padding:\s*0\.12em 0\.42em/);
    expect(openRule).not.toMatch(/marker-wash/);
    expect(openRule).not.toMatch(/background-image:\s*url/);
    expect(openRule).toMatch(/box-shadow:\s*none/);
    expect(openRule).not.toMatch(/0 0 8px/);
    expect(openRule).not.toMatch(/border-bottom/);
    expect(openRule).not.toMatch(/cm-markdown-heading/);
    expect(css).not.toMatch(/marker-wash/);
    expect(css).not.toMatch(/rgba\(214,\s*158,\s*58/);
    expect(
      existsSync(new URL("../src/features/redline-spike/marker-wash.svg", import.meta.url)),
    ).toBe(false);
    const del = css.slice(css.indexOf(".cm-editor .cm-redline-del {"));
    const delRule = del.slice(0, del.indexOf("}"));
    expect(delRule).toMatch(/line-through/);
    const insStart = css.lastIndexOf(".cm-editor .cm-content .cm-redline-ins {");
    const insRule = css.slice(insStart, css.indexOf("}", insStart) + 1);
    expect(insRule).toMatch(/margin-left:\s*0\.3em/);
    expect(css).not.toMatch(/\.cm-redline-locus \{/);
    expect(css).toMatch(/redline-ink-tick/);
    expect(css).toMatch(/redline-ink-paint/);
    expect(css).not.toMatch(/cm-redline-connector-dot/);
    expect(css).not.toMatch(/cm-redline-connector-path/);
    expect(css).not.toMatch(/cm-redline-note-connector/);
    expect(css).not.toMatch(/--redline-stub-width/);
    expect(css).toMatch(/\.cm-redline-gutter-stub \{/);
    expect(css).toContain(`redline-ink-tick ${REDLINE_INK_TICK_MS}ms`);
    expect(css).not.toMatch(/redline-locus-dissolve/);
    expect(css).not.toMatch(/\.cm-redline-ink-tick \{[\s\S]*?border-radius:\s*50%/);
    const bodyRule = css.slice(
      css.indexOf(".cm-editor .cm-redline-note-body {"),
      css.indexOf("}", css.indexOf(".cm-editor .cm-redline-note-body {")) + 1,
    );
    const noteRule = css.slice(
      css.indexOf(".cm-editor .cm-redline-note {"),
      css.indexOf("}", css.indexOf(".cm-editor .cm-redline-note {")) + 1,
    );
    const btnRule = css.slice(
      css.indexOf(".cm-editor .cm-redline-btn {"),
      css.indexOf("}", css.indexOf(".cm-editor .cm-redline-btn {")) + 1,
    );
    const askRule = css.slice(
      css.indexOf(".cm-editor .cm-redline-instruction {"),
      css.indexOf("}", css.indexOf(".cm-editor .cm-redline-instruction {")) + 1,
    );
    const stubRule = css.slice(
      css.indexOf(".cm-redline-gutter-stub {"),
      css.indexOf("}", css.indexOf(".cm-redline-gutter-stub {")) + 1,
    );
    expect(bodyRule).toMatch(/var\(--redline-scribble\)/);
    expect(bodyRule).toMatch(/font-size:\s*var\(--redline-scribble-size\)/);
    expect(bodyRule).not.toMatch(/font-size:\s*19px/);
    expect(bodyRule).not.toMatch(/font-size:\s*17px/);
    expect(askRule).toMatch(/var\(--redline-scribble\)/);
    expect(askRule).toMatch(/font-size:\s*var\(--redline-scribble-size\)/);
    expect(askRule).not.toMatch(/border-bottom/);
    expect(askRule).not.toMatch(/dashed/);
    expect(askRule).not.toMatch(/dotted/);
    expect(css).not.toMatch(/cm-redline-quote/);
    const actionsStart = css.indexOf(".cm-editor .cm-redline-note-actions {");
    const actionsRule = css.slice(actionsStart, css.indexOf("}", actionsStart) + 1);
    expect(actionsRule).toMatch(/border-top:\s*1px solid/);
    expect(actionsRule).not.toMatch(/dashed/);
    expect(actionsRule).not.toMatch(/dotted/);
    expect(css).toMatch(/--redline-scribble:\s*"Nothing You Could Do"/);
    expect(css).toMatch(/--redline-scribble-size:\s*20px/);
    expect(bodyRule).toMatch(/line-height:\s*1\.3/);
    expect(askRule).toMatch(/line-height:\s*1\.3/);
    expect(css).toMatch(/--redline-label-size:\s*10px/);
    const composeActionsStart = css.indexOf(
      ".cm-editor .cm-redline-note-actions.cm-redline-compose-actions {",
    );
    expect(composeActionsStart).toBeGreaterThan(actionsStart);
    const composeActions = css.slice(
      composeActionsStart,
      css.indexOf("}", composeActionsStart) + 1,
    );
    expect(composeActions).toMatch(/flex-wrap:\s*nowrap/);
    // One primary rule for every margin row: a drawn line, so the theme can recolor it.
    const primaryStart = css.indexOf(".cm-editor .cm-redline-btn-primary {");
    expect(primaryStart).toBeGreaterThan(-1);
    const primary = css.slice(primaryStart, css.indexOf("}", primaryStart) + 1);
    expect(primary).toMatch(/background-image:\s*linear-gradient\(currentColor, currentColor\)/);
    expect(primary).not.toMatch(/background-color/);
    expect(css).not.toMatch(/\.cm-redline-compose \.cm-redline-btn-primary/);
    expect(css).not.toMatch(/\.cm-redline-btn::before/);
    expect(css).toMatch(/--redline-note-stack:\s*2px/);
    expect(noteRule).toMatch(/--ui-font/);
    expect(noteRule).not.toMatch(/Rock Salt/);
    expect(noteRule).not.toMatch(/Caveat/);
    expect(btnRule).toMatch(/font:\s*inherit/);
    expect(btnRule).not.toMatch(/Rock Salt/);
    expect(btnRule).not.toMatch(/Caveat/);
    expect(btnRule).toMatch(/text-decoration:\s*none/);
    expect(stubRule).toMatch(/border-radius:\s*50%/);
    expect(stubRule).toMatch(/width:\s*6px/);
    expect(stubRule).toMatch(/var\(--redline-stub/);
    expect(stubRule).not.toMatch(/stroke-dasharray/);
    expect(
      existsSync(
        new URL("../src/features/redline-spike/fonts/RockSalt-latin-400.woff2", import.meta.url),
      ),
    ).toBe(false);
    expect(
      existsSync(
        new URL(
          "../src/features/redline-spike/fonts/NothingYouCouldDo-latin-400.woff2",
          import.meta.url,
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        new URL("../src/features/redline-spike/fonts/Caveat-latin-400.woff2", import.meta.url),
      ),
    ).toBe(false);
    expect(css).toMatch(/font-family:\s*"Nothing You Could Do"/);
    expect(css).toMatch(/NothingYouCouldDo-latin-400\.woff2/);
    expect(css).not.toMatch(/fonts\.googleapis/);
    const paneStart = css.indexOf('[data-theme="light"] [data-pane]');
    const paneRule = css.slice(paneStart, css.indexOf("}", paneStart) + 1);
    expect(paneRule).toMatch(/background-color:\s*var\(--redline-paper\)/);
    expect(css).not.toMatch(/\.cm-markdown-heading \{/);
    const labelRule = css.slice(
      css.indexOf(".cm-editor .cm-redline-note-label {"),
      css.indexOf("}", css.indexOf(".cm-editor .cm-redline-note-label {")) + 1,
    );
    expect(labelRule).toMatch(/font-size:\s*var\(--redline-label-size\)/);
    expect(labelRule).toMatch(/margin-bottom:\s*var\(--redline-note-stack\)/);
    expect(labelRule).toMatch(/background-image:\s*none/);
    expect(labelRule).not.toMatch(/#9a948c/);
    expect(labelRule).not.toMatch(/--redline-span/);
    expect(labelRule).not.toMatch(/marker-wash/);
    expect(noteRule).toMatch(/background-image:\s*none/);
    expect(noteRule).not.toMatch(/#9a948c/);
    expect(noteRule).not.toMatch(/--redline-span/);
    expect(noteRule).not.toMatch(/marker-wash/);
  });

  test("notes zero the scroller's right clip so the gutter is not clipped", () => {
    const css = readFileSync(
      new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(
      /\[data-redline-notes\][\s\S]*?\.cm-scroller \{[\s\S]*?clip-path:\s*inset\(\s*0 0 0 /,
    );
  });

  test("the note rail is 268px beside the capped draft, centered as one unit", () => {
    const src = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    const css = readFileSync(
      new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
      "utf8",
    );
    expect(REDLINE_GUTTER_WIDTH).toBe(268);
    expect(src).not.toMatch(/redlineGutterWidth/);
    expect(src).not.toMatch(/getComputedStyle\(content\)\.paddingRight/);
    expect(src).not.toMatch(/margin-variant/);
    expect(css).toMatch(/--redline-sidebar-width:\s*268px/);
    expect(css).toMatch(/--writer-editor-max-width,\s*75ch/);
    expect(css).toMatch(/--redline-gutter-inset-right:\s*max\(0px,\s*var\(--writer-half\)\)/);
    expect(css).not.toContain("data-margin-variant");
  });
});

describe("gutter coordsAtPos deferral", () => {
  test("gutter defers coordsAtPos via requestMeasure (Mac Ask crash)", () => {
    const src = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/requestMeasure\s*\(/);
    expect(src).toMatch(/scheduleStubLayout/);
    expect(src).not.toMatch(/layoutConnectors\s*\(/);
    expect(src).not.toMatch(/scheduleConnectorLayout/);
    const scheduleAt = src.indexOf("private scheduleStubLayout");
    expect(scheduleAt).toBeGreaterThan(-1);
    const drawPart = src.slice(src.indexOf("private draw("), scheduleAt);
    expect(drawPart).toMatch(/this\.scheduleStubLayout/);
    expect(drawPart).not.toMatch(/coordsAtPos\s*\(/);
    expect(src.slice(scheduleAt)).toMatch(/requestMeasure[\s\S]*coordsAtPos\s*\(/);
  });
});

describe("overlappingNote", () => {
  test("finds the note covering the selection", () => {
    const notes = [note()];
    expect(overlappingNote(notes, 2, 8)?.id).toBe("redline-1");
    expect(overlappingNote(notes, 80, 90)).toBeUndefined();
    expect(noteAtExactRange(notes, 0, ORIGINAL.length)?.id).toBe("redline-1");
    expect(noteAtExactRange(notes, 2, 8)).toBeUndefined();
  });
});

describe("paper annotate locus", () => {
  test("noteShowsLocus is insert/replace with proposed, not human or caution", () => {
    expect(noteShowsLocus(note({ intent: "replace", proposed: PROPOSED, status: "pending" }))).toBe(
      true,
    );
    expect(noteShowsLocus(note({ intent: "insert", proposed: INSERT, status: "pending" }))).toBe(
      true,
    );
    expect(
      noteShowsLocus(note({ intent: "none", proposed: "this is muddy", status: "pending" })),
    ).toBe(false);
    expect(
      noteShowsLocus(note({ intent: "replace", proposed: PROPOSED, status: "accepted" })),
    ).toBe(false);
    expect(noteShowsLocus(note({ status: "open" }))).toBe(false);
  });

  test("reopenCompose returns the note to margin scribble", () => {
    let state = stateWith(ORIGINAL, [
      note({
        proposed: PROPOSED,
        intent: "replace",
        instruction: "@agent tighten",
        status: "pending",
      }),
    ]);
    state = state.update({ effects: reopenCompose.of("redline-1") }).state;
    const item = state.field(redlineNotesField)[0];
    expect(item?.status).toBe("open");
    expect(item?.intent).toBeNull();
    expect(item?.proposed).toBeNull();
    expect(item?.instruction).toBe("@agent tighten");
    expect(noteShowsLocus(item!)).toBe(false);
    expect(noteShowsCompose(item!)).toBe(true);
  });

  test("ink tick widget appears on flash and clears", () => {
    const item = note({ proposed: PROPOSED, intent: "replace", status: "accepted" });
    const withTick = buildRedlineDecorations(Text.of([ORIGINAL]), [item], "redline-1");
    expect(widgetsOfKind(withTick, ORIGINAL.length + 1, "tick")).toBe(1);
    expect(widgetsOfKind(withTick, ORIGINAL.length + 1, "locus")).toBe(0);
    const without = buildRedlineDecorations(Text.of([ORIGINAL]), [item], null);
    expect(widgetsOfKind(without, ORIGINAL.length + 1, "tick")).toBe(0);

    let state = EditorState.create({
      doc: ORIGINAL,
      extensions: [
        redlineSeedNotes.of([item]),
        redlineNotesField,
        redlineInkTickField,
        redlineDecorationsField,
      ],
    });
    state = state.update({ effects: flashInkTick.of("redline-1") }).state;
    expect(state.field(redlineInkTickField)).toBe("redline-1");
    expect(widgetsOfKind(state.field(redlineDecorationsField), ORIGINAL.length + 1, "tick")).toBe(
      1,
    );
  });

  test("Reject drops the note; Accept tick is not a badge", () => {
    const deco = readFileSync(
      new URL("../src/features/redline-spike/decorations.ts", import.meta.url),
      "utf8",
    );
    const actions = readFileSync(
      new URL("../src/features/redline-spike/actions.ts", import.meta.url),
      "utf8",
    );
    expect(deco).not.toMatch(/dissolveLocusThen/);
    expect(deco).not.toMatch(/is-dissolving/);
    expect(actions).not.toMatch(/flashTick\(/);
    expect(actions).toMatch(/armInkTickClear/);
    expect(actions).not.toMatch(/700\b/);
  });

  test("selection theme uses the wash, not a compose bar on the body", () => {
    const deco = readFileSync(
      new URL("../src/features/redline-spike/decorations.ts", import.meta.url),
      "utf8",
    );
    const css = readFileSync(
      new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
      "utf8",
    );
    expect(deco).toMatch(/redlineSelectionTheme/);
    expect(deco).toMatch(/backgroundColor:\s*"transparent"/);
    expect(css).toMatch(/\.cm-content \.cm-line ::selection/);
    expect(css).toMatch(/background-color:\s*var\(--redline-select\)\s*!important/);
    expect(css).toMatch(
      /\.cm-selectionLayer \.cm-selectionBackground \{[\s\S]*?background-color:\s*transparent\s*!important/,
    );
    expect(css).toMatch(/#f3eee4 46%/);
    expect(css).toMatch(
      /\[data-theme="dark"\] \.cm-editor \.cm-scroller \.cm-selectionLayer \.cm-selectionBackground/,
    );
    expect(deco).not.toMatch(/textarea/);
    expect(deco).not.toMatch(/placeholder/);
  });
});

describe("own notes, overlap, wash scope", () => {
  test("create → edit → persist keeps the new body and the wash", () => {
    const view = dispatchView(ORIGINAL);
    expect(addNoteAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(beginAskOnNote(view, id, "this is muddy")).toBe(true);
    expect(isOwnCommentNote(view.state.field(redlineNotesField)[0]!)).toBe(true);
    expect(editAskOnNote(view, id)).toBe(true);
    const editing = view.state.field(redlineNotesField)[0]!;
    expect(editing.status).toBe("open");
    expect(editing.intent).toBeNull();
    expect(editing.instruction).toBe("this is muddy");
    expect(editing.proposed).toBe("this is muddy");
    expect(noteShowsCompose(editing)).toBe(true);
    expect(markClasses(view.state.field(redlineDecorationsField), 0, ORIGINAL.length)).toContain(
      "cm-redline-open",
    );
    expect(
      markClasses(view.state.field(redlineDecorationsField), 0, ORIGINAL.length),
    ).not.toContain("cm-redline-del");
    expect(insertWidgets(view.state.field(redlineDecorationsField), ORIGINAL.length + 1)).toEqual(
      [],
    );
    expect(beginAskOnNote(view, id, "tighten the claim")).toBe(true);
    const saved = view.state.field(redlineNotesField)[0]!;
    expect(saved.proposed).toBe("tighten the claim");
    expect(saved.intent).toBe("none");
    expect(saved.instruction).toBeNull();
    expect(saved.status).toBe("pending");
    expect(isOwnCommentNote(saved)).toBe(true);
    expect(view.state.field(redlineNotesField)).toHaveLength(1);
    expect(markClasses(view.state.field(redlineDecorationsField), 0, ORIGINAL.length)).toContain(
      "cm-redline-open",
    );
  });

  test("Cancel after Edit restores the saved body instead of deleting", () => {
    const view = dispatchView(ORIGINAL);
    expect(addNoteAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(beginAskOnNote(view, id, "this is muddy")).toBe(true);
    expect(editAskOnNote(view, id)).toBe(true);
    expect(rejectNote(view, id)).toBe(true);
    const restored = view.state.field(redlineNotesField)[0]!;
    expect(restored.proposed).toBe("this is muddy");
    expect(restored.intent).toBe("none");
    expect(restored.instruction).toBeNull();
    expect(isOwnCommentNote(restored)).toBe(true);
  });

  test("Delete removes the note, wash, and decorations", () => {
    const view = dispatchView(ORIGINAL);
    expect(addNoteAtRange(view, 0, ORIGINAL.length)).toBe(true);
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(beginAskOnNote(view, id, "this is muddy")).toBe(true);
    expect(decorationCount(view.state.field(redlineDecorationsField), ORIGINAL.length + 1)).toBe(1);
    expect(rejectNote(view, id)).toBe(true);
    expect(view.state.field(redlineNotesField)).toEqual([]);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
    expect(decorationCount(view.state.field(redlineDecorationsField), ORIGINAL.length + 1)).toBe(0);
  });

  test("overlapping selection creates a second note", () => {
    const view = dispatchView(ORIGINAL);
    expect(addNoteAtRange(view, 0, 12)).toBe(true);
    expect(addNoteAtRange(view, 8, 20)).toBe(true);
    const notes = view.state.field(redlineNotesField);
    expect(notes).toHaveLength(2);
    expect(noteAtExactRange(notes, 0, 12)).toBeDefined();
    expect(noteAtExactRange(notes, 8, 20)).toBeDefined();
    expect(addNoteAtRange(view, 8, 20)).toBe(true);
    expect(view.state.field(redlineNotesField)).toHaveLength(2);
  });

  test("overlapping selection in reverse order still creates both washes", () => {
    const view = dispatchView(ORIGINAL);
    expect(addNoteAtRange(view, 8, 20)).toBe(true);
    expect(addNoteAtRange(view, 0, 12)).toBe(true);
    const notes = view.state.field(redlineNotesField);
    expect(notes).toHaveLength(2);
    expect(noteAtExactRange(notes, 8, 20)).toBeDefined();
    expect(noteAtExactRange(notes, 0, 12)).toBeDefined();
    const set = view.state.field(redlineDecorationsField);
    expect(decorationCount(set, ORIGINAL.length + 1)).toBe(2);
    expect(markClasses(set, 0, 12)).toContain("cm-redline-open");
    expect(markClasses(set, 8, 20)).toContain("cm-redline-open");
  });

  test("deleting one of two overlapping notes leaves the other wash", () => {
    const view = dispatchView(ORIGINAL);
    expect(addNoteAtRange(view, 0, 12)).toBe(true);
    expect(addNoteAtRange(view, 8, 20)).toBe(true);
    const first = noteAtExactRange(view.state.field(redlineNotesField), 0, 12)!;
    expect(beginAskOnNote(view, first.id, "first")).toBe(true);
    expect(rejectNote(view, first.id)).toBe(true);
    const notes = view.state.field(redlineNotesField);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.from).toBe(8);
    expect(notes[0]?.to).toBe(20);
    const spans: [number, number, string][] = [];
    view.state.field(redlineDecorationsField).between(0, ORIGINAL.length, (from, to, value) => {
      const cls = value.spec.class as string | undefined;
      if (cls) spans.push([from, to, cls]);
    });
    expect(spans).toEqual([[8, 20, "cm-redline-open"]]);
  });

  test("Cancel after Edit ask on an agent proposal still deletes", () => {
    const view = dispatchView(ORIGINAL);
    view.dispatch({
      effects: addRedlineNote.of(
        note({
          proposed: PROPOSED,
          intent: "replace",
          instruction: "@agent tighten",
          status: "pending",
        }),
      ),
    });
    const id = view.state.field(redlineNotesField)[0]!.id;
    expect(editAskOnNote(view, id)).toBe(true);
    const editing = view.state.field(redlineNotesField)[0]!;
    expect(editing.status).toBe("open");
    expect(editing.proposed).toBeNull();
    expect(editing.instruction).toBe("@agent tighten");
    expect(rejectNote(view, id)).toBe(true);
    expect(view.state.field(redlineNotesField)).toEqual([]);
    expect(view.state.doc.toString()).toBe(ORIGINAL);
  });

  test("selection can sit on an intersecting wash mark", () => {
    let state = EditorState.create({
      doc: ORIGINAL,
      extensions: [redlineNotesField, redlineDecorationsField],
    });
    state = state.update({
      effects: addRedlineNote.of(
        note({ intent: "none", proposed: "this is muddy", status: "pending", from: 0, to: 12 }),
      ),
    }).state;
    state = state.update({ selection: EditorSelection.range(5, 20) }).state;
    expect(state.selection.main.from).toBe(5);
    expect(state.selection.main.to).toBe(20);
    expect(state.doc.toString()).toBe(ORIGINAL);
  });

  test("wash class and decoration stay on the body span, not note chrome", () => {
    const own = note({ intent: "none", proposed: "this is muddy", status: "pending" });
    for (const cls of redlineNoteClassName(own).split(/\s+/)) {
      expect(cls).not.toBe("cm-redline-open");
      expect(cls).not.toBe("cm-redline-del");
      expect(cls).not.toBe("cm-redline-ins");
    }
    const gutterSrc = readFileSync(
      new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
      "utf8",
    );
    expect(gutterSrc).toMatch(/label\.className = "cm-redline-note-label"/);
    expect(gutterSrc).not.toMatch(/note-label[\s\S]{0,80}cm-redline-open/);
    const deco = readFileSync(
      new URL("../src/features/redline-spike/decorations.ts", import.meta.url),
      "utf8",
    );
    expect(deco).not.toMatch(/atomicRanges/);
    expect(deco).toMatch(/ignoreEvent\(\)[\s\S]{0,40}return false/);
    const set = buildRedlineDecorations(Text.of([ORIGINAL]), [
      note({
        id: "span-a",
        from: 5,
        to: 15,
        intent: "none",
        proposed: "a",
        status: "pending",
      }),
    ]);
    const spans: [number, number, string][] = [];
    set.between(0, ORIGINAL.length, (from, to, value) => {
      const cls = value.spec.class as string | undefined;
      if (cls) {
        expect(value.spec.atomic).toBeUndefined();
        spans.push([from, to, cls]);
      }
    });
    expect(spans).toEqual([[5, 15, "cm-redline-open"]]);
  });
});
