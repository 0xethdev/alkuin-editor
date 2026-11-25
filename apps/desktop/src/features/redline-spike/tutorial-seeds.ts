import { getFileName } from "@/lib/paths";
import type { RedlineNote } from "./model";

const TUTORIAL_FILE = "Tutorial.md";
const AUTHOR = "Alkuin";

/** Local chip only. The tutorial has no collaborator, so the handle is Alex. */
const ALEX = { id: "tutorial-alex", name: "Alex" };

/** Official timeline width. Same frame a figure ask Accepts. */
const FENCE_WIDTH = 52;

function fenceLine(inner: string): string {
  return `|${inner.padEnd(FENCE_WIDTH - 2)}|`;
}

function timelineStep(mark: string, text: string): string {
  return fenceLine(` ${mark}  ${text}`);
}

/** The insert preview. Not a sentence in the locked body. */
const WORKFLOW_GRAPH = [
  "+------------------- [ ALKUIN ] -------------------+",
  fenceLine(""),
  timelineStep("\u25cf", "highlight text"),
  fenceLine(" \u2502"),
  timelineStep("\u25cf", "click \u201cNote\u201d and add a margin note"),
  fenceLine(" \u2502"),
  timelineStep("\u25cf", "click \u201cAsk Alkuin\u201d"),
  fenceLine(" \u2502"),
  timelineStep("\u25cb", "review suggestions and accept or reject"),
  fenceLine(""),
  `+${"-".repeat(FENCE_WIDTH - 2)}+`,
].join("\n");

const INVITE_NOTE =
  "@Alex — does this invite path feel clear? Dismiss this note if you don’t need it.";

const WORKFLOW_INSERT = `\`\`\`\n${WORKFLOW_GRAPH}\n\`\`\``;

/**
 * Margin items on sentences that are in the locked body.
 * The format card is an own note (Edit, Delete, Reply, Done).
 * The graph card is an Ask insert: the gutter shows the ask, Accept writes the fence.
 * `@Alex` is the body tag, not a share row.
 * The invite card is shaped like a note someone sent (document-share/place.ts):
 * pending, with the text as its instruction too, so it reads "Note from Alkuin"
 * and offers Dismiss. `open` is a draft: it drew an empty composer under the
 * text, with no Dismiss for a note that says to dismiss it.
 */
const SEEDS: readonly {
  id: string;
  anchor: string;
  proposed: string;
  instruction?: string;
  intent: "none" | "insert";
  status: "open" | "pending";
  person: boolean;
  mentions?: readonly { id: string; name: string }[];
}[] = [
  {
    id: "tutorial-note-format",
    anchor: "Try it out yourself: formatted text.",
    proposed: "try formatting this text in any way you like!",
    intent: "none",
    status: "pending",
    person: false,
  },
  {
    id: "tutorial-insert-graph",
    anchor: "You can be sure that Alkuin always chooses the best model for the given task!\n",
    proposed: WORKFLOW_INSERT,
    instruction: "add a graph to highlight this workflow",
    intent: "insert",
    status: "pending",
    person: false,
  },
  {
    id: "tutorial-note-invite",
    anchor:
      "Once they have accepted the invitation, `@` them in a margin note when you need their input. They can **Send changes**; you Accept or Reject the same way you do Alkuin\u2019s.",
    proposed: INVITE_NOTE,
    instruction: INVITE_NOTE,
    intent: "none",
    status: "pending",
    person: true,
    mentions: [ALEX],
  },
];

export function tutorialMarginSeeds(path: string, doc: string): RedlineNote[] {
  if (getFileName(path) !== TUTORIAL_FILE) return [];
  const notes: RedlineNote[] = [];
  for (const seed of SEEDS) {
    const from = doc.indexOf(seed.anchor);
    if (from < 0) continue;
    notes.push({
      id: seed.id,
      from,
      to: from + seed.anchor.length,
      original: seed.anchor,
      proposed: seed.proposed,
      intent: seed.intent,
      instruction: seed.instruction ?? null,
      status: seed.status,
      error: null,
      git: null,
      publish: null,
      ...(seed.person ? { person: AUTHOR } : {}),
      ...(seed.mentions ? { mentions: seed.mentions.map((mention) => ({ ...mention })) } : {}),
    });
  }
  return notes;
}
