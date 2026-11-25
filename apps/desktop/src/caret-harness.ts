import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditorExtensions } from "./components/editor-area/editor-extensions";
import { caretDiagPendingText, setCaretDiagLocal } from "./lib/caret-diag-log";
import "./App.css";
import "./components/editor-area/prosemark-theme.css";

const parent = document.getElementById("root");
if (!parent) throw new Error("missing #root");

const historyCompartment = new Compartment();
const view = new EditorView({
  parent,
  state: EditorState.create({
    doc: "",
    extensions: createEditorExtensions(
      () => "/tmp/caret-note.md",
      () => false,
      historyCompartment,
    ),
  }),
});

view.focus();

declare global {
  interface Window {
    __writerView: EditorView;
    __caretDiag: {
      setEnabled(on: boolean): void;
      text(): string;
    };
  }
}

window.__writerView = view;
window.__caretDiag = {
  setEnabled: setCaretDiagLocal,
  text: caretDiagPendingText,
};
