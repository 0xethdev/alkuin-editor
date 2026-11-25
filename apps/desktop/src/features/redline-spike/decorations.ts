import { Facet, StateField, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { citePreviewChanges, referenceBearingChanges } from "./cite-apply";
import { isAgentCard, noteState, type RedlineNote } from "./model";
import { redlineInkTickField, redlineNotesField, redlineSeedNotes } from "./notes";

export type RedlineHandlers = {
  accept(view: EditorView, id: string): void;
  reject(view: EditorView, id: string): void;
  ask(view: EditorView, id: string, instruction?: string): void;
  leave(view: EditorView, id: string, instruction?: string): void;
  publish(view: EditorView, id: string): void;
  editAsk(view: EditorView, id: string): void;
};

const noopHandlers: RedlineHandlers = {
  accept() {},
  reject() {},
  ask() {},
  leave() {},
  publish() {},
  editAsk() {},
};

export const redlineHandlersFacet = Facet.define<RedlineHandlers, RedlineHandlers>({
  combine: (values) => values[0] ?? noopHandlers,
});

/** Selection wash lives in `redline-spike.css`: native `::selection` hugs
 *  each wrap fragment. Layer rects stay transparent so CM's full-width
 *  `rightSide` / between-filler does not paint past short rows. */
export const redlineSelectionTheme = EditorView.theme({
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    {
      backgroundColor: "transparent",
    },
});

class RedlineInsertWidget extends WidgetType {
  readonly kind = "insert" as const;

  constructor(readonly text: string) {
    super();
  }

  eq(other: RedlineInsertWidget): boolean {
    return this.text === other.text;
  }

  ignoreEvent(): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    const ins = document.createElement("ins");
    ins.className = this.text.includes("\n")
      ? "cm-redline-ins cm-redline-ins-ref"
      : "cm-redline-ins";
    // The accepted note stores the link. The preview shows the marker.
    ins.textContent = this.text.replace(/\[\\\[(\d+)\\\]\]\(#ref-\d+\)/g, "[$1]");
    return ins;
  }
}

class RedlineInkTickWidget extends WidgetType {
  readonly kind = "tick" as const;

  eq(other: RedlineInkTickWidget): boolean {
    return other.kind === "tick";
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-redline-ink-tick";
    el.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M2.8 8.6 6.2 12.1 13.4 3.6");
    path.setAttribute("fill", "none");
    svg.append(path);
    el.append(svg);
    return el;
  }
}

/** Body-span wash only. Not atomic — overlap annotate still selects through. */
const openMark = Decoration.mark({ class: "cm-redline-open" });
const delMark = Decoration.mark({ class: "cm-redline-del" });

/** A suggestion with text that would be written. Not stale, not decided. */
function liveSuggestion(note: RedlineNote): boolean {
  const state = noteState(note);
  return state.kind === "suggestion" && !state.stale;
}

function spanMarkFor(note: RedlineNote) {
  const state = noteState(note);
  if (state.kind === "accepted") return null;
  if (state.kind === "suggestion") {
    if (state.stale || note.intent === "insert") return null;
    return delMark;
  }
  if (state.kind !== "compose" && note.intent === "insert") return null;
  return openMark;
}

function proposedAfter(note: RedlineNote): boolean {
  return liveSuggestion(note);
}

export function buildRedlineDecorations(
  doc: Text,
  notes: readonly RedlineNote[],
  tickId: string | null = null,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let text: string | null = null;
  for (const note of notes) {
    if (note.from > doc.length || note.to > doc.length) continue;
    const from = Math.max(0, note.from);
    const to = Math.min(note.to, doc.length);
    const citePreview = citePreviewChanges((text ??= doc.toString()), note);
    // Empty array still means "cite merge", including a merge that inserts nothing.
    if (citePreview !== null) {
      for (const change of citePreview) {
        if (!change.insert) continue;
        const at = Math.max(0, Math.min(change.from, doc.length));
        ranges.push(
          Decoration.widget({
            widget: new RedlineInsertWidget(change.insert),
            side: change.insert.includes("\n") ? 2 : 1,
          }).range(at),
        );
      }
      continue;
    }
    // The connector's text is painted as it will be written: as it was sent.
    const grounded =
      !note.caution?.trim() &&
      !isAgentCard(note) &&
      liveSuggestion(note) &&
      note.proposed &&
      (note.intent === "insert" || note.intent === "replace")
        ? referenceBearingChanges(text, from, to, note.proposed, note.intent)
        : null;
    if (grounded) {
      const spanMark = spanMarkFor(note);
      if (spanMark && note.intent !== "insert" && from < to) {
        ranges.push(spanMark.range(from, to));
      }
      for (const change of grounded) {
        if (!change.insert) continue;
        const at = change.from === change.to ? change.from : to;
        ranges.push(
          Decoration.widget({
            widget: new RedlineInsertWidget(change.insert),
            side: change.insert.includes("\n") ? 2 : 1,
          }).range(Math.max(0, Math.min(at, doc.length))),
        );
      }
      continue;
    }
    const spanMark = spanMarkFor(note);
    if (spanMark && from < to) {
      ranges.push(spanMark.range(from, to));
    }
    if (proposedAfter(note) && note.proposed) {
      ranges.push(
        Decoration.widget({
          widget: new RedlineInsertWidget(note.proposed),
          side: 1,
        }).range(to),
      );
    }
  }
  if (tickId) {
    const ticked = notes.find((note) => note.id === tickId);
    if (ticked) {
      const to = Math.min(Math.max(0, ticked.to), doc.length);
      ranges.push(
        Decoration.widget({
          widget: new RedlineInkTickWidget(),
          side: 3,
        }).range(to),
      );
    }
  }
  return Decoration.set(ranges, true);
}

export function decorationCount(set: DecorationSet, docLength: number): number {
  let count = 0;
  set.between(0, docLength, () => {
    count += 1;
  });
  return count;
}

export const redlineDecorationsField = StateField.define<DecorationSet>({
  create(state) {
    const notes = state.field(redlineNotesField, false) ?? state.facet(redlineSeedNotes);
    const tickId = state.field(redlineInkTickField, false) ?? null;
    return buildRedlineDecorations(state.doc, notes, tickId);
  },
  update(value, tr) {
    const notes = tr.state.field(redlineNotesField, false) ?? [];
    const prev = tr.startState.field(redlineNotesField, false);
    const tickId = tr.state.field(redlineInkTickField, false) ?? null;
    const prevTick = tr.startState.field(redlineInkTickField, false) ?? null;
    if (!tr.docChanged && notes === prev && tickId === prevTick) return value;
    if (notes.length === 0 && (prev?.length ?? 0) === 0 && tickId === null) return Decoration.none;
    return buildRedlineDecorations(tr.state.doc, notes, tickId);
  },
  provide: (f) => EditorView.decorations.from(f),
});
