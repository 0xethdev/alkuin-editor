import { Annotation, EditorSelection, Transaction, type TransactionSpec } from "@codemirror/state";

/**
 * Which file the editor is leaving and which one it shows now. The path getter the
 * extensions hold already answers with the new path before the swap is dispatched,
 * so the transaction says it. `rename` is this same buffer under a new path.
 */
export interface FilePathChange {
  from: string | null;
  to: string;
  kind: "swap" | "rename";
}

export const filePathChange = Annotation.define<FilePathChange>();

/**
 * What a path change is to the margin notes: this buffer under a new name, or another
 * file. The previous path being gone is a rename when the editor keeps its text, and
 * when the text it is given is the same words (the store can hold other line endings).
 * Anything else is another file, including the one shown after a file is closed.
 */
export function pathChangeKind(input: {
  previousStillOpen: boolean;
  replace: boolean;
  live: string;
  incoming: string;
}): FilePathChange["kind"] {
  if (input.previousStillOpen) return "swap";
  if (!input.replace) return "rename";
  return input.incoming.replace(/\r\n?/g, "\n") === input.live ? "rename" : "swap";
}

function reloadAnnotations(pathChange?: FilePathChange) {
  return pathChange
    ? [Transaction.addToHistory.of(false), filePathChange.of(pathChange)]
    : Transaction.addToHistory.of(false);
}

/**
 * A rename moves the store entry to the new path with the text as of the
 * rename. Keystrokes between the rename and this editor following it went
 * to the old path, so the live editor can be a longer string with that
 * snapshot as a prefix. Replacing the editor with the prefix would clip
 * those keystrokes and leave the caret on the shorter string.
 *
 * An empty snapshot still replaces: that is a real clear, and every document
 * starts with the empty string. A snapshot that is not a prefix is an
 * external edit and still replaces.
 *
 * Only a rename gets this rule. A disk reload of the same path (watcher,
 * history pull, Accept of the other copy, an import) is the store's decision
 * to replace the buffer — the `if-clean` policy already refuses one while
 * there are unsaved edits — so a reload that shortens the end (a deleted
 * last paragraph, a dropped trailing newline) must replace, not be adopted
 * and written back over the copy just accepted.
 */
function renameSnapshotToApply(
  live: string,
  liveHead: number,
  incoming: string,
): { content: string; head: number; replace: boolean } {
  const head = Math.max(liveHead, 0);
  if (incoming === live) return { content: live, head, replace: false };
  if (incoming.length > 0 && incoming.length < live.length && live.startsWith(incoming)) {
    return { content: live, head, replace: false };
  }
  return { content: incoming, head: Math.min(head, incoming.length), replace: true };
}

/**
 * Decide whether a path change or a disk reload may replace the live editor.
 *
 * - Rename (the path changed and the previous path is gone): same buffer. A
 *   non-empty snapshot the live document already extends must not reload.
 * - Disk reload (same path, new reload version) and tab switch (the previous
 *   path is still open): replace unless the text is already identical.
 */
export function resolveEditorReload(input: {
  pathChanged: boolean;
  previousStillOpen: boolean;
  live: string;
  liveHead: number;
  incoming: string;
}): { content: string; head: number; replace: boolean } {
  if (input.pathChanged && !input.previousStillOpen) {
    return renameSnapshotToApply(input.live, input.liveHead, input.incoming);
  }
  const head = Math.max(input.liveHead, 0);
  if (input.incoming === input.live) return { content: input.live, head, replace: false };
  return {
    content: input.incoming,
    head: Math.min(head, input.incoming.length),
    replace: true,
  };
}

/**
 * What the editor does when its path or reload version changes.
 *
 * - `adopt`: same buffer — a rename (the live text may extend the moved
 *   snapshot), or a reload whose text is already identical. Keep the live
 *   text, caret and undo history.
 * - `load`: show `incoming`. `newDocument` is a different document taking over
 *   this view (tab navigation), even when its text equals the live text, so
 *   undo history resets, the caret and scroll are restored, and work started
 *   for the old document is invalidated. `replace` is false only when the text
 *   is already identical, so nothing needs rewriting.
 */
export type EditorSwapPlan =
  | { kind: "adopt" }
  | {
      kind: "load";
      replace: boolean;
      newDocument: boolean;
      resetHistory: boolean;
      cursorPos: number;
    };

export function planEditorSwap(input: {
  pathChanged: boolean;
  previousStillOpen: boolean;
  live: string;
  liveHead: number;
  incoming: string;
  incomingCursorPos: number;
}): EditorSwapPlan {
  const decision = resolveEditorReload(input);
  const newDocument = input.pathChanged && input.previousStillOpen;
  if (!decision.replace && !newDocument) return { kind: "adopt" };
  const cursorPos = input.pathChanged
    ? Math.min(input.incomingCursorPos, input.incoming.length)
    : Math.min(input.liveHead, input.incoming.length);
  return {
    kind: "load",
    replace: decision.replace,
    newDocument,
    resetHistory: input.pathChanged,
    cursorPos,
  };
}

/** Caret-only load for a swap whose text is already identical. */
export function swapSelectionChange(
  head: number,
  docLength: number,
  pathChange?: FilePathChange,
): TransactionSpec {
  return {
    selection: EditorSelection.cursor(Math.min(Math.max(head, 0), docLength)),
    annotations: reloadAnnotations(pathChange),
    userEvent: "writer.swap",
    scrollIntoView: false,
  };
}

/** Full-document replace used when a tab swaps or the watcher reloads from disk. */
export function reloadEditorChange(
  docLength: number,
  head: number,
  content: string,
  userEvent: "writer.reload" | "writer.swap",
  pathChange?: FilePathChange,
): TransactionSpec {
  return {
    changes: { from: 0, to: docLength, insert: content },
    selection: EditorSelection.cursor(Math.min(Math.max(head, 0), content.length)),
    annotations: reloadAnnotations(pathChange),
    userEvent,
    scrollIntoView: false,
  };
}
