import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { askAgentFromMenu } from "@/features/redline-spike";
import { dragFrozenSelectionField } from "./drag-selection-gate";
import {
  EDITOR_COMMAND_SUBMENUS,
  menuLayoutWithoutCommandIds,
  uniqueEditorBodyCommandIds,
} from "./editor-context-menu";
import { findOuterScroller } from "./editor-scroll";
import { editorCommands, runEditorCommand, type EditorCommandId } from "./markdown-formatting";
import { useEditorSearchStore } from "./editor-search-store";
import "./selection-bubble.css";

/** B1 strip: short labels. Remaining inventory lives under More. */
export const BUBBLE_PRIMARY_IDS = [
  "format.bold",
  "format.italic",
  "format.link",
  "format.bulletList",
] as const satisfies readonly EditorCommandId[];

const PRIMARY_SKIP = new Set<EditorCommandId>(BUBBLE_PRIMARY_IDS);

const PRIMARY_LABEL: Record<(typeof BUBBLE_PRIMARY_IDS)[number], string> = {
  "format.bold": "B",
  "format.italic": "I",
  "format.link": "Link",
  "format.bulletList": "List",
};

export type SelectionBubbleStripItem =
  | { kind: "command"; id: EditorCommandId; label: string }
  | { kind: "note"; label: "Note" }
  | { kind: "more"; label: "···" }
  | { kind: "separator" };

export function selectionBubbleStrip(): SelectionBubbleStripItem[] {
  return [
    { kind: "command", id: "format.bold", label: PRIMARY_LABEL["format.bold"] },
    { kind: "command", id: "format.italic", label: PRIMARY_LABEL["format.italic"] },
    { kind: "separator" },
    { kind: "command", id: "format.link", label: PRIMARY_LABEL["format.link"] },
    { kind: "command", id: "format.bulletList", label: PRIMARY_LABEL["format.bulletList"] },
    { kind: "separator" },
    { kind: "note", label: "Note" },
    { kind: "separator" },
    { kind: "more", label: "···" },
  ];
}

export function selectionBubbleMoreGroups(): ReadonlyArray<{
  title: string;
  items: Array<{ id: EditorCommandId; label: string }>;
}> {
  return EDITOR_COMMAND_SUBMENUS.map(([title, layout]) => ({
    title,
    items: menuLayoutWithoutCommandIds(layout, PRIMARY_SKIP)
      .filter((entry): entry is readonly [string, EditorCommandId, string?] => entry !== "---")
      .map(([, id, label]) => ({ id, label: label ?? editorCommands[id].label })),
  })).filter((group) => group.items.length > 0);
}

export function selectionBubbleCommandIds(): EditorCommandId[] {
  const ids: EditorCommandId[] = [...BUBBLE_PRIMARY_IDS];
  const seen = new Set<EditorCommandId>(ids);
  for (const group of selectionBubbleMoreGroups()) {
    for (const item of group.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      ids.push(item.id);
    }
  }
  return ids;
}

export function selectionBubbleOpen(input: {
  empty: boolean;
  dragging?: boolean;
  searchOpen?: boolean;
}): boolean {
  return !input.empty && !input.dragging && !input.searchOpen;
}

export function selectionBubbleEscape(input: {
  moreOpen: boolean;
  empty: boolean;
  searchOpen?: boolean;
}): "close-more" | "collapse" | "noop" {
  if (input.searchOpen) return "noop";
  if (input.moreOpen) return "close-more";
  if (!input.empty) return "collapse";
  return "noop";
}

export function selectionBubbleClickAway(input: {
  bubbleOpen: boolean;
  paneActive: boolean;
  targetInBubble: boolean;
  targetInEditor: boolean;
  targetProtected: boolean;
}): boolean {
  if (!input.bubbleOpen || !input.paneActive) return false;
  return !input.targetInBubble && !input.targetInEditor && !input.targetProtected;
}

export function selectionBubbleTargetProtected(
  target: {
    closest?: (sel: string) => unknown;
  } | null,
): boolean {
  return Boolean(
    target && typeof target.closest === "function" && target.closest("[data-search-overlay]"),
  );
}

export function selectionBubblePaneActive(editorRoot: {
  closest?: (sel: string) => { classList?: { contains: (name: string) => boolean } } | null;
}): boolean {
  const pane = editorRoot.closest?.("[data-pane]");
  return !pane?.classList?.contains("invisible");
}

export function collapseEditorSelection(view: EditorView): boolean {
  const main = view.state.selection.main;
  if (main.empty) return false;
  view.dispatch({
    selection: EditorSelection.cursor(main.head),
    userEvent: "select.bubbleDismiss",
  });
  return true;
}

export function runSelectionBubbleNote(view: EditorView, from: number, to: number): boolean {
  return askAgentFromMenu(view, from, to);
}

function rectFromLineBlock(
  view: EditorView,
  pos: number,
): { top: number; bottom: number; left: number; right: number } {
  const block = view.lineBlockAt(pos);
  const top = view.documentTop + block.top;
  const bottom = view.documentTop + block.bottom;
  const content = view.contentDOM.getBoundingClientRect();
  return { top, bottom, left: content.left, right: content.left + 40 };
}

/** desk-p15 compact pill (no caret). Used until offsetHeight is available. */
export const BUBBLE_HEIGHT = 28;
/** Snug gap above/below the span — not the desk-p2 denser-below toolbar. */
const BUBBLE_GAP = 4;

/** Place the bubble snug above the selection midpoint; flip below if clipped by the visible scroller. */
export function selectionBubbleCoords(
  fromRect: { top: number; bottom: number; left: number; right: number } | null,
  toRect: { top: number; bottom: number; left: number; right: number } | null,
  editorRect: { top: number; left: number },
  height = BUBBLE_HEIGHT,
  visibleTop = editorRect.top,
): { left: number; top: number; side: "above" | "below" } | null {
  if (!fromRect || !toRect) return null;
  const left = (fromRect.left + toRect.right) / 2 - editorRect.left;
  const selTop = Math.min(fromRect.top, toRect.top);
  const aboveViewport = selTop - height - BUBBLE_GAP;
  if (aboveViewport >= visibleTop + 4) {
    return { left, top: aboveViewport - editorRect.top, side: "above" };
  }
  const selBottom = Math.max(fromRect.bottom, toRect.bottom);
  return { left, top: selBottom - editorRect.top + BUBBLE_GAP, side: "below" };
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/** ponytail: inventory must stay a set-equal of the live menus. */
export function selectionBubbleMatchesContextMenu(): boolean {
  return (
    sortedIds(selectionBubbleCommandIds()).join("\0") ===
    sortedIds(uniqueEditorBodyCommandIds()).join("\0")
  );
}

function bindKeepSelection(el: HTMLElement, run: () => void) {
  el.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  el.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
}

/** A pointer drag is selecting text. The drag gate's field is the one source:
 *  it starts on the content press and ends on pointerup, pointercancel or
 *  blur, so a lost pointerup can't leave the bubble suppressed. */
export function isDragSelecting(state: EditorState): boolean {
  return (state.field(dragFrozenSelectionField, false) ?? null) !== null;
}

class SelectionBubble {
  readonly dom: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly more: HTMLElement;
  private readonly moreButton: HTMLButtonElement;
  private moreOpen = false;
  // The side `sync` placed the bubble on. `applySide` is the only writer of
  // `data-side`: it starts from this and flips below while More would be
  // clipped above, so a later sync can't undo the flip.
  private anchorSide: "above" | "below" = "above";
  private measureQueued = false;
  private measureId = 0;
  private dead = false;
  private readonly onPointerDownCapture: (event: PointerEvent) => void;
  private readonly unsubscribeSearch: () => void;

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-selection-bubble";
    this.dom.hidden = true;
    this.dom.contentEditable = "false";
    this.dom.setAttribute("role", "toolbar");
    this.dom.setAttribute("aria-label", "Selection");

    this.more = document.createElement("div");
    this.more.className = "cm-selection-bubble-more";
    this.more.hidden = true;
    this.more.setAttribute("role", "menu");
    for (const group of selectionBubbleMoreGroups()) {
      const section = document.createElement("div");
      section.className = "cm-selection-bubble-more-group";
      const title = document.createElement("div");
      title.className = "cm-selection-bubble-more-title";
      title.textContent = group.title;
      section.append(title);
      for (const item of group.items) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = item.label;
        button.dataset.command = item.id;
        button.setAttribute("role", "menuitem");
        bindKeepSelection(button, () => {
          runEditorCommand(this.view, item.id);
          this.setMoreOpen(false);
        });
        section.append(button);
      }
      this.more.append(section);
    }

    this.strip = document.createElement("div");
    this.strip.className = "cm-selection-bubble-strip";
    let moreButton: HTMLButtonElement | null = null;
    for (const item of selectionBubbleStrip()) {
      if (item.kind === "separator") {
        const sep = document.createElement("span");
        sep.className = "cm-selection-bubble-sep";
        sep.setAttribute("aria-hidden", "true");
        this.strip.append(sep);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      if (item.kind === "command") {
        button.textContent = item.label;
        button.dataset.command = item.id;
        button.title = editorCommands[item.id].label;
        bindKeepSelection(button, () => {
          runEditorCommand(this.view, item.id);
        });
      } else if (item.kind === "note") {
        button.classList.add("cm-selection-bubble-note");
        button.textContent = item.label;
        button.dataset.bubble = "note";
        button.title = "Note";
        bindKeepSelection(button, () => {
          const { from, to } = this.view.state.selection.main;
          this.setMoreOpen(false);
          // Hide first so the bubble doesn't flash over the compose note
          // that takes focus. If no note opened, bring the bubble back.
          this.dom.hidden = true;
          if (!runSelectionBubbleNote(this.view, from, to)) this.queueSync(this.view);
        });
      } else {
        button.textContent = item.label;
        button.dataset.bubble = "more";
        button.setAttribute("aria-label", "More");
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", "false");
        bindKeepSelection(button, () => {
          this.setMoreOpen(!this.moreOpen);
        });
        moreButton = button;
      }
      this.strip.append(button);
    }
    if (!moreButton) throw new Error("selection bubble More button missing");
    this.moreButton = moreButton;

    this.dom.append(this.more, this.strip);
    view.dom.append(this.dom);

    this.onPointerDownCapture = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (this.dom.contains(target)) return;
      // A press in the text starts the drag gate, whose transaction re-syncs
      // the bubble (see `update`).
      if (this.view.contentDOM.contains(target)) return;
      const duck = target as unknown as { closest?: (sel: string) => unknown };
      if (
        selectionBubbleClickAway({
          bubbleOpen: !this.dom.hidden,
          paneActive: selectionBubblePaneActive(this.view.dom),
          targetInBubble: false,
          targetInEditor: this.view.dom.contains(target),
          targetProtected: selectionBubbleTargetProtected(duck),
        })
      ) {
        this.setMoreOpen(false);
        collapseEditorSelection(this.view);
      }
    };
    document.addEventListener("pointerdown", this.onPointerDownCapture, true);
    this.unsubscribeSearch = useEditorSearchStore.subscribe((state, prev) => {
      if (state.isOpen === prev.isOpen) return;
      this.queueSync(this.view);
    });
    this.queueSync(view);
  }

  update(update: ViewUpdate) {
    const dragStarted = !isDragSelecting(update.startState) && isDragSelecting(update.state);
    if (dragStarted) {
      // Hide at the press, not a frame later, so the bubble doesn't sit
      // over the text the drag is about to select.
      this.hide(update.view);
      return;
    }
    if (
      update.selectionSet ||
      update.docChanged ||
      update.geometryChanged ||
      update.viewportChanged ||
      isDragSelecting(update.startState) !== isDragSelecting(update.state)
    ) {
      this.queueSync(update.view);
    }
  }

  destroy() {
    this.dead = true;
    if (this.measureId) cancelAnimationFrame(this.measureId);
    this.unsubscribeSearch();
    document.removeEventListener("pointerdown", this.onPointerDownCapture, true);
    this.dom.remove();
  }

  private hide(view: EditorView) {
    this.setMoreOpen(false);
    this.dom.hidden = true;
    view.dom.removeAttribute("data-selection-bubble");
  }

  // The only writer of `data-side`.
  private applySide() {
    let side = this.anchorSide;
    if (this.moreOpen && side === "above") {
      this.dom.dataset.side = "above";
      const moreTop = this.more.getBoundingClientRect().top;
      const scroller = findOuterScroller(this.view.dom);
      const clipTop = (scroller ?? this.view.dom).getBoundingClientRect().top;
      if (moreTop < clipTop + 4) side = "below";
    }
    this.dom.dataset.side = side;
  }

  private queueSync(view: EditorView) {
    if (this.measureQueued || this.dead) return;
    this.measureQueued = true;
    this.measureId = requestAnimationFrame(() => {
      this.measureQueued = false;
      this.measureId = 0;
      if (this.dead) return;
      this.sync(view);
    });
  }

  private setMoreOpen(open: boolean) {
    if (this.moreOpen === open) return;
    this.moreOpen = open;
    this.more.hidden = !open;
    this.moreButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (!this.dom.hidden) this.applySide();
  }

  private sync(view: EditorView) {
    const sel = view.state.selection.main;
    const composing =
      typeof document !== "undefined" &&
      document.activeElement instanceof Element &&
      Boolean(document.activeElement.closest(".cm-redline-note"));
    const searchOpen = useEditorSearchStore.getState().isOpen;
    if (
      composing ||
      !selectionBubbleOpen({
        empty: sel.empty,
        dragging: isDragSelecting(view.state),
        searchOpen,
      })
    ) {
      this.hide(view);
      return;
    }
    const box = view.dom.getBoundingClientRect();
    const from = view.coordsAtPos(sel.from) ?? rectFromLineBlock(view, sel.from);
    const to = view.coordsAtPos(sel.to) ?? rectFromLineBlock(view, sel.to);
    const scroller = findOuterScroller(view.dom);
    const visibleTop = (scroller ?? view.dom).getBoundingClientRect().top;
    const coords = selectionBubbleCoords(
      from,
      to,
      box,
      this.dom.hidden ? BUBBLE_HEIGHT : this.dom.offsetHeight || BUBBLE_HEIGHT,
      visibleTop,
    );
    if (!coords) {
      this.dom.hidden = true;
      view.dom.removeAttribute("data-selection-bubble");
      return;
    }
    this.dom.hidden = false;
    this.anchorSide = coords.side;
    view.dom.dataset.selectionBubble = "open";
    const width = this.dom.offsetWidth || 220;
    const minLeft = width / 2 + 8;
    const maxLeft = Math.max(minLeft, box.width - width / 2 - 8);
    const left = Math.min(maxLeft, Math.max(minLeft, coords.left));
    this.dom.style.left = `${left}px`;
    this.dom.style.top = `${Math.max(0, coords.top)}px`;
    this.applySide();
  }

  escape(): boolean {
    const sel = this.view.state.selection.main;
    const action = selectionBubbleEscape({
      moreOpen: this.moreOpen,
      empty: sel.empty,
      searchOpen: useEditorSearchStore.getState().isOpen,
    });
    if (action === "close-more") {
      this.setMoreOpen(false);
      return true;
    }
    if (action === "collapse") return collapseEditorSelection(this.view);
    return false;
  }
}

const bubbleEscape = keymap.of([
  {
    key: "Escape",
    run: (view) => {
      const plugin = view.plugin(selectionBubblePlugin);
      return plugin?.escape() ?? false;
    },
  },
]);

const selectionBubblePlugin = ViewPlugin.fromClass(SelectionBubble);

export const selectionBubble: Extension = [selectionBubblePlugin, bubbleEscape];
