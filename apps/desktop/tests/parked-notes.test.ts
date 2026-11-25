import { readFileSync } from "node:fs";
import { history } from "@codemirror/commands";
import { Compartment, EditorState, type TransactionSpec } from "@codemirror/state";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import {
  filePathChange,
  pathChangeKind,
  planEditorSwap,
  reloadEditorChange,
  swapSelectionChange,
} from "../src/components/editor-area/editor-reload";
import { noteParker } from "../src/features/redline-spike/extension";
import type { RedlineNote } from "../src/features/redline-spike/model";
import {
  addRedlineNote,
  redlineFilePathFacet,
  redlineNotesField,
  removeRedlineNote,
} from "../src/features/redline-spike/notes";
import {
  moveParkedNotes,
  parkNotes,
  parkedNotes,
  relocateNotes,
  resetParkedNotesForTest,
  restorable,
} from "../src/features/redline-spike/parked-notes";

const A_PATH = "/notes/A.md";
const B_PATH = "/notes/B.md";
const A_TEXT = "Alpha opens here.\n\nThe passage to keep.\n\nAlpha closes here.\n";
const B_TEXT = "Beta is another file.\n\nBeta has a passage too.\n";
const KEPT = "The passage to keep.";

function noteOn(doc: string, passage: string, overrides: Partial<RedlineNote> = {}): RedlineNote {
  const from = overrides.from ?? doc.indexOf(passage);
  return {
    id: `redline-${passage}`,
    from,
    to: from + passage.length,
    original: passage,
    proposed: null,
    intent: null,
    instruction: null,
    status: "open",
    error: null,
    git: null,
    publish: null,
    ...overrides,
  };
}

/** An answered Ask: the suggestion a writer would lose by clicking another file. */
function suggestionOn(doc: string, passage: string): RedlineNote {
  return noteOn(doc, passage, {
    status: "pending",
    proposed: "A tighter passage.",
    intent: "replace",
    instruction: "improve",
  });
}

/**
 * One editor view, without a DOM. It dispatches what `use-prosemark-editor.ts` dispatches,
 * in the same order, and runs the same parker the view plugin runs.
 */
function openView(path: string, text: string) {
  let current = path;
  const historyCompartment = new Compartment();
  let state = EditorState.create({
    doc: text,
    extensions: [
      redlineFilePathFacet.of(() => current),
      redlineNotesField,
      historyCompartment.of(history()),
    ],
  });
  const parker = noteParker(state);
  const dispatch = (spec: TransactionSpec) => {
    const tr = state.update(spec);
    state = tr.state;
    parker.follow([tr]);
  };
  /**
   * The path effect of `use-prosemark-editor.ts`: the same plan and the same kind, then
   * the same dispatches in the same order.
   */
  const moveTo = (next: string, incoming: string, previousStillOpen: boolean) => {
    const previous = current;
    // The path ref is assigned during render, before the effect dispatches anything.
    current = next;
    const live = state.doc.toString();
    const plan = planEditorSwap({
      pathChanged: true,
      previousStillOpen,
      live,
      liveHead: 0,
      incoming,
      incomingCursorPos: 0,
    });
    const change = {
      from: previous,
      to: next,
      kind: pathChangeKind({
        previousStillOpen,
        replace: plan.kind === "load" && plan.replace,
        live,
        incoming,
      }),
    };
    if (plan.kind === "adopt") {
      dispatch({ annotations: filePathChange.of(change) });
      return;
    }
    if (plan.resetHistory) {
      dispatch({ effects: historyCompartment.reconfigure([]) });
      dispatch({ effects: historyCompartment.reconfigure(history()) });
    }
    dispatch(
      plan.replace
        ? reloadEditorChange(state.doc.length, plan.cursorPos, incoming, "writer.swap", change)
        : swapSelectionChange(plan.cursorPos, state.doc.length, change),
    );
  };
  return {
    notes: () => state.field(redlineNotesField),
    text: () => state.doc.toString(),
    dispatch,
    add: (note: RedlineNote) => dispatch({ effects: addRedlineNote.of(note) }),
    /** The tab now shows another file that is already loaded. */
    swapTo(next: string, nextText: string) {
      moveTo(next, nextText, true);
    },
    /** This same buffer was renamed. `storeText` is the store's copy when it differs. */
    renameTo(next: string, storeText = state.doc.toString()) {
      moveTo(next, storeText, false);
    },
    /** The file shown was closed, and the tab shows the next one. */
    closeAndShow(next: string, nextText: string) {
      moveTo(next, nextText, false);
    },
    /** The same file, with new text from disk. */
    reload(nextText: string) {
      dispatch(reloadEditorChange(state.doc.length, 0, nextText, "writer.reload"));
    },
    /** The pane shows a spinner while the next file loads, or the tab closes. */
    destroy() {
      parker.leave(state);
    },
  };
}

beforeEach(() => {
  resetParkedNotesForTest();
});

describe("margin notes stay with their file", () => {
  test("a suggestion is still there after another file was opened in the same tab", () => {
    const view = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    view.add(suggestion);

    view.swapTo(B_PATH, B_TEXT);
    expect(view.text()).toBe(B_TEXT);
    expect(view.notes()).toEqual([]);

    const onBeta = noteOn(B_TEXT, "Beta has a passage too.");
    view.add(onBeta);
    view.swapTo(A_PATH, A_TEXT);
    expect(view.notes()).toEqual([suggestion]);

    view.swapTo(B_PATH, B_TEXT);
    expect(view.notes()).toEqual([onBeta]);
  });

  test("the notes wait when the view is torn down while the next file loads", () => {
    const first = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    first.add(suggestion);
    first.destroy();

    const loading = openView(B_PATH, B_TEXT);
    expect(loading.notes()).toEqual([]);
    loading.destroy();

    const back = openView(A_PATH, A_TEXT);
    expect(back.notes()).toEqual([suggestion]);
    // The view holds them now. A second view on the same file does not get a stale copy.
    expect(parkedNotes(A_PATH, A_TEXT)).toEqual([]);
  });

  test("a note dismissed after coming back does not return", () => {
    const view = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    view.add(suggestion);
    view.swapTo(B_PATH, B_TEXT);
    view.swapTo(A_PATH, A_TEXT);
    view.dispatch({ effects: removeRedlineNote.of(suggestion.id) });

    view.swapTo(B_PATH, B_TEXT);
    view.swapTo(A_PATH, A_TEXT);
    expect(view.notes()).toEqual([]);
  });

  test("two open files with the same words do not share notes", () => {
    const same = "Same words in both.\n";
    const view = openView(A_PATH, same);
    const onAlpha = noteOn(same, "Same words in both.");
    view.add(onAlpha);

    view.swapTo(B_PATH, same);
    expect(view.text()).toBe(same);
    expect(view.notes()).toEqual([]);

    view.swapTo(A_PATH, same);
    expect(view.notes()).toEqual([onAlpha]);
  });

  test("a rename keeps the notes, and they wait under the new name", () => {
    const view = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    view.add(suggestion);

    view.renameTo("/notes/Renamed.md");
    expect(view.notes()).toEqual([suggestion]);

    view.swapTo(B_PATH, B_TEXT);
    expect(parkedNotes(A_PATH, A_TEXT)).toEqual([]);
    expect(parkedNotes("/notes/Renamed.md", A_TEXT)).toEqual([suggestion]);

    view.swapTo("/notes/Renamed.md", A_TEXT);
    expect(view.notes()).toEqual([suggestion]);
  });

  test("a rename that also hands the editor the store's line endings keeps the notes", () => {
    const view = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    view.add(suggestion);

    // A file with Windows line endings, not edited since it was opened.
    view.renameTo("/notes/Renamed.md", A_TEXT.replace(/\n/g, "\r\n"));

    expect(view.text()).toBe(A_TEXT);
    expect(view.notes()).toEqual([suggestion]);
    expect(parkedNotes(A_PATH, A_TEXT)).toEqual([]);
  });

  test("closing the file and landing on another one is not a rename", () => {
    const view = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    view.add(suggestion);

    view.closeAndShow(B_PATH, B_TEXT);

    expect(view.notes()).toEqual([]);
    expect(parkedNotes(A_PATH, A_TEXT)).toEqual([suggestion]);
  });

  test("a file renamed or moved while another file is shown takes its notes along", () => {
    const view = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    view.add(suggestion);
    view.swapTo(B_PATH, B_TEXT);

    // What the sidebar's rename calls, for a file and then for the folder above it.
    moveParkedNotes(A_PATH, "/notes/Renamed.md");
    moveParkedNotes("/notes", "/archive");
    expect(parkedNotes(A_PATH, A_TEXT)).toEqual([]);

    view.swapTo("/archive/Renamed.md", A_TEXT);
    expect(view.notes()).toEqual([suggestion]);
  });

  test("a folder rename does not move the notes of a file that only starts with its name", () => {
    parkNotes("/notes-old/A.md", A_TEXT, [suggestionOn(A_TEXT, KEPT)]);
    moveParkedNotes("/notes", "/archive");
    expect(parkedNotes("/notes-old/A.md", A_TEXT)).toHaveLength(1);
  });

  test("the file changed on disk while it was in the background", () => {
    const view = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    view.add(suggestion);
    view.swapTo(B_PATH, B_TEXT);

    const longer = `A new opening line.\n\n${A_TEXT}`;
    view.swapTo(A_PATH, longer);
    const [moved] = view.notes();
    expect(view.notes()).toHaveLength(1);
    expect(longer.slice(moved!.from, moved!.to)).toBe(KEPT);
    expect(moved).toEqual({
      ...suggestion,
      from: longer.indexOf(KEPT),
      to: longer.indexOf(KEPT) + KEPT.length,
    });
  });

  test("only the writer's own notes that still mean something are kept", () => {
    const text = "One. Two. Three. Four. Five. Six.\n";
    const view = openView(A_PATH, text);
    const open = noteOn(text, "One.");
    const failed = noteOn(text, "Two.", { status: "error", error: "Alkuin can't connect." });
    const answered = suggestionOn(text, "Three.");
    const accepted = noteOn(text, "Four.", {
      status: "accepted",
      proposed: "4.",
      intent: "replace",
    });
    const theirs = noteOn(text, "Five.", {
      status: "pending",
      proposed: "5.",
      intent: "replace",
      shareChangeId: "change-1",
    });
    const asking = noteOn(text, "Six.", { status: "pending", instruction: "improve" });
    for (const note of [open, failed, answered, accepted, theirs, asking]) view.add(note);
    expect(view.notes()).toHaveLength(6);

    view.swapTo(B_PATH, B_TEXT);
    view.swapTo(A_PATH, text);
    expect(view.notes()).toEqual([open, failed, answered]);
    expect([open, failed, answered, accepted, theirs, asking].map(restorable)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("a reload of the same file", () => {
  test("a note moves with its passage when text is added above it", () => {
    const view = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    view.add(suggestion);

    const longer = A_TEXT.replace("Alpha opens here.", "Alpha opens here, with more words.");
    view.reload(longer);

    expect(view.text()).toBe(longer);
    expect(view.notes()).toEqual([
      { ...suggestion, from: longer.indexOf(KEPT), to: longer.indexOf(KEPT) + KEPT.length },
    ]);
  });

  test("a note on a sentence the writer has since edited stays when text is added elsewhere", () => {
    const view = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    view.add(suggestion);
    // The writer fixes a word inside the noted sentence. The note's `original` is unchanged.
    const word = A_TEXT.indexOf("keep");
    view.dispatch({ changes: { from: word, to: word + 4, insert: "hold" } });
    const edited = view.text();
    expect(view.notes()).toHaveLength(1);

    view.reload(`${edited}A line from the other Mac.\n`);

    expect(view.notes()).toEqual([
      { ...suggestion, from: view.notes()[0]!.from, to: view.notes()[0]!.to },
    ]);
    expect(view.text().slice(view.notes()[0]!.from, view.notes()[0]!.to)).toBe(
      "The passage to hold.",
    );
  });

  test("a note is dropped when its passage was rewritten", () => {
    const view = openView(A_PATH, A_TEXT);
    view.add(suggestionOn(A_TEXT, KEPT));

    view.reload(A_TEXT.replace(KEPT, "The passage, rewritten."));

    expect(view.notes()).toEqual([]);
  });

  test("the same words earlier in the file do not take the note", () => {
    const text = "Keep this. Then other words.\n\nKeep this.\n";
    const second = text.lastIndexOf("Keep this.");
    const view = openView(A_PATH, text);
    // The note is on the second "Keep this.", not the first.
    view.add(
      noteOn(text, "Keep this.", {
        from: second,
        status: "pending",
        proposed: "Kept.",
        intent: "replace",
      }),
    );
    expect(text.slice(view.notes()[0]!.from, view.notes()[0]!.to)).toBe("Keep this.");
    expect(view.notes()[0]?.from).toBe(second);

    view.reload("Keep this. Then other words.\n\nSomething else now.\n");

    expect(view.notes()).toEqual([]);
  });

  test("the other person's cards and accepted notes still leave, as before", () => {
    const text = "One. Two.\n";
    const view = openView(A_PATH, text);
    view.add(noteOn(text, "One.", { status: "accepted", proposed: "1.", intent: "replace" }));
    view.add(
      noteOn(text, "Two.", {
        status: "pending",
        proposed: "2.",
        intent: "replace",
        shareChangeId: "change-2",
      }),
    );

    view.reload("One. Two. Three.\n");

    expect(view.notes()).toEqual([]);
  });

  test("an Ask still in flight stays, because this view is here for its answer", () => {
    const text = "One. Two.\n";
    const view = openView(A_PATH, text);
    const asking = noteOn(text, "Two.", { status: "pending", instruction: "improve" });
    view.add(asking);

    // The other Mac's copy arrives while Alkuin is still writing the suggestion.
    view.reload("Zero. One. Two.\n");

    expect(view.notes()).toEqual([{ ...asking, from: 11, to: 15 }]);
    // Leaving the file is different: no answer can reach a note that is not in a view.
    view.swapTo(B_PATH, B_TEXT);
    view.swapTo(A_PATH, "Zero. One. Two.\n");
    expect(view.notes()).toEqual([]);
  });
});

describe("Tutorial.md", () => {
  const body = readFileSync(new URL("../src-tauri/src/tutorial.md", import.meta.url), "utf8");
  const path = "/notes/Tutorial.md";
  const seedIds = ["tutorial-note-format", "tutorial-insert-graph", "tutorial-note-invite"];

  test("seeds are made from the text again, and a note of the writer's own comes back beside them", () => {
    const view = openView(path, body);
    expect(view.notes().map((note) => note.id)).toEqual(seedIds);
    const passage = body.split("\n").find((line) => line.length > 20 && !line.startsWith("#"))!;
    const own = suggestionOn(body, passage);
    view.add(own);
    view.dispatch({ effects: removeRedlineNote.of("tutorial-note-format") });
    expect(view.notes().map((note) => note.id)).toEqual([
      "tutorial-insert-graph",
      "tutorial-note-invite",
      own.id,
    ]);

    view.swapTo(B_PATH, B_TEXT);
    // Seeds are not parked. They are computed from the Tutorial text each time.
    expect(parkedNotes(path, body)).toEqual([own]);

    view.swapTo(path, body);
    // The dismissed seed is back, as before, and no id appears twice.
    expect(view.notes().map((note) => note.id)).toEqual([...seedIds, own.id]);
  });
});

describe("relocateNotes", () => {
  const caret = (at: number): RedlineNote =>
    noteOn("", "", { id: `caret-${at}`, from: at, to: at, intent: "insert", proposed: " more." });

  test("the same text returns every note as it was", () => {
    const notes = [noteOn(A_TEXT, KEPT), caret(3)];
    expect(relocateNotes(notes, A_TEXT, A_TEXT)).toEqual(notes);
  });

  test("a change at the start moves a later note and drops the one it rewrote", () => {
    const before = "one two three";
    const after = "ONE and two three";
    const kept = noteOn(before, "three");
    expect(relocateNotes([noteOn(before, "one"), kept], before, after)).toEqual([
      { ...kept, from: after.indexOf("three"), to: after.length },
    ]);
  });

  test("a change at the end leaves an earlier note where it was", () => {
    const before = "one two three";
    const kept = noteOn(before, "one");
    expect(relocateNotes([kept, noteOn(before, "three")], before, "one two 3, and four")).toEqual([
      kept,
    ]);
  });

  test("a caret with no words to check is kept outside the rewritten middle only", () => {
    const before = "start MIDDLE end";
    const after = "start other end";
    // 6 is where the rewrite begins and 12 where it ends. 9 is inside it.
    expect(
      relocateNotes([caret(2), caret(6), caret(9), caret(12), caret(15)], before, after),
    ).toEqual([
      caret(2),
      caret(6),
      { ...caret(12), from: 11, to: 11 },
      { ...caret(15), from: 14, to: 14 },
    ]);
  });

  test("an empty text on either side", () => {
    expect(relocateNotes([caret(0)], "", "new words")).toEqual([{ ...caret(0), from: 9, to: 9 }]);
    expect(relocateNotes([noteOn("words", "words"), caret(2)], "words", "")).toEqual([]);
    expect(relocateNotes([], "a", "b")).toEqual([]);
  });

  test("a note outside the text it was made on is dropped, not mapped", () => {
    const stray = noteOn("short", "short", { from: 40, to: 45 });
    expect(relocateNotes([stray], "short", "short text")).toEqual([]);
  });
});

describe("parkNotes", () => {
  test("a file with nothing to keep leaves no entry behind", () => {
    parkNotes(A_PATH, A_TEXT, [{ ...suggestionOn(A_TEXT, KEPT), status: "accepted" }]);
    expect(parkedNotes(A_PATH, A_TEXT)).toEqual([]);
  });

  test("a second view of the file with no notes does not erase the ones waiting", () => {
    const first = openView(A_PATH, A_TEXT);
    const suggestion = suggestionOn(A_TEXT, KEPT);
    first.add(suggestion);
    const second = openView(A_PATH, A_TEXT);
    expect(second.notes()).toEqual([]);

    first.swapTo(B_PATH, B_TEXT);
    second.destroy();

    expect(parkedNotes(A_PATH, A_TEXT)).toEqual([suggestion]);
  });

  test("two views of one file that each park notes keep both", () => {
    const first = openView(A_PATH, A_TEXT);
    const second = openView(A_PATH, A_TEXT);
    const fromFirst = suggestionOn(A_TEXT, KEPT);
    const fromSecond = noteOn(A_TEXT, "Alpha closes here.");
    first.add(fromFirst);
    second.add(fromSecond);

    first.swapTo(B_PATH, B_TEXT);
    second.destroy();

    expect(parkedNotes(A_PATH, A_TEXT)).toEqual([fromSecond, fromFirst]);
  });

  test("the earlier view's notes are placed in the later view's text", () => {
    const earlier = suggestionOn(A_TEXT, KEPT);
    parkNotes(A_PATH, A_TEXT, [earlier]);
    const longer = `A new opening line.\n\n${A_TEXT}`;
    const later = noteOn(longer, "A new opening line.");

    parkNotes(A_PATH, longer, [later]);

    const at = longer.indexOf(KEPT);
    expect(parkedNotes(A_PATH, longer)).toEqual([
      later,
      { ...earlier, from: at, to: at + KEPT.length },
    ]);
  });

  test("the text is read only when a note stays", () => {
    let reads = 0;
    const doc = {
      toString() {
        reads += 1;
        return A_TEXT;
      },
    };
    parkNotes(A_PATH, doc, []);
    parkNotes(A_PATH, doc, [{ ...suggestionOn(A_TEXT, KEPT), shareChangeId: "change-3" }]);
    expect(reads).toBe(0);
    parkNotes(A_PATH, doc, [suggestionOn(A_TEXT, KEPT)]);
    expect(reads).toBe(1);
  });
});
