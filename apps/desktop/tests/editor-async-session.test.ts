import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const navigateToFile = vi.fn(async (_path: string) => {});
vi.mock("@/hooks/editor-api", () => ({
  navigateToFile: (path: string) => navigateToFile(path),
  getOpenFile: () => undefined,
}));
vi.mock("@/hooks/workspace-api", () => ({ getWorkspaceRoot: () => "/ws" }));
vi.mock("@/hooks/use-document-headings", () => ({
  buildSlugIndex: () => new Map(),
  parseDocumentHeadings: () => [],
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  docSessionField,
  startNextDocSession,
} from "../src/components/editor-area/editor-doc-session";
import { followLink } from "../src/components/editor-area/link-navigation";

function fakeView() {
  const view = {
    state: EditorState.create({ doc: "[x](other.md)", extensions: [docSessionField] }),
  };
  return view as unknown as EditorView & { state: EditorState };
}

beforeEach(() => {
  navigateToFile.mockClear();
});

describe("followLink resolves for the document it was clicked in", () => {
  test("opens the target while the view still shows that document", async () => {
    await followLink("other.md", fakeView(), "/ws/a.md");
    expect(navigateToFile).toHaveBeenCalledWith("/ws/other.md");
  });

  test("drops the navigation if the view moved on to another document meanwhile", async () => {
    const view = fakeView();
    const pending = followLink("other.md", view, "/ws/a.md");
    view.state = view.state.update({ effects: startNextDocSession() }).state;
    await pending;
    expect(navigateToFile).not.toHaveBeenCalled();
  });

  test("drops the navigation if the view was disposed meanwhile", async () => {
    let disposed = false;
    const pending = followLink("other.md", fakeView(), "/ws/a.md", () => disposed);
    disposed = true;
    await pending;
    expect(navigateToFile).not.toHaveBeenCalled();
  });
});
