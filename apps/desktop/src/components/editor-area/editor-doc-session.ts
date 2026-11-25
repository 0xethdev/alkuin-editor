import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// Which document a view is showing. One EditorView is reused across the
// documents of a tab (navigation swaps the text in place), so work that
// finishes later — a rAF scroll, an image paste, a link resolve — must check
// that the view still shows the document it started for. The generation
// bumps when the view starts showing a different document; a rename or a disk
// reload of the same document keeps it. `use-prosemark-editor.ts` owns the
// bump (`startNextDocSession` on the swap transaction).

const nextDocSession = StateEffect.define<null>();

export const docSessionField = StateField.define<number>({
  create: () => 0,
  update: (generation, tr) =>
    tr.effects.some((effect) => effect.is(nextDocSession)) ? generation + 1 : generation,
});

export function startNextDocSession(): StateEffect<null> {
  return nextDocSession.of(null);
}

export function docSessionOf(state: EditorState): number {
  return state.field(docSessionField, false) ?? 0;
}

/** Capture the view's document before an await. The returned check is true
 *  while the view is alive and still shows that document. */
export function captureDocSession(view: EditorView, isDisposed: () => boolean): () => boolean {
  const generation = docSessionOf(view.state);
  return () => !isDisposed() && docSessionOf(view.state) === generation;
}
