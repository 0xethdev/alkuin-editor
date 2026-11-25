import { describe, expect, test } from "vite-plus/test";
import { Compartment, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import {
  captureDocSession,
  docSessionField,
  docSessionOf,
  startNextDocSession,
} from "../src/components/editor-area/editor-doc-session";
import {
  planEditorSwap,
  reloadEditorChange,
  swapSelectionChange,
} from "../src/components/editor-area/editor-reload";

const swapTo = (over: Partial<Parameters<typeof planEditorSwap>[0]>) =>
  planEditorSwap({
    pathChanged: true,
    previousStillOpen: true,
    live: "# ",
    liveHead: 2,
    incoming: "# ",
    incomingCursorPos: 0,
    ...over,
  });

describe("planEditorSwap", () => {
  test("a different document with identical text still loads as a new document", () => {
    expect(swapTo({ incomingCursorPos: 1 })).toEqual({
      kind: "load",
      replace: false,
      newDocument: true,
      resetHistory: true,
      cursorPos: 1,
    });
  });

  test("a different document with other text replaces it", () => {
    expect(swapTo({ incoming: "# B\n", incomingCursorPos: 99 })).toEqual({
      kind: "load",
      replace: true,
      newDocument: true,
      resetHistory: true,
      cursorPos: 4,
    });
  });

  test("a rename of the same buffer adopts it", () => {
    expect(swapTo({ previousStillOpen: false })).toEqual({ kind: "adopt" });
    expect(swapTo({ previousStillOpen: false, live: "# Title more", incoming: "# Title" })).toEqual(
      { kind: "adopt" },
    );
  });

  test("a disk reload replaces the text but keeps the document session", () => {
    expect(swapTo({ pathChanged: false, live: "old", liveHead: 3, incoming: "new text" })).toEqual({
      kind: "load",
      replace: true,
      newDocument: false,
      resetHistory: false,
      cursorPos: 3,
    });
    expect(swapTo({ pathChanged: false, live: "same", incoming: "same" })).toEqual({
      kind: "adopt",
    });
  });

  test("a disk reload that is a strict prefix of the editor text replaces it", () => {
    // e.g. Accept of a copy that deleted the last paragraph. Adopting would
    // mark the buffer dirty and autosave the old text over the accepted one.
    expect(
      swapTo({
        pathChanged: false,
        live: "Intro.\n\nLast paragraph.",
        liveHead: 23,
        incoming: "Intro.",
      }),
    ).toEqual({
      kind: "load",
      replace: true,
      newDocument: false,
      resetHistory: false,
      cursorPos: 6,
    });
  });
});

/** Run the swap the way `use-prosemark-editor` does, on a bare state. */
function applySwap(
  state: EditorState,
  compartment: Compartment,
  plan: ReturnType<typeof planEditorSwap>,
  content: string,
): EditorState {
  if (plan.kind === "adopt") return state;
  if (plan.resetHistory) {
    state = state.update({ effects: compartment.reconfigure([]) }).state;
    state = state.update({ effects: compartment.reconfigure(history()) }).state;
  }
  const load: TransactionSpec = plan.replace
    ? reloadEditorChange(state.doc.length, plan.cursorPos, content, "writer.swap")
    : swapSelectionChange(plan.cursorPos, state.doc.length);
  return state.update({ ...load, effects: plan.newDocument ? startNextDocSession() : [] }).state;
}

describe("swapping to a document with identical text", () => {
  function typedThenCleared() {
    const compartment = new Compartment();
    let state = EditorState.create({
      doc: "# ",
      extensions: [compartment.of(history()), docSessionField],
    });
    state = state.update({ changes: { from: 2, insert: "x" }, userEvent: "input.type" }).state;
    state = state.update({ changes: { from: 2, to: 3 }, userEvent: "delete.backward" }).state;
    expect(state.doc.toString()).toBe("# ");
    expect(undoDepth(state)).toBeGreaterThan(0);
    return { state, compartment };
  }

  test("drops the previous document's undo history and starts a new session", () => {
    const before = typedThenCleared();
    const plan = swapTo({ incomingCursorPos: 2 });
    const state = applySwap(before.state, before.compartment, plan, "# ");
    expect(undoDepth(state)).toBe(0);
    expect(docSessionOf(state)).toBe(docSessionOf(before.state) + 1);
    expect(state.selection.main.head).toBe(2);

    let undone = state;
    undo({
      state,
      dispatch: (tr) => {
        undone = tr.state;
      },
    });
    expect(undone.doc.toString()).toBe("# ");
  });
});

describe("captureDocSession", () => {
  function fakeView(state: EditorState) {
    const view = { state };
    return view as unknown as EditorView & { state: EditorState };
  }

  test("goes stale when the view starts showing another document", () => {
    const view = fakeView(EditorState.create({ doc: "a", extensions: [docSessionField] }));
    const isCurrent = captureDocSession(view, () => false);
    expect(isCurrent()).toBe(true);

    view.state = view.state.update({ changes: { from: 1, insert: "b" } }).state;
    expect(isCurrent()).toBe(true);

    view.state = view.state.update({ effects: startNextDocSession() }).state;
    expect(isCurrent()).toBe(false);
  });

  test("goes stale when the view is disposed", () => {
    let disposed = false;
    const view = fakeView(EditorState.create({ doc: "a", extensions: [docSessionField] }));
    const isCurrent = captureDocSession(view, () => disposed);
    disposed = true;
    expect(isCurrent()).toBe(false);
  });
});
