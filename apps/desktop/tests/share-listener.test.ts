import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { subscribeView } from "../src/features/document-share/live";

function fakeView() {
  let state = EditorState.create({ doc: "x" });
  return {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
  };
}

function fire(view: ReturnType<typeof fakeView>): void {
  for (const listener of view.state.facet(EditorView.updateListener)) {
    listener({} as ViewUpdate);
  }
}

test("repeated activation keeps one live-sync listener", () => {
  const view = fakeView();
  const editor = view as unknown as EditorView;
  const base = view.state.facet(EditorView.updateListener).length;
  const heard: string[] = [];
  let stop = subscribeView(editor, () => heard.push("first"));
  stop();
  stop = subscribeView(editor, () => heard.push("second"));
  stop();
  stop = subscribeView(editor, () => heard.push("third"));
  expect(view.state.facet(EditorView.updateListener).length).toBe(base + 1);
  fire(view);
  expect(heard).toEqual(["third"]);
  // Cleanup leaves an empty fan-out: nothing hears the next update.
  stop();
  fire(view);
  expect(heard).toEqual(["third"]);
  expect(view.state.facet(EditorView.updateListener).length).toBe(base + 1);
});
