import { Prec, type Text } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import "./type-altitude.css";

/** Document H1 follows the editor face. Paper Mono has no italic cut.
 *  Size is the mock ratio: 17/11 of the 14px body, from `--writer-title-size`. */
export const TITLE_FAMILY = "var(--writer-editor-font-family, var(--editor-font))";
export const TITLE_SIZE = "var(--writer-title-size)";
/** H2 and H3 keep the mock's 13/11 ratio against the same body. */
export const SECTION_SIZE = "var(--writer-section-size)";
export const TITLE_WEIGHT = "700";
/** Lighter than ink 3. The mock's `#` is this ash, not the body ink. */
export const HASH_INK = "#A8A39A";
export const TITLE_TRACKING = "0";
export const TITLE_INK = "#141312";

/** Locked empty-pane line. No product name. */
export const PROMISE_TEXT = "Write in the center. Help in the margin.";
export const PROMISE_SIZE = "15.5px";
export const PROMISE_INK = "#a8a194";

export const heading1Altitude = {
  tag: tags.heading1,
  fontFamily: TITLE_FAMILY,
  fontSize: TITLE_SIZE,
  fontWeight: TITLE_WEIGHT,
  letterSpacing: TITLE_TRACKING,
};

export const titleAltitudeHighlight = Prec.highest(
  syntaxHighlighting(HighlightStyle.define([heading1Altitude])),
);

/** Blank page: empty buffer, or the new-file `# ` title stub with no title yet. */
export function isBlankDraft(doc: string): boolean {
  const trimmed = doc.trim();
  return trimmed.length === 0 || trimmed === "#";
}

/** Same answer as `isBlankDraft(doc.toString())`, but stops at the second non-blank character
 *  so a long document is never copied. */
export function isBlankDraftDoc(doc: Text): boolean {
  let marks = 0;
  for (const line of doc.iterLines()) {
    for (const ch of line) {
      if (ch.trim() === "") continue;
      if (ch !== "#" || ++marks > 1) return false;
    }
  }
  return true;
}

export const blankDraftPromise = ViewPlugin.fromClass(
  class {
    readonly el: HTMLParagraphElement;

    constructor(readonly view: EditorView) {
      this.el = document.createElement("p");
      this.el.className = "cm-blank-promise";
      this.el.textContent = PROMISE_TEXT;
      (view.dom.closest("[data-pane]") ?? view.dom).append(this.el);
      this.sync();
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.sync();
    }

    sync() {
      this.el.toggleAttribute("hidden", !isBlankDraftDoc(this.view.state.doc));
    }

    destroy() {
      this.el.remove();
    }
  },
);
