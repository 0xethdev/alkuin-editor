import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  applyCssVarBindings: vi.fn(),
  readStoredAppearance: () => null,
}));

import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { restoreDocumentViewport } from "../src/components/editor-area/use-prosemark-editor";
import { consumePendingAnchor, setPendingAnchor } from "../src/lib/pending-anchor";

const PATH = "/notes/b.md";
const DOC = "# Top\n\nintro\n\n## Second\n\nbody";
const SECOND_POS = DOC.indexOf("## Second");

function fakeView() {
  const view = {
    state: EditorState.create({ doc: DOC }),
    documentTop: 0,
    lineBlockAt: (pos: number) => ({ top: pos * 100 }),
  };
  return view as unknown as EditorView;
}

function fakeScroller() {
  const scrollTo = vi.fn();
  const scroller = {
    scrollTop: 0,
    scrollHeight: 100_000,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo,
  };
  return { scroller: scroller as unknown as HTMLElement, scrollTo };
}

let frames: Array<() => void> = [];

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  consumePendingAnchor(PATH);
});

function runFrames() {
  const queued = frames;
  frames = [];
  for (const fn of queued) fn();
}

describe("restoreDocumentViewport", () => {
  test("a view thrown away before its frame leaves the anchor for the view that replaces it", () => {
    // React StrictMode: the ref mounts view A, unmounts it, then mounts B.
    setPendingAnchor(PATH, "second");
    const a = fakeView();
    const b = fakeView();
    let current: EditorView = a;
    const { scroller, scrollTo } = fakeScroller();

    restoreDocumentViewport(a, scroller, PATH, 0, () => current === a);
    current = b;
    restoreDocumentViewport(b, scroller, PATH, 0, () => current === b);
    runFrames();

    // One scroll, by the surviving view, to the heading (less the safe-zone
    // margin), not to the saved position 0.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const [target] = scrollTo.mock.calls[0] as [{ top: number; behavior: string }];
    expect(target.behavior).toBe("auto");
    expect(target.top).toBeGreaterThan(0);
    expect(target.top).toBeLessThanOrEqual(SECOND_POS * 100);
    expect(consumePendingAnchor(PATH)).toBeUndefined();
  });

  test("without an anchor the saved scroll is restored", () => {
    const view = fakeView();
    const { scroller, scrollTo } = fakeScroller();
    restoreDocumentViewport(view, scroller, PATH, 320, () => true);
    expect(scrollTo).not.toHaveBeenCalled();
    runFrames();
    expect(scrollTo).toHaveBeenCalledWith(0, 320);
  });
});
