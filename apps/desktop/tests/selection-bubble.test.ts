import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { editorCommands } from "../src/components/editor-area/markdown-formatting";
import {
  uniqueEditorBodyCommandIds,
  menuLayoutWithoutCommandIds,
  FORMAT_SUBMENU,
} from "../src/components/editor-area/editor-context-menu";
import {
  BUBBLE_HEIGHT,
  BUBBLE_PRIMARY_IDS,
  collapseEditorSelection,
  isDragSelecting,
  runSelectionBubbleNote,
  selectionBubbleClickAway,
  selectionBubbleCommandIds,
  selectionBubbleCoords,
  selectionBubbleEscape,
  selectionBubbleMatchesContextMenu,
  selectionBubbleMoreGroups,
  selectionBubbleOpen,
  selectionBubblePaneActive,
  selectionBubbleStrip,
  selectionBubbleTargetProtected,
} from "../src/components/editor-area/selection-bubble";
import { redlineNotesField } from "../src/features/redline-spike";
import {
  buildEndDragDispatch,
  dragFreezeExtensions,
  startDragEffect,
} from "../src/components/editor-area/drag-selection-gate";

const DOC = "The creatine works good for training.";

function dispatchView(doc: string, from = 0, to = doc.length) {
  let state = EditorState.create({
    doc,
    extensions: [redlineNotesField],
    selection: EditorSelection.range(from, to),
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
      focused.push("view");
    },
  };
  return { view: view as unknown as EditorView, focused };
}

describe("selection bubble inventory", () => {
  test("matches the live Format / Paragraph / Insert command IDs", () => {
    expect(selectionBubbleMatchesContextMenu()).toBe(true);
    expect([...selectionBubbleCommandIds()].sort()).toEqual(
      [...uniqueEditorBodyCommandIds()].sort(),
    );
    expect([...uniqueEditorBodyCommandIds()].sort()).toEqual(Object.keys(editorCommands).sort());
  });

  test("B1 strip is compact short labels plus Note and More", () => {
    const strip = selectionBubbleStrip().map((item) => {
      if (item.kind === "separator") return "|";
      if (item.kind === "command") return `${item.id}:${item.label}`;
      return `${item.kind}:${item.label}`;
    });
    expect(strip).toEqual([
      "format.bold:B",
      "format.italic:I",
      "|",
      "format.link:Link",
      "format.bulletList:List",
      "|",
      "note:Note",
      "|",
      "more:···",
    ]);
  });

  test("More reaches every remaining menu command and skips the primary four", () => {
    const moreIds = selectionBubbleMoreGroups().flatMap((group) =>
      group.items.map((item) => item.id),
    );
    const titles = selectionBubbleMoreGroups().map((group) => group.title);
    expect(titles).toEqual(["Format", "Paragraph", "Insert"]);
    for (const id of BUBBLE_PRIMARY_IDS) {
      expect(moreIds).not.toContain(id);
    }
    const remainder = uniqueEditorBodyCommandIds().filter(
      (id) => !(BUBBLE_PRIMARY_IDS as readonly string[]).includes(id),
    );
    expect([...moreIds].sort()).toEqual([...remainder].sort());
  });

  test("squeezes separators after dropping primary rows from a layout", () => {
    const compact = menuLayoutWithoutCommandIds(
      FORMAT_SUBMENU,
      new Set(["format.bold", "format.italic", "format.link"]),
    );
    expect(compact.filter((entry) => entry === "---")).toEqual(["---"]);
    expect(compact.filter((entry) => entry !== "---").map((entry) => entry[1])).toEqual([
      "format.strikethrough",
      "format.code",
      "format.clearFormatting",
    ]);
  });
});

describe("selection bubble on selection", () => {
  test("opens on a non-empty range and hides when empty, dragging, or find is open", () => {
    expect(selectionBubbleOpen({ empty: false })).toBe(true);
    expect(selectionBubbleOpen({ empty: true })).toBe(false);
    expect(selectionBubbleOpen({ empty: false, dragging: true })).toBe(false);
    expect(selectionBubbleOpen({ empty: false, searchOpen: true })).toBe(false);
  });

  test("dragging is the drag gate's field, so its pointerup/cancel/blur end also ends it", () => {
    let state = EditorState.create({
      doc: DOC,
      extensions: [dragFreezeExtensions],
      selection: EditorSelection.range(0, 3),
    });
    expect(isDragSelecting(state)).toBe(false);
    state = state.update({ effects: startDragEffect.of(state.selection.ranges) }).state;
    expect(isDragSelecting(state)).toBe(true);
    const end = buildEndDragDispatch(state)!;
    state = state.update({ selection: end.selection, effects: end.effects }).state;
    expect(isDragSelecting(state)).toBe(false);
    // Without the gate installed there is no drag.
    expect(isDragSelecting(EditorState.create({ doc: DOC }))).toBe(false);
  });

  test("sits snug above the span midpoint and flips below when clipped", () => {
    expect(BUBBLE_HEIGHT).toBe(28);
    expect(
      selectionBubbleCoords(
        { top: 80, bottom: 98, left: 40, right: 80 },
        { top: 80, bottom: 98, left: 120, right: 160 },
        { top: 10, left: 10 },
      ),
    ).toEqual({ left: 90, top: 38, side: "above" });
    expect(
      selectionBubbleCoords(
        { top: 12, bottom: 30, left: 40, right: 80 },
        { top: 12, bottom: 30, left: 120, right: 160 },
        { top: 10, left: 10 },
      ),
    ).toEqual({ left: 90, top: 24, side: "below" });
    expect(
      selectionBubbleCoords(
        { top: 140, bottom: 158, left: 40, right: 80 },
        { top: 140, bottom: 158, left: 120, right: 160 },
        { top: -400, left: 10 },
        28,
        120,
      ),
    ).toEqual({ left: 90, top: 562, side: "below" });
    expect(
      selectionBubbleCoords(
        null,
        { top: 80, bottom: 98, left: 120, right: 160 },
        { top: 10, left: 10 },
      ),
    ).toBeNull();
  });

  test("the bar and its menu are opaque, and menu rows stay on one line", () => {
    const css = readFileSync(
      new URL("../src/components/editor-area/selection-bubble.css", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("../src/components/editor-area/selection-bubble.ts", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(/font-size:\s*12px/);
    expect(css).toMatch(/cm-selection-bubble-note/);
    expect(css).toMatch(/--paper-elevated:\s*#faf8f5/);
    expect(css).toMatch(/--paper-elevated:\s*#1e1e1c/);
    expect(css).toMatch(/background:\s*var\(--bubble-fill\)/);
    expect(css).toMatch(/box-shadow:\s*var\(--bubble-shadow\)/);
    expect(css).toMatch(/white-space:\s*nowrap/);
    expect(css).toMatch(/line-height:\s*1\.35/);
    expect(css).not.toMatch(/selection-bubble-caret/);
    expect(source).not.toMatch(/notePencil/);
    expect(source).not.toMatch(/createElementNS/);
  });
});

describe("selection bubble Note", () => {
  test("opens margin compose on the captured range and does not focus the view", () => {
    const { view, focused } = dispatchView(DOC);
    expect(runSelectionBubbleNote(view, 0, DOC.length)).toBe(true);
    const note = view.state.field(redlineNotesField)[0];
    expect(note?.original).toBe(DOC);
    expect(note?.status).toBe("open");
    expect(note?.proposed).toBeNull();
    expect(focused).toEqual([note?.id]);
    expect(focused).not.toContain("view");
  });

  test("empty range is a no-op", () => {
    const { view } = dispatchView(DOC, 0, 0);
    expect(runSelectionBubbleNote(view, 0, 0)).toBe(false);
    expect(view.state.field(redlineNotesField)).toEqual([]);
  });
});

describe("selection bubble dismiss", () => {
  test("Escape closes More first, then collapses the range, and yields to find", () => {
    expect(selectionBubbleEscape({ moreOpen: true, empty: false })).toBe("close-more");
    expect(selectionBubbleEscape({ moreOpen: false, empty: false })).toBe("collapse");
    expect(selectionBubbleEscape({ moreOpen: false, empty: true })).toBe("noop");
    expect(selectionBubbleEscape({ moreOpen: true, empty: false, searchOpen: true })).toBe("noop");
    expect(selectionBubbleEscape({ moreOpen: false, empty: false, searchOpen: true })).toBe("noop");
  });

  test("click away is outside the bubble, the editor, and find chrome", () => {
    const away = {
      bubbleOpen: true,
      paneActive: true,
      targetInBubble: false,
      targetInEditor: false,
      targetProtected: false,
    };
    expect(selectionBubbleClickAway({ ...away, targetInBubble: true })).toBe(false);
    expect(selectionBubbleClickAway({ ...away, targetInEditor: true })).toBe(false);
    expect(selectionBubbleClickAway({ ...away, targetProtected: true })).toBe(false);
    expect(selectionBubbleClickAway({ ...away, bubbleOpen: false })).toBe(false);
    expect(selectionBubbleClickAway({ ...away, paneActive: false })).toBe(false);
    expect(selectionBubbleClickAway(away)).toBe(true);
  });

  test("inactive keep-alive panes and find overlay are not away", () => {
    expect(
      selectionBubblePaneActive({
        closest: () => ({ classList: { contains: (name: string) => name === "invisible" } }),
      }),
    ).toBe(false);
    expect(
      selectionBubblePaneActive({
        closest: () => ({ classList: { contains: () => false } }),
      }),
    ).toBe(true);
    expect(
      selectionBubbleTargetProtected({ closest: (sel) => sel === "[data-search-overlay]" }),
    ).toBe(true);
    expect(selectionBubbleTargetProtected({ closest: () => null })).toBe(false);
  });

  test("collapsing the selection hides the bubble", () => {
    const { view } = dispatchView(DOC);
    expect(view.state.selection.main.empty).toBe(false);
    expect(selectionBubbleOpen({ empty: view.state.selection.main.empty })).toBe(true);
    expect(collapseEditorSelection(view)).toBe(true);
    expect(view.state.selection.main.empty).toBe(true);
    expect(selectionBubbleOpen({ empty: view.state.selection.main.empty })).toBe(false);
    expect(collapseEditorSelection(view)).toBe(false);
  });
});
