import { EditorView, ViewPlugin } from "@codemirror/view";
import type { EditorState, Extension, Transaction } from "@codemirror/state";
import { filePathChange } from "@/components/editor-area/editor-reload";
import {
  acceptNote,
  askAlkuinOnNote,
  editAskOnNote,
  leaveNoteOnNote,
  publishNote,
  rejectNote,
} from "./actions";
import {
  redlineDecorationsField,
  redlineHandlersFacet,
  redlineSelectionTheme,
} from "./decorations";
import { marginNoteVisible, redlineGutter } from "./gutter";
import { redlineFilePathFacet, redlineInkTickField, redlineNotesField } from "./notes";
import { dropParkedNotes, parkNotes } from "./parked-notes";
import "./redline-spike.css";

let activeRedlineView: EditorView | null = null;

export function getActiveRedlineView(): EditorView | null {
  return activeRedlineView;
}

/**
 * Moves one view's notes into and out of `parked-notes.ts` as the file it shows changes.
 * The notes field only reads what is parked. The writes happen here, once per
 * transaction. Apart from the view plugin so it runs without a DOM.
 */
export function noteParker(state: EditorState) {
  // The file these notes belong to. The path getter moves to the next file before the
  // swap is dispatched, so this keeps its own answer.
  let path = state.facet(redlineFilePathFacet)();
  // The notes field took what was waiting for this file. This view holds them now.
  dropParkedNotes(path);
  return {
    follow(transactions: readonly Transaction[]) {
      for (const tr of transactions) {
        const change = tr.annotation(filePathChange);
        if (!change) continue;
        const leaving = change.from ?? path;
        if (change.kind === "swap" && leaving !== change.to) {
          parkNotes(leaving, tr.startState.doc, tr.startState.field(redlineNotesField));
          dropParkedNotes(change.to);
        }
        path = change.to;
      }
    },
    /** The view goes when its tab closes, and while the next file is still loading. */
    leave(last: EditorState) {
      parkNotes(path, last.doc, last.field(redlineNotesField));
    },
  };
}

const activeViewPlugin = ViewPlugin.define((view) => {
  activeRedlineView = view;
  view.dom.dataset.redlineNotes = String(
    view.state.field(redlineNotesField).filter(marginNoteVisible).length,
  );
  const parker = noteParker(view.state);
  return {
    update(update) {
      parker.follow(update.transactions);
      update.view.dom.dataset.redlineNotes = String(
        update.state.field(redlineNotesField).filter(marginNoteVisible).length,
      );
    },
    destroy() {
      parker.leave(view.state);
      if (activeRedlineView === view) activeRedlineView = null;
    },
  };
});

const focusTracker = EditorView.domEventHandlers({
  focusin(_event, view) {
    activeRedlineView = view;
  },
});

const handlers = redlineHandlersFacet.of({
  accept: (view, id) => {
    void acceptNote(view, id);
  },
  reject: (view, id) => {
    rejectNote(view, id);
  },
  ask: (view, id, instruction) => {
    askAlkuinOnNote(view, id, instruction);
  },
  leave: (view, id, instruction) => {
    leaveNoteOnNote(view, id, instruction);
  },
  publish: (view, id) => {
    void publishNote(view, id);
  },
  editAsk: (view, id) => {
    editAskOnNote(view, id);
  },
});

export function redlineSpikeExtension(getFilePath: () => string): Extension {
  return [
    redlineFilePathFacet.of(getFilePath),
    redlineNotesField,
    redlineInkTickField,
    redlineDecorationsField,
    redlineGutter,
    redlineSelectionTheme,
    handlers,
    activeViewPlugin,
    focusTracker,
  ];
}
