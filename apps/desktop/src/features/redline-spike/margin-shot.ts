import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  prosemarkBaseThemeSetup,
  prosemarkBasicSetup,
  prosemarkMarkdownSyntaxExtensions,
} from "@/lib/prosemark-core/main";
import { headingDecorations } from "@/components/editor-area/heading-decorations";
import "@/components/editor-area/type-altitude.css";
import "@/App.css";
import "@/components/editor-area/prosemark-theme.css";
import { redlineDecorationsField, redlineSelectionTheme } from "./decorations";
import { redlineGutter } from "./gutter";
import type { RedlineNote } from "./model";
import { redlineInkTickField, redlineNotesField, redlineSeedNotes } from "./notes";

const DOC = `# Harbor

The channel is narrow at dusk, and the last boat still has its lamp on.

The quay is empty except for the fish crates and a coil of rope. A gull sits on the lamp post and does not move when the door opens.

North grew faster than South last quarter. The difference is the whole argument, and it should be easy to see without a table.

The numbers are in the folder. Last year South led in March and April, then North pulled ahead and stayed there through the autumn.

This sentence runs long and says the same thing twice, so the reader loses the point before the harbour comes back into view.

Read it aloud once. If a line makes you breathe in the middle, it is two lines.

A short note belongs on the closing line, where the decision actually sits.
`;

const SPANS = [
  "The channel is narrow at dusk",
  "North grew faster than South last quarter. The difference is the whole argument, and it should be easy to see without a table.",
  "This sentence runs long and says the same thing twice",
  "where the decision actually sits",
] as const;

function note(span: string, overrides: Partial<RedlineNote>): RedlineNote {
  const from = DOC.indexOf(span);
  if (from < 0) throw new Error(`missing span: ${span}`);
  return {
    id: "shot",
    from,
    to: from + span.length,
    original: span,
    proposed: null,
    intent: null,
    instruction: null,
    status: "pending",
    error: null,
    git: null,
    publish: null,
    ...overrides,
  };
}

const NOTES: RedlineNote[] = [
  note(SPANS[0], {
    id: "tide",
    intent: "none",
    proposed: "Check the tide table before this goes out.",
  }),
  note(SPANS[1], {
    id: "north",
    intent: "replace",
    proposed: "North grew faster than South last quarter.",
    instruction: "The comparison is the argument. The second sentence can go.",
  }),
  note(SPANS[2], {
    id: "long",
    intent: "none",
    proposed: "Say it once.",
  }),
  note(SPANS[3], {
    id: "close",
    intent: "none",
    proposed: "Print the tide.",
  }),
];

const SHELL = `
  html, body { height: 100%; margin: 0; overflow: hidden; background: #f3eee4; }
  #margin-frame { height: 100%; }
  .shell { display: flex; height: 100%; min-width: 0; }
  .files {
    width: 240px; flex: none; box-sizing: border-box;
    padding: 56px 12px 16px;
    border-right: 1px solid rgba(20, 19, 18, 0.08);
    color: #55524d;
    font: 13px/1.3 var(--ui-font, "Paper Mono", ui-monospace, monospace);
  }
  .files-label {
    margin: 0 0 8px 12px;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #6f6a62;
  }
  .file { padding: 6px 12px; border-radius: 8px; }
  .file.active { background: rgba(20, 19, 18, 0.06); color: #141312; }
  .pane { position: relative; flex: 1; min-width: 0; background: #f7f3ec; }
  .scroll { height: 100%; overflow-y: auto; scrollbar-gutter: stable both-edges; }
  #host { min-height: 100%; }
`;

type Anchor = { id: string; dy: number | null };

function anchorDeltas(view: EditorView): Anchor[] {
  const gutter = view.dom.querySelector(".cm-redline-gutter");
  return NOTES.map((note) => {
    const stub = gutter?.querySelector<HTMLElement>(`[data-redline-stub="${note.id}"]`);
    const span = view.coordsAtPos(Math.max(note.from, note.to - 1));
    if (!stub || stub.hidden || !span) return { id: note.id, dy: null };
    const box = stub.getBoundingClientRect();
    const mid = (span.top + span.bottom) / 2;
    return { id: note.id, dy: Math.round((box.top + box.height / 2 - mid) * 10) / 10 };
  });
}

function chWidth(el: HTMLElement): number {
  const probe = document.createElement("span");
  probe.textContent = "0";
  probe.style.font = getComputedStyle(el).font;
  probe.style.position = "absolute";
  probe.style.left = "-9999px";
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

function readMeasure(view: EditorView, resized: boolean) {
  const content = view.contentDOM;
  const scroll = view.scrollDOM;
  const gutter = view.dom.querySelector(".cm-redline-gutter");
  const cs = getComputedStyle(content);
  const padL = parseFloat(cs.paddingLeft);
  const padR = parseFloat(cs.paddingRight);
  const contentBox = content.getBoundingClientRect();
  const scrollBox = scroll.getBoundingClientRect();
  const gutterBox = gutter?.getBoundingClientRect();
  const ch = chWidth(scroll);
  const text = contentBox.width - padL - padR;
  const textEnd = contentBox.left + padL + text;
  return {
    resized,
    fontSize: getComputedStyle(scroll).fontSize,
    pane: Math.round(scrollBox.width * 10) / 10,
    padL: Math.round(padL * 10) / 10,
    padR: Math.round(padR * 10) / 10,
    text: Math.round(text * 10) / 10,
    textCh: ch > 0 ? Math.round((text / ch) * 10) / 10 : null,
    capPx: Math.round(ch * 75 * 10) / 10,
    sidebar: gutterBox ? Math.round(gutterBox.width * 10) / 10 : null,
    gap: gutterBox ? Math.round((gutterBox.left - textEnd) * 10) / 10 : null,
    insetRight: gutterBox ? Math.round((scrollBox.right - gutterBox.right) * 10) / 10 : null,
    glyphGap: gutterBox ? Math.round((gutterBox.left - glyphRight(content)) * 10) / 10 : null,
    overflowX: Math.round((scroll.scrollWidth - scroll.clientWidth) * 10) / 10,
    anchors: anchorDeltas(view),
  };
}

function glyphRight(content: HTMLElement): number {
  let right = 0;
  for (const line of content.querySelectorAll(".cm-line")) {
    const range = document.createRange();
    range.selectNodeContents(line);
    for (const rect of range.getClientRects()) right = Math.max(right, rect.right);
  }
  return right;
}

function whenSettled(view: EditorView, done: () => void) {
  let last = "";
  let stable = 0;
  let tries = 0;
  const tick = () => {
    tries += 1;
    view.requestMeasure();
    const now = JSON.stringify(anchorDeltas(view));
    const ready =
      !now.includes("null") &&
      !(JSON.parse(now) as Anchor[]).some((anchor) => anchor.dy == null || Math.abs(anchor.dy) > 2);
    if (ready && now === last) stable += 1;
    else stable = 0;
    last = now;
    if ((ready && stable >= 2) || tries > 40) {
      done();
      return;
    }
    window.setTimeout(tick, 50);
  };
  tick();
}

export function renderMarginShot(params: URLSearchParams) {
  const resize = params.get("resize") === "1";
  const root = document.documentElement;
  root.dataset.theme = "light";
  root.style.setProperty("--page-bg", "#F7F3EC");

  const style = document.createElement("style");
  style.textContent = SHELL;
  document.head.append(style);

  const frame = document.createElement("div");
  frame.id = "margin-frame";
  if (resize) frame.style.width = "1100px";
  frame.innerHTML = `
    <div class="shell">
      <aside class="files">
        <div class="files-label">Documents</div>
        <div class="file active">Harbor.md</div>
        <div class="file">North and South.md</div>
        <div class="file">Launch plan.md</div>
        <div class="file">Notes.md</div>
      </aside>
      <div class="pane" data-pane>
        <div class="scroll"><div id="host"></div></div>
      </div>
    </div>`;
  document.body.append(frame);
  const host = frame.querySelector("#host");
  if (!(host instanceof HTMLElement)) throw new Error("missing host");

  const extra: Extension[] = [
    markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
    prosemarkBasicSetup(),
    prosemarkBaseThemeSetup(),
    headingDecorations,
  ];
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: DOC,
      extensions: [
        EditorView.editable.of(false),
        redlineSeedNotes.of(NOTES),
        redlineNotesField,
        redlineInkTickField,
        redlineDecorationsField,
        redlineSelectionTheme,
        redlineGutter,
        ...extra,
      ],
    }),
  });

  const publish = () => {
    document.body.dataset.measure = JSON.stringify(readMeasure(view, resize));
    document.body.dataset.shotReady = "1";
  };

  const start = () => {
    whenSettled(view, () => {
      if (!resize) {
        publish();
        return;
      }
      document.body.dataset.measureBefore = JSON.stringify(anchorDeltas(view));
      frame.style.width = "100%";
      whenSettled(view, publish);
    });
  };

  requestAnimationFrame(start);
}
