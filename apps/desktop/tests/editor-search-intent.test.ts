import { describe, expect, test } from "vite-plus/test";
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import {
  editorSearchExtensions,
  takeSearchScrollIntent,
} from "../src/components/editor-area/editor-search-extensions";

const nudge = StateEffect.define<null>();

function view() {
  return {
    state: EditorState.create({ doc: "one two one two one", extensions: [editorSearchExtensions] }),
  };
}

describe("search scroll intent", () => {
  test("a search jump owns the next scroll only", () => {
    const v = view();
    v.state = v.state.update({
      selection: EditorSelection.range(8, 11),
      userEvent: "select.search",
    }).state;
    expect(takeSearchScrollIntent(v)).toBe(true);
    // An effect-only transaction (a parse commit, a scroll request of its
    // own) keeps the token, but its scroll is not search's.
    v.state = v.state.update({ effects: nudge.of(null) }).state;
    expect(takeSearchScrollIntent(v)).toBe(false);
  });

  test("typing or moving the caret ends it, and the next jump starts a fresh one", () => {
    const v = view();
    v.state = v.state.update({
      selection: EditorSelection.range(8, 11),
      userEvent: "select.search",
    }).state;
    v.state = v.state.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }).state;
    expect(takeSearchScrollIntent(v)).toBe(false);

    v.state = v.state.update({
      selection: EditorSelection.range(17, 20),
      userEvent: "select.search",
    }).state;
    expect(takeSearchScrollIntent(v)).toBe(true);
  });

  test("replace navigation counts as search", () => {
    const v = view();
    v.state = v.state.update({
      changes: { from: 0, to: 3, insert: "ONE" },
      userEvent: "input.replace",
    }).state;
    expect(takeSearchScrollIntent(v)).toBe(true);
  });
});
