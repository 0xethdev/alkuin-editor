import { EditorView } from "@codemirror/view";
import type { ChangeDesc, Extension } from "@codemirror/state";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { buildEditorBodyMenuItemsSpec, showNativeContextMenu } from "./editor-context-menu";
import { followLink, linkHrefAtPos } from "./link-navigation";
import { runEditorCommand } from "./markdown-formatting";
import { askAgentFromMenu, selectionRange } from "@/features/redline-spike";
import { captureDocSession } from "./editor-doc-session";
import { showEditorNotice } from "./editor-notice-store";

/** Range for a native context-menu action. Live CM selection wins; if it
 *  collapsed (WKWebView right-click / menu blur), use the pointer-down
 *  snapshot; if that is empty too but the click landed in the last non-empty
 *  range, reuse that (native highlight can outlive CM state). */
export function resolveContextMenuRange(input: {
  liveFrom: number;
  liveTo: number;
  pointerFrom: number;
  pointerTo: number;
  lastFrom: number;
  lastTo: number;
  clickPos: number | null;
}): { from: number; to: number } {
  const live = selectionRange(input.liveFrom, input.liveTo);
  if (live) return live;
  const pointer = selectionRange(input.pointerFrom, input.pointerTo);
  if (pointer) return pointer;
  const last = selectionRange(input.lastFrom, input.lastTo);
  if (last && input.clickPos !== null && last.from <= input.clickPos && input.clickPos <= last.to) {
    return last;
  }
  return { from: input.liveFrom, to: input.liveTo };
}

interface MenuRange {
  from: number;
  to: number;
}

const NO_RANGE: MenuRange = { from: 0, to: 0 };

function mapMenuRange(range: MenuRange, changes: ChangeDesc): MenuRange {
  if (range.from === range.to) return range;
  const from = changes.mapPos(range.from, 1);
  const to = changes.mapPos(range.to, -1);
  return from < to ? { from, to } : NO_RANGE;
}

/**
 * The ranges a context menu falls back on when WKWebView has collapsed the
 * live selection, each with one lifecycle:
 *
 * - `last`: the last non-empty selection. Mapped through edits; reused only
 *   when the click lands inside it.
 * - `pointer`: the selection snapshotted at the menu press (right button,
 *   or Ctrl-click on macOS). Good for the one contextmenu that follows: it is
 *   consumed there, and any other press drops it, so a keyboard-opened menu
 *   never inherits an earlier right-click's range.
 * - `menu`: the range the open menu acts on. Mapped through edits made while
 *   the menu is open, so "Add redline note" lands on the same text.
 *
 * A swap to another document clears all three.
 */
export class ContextMenuRanges {
  private last = NO_RANGE;
  private pointer = NO_RANGE;
  private menu = NO_RANGE;

  observe(update: {
    docChanged: boolean;
    changes: ChangeDesc;
    selection: MenuRange;
    swapped: boolean;
  }) {
    if (update.swapped) {
      this.last = this.pointer = this.menu = NO_RANGE;
    } else if (update.docChanged) {
      this.last = mapMenuRange(this.last, update.changes);
      this.pointer = mapMenuRange(this.pointer, update.changes);
      this.menu = mapMenuRange(this.menu, update.changes);
    }
    this.remember(update.selection);
  }

  /** A mouse press. Only a menu press keeps a pointer snapshot. */
  press(selection: MenuRange, clickPos: number | null, isMenuPress: boolean) {
    this.remember(selection);
    if (!isMenuPress) {
      this.pointer = NO_RANGE;
      return;
    }
    this.pointer = this.resolve(selection, selection, clickPos);
  }

  /** The contextmenu event: fix the range the menu acts on. Consumes the
   *  press snapshot. */
  open(selection: MenuRange, clickPos: number | null): MenuRange {
    this.remember(selection);
    this.menu = this.resolve(selection, this.pointer, clickPos);
    this.pointer = NO_RANGE;
    return this.menu;
  }

  /** The open menu's range as of now. */
  menuRange(): MenuRange {
    return this.menu;
  }

  private remember(selection: MenuRange) {
    if (selection.from !== selection.to) this.last = { from: selection.from, to: selection.to };
  }

  private resolve(live: MenuRange, pointer: MenuRange, clickPos: number | null): MenuRange {
    return resolveContextMenuRange({
      liveFrom: live.from,
      liveTo: live.to,
      pointerFrom: pointer.from,
      pointerTo: pointer.to,
      lastFrom: this.last.from,
      lastTo: this.last.to,
      clickPos,
    });
  }
}

/** Right-click menu over the editor body: clipboard, the command submenus,
 *  and link actions when the click landed on a link. */
export function editorBodyContextMenuExtension(
  getFilePath: () => string,
  isDisposed: () => boolean,
): Extension {
  const ranges = new ContextMenuRanges();

  return [
    EditorView.updateListener.of((update) => {
      ranges.observe({
        docChanged: update.docChanged,
        changes: update.changes,
        selection: update.state.selection.main,
        swapped: update.transactions.some((tr) => tr.isUserEvent("writer")),
      });
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        // macOS opens the context menu on Ctrl-click too.
        const isMenuPress = event.button === 2 || (event.button === 0 && event.ctrlKey);
        const clickPos = isMenuPress
          ? view.posAtCoords({ x: event.clientX, y: event.clientY })
          : null;
        ranges.press(view.state.selection.main, clickPos, isMenuPress);
        return false;
      },
      contextmenu(event, view) {
        event.preventDefault();

        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const linkHref = pos === null ? null : linkHrefAtPos(view, pos);
        const hasLink = linkHref !== null;
        const filePath = getFilePath();
        // The menu is native and async: an action picked after the view moved
        // on to another document must not land there.
        const isCurrent = captureDocSession(view, isDisposed);
        ranges.open(view.state.selection.main, pos);

        void showNativeContextMenu(
          buildEditorBodyMenuItemsSpec(
            {
              onCut: () => {
                const { from, to } = view.state.selection.main;
                if (from === to) return;
                void writeText(view.state.sliceDoc(from, to));
                view.dispatch({ changes: { from, to } });
              },
              onCopy: () => {
                const { from, to } = view.state.selection.main;
                if (from === to) return;
                void writeText(view.state.sliceDoc(from, to));
              },
              onPaste: () => {
                void readText().then((text) => {
                  if (!text || !isCurrent()) return;
                  view.dispatch(view.state.replaceSelection(text));
                });
              },
              onSelectAll: () => {
                view.dispatch({
                  selection: { anchor: 0, head: view.state.doc.length },
                });
              },
              onOpenLink: hasLink
                ? () => {
                    if (!isCurrent()) return;
                    void followLink(linkHref, view, filePath, isDisposed).catch((error) => {
                      if (!isDisposed()) console.error("[editor] Failed to open link:", error);
                    });
                  }
                : undefined,
              onCopyLink: hasLink
                ? () => {
                    void writeText(linkHref);
                  }
                : undefined,
              onRunCommand: (id) => {
                view.focus();
                runEditorCommand(view, id);
              },
              onAddRedlineNote: () => {
                if (!isCurrent()) return;
                const { from, to } = ranges.menuRange();
                if (!askAgentFromMenu(view, from, to)) {
                  showEditorNotice("Select text to add a margin note");
                }
              },
            },
            hasLink,
          ),
        );

        return true;
      },
    }),
  ];
}
