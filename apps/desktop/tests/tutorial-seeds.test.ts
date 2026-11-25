import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { describe, expect, test } from "vite-plus/test";
import {
  isOwnCommentNote,
  measuredNoteHeight,
  noteShowsLocus,
  preferenceRecordArgs,
  stackGutterTops,
} from "../src/features/redline-spike";
import { redlineFilePathFacet, redlineNotesField } from "../src/features/redline-spike/notes";
import { tutorialMarginSeeds } from "../src/features/redline-spike/tutorial-seeds";
import { noteFrom } from "../src/features/document-share/copy";
import { noteShowsCompose, redlineGutterBody } from "../src/features/redline-spike/gutter";
import { noteState } from "../src/features/redline-spike/model";

const BODY = readFileSync(new URL("../src-tauri/src/tutorial.md", import.meta.url), "utf8");
const PATH = "/notes/Tutorial.md";

const FORMAT = "Try it out yourself: formatted text.";
const ASK = "You can be sure that Alkuin always chooses the best model for the given task!\n";
const INVITE =
  "Once they have accepted the invitation, `@` them in a margin note when you need their input. They can **Send changes**; you Accept or Reject the same way you do Alkuin’s.";
const FORMAT_NOTE = "try formatting this text in any way you like!";
const GRAPH_ASK = "add a graph to highlight this workflow";
const INVITE_NOTE =
  "@Alex — does this invite path feel clear? Dismiss this note if you don’t need it.";

describe("tutorial margin seeds", () => {
  test("format, the workflow graph, and the invite note sit on this body", () => {
    const notes = tutorialMarginSeeds(PATH, BODY);
    expect(notes.map((note) => note.id)).toEqual([
      "tutorial-note-format",
      "tutorial-insert-graph",
      "tutorial-note-invite",
    ]);
    const format = notes[0]!;
    const graph = notes[1]!;
    const invite = notes[2]!;

    expect(BODY.slice(format.from, format.to)).toBe(FORMAT);
    expect(format).toMatchObject({
      proposed: FORMAT_NOTE,
      intent: "none",
      instruction: null,
      status: "pending",
    });
    expect(format.person).toBeUndefined();
    expect(isOwnCommentNote(format)).toBe(true);
    expect(noteShowsLocus(format)).toBe(false);
    expect(redlineGutterBody(format)).toBe(FORMAT_NOTE);
    expect(preferenceRecordArgs(format, false)).toBeNull();

    expect(BODY.slice(graph.from, graph.to)).toBe(ASK);
    expect(graph).toMatchObject({
      instruction: GRAPH_ASK,
      intent: "insert",
      status: "pending",
    });
    expect(graph.person).toBeUndefined();
    expect(noteShowsLocus(graph)).toBe(true);
    expect(isOwnCommentNote(graph)).toBe(false);
    expect(redlineGutterBody(graph)).toBe(GRAPH_ASK);
    expect(preferenceRecordArgs(graph, true)).toEqual({
      accepted: true,
      intent: "insert",
      instruction: GRAPH_ASK,
    });
    const fence = graph.proposed!.replace(/^```\n|\n```$/g, "");
    const lines = fence.split("\n");
    expect(new Set(lines.map((line) => line.length))).toEqual(new Set([52]));
    expect(lines[0]).toBe("+------------------- [ ALKUIN ] -------------------+");
    expect(fence).toContain("highlight text");
    expect(fence).toContain("click \u201cAsk Alkuin\u201d");
    expect(BODY).not.toContain("North grew faster than South last quarter.");
    expect(BODY).not.toContain("[ ALKUIN ]");

    expect(BODY.slice(invite.from, invite.to)).toBe(INVITE);
    expect(invite).toMatchObject({
      proposed: INVITE_NOTE,
      intent: "none",
      // Shaped like a note someone sent: the text is the instruction too.
      instruction: INVITE_NOTE,
      status: "pending",
      person: "Alkuin",
      mentions: [{ id: "tutorial-alex", name: "Alex" }],
    });
    expect(noteFrom(invite.person!)).toBe("Note from Alkuin");
    // A card to read and Dismiss, not a draft with an empty composer under it.
    expect(noteState(invite).kind).toBe("comment");
    expect(noteShowsCompose(invite)).toBe(false);
    expect(isOwnCommentNote(invite)).toBe(false);
    expect(redlineGutterBody(invite)).toBe(INVITE_NOTE);
    expect(format.from).toBeLessThan(graph.from);
    expect(graph.from).toBeLessThan(invite.from);
  });

  test("another file, or a sentence that was edited, is left alone", () => {
    expect(tutorialMarginSeeds("/notes/Essay.md", BODY)).toEqual([]);
    const edited = BODY.replace(FORMAT, "Write wherever you like.");
    const notes = tutorialMarginSeeds(PATH, edited);
    expect(notes.map((note) => note.id)).toEqual(["tutorial-insert-graph", "tutorial-note-invite"]);
  });

  test("opening Tutorial.md seeds the margin, and a swap clears it", () => {
    let path = PATH;
    const state = EditorState.create({
      doc: BODY,
      extensions: [redlineFilePathFacet.of(() => path), redlineNotesField],
    });
    expect(state.field(redlineNotesField).map((note) => note.id)).toEqual([
      "tutorial-note-format",
      "tutorial-insert-graph",
      "tutorial-note-invite",
    ]);

    path = "/notes/Essay.md";
    const swapped = state.update({
      changes: { from: 0, to: BODY.length, insert: BODY },
      userEvent: "writer.swap",
    }).state;
    expect(swapped.field(redlineNotesField)).toEqual([]);

    path = PATH;
    const back = swapped.update({
      changes: { from: 0, to: swapped.doc.length, insert: BODY },
      userEvent: "writer.swap",
    }).state;
    expect(back.field(redlineNotesField)).toHaveLength(3);
  });

  test("an older locked body does not get this margin", () => {
    const v6 = readFileSync(new URL("../src-tauri/src/tutorial-v6.md", import.meta.url), "utf8");
    expect(v6).not.toBe(BODY);
    expect(tutorialMarginSeeds(PATH, v6)).toEqual([]);
  });

  test("a short suggestion does not reserve 140px and push the chart note off its line", () => {
    expect(measuredNoteHeight(0)).toBe(140);
    expect(measuredNoteHeight(72)).toBe(72);
    const line = 28;
    const suggestionTop = 480;
    const chartPreferred = suggestionTop + line * 2;
    const tops = stackGutterTops([suggestionTop, chartPreferred], [measuredNoteHeight(72), 64], 36);
    const pushed = tops[1]! - chartPreferred;
    expect(pushed).toBeLessThan(80);
    const floored = stackGutterTops([suggestionTop, chartPreferred], [140, 64], 36);
    expect(floored[1]! - chartPreferred).toBeGreaterThan(pushed);
  });
});
