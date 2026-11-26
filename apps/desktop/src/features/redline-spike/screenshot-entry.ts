import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  prosemarkBaseThemeSetup,
  prosemarkBasicSetup,
  prosemarkMarkdownSyntaxExtensions,
} from "@/lib/prosemark-core/main";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { redlineDecorationsField, redlineSelectionTheme } from "./decorations";
import { redlineGutter } from "./gutter";
import { TOOL_CAUTION_NOTE, type RedlineNote } from "./model";
import { redlineInkTickField, redlineNotesField, redlineSeedNotes, flashInkTick } from "./notes";
import { tutorialMarginSeeds } from "./tutorial-seeds";
import tutorialBody from "../../../src-tauri/src/tutorial.md?raw";
import { headingDecorations } from "@/components/editor-area/heading-decorations";
import { selectionBubble } from "@/components/editor-area/selection-bubble";
import { blankDraftPromise, titleAltitudeHighlight } from "@/components/editor-area/type-altitude";
import { SignInScreen } from "@/components/sign-in-screen";
import { ACCOUNT_EXISTS_LINE, CODE_ENTRY_ERROR, NO_ACCOUNT_LINE } from "@/lib/account-copy";
import { agentCard } from "@/features/agent-proposal/cards";
import { openTagDot } from "@/features/note-mention/desk";
import "@/fonts/paper-mono.css";
import "./redline-spike.css";

const ORIGINAL = "really very important";
const REPLACE_PROPOSED = "This is important for our launch plan.";
const INSERT_PROPOSED = "also: ship date is Tuesday";
const A1_DOC = `Most notes on supplements stay vague. The better habit is to keep claims tight and local to the evidence you actually have.

The creatine works good for training.

You're still reading. The note lives in the margin — not a modal, not a toast.
`;
const A1_SPAN = "The creatine works good for training.";
const SUGGEST_DOC = `# writing is thinking

At Alkuin we deeply believe that to write is to think. Not only because the finished text is a product of your thinking, but because the act of putting words on paper is itself thinking. And good writing is good thinking. The way you iterate over your text, make changes, and choose the words that best match what you mean is what separates a good text from a bad one. In the end, your style shows the reasoning behind what you wrote.

If that is true, then handing your writing over to someone else means handing over your thinking too. This holds for human collaborators, and even more so for AI writing tools. Today's chatbots are black boxes: you put a message in and get a wall of text out that may sound plausible. But does it really reflect what you think about the topic? Or are you simply regurgitating whatever the most likely average response would be?

At Alkuin, we built an editor that lets you keep putting your thoughts on paper while AI stands by to help. Your writing stays front and center, with AI suggestions in the margin. Any change to your text remains a suggestion until you accept or reject it. Nobody can change your written thoughts except you.

Alkuin is named after Alcuin of York, whom Charlemagne tasked around the year 800 with correcting the Latin Bible. Centuries of hand copying had filled the text with errors. Alcuin corrected them, but he didn't write a new Bible. That is what we want Alkuin to be: it points at what could be better, and the writing stays yours.
`;
const SUGGEST_SPAN =
  "Not only because the finished text is a product of your thinking, but because the act of putting words on paper is itself thinking.";
const SUGGEST_PROPOSED = "The finished text is your thinking, and so is putting words on paper.";

function tokens() {
  const root = document.documentElement.style;
  root.setProperty("--accent", "#c48a4a");
  root.setProperty("--text-primary", "#2a2824");
  root.setProperty("--text-secondary", "#2e2c28");
  root.setProperty("--text-muted", "#6a645a");
  root.setProperty("--line-subtle", "rgba(60,50,40,0.12)");
  root.setProperty("--surface-card", "transparent");
  root.setProperty("--surface-subtle", "transparent");
  root.setProperty("--ui-font", "Inter, system-ui, sans-serif");
  root.setProperty("--mono-font", "ui-monospace, SFMono-Regular, Menlo, monospace");
  root.setProperty("--writer-editor-max-width", "520px");
  root.setProperty("--writer-editor-side-padding", "36px");
  const style = document.createElement("style");
  style.textContent = `
    html, body { width: 1180px; height: 720px; overflow: hidden; }
    body {
      margin: 0;
      background: #c8c4bc;
      color: #2a2824;
      font: 16px "Iowan Old Style", Georgia, serif;
    }
    .desk {
      width: 1180px; height: 720px;
      display: flex; align-items: center; justify-content: center;
      background:
        radial-gradient(ellipse at 30% 20%, #d4d0c8 0%, transparent 50%),
        radial-gradient(ellipse at 70% 80%, #bdb8ae 0%, transparent 45%),
        #c8c4bc;
    }
    .window {
      width: 1120px; height: 680px;
      background: #f4efe6;
      border-radius: 10px;
      border: 1px solid rgba(60,50,40,0.18);
      box-shadow: 0 18px 48px rgba(40,36,28,0.28);
      display: flex; flex-direction: column; overflow: hidden;
    }
    .titlebar {
      height: 36px; display: flex; align-items: center; padding: 0 14px;
      background: linear-gradient(180deg, #ebe6dc 0%, #e2ddd3 100%);
      border-bottom: 1px solid rgba(60,50,40,0.12); flex-shrink: 0;
    }
    .traffic { display: flex; gap: 7px; }
    .traffic i { width: 11px; height: 11px; border-radius: 50%; display: block; }
    .traffic .r { background: #e06c60; }
    .traffic .y { background: #e0b050; }
    .traffic .g { background: #68b06a; }
    .title-label {
      flex: 1; text-align: center;
      font: 500 12px Inter, system-ui, sans-serif; color: #6a645a;
    }
    .panes { flex: 1; display: flex; min-height: 0; }
    .files {
      width: 168px; flex-shrink: 0; background: #ebe6dc;
      border-right: 1px solid rgba(60,50,40,0.12);
      padding: 16px 10px; font: 12.5px Inter, system-ui, sans-serif;
    }
    .files h3 {
      font-size: 10px; font-weight: 500; letter-spacing: 0.08em;
      text-transform: uppercase; color: #9a9488; margin: 0 8px 10px;
    }
    .file { display: flex; align-items: center; gap: 7px; padding: 6px 8px; color: #5a554c; }
    .file.active { background: rgba(90,80,60,0.08); color: #3a3530; font-weight: 500; border-radius: 5px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #b0a898; }
    .file.active .dot { background: #6a8a5a; }
    .paper-host { flex: 1; min-width: 0; background: #f4efe6; position: relative; display: flex; flex-direction: column; overflow: visible; }
    .paper-title {
      margin: 32px 36px 8px 52px;
    }
    .cm-editor { background: #f4efe6; padding: 0 0 40px; min-height: 480px; flex: 1; overflow: visible; position: relative; }
    .cm-content {
      outline: none;
      font: 17.5px/1.72 "Iowan Old Style", Georgia, serif;
      overflow: visible;
      max-width: calc(520px + 36px + 268px);
      padding-left: 52px;
    }
    .cm-scroller { overflow: visible !important; clip-path: none !important; }
    .cm-line { position: relative; }
    .status {
      position: absolute; bottom: 14px; left: 52px;
      font: 10px Inter, system-ui, sans-serif; color: #a09888;
    }
  `;
  document.head.append(style);
}

function chrome(
  title: string,
  host: HTMLElement,
  paperTitle = "Creatine and training",
  statusLabel = "ASH-FILL · A1",
  activeFile = "Creatine.md",
) {
  const desk = document.createElement("div");
  desk.className = "desk";
  desk.innerHTML = `
    <div class="window">
      <div class="titlebar">
        <div class="traffic"><i class="r"></i><i class="y"></i><i class="g"></i></div>
        <div class="title-label">${title}</div>
      </div>
      <div class="panes">
        <aside class="files">
          <h3>Documents</h3>
          <div class="file active"><span class="dot"></span>${activeFile}</div>
          <div class="file"><span class="dot"></span>Notes.md</div>
          <div class="file"><span class="dot"></span>Ship checklist.md</div>
        </aside>
        <div class="paper-host"></div>
      </div>
    </div>`;
  const paper = desk.querySelector(".paper-host") as HTMLElement;
  const heading = document.createElement("h1");
  heading.className = "paper-title";
  heading.textContent = paperTitle;
  if (!paperTitle) heading.hidden = true;
  const status = document.createElement("div");
  status.className = "status";
  status.textContent = statusLabel;
  paper.append(heading, host, status);
  document.body.append(desk);
  return desk;
}

function noteAt(doc: string, span: string, overrides: Partial<RedlineNote>): RedlineNote {
  const from = doc.indexOf(span);
  return {
    id: "shot",
    from,
    to: from + span.length,
    original: span,
    proposed: null,
    intent: null,
    instruction: "improve",
    status: "pending",
    error: null,
    git: null,
    publish: null,
    ...overrides,
  };
}

function createView(
  parent: HTMLElement,
  doc: string,
  notes: RedlineNote[],
  extra: Extension[] = [],
  editable = false,
): EditorView {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        EditorView.lineWrapping,
        EditorView.editable.of(editable),
        redlineSeedNotes.of(notes),
        redlineNotesField,
        redlineInkTickField,
        redlineDecorationsField,
        redlineSelectionTheme,
        redlineGutter,
        ...extra,
      ],
    }),
  });
  view.dom.dataset.redlineNotes = String(view.state.field(redlineNotesField).length);
  return view;
}

const PAUL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUINN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DOCUMENT_TEXT = "The harbor is narrow at dusk.";
const NOTE_ONE = "Could you check the source on this?";
const HARBOR_DOC = `${DOCUMENT_TEXT}

The last paragraph still needs a source.
`;
const HARBOR_SPAN = "The last paragraph still needs a source.";

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const shot = params.get("shot") ?? document.body.dataset.shot ?? "pending";
if (shot !== "margin") tokens();
const host = document.createElement("div");

function markShotReady() {
  const ready = () => {
    document.body.dataset.shotReady = "1";
  };
  const afterFonts = () => requestAnimationFrame(() => requestAnimationFrame(ready));
  if (document.fonts?.ready) void document.fonts.ready.then(afterFonts);
  else afterFonts();
}

if (shot === "margin") {
  document.body.dataset.shotBoot = "margin";
  void import("./margin-shot")
    .then(({ renderMarginShot }) => renderMarginShot(params))
    .catch((error: unknown) => {
      document.body.dataset.shotError = error instanceof Error ? error.message : String(error);
    });
} else if (
  shot === "sign-in-welcome" ||
  shot === "sign-in-no-account" ||
  shot === "sign-in-create" ||
  shot === "sign-in-account-exists" ||
  shot === "sign-in-code" ||
  shot === "sign-in-code-error"
) {
  // The welcome step's two doors, and the line each door shows for the other.
  const welcome =
    shot === "sign-in-welcome" ||
    shot === "sign-in-no-account" ||
    shot === "sign-in-create" ||
    shot === "sign-in-account-exists";
  const door =
    shot === "sign-in-create" || shot === "sign-in-account-exists" ? "create" : "sign-in";
  const welcomeError =
    shot === "sign-in-no-account"
      ? NO_ACCOUNT_LINE
      : shot === "sign-in-account-exists"
        ? ACCOUNT_EXISTS_LINE
        : null;
  document.documentElement.style.width = "1280px";
  document.documentElement.style.height = "800px";
  document.body.style.width = "1280px";
  document.body.style.height = "800px";
  document.body.style.background = "#f4efe6";
  const root = document.createElement("div");
  document.body.append(root);
  createRoot(root).render(
    createElement(SignInScreen, {
      step: welcome ? "welcome" : "code",
      door,
      birthDate: shot === "sign-in-account-exists" ? "1990-05-17" : "",
      email: shot === "sign-in-welcome" || shot === "sign-in-create" ? "" : "you@example.com",
      error: shot === "sign-in-code-error" ? CODE_ENTRY_ERROR : welcomeError,
      busy: false,
      resendIn: 0,
      initialCode: shot === "sign-in-code-error" ? "48219037" : "",
      onEmail: () => {},
      onContinue: () => {},
      onResend: () => {},
      onDifferentEmail: () => {},
      onSubmitCode: () => {},
    }),
  );
} else if (shot === "accepted") {
  chrome("Alkuin — Launch plan.md", host, "Launch plan");
  const doc = `This is important for our launch plan.\n`;
  createView(host, doc, [
    noteAt(doc, "This is important for our launch plan.", {
      id: "shot-accepted",
      original: "This is really very important.",
      proposed: REPLACE_PROPOSED,
      intent: "replace",
      status: "accepted",
      git: {
        repo_root: "/tmp/vault",
        clean: false,
        porcelain: " M Launch plan.md",
        diff: "diff --git a/Launch plan.md b/Launch plan.md\n--- a/Launch plan.md\n+++ b/Launch plan.md\n@@ -1 +1 @@\n-This is really very important.\n+This is important for our launch plan.\n",
        error: null,
        sharing: false,
      },
    }),
  ]);
} else if (shot === "stub") {
  chrome(
    "Paper annotate — B2 gutter stub + Rock Salt",
    host,
    "Creatine and training",
    "GUTTER-STUB · B2",
  );
  createView(host, A1_DOC, [
    noteAt(A1_DOC, A1_SPAN, {
      id: "shot-stub",
      proposed: "tighten — sounds casual for a claim",
      intent: "none",
      instruction: null,
      status: "pending",
    }),
  ]);
} else if (shot === "paper") {
  chrome("Paper annotate — ash fill → B2 stub → margin scribble", host);
  createView(host, A1_DOC, [
    noteAt(A1_DOC, A1_SPAN, {
      id: "shot-paper",
      proposed: "tighten — sounds casual for a claim",
      intent: "none",
      instruction: null,
      status: "pending",
    }),
  ]);
} else if (shot === "locus") {
  chrome("Margin owns Accept / Reject / Edit ask", host);
  createView(host, A1_DOC, [
    noteAt(A1_DOC, A1_SPAN, {
      id: "shot-locus",
      original: A1_SPAN,
      proposed: "Creatine is effective for improving training performance.",
      intent: "replace",
      instruction: "tighten — sounds casual for a claim",
      status: "pending",
    }),
  ]);
} else if (shot === "connector") {
  // An addition an AI chat sent through the connector. It is not in the text:
  // the card waits at the end of the document for Accept or Reject.
  chrome("An addition from the connector waits for Accept or Reject", host);
  createView(host, HARBOR_DOC, [
    agentCard(HARBOR_DOC.length, {
      path: "/shot/Harbor.md",
      project_id: "shot-project",
      document_id: "shot-document",
      proposal_id: "shot-connector",
      text: "\nThe harbor master's log for 1887 records the same narrowing.\n",
    }),
  ]);
} else if (shot === "suggest") {
  document.body.dataset.shot = "suggest";
  document.documentElement.style.width = "1282px";
  document.documentElement.style.height = "482px";
  document.body.style.width = "1282px";
  document.body.style.height = "482px";
  document.body.style.overflow = "hidden";
  document.documentElement.style.setProperty(
    "--editor-font",
    '"Paper Mono", ui-monospace, monospace',
  );
  document.documentElement.style.setProperty("--ui-font", '"Paper Mono", ui-monospace, monospace');
  const fit = document.createElement("style");
  fit.textContent = `
    body[data-shot="suggest"] .desk,
    body[data-shot="suggest"] .window { width: 1282px; height: 482px; }
    body[data-shot="suggest"] .window { border-radius: 0; box-shadow: none; }
    body[data-shot="suggest"] .desk { background: #f3eee4; }
    body[data-shot="suggest"] .paper-title,
    body[data-shot="suggest"] .status,
    body[data-shot="suggest"] .files { display: none; }
    body[data-shot="suggest"] .title-label { font-family: "Paper Mono", ui-monospace, monospace; }
    body[data-shot="suggest"] .cm-editor { min-height: 0; padding: 0; background: #f3eee4; }
    body[data-shot="suggest"] .paper-host,
    body[data-shot="suggest"] .window { background: #f3eee4; }
    body[data-shot="suggest"] .cm-scroller {
      --writer-editor-max-width: 68ch;
      --writer-column-pad-left: 36px;
      --writer-editor-font-family: "Paper Mono", ui-monospace, monospace;
      --writer-editor-font-size: 14px;
    }
    body[data-shot="suggest"] .cm-editor > .cm-scroller > .cm-content {
      font-family: "Paper Mono", ui-monospace, SFMono-Regular, Menlo, monospace !important;
      font-size: 14px !important;
      line-height: 1.65 !important;
      font-weight: 400 !important;
      max-width: none !important;
      /* 520px clears the gutter at this 1282px frame. The rail width is the pane minus 68ch. */
      padding: 28px 520px 32px 36px !important;
    }
  `;
  document.head.append(fit);
  chrome("writing is thinking - Alkuin", host, "", "", "writing is thinking.md");
  createView(
    host,
    SUGGEST_DOC,
    [
      noteAt(SUGGEST_DOC, SUGGEST_SPAN, {
        id: "shot-suggest",
        original: SUGGEST_SPAN,
        proposed: SUGGEST_PROPOSED,
        intent: "replace",
        instruction: "Say this in fewer words.",
        status: "pending",
      }),
    ],
    [
      markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
      prosemarkBasicSetup(),
      prosemarkBaseThemeSetup(),
      headingDecorations,
    ],
  );
} else if (shot === "suggest-phone") {
  // The suggest shot for the website's one-column layout (900px and down): the same passage
  // and note in a 390px frame, so the text stays legible there. That width has no room for
  // the 268px rail, so the note card sits under the paragraph. Capture .window at scale 3
  // and save it as the website's suggest-phone.webp.
  document.body.dataset.shot = "suggest-phone";
  document.documentElement.style.width = "390px";
  document.body.style.width = "390px";
  document.documentElement.style.setProperty(
    "--editor-font",
    '"Paper Mono", ui-monospace, monospace',
  );
  document.documentElement.style.setProperty("--ui-font", '"Paper Mono", ui-monospace, monospace');
  const fit = document.createElement("style");
  fit.textContent = `
    html, body { height: auto !important; overflow: visible !important; }
    body[data-shot="suggest-phone"] .desk,
    body[data-shot="suggest-phone"] .window { width: 390px; height: auto; }
    body[data-shot="suggest-phone"] .window { border-radius: 0; box-shadow: none; box-sizing: border-box; }
    body[data-shot="suggest-phone"] .desk { display: block; background: #f3eee4; }
    body[data-shot="suggest-phone"] .paper-title,
    body[data-shot="suggest-phone"] .status,
    body[data-shot="suggest-phone"] .files,
    body[data-shot="suggest-phone"] .cm-redline-gutter-stub,
    body[data-shot="suggest-phone"] .cm-redline-gutter::before { display: none; }
    body[data-shot="suggest-phone"] .title-label { font-family: "Paper Mono", ui-monospace, monospace; }
    body[data-shot="suggest-phone"] .cm-editor { min-height: 0; padding: 0; background: #f3eee4; }
    body[data-shot="suggest-phone"] .paper-host,
    body[data-shot="suggest-phone"] .window { background: #f3eee4; }
    body[data-shot="suggest-phone"] .cm-editor > .cm-scroller > .cm-content {
      font-family: "Paper Mono", ui-monospace, SFMono-Regular, Menlo, monospace !important;
      font-size: 14px !important;
      line-height: 1.65 !important;
      font-weight: 400 !important;
      max-width: none !important;
      /* The bottom pad is the room the note card takes under the paragraph. */
      padding: 22px 20px var(--phone-note-room, 128px) 20px !important;
    }
    body[data-shot="suggest-phone"] .cm-redline-gutter {
      left: 20px !important;
      right: 20px !important;
      width: auto !important;
      padding: 14px 0 0 !important;
      border-top: 1px solid rgba(80, 70, 55, 0.28);
      top: var(--phone-note-top, 0px) !important;
    }
    body[data-shot="suggest-phone"] .cm-editor .cm-redline-note {
      top: 14px !important;
      left: 0 !important;
      right: 0 !important;
    }
  `;
  document.head.append(fit);
  chrome("writing is thinking - Alkuin", host, "", "", "writing is thinking.md");
  const doc = SUGGEST_DOC.slice(0, SUGGEST_DOC.indexOf("\n\nIf that is true"));
  const view = createView(
    host,
    doc,
    [
      noteAt(doc, SUGGEST_SPAN, {
        id: "shot-suggest-phone",
        original: SUGGEST_SPAN,
        proposed: SUGGEST_PROPOSED,
        intent: "replace",
        instruction: "Say this in fewer words.",
        status: "pending",
      }),
    ],
    [
      markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
      prosemarkBasicSetup(),
      prosemarkBaseThemeSetup(),
      headingDecorations,
    ],
  );
  // Put the rail under the last line once the editor has laid out.
  const place = () => {
    const lines = view.contentDOM.querySelectorAll(".cm-line");
    const last = lines[lines.length - 1];
    if (!last) return;
    const scroller = view.scrollDOM.getBoundingClientRect();
    const top = last.getBoundingClientRect().bottom - scroller.top + view.scrollDOM.scrollTop + 18;
    document.documentElement.style.setProperty("--phone-note-top", `${Math.round(top)}px`);
  };
  requestAnimationFrame(() => {
    place();
    requestAnimationFrame(() => {
      place();
      markShotReady();
    });
  });
} else if (shot === "tick") {
  chrome("Accept — ink tick paints then fades", host);
  const doc = A1_DOC.replace(A1_SPAN, "Creatine is effective for improving training performance.");
  const view = createView(host, doc, [
    noteAt(doc, "Creatine is effective for improving training performance.", {
      id: "shot-tick",
      original: A1_SPAN,
      proposed: "Creatine is effective for improving training performance.",
      intent: "replace",
      instruction: "tighten — sounds casual for a claim",
      status: "accepted",
    }),
  ]);
  view.dispatch({ effects: flashInkTick.of("shot-tick") });
  const freezeTick = () => {
    view.dom.querySelector(".cm-redline-ink-tick")?.classList.add("is-shot");
    markShotReady();
  };
  requestAnimationFrame(() => requestAnimationFrame(freezeTick));
} else if (shot === "caution") {
  chrome("Caution — the note sits under the suggestion", host);
  createView(host, A1_DOC, [
    noteAt(A1_DOC, A1_SPAN, {
      id: "shot-caution",
      original: A1_SPAN,
      proposed: "The claim is too broad.",
      intent: "replace",
      instruction: "@agent add a citation",
      caution: TOOL_CAUTION_NOTE,
      status: "pending",
    }),
  ]);
} else if (shot === "ash-clip") {
  chrome(
    "Paper annotate — ash fill hugs each wrap",
    host,
    "Creatine and training",
    "ASH-MULTIROW · CLIP",
  );
  const span =
    "Most notes on supplements stay vague. The better habit is to keep claims tight and local to the evidence you actually have.";
  createView(host, A1_DOC, [
    noteAt(A1_DOC, span, {
      id: "shot-ash-clip",
      proposed: "keep claims local to the evidence",
      intent: "none",
      instruction: null,
      status: "pending",
    }),
  ]);
} else if (shot === "ash-sel") {
  chrome("Live selection — ash hugs each row", host, "Creatine and training", "ASH-MULTIROW · SEL");
  const view = createView(host, A1_DOC, [], [drawSelection()], true);
  const from = A1_DOC.indexOf("The creatine works good");
  const to = A1_DOC.indexOf("You're still reading") + "You're still reading".length;
  view.dispatch({ selection: EditorSelection.range(from, to) });
  view.focus();
  const wait = (tries = 0) => {
    if (view.dom.querySelector(".cm-selectionBackground") || tries > 40) {
      document.body.dataset.shotReady = "1";
      return;
    }
    view.requestMeasure();
    requestAnimationFrame(() => wait(tries + 1));
  };
  wait();
} else if (shot === "bubble") {
  chrome(
    "Selection bubble — desk-p15 parchment pill",
    host,
    "Creatine and training",
    "TASTE-40-B · DESK-P15",
  );
  const doc = `Most notes on supplements stay vague. The better habit is to keep claims tight and local to the evidence you actually have.

The creatine works good for training.

You're still reading. Softer hairline, parchment-native pill — same B1 set, less chrome.
`;
  const span = "The creatine works good for training.";
  const view = createView(host, doc, [], [drawSelection(), selectionBubble], true);
  const from = doc.indexOf(span);
  view.dispatch({ selection: EditorSelection.range(from, from + span.length) });
  view.focus();
  const wait = (tries = 0) => {
    if (view.dom.dataset.selectionBubble === "open" || tries > 40) {
      document.body.dataset.shotReady = "1";
      return;
    }
    view.requestMeasure();
    requestAnimationFrame(() => wait(tries + 1));
  };
  wait();
} else if (shot === "t1") {
  const plateStyle = document.createElement("style");
  plateStyle.textContent = `
    body:has(.t1-plate) { background: #f4efe6; }
    .t1-plate {
      width: 1180px; height: 720px; background: #f4efe6;
      display: grid; grid-template-columns: 1.2fr 0.8fr; position: relative;
    }
    .t1-col {
      position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0;
    }
    .t1-col + .t1-col { border-left: 1px solid rgba(44, 40, 36, 0.14); }
    .t1-kicker {
      margin: 28px 0 0 36px;
      font: 500 11px/1 Inter, system-ui, sans-serif;
      letter-spacing: 0.16em; color: #c4bdb4;
    }
    .t1-host { flex: 1; min-height: 0; position: relative; }
    .t1-plate .cm-editor {
      min-height: 0; height: 100%; background: transparent; padding: 0;
    }
    .t1-plate .cm-content { max-width: none; padding-top: 18px; padding-left: 36px; }
    .t1-plate .cm-heading-hash {
      position: absolute; right: 100%; opacity: 0; pointer-events: none;
    }
    .t1-footer {
      position: absolute; left: 36px; bottom: 22px; margin: 0;
      font: 500 10px/1 Inter, system-ui, sans-serif;
      letter-spacing: 0.14em; color: #c4bdb4;
    }
  `;
  document.head.append(plateStyle);
  const plate = document.createElement("div");
  plate.className = "t1-plate";
  plate.innerHTML = `
    <section class="t1-col" data-pane><p class="t1-kicker">A · DOCUMENT</p><div class="t1-host"></div></section>
    <section class="t1-col t1-empty" data-pane><p class="t1-kicker">B · EMPTY</p><div class="t1-host"></div></section>
    <p class="t1-footer">TYPE-ALTITUDE · T1 — QUIETER D · SERIF TITLE + PROMISE</p>`;
  document.body.append(plate);
  const doc = `# Creatine and training

Most notes on supplements stay vague. The better habit is to keep claims tight and local to the evidence you actually have.

The creatine works good for training.

You're still reading. The note lives in the margin — scribble actions only.
`;
  const span = "The creatine works good for training.";
  const left = createView(
    plate.querySelector(".t1-col:not(.t1-empty) .t1-host") as HTMLElement,
    doc,
    [
      noteAt(doc, span, {
        id: "shot-t1",
        proposed: "TIGHTEN",
        intent: "none",
        instruction: null,
        status: "pending",
      }),
    ],
    [
      markdown({ extensions: [GFM] }),
      headingDecorations,
      titleAltitudeHighlight,
      drawSelection(),
      selectionBubble,
      blankDraftPromise,
    ],
    true,
  );
  const from = doc.indexOf(span);
  left.dispatch({ selection: EditorSelection.range(from, from + span.length) });
  left.focus();
  createView(plate.querySelector(".t1-empty .t1-host") as HTMLElement, "", [], [blankDraftPromise]);
  const wait = (tries = 0) => {
    const title = plate.querySelector(".cm-heading-line-1");
    const promise = plate.querySelector(".t1-empty .cm-blank-promise:not([hidden])");
    const bubble = left.dom.dataset.selectionBubble === "open";
    if ((title && promise && bubble) || tries > 40) {
      document.body.dataset.shotReady = "1";
      return;
    }
    left.requestMeasure();
    requestAnimationFrame(() => wait(tries + 1));
  };
  wait();
} else if (shot === "cite") {
  chrome("Alkuin — note.md", host, "Creatine and training", "CITE");
  const claim = "Available evidence.";
  const doc = `Creatine monohydrate reliably increases lean mass when used with resistance training (Kreider et al., 2017).

${claim}

## References
`;
  const mash =
    "Page MJ, Moher D, Bossuyt PM, Boutron I, Hoffmann TC, Mulrow CD, Shamseer L, Tetzlaff JM, Akl EA, Brennan SE, Chou R, Glanville J, Grimshaw JM, Hróbjartsson A, Lalu MM, Li T, Loder EW, Mayo-Wilson E, McDonald S, McKenzie JE. PRISMA 2020 explanation and elaboration: updated guidance and exemplars for reporting systematic reviews. BMJ. 2021;372:n160. doi:10.1136/bmj.n160. indicates that, when administered at recommended dosages, creatine supplementation is generally well tolerated and considered safe in healthy adolescent populations; however, long-term safety data are limited.";
  createView(host, doc, [
    noteAt(doc, "reliably increases lean mass", {
      id: "shot-saved",
      proposed: "(Kreider et al., 2017)",
      intent: "insert",
      instruction: "@agent add a citation",
      status: "accepted",
      git: {
        repo_root: "/tmp/vault",
        clean: false,
        porcelain: "",
        diff: "",
        error: null,
        sharing: false,
      },
    }),
    noteAt(doc, claim, {
      id: "shot-cite",
      proposed: mash,
      intent: "insert",
      instruction: "@agent add citations for this claim",
      status: "pending",
    }),
  ]);
} else if (shot.startsWith("mention-")) {
  void renderMentionShot(shot, host);
} else if (shot === "compose-empty" || shot === "compose-text" || shot === "compose-asked") {
  chrome("Creatine and training", host, "Creatine and training", "");
  const span =
    "In order to make a decision, we need to first gather all of the facts. So this page lists what the studies agree on, and what they don't.";
  const doc = `Most notes on supplements stay vague. The better habit is to keep claims tight and local to the evidence you actually have.

Creatine monohydrate is the most studied supplement in sport. Three to five grams a day fills the muscles in about four weeks; loading only gets you there sooner.

${span}

## What we know

- Small, reliable gains in short, hard efforts.
- Timing barely matters. Take it with a meal.
- Water weight of a kilo or so in the first weeks.

## Open questions

Whether it helps on rest days, and how much the effect shrinks for people who already eat a lot of meat.
`;
  const asked = shot === "compose-asked";
  const view = createView(
    host,
    doc,
    [
      noteAt(doc, span, {
        id: "shot-compose",
        status: asked ? "pending" : "open",
        intent: asked ? "replace" : null,
        instruction: shot === "compose-empty" ? null : "make this clearer",
        proposed: asked
          ? "To decide, this page lists what the studies agree on, and what they don't."
          : null,
      }),
    ],
    [drawSelection()],
    true,
  );
  const from = doc.indexOf(span);
  view.dispatch({ selection: EditorSelection.range(from, from + span.length) });
} else if (shot === "tutorial" || shot === "tutorial-chart") {
  const chart = shot === "tutorial-chart";
  document.body.dataset.shot = "tutorial";
  const pageHeight = chart ? 800 : 1760;
  document.documentElement.style.width = "1280px";
  document.documentElement.style.height = `${pageHeight}px`;
  document.body.style.width = "1280px";
  document.body.style.height = `${pageHeight}px`;
  document.body.style.overflow = "hidden";
  const fit = document.createElement("style");
  fit.textContent = `
    body[data-shot="tutorial"] .desk { width: 1280px; height: 1760px; }
    body[data-shot="tutorial"] .window { width: 1220px; height: 1700px; }
    body[data-shot="tutorial"] .cm-content {
      max-width: none;
      padding-left: 28px;
      padding-right: 360px;
      box-sizing: border-box;
    }
    body[data-shot="tutorial"] .cm-redline-note-body { max-height: none; overflow: visible; }
  `;
  document.head.append(fit);
  chrome("Alkuin — Tutorial.md", host, "", "", "Tutorial.md");
  createView(host, tutorialBody, tutorialMarginSeeds("/notes/Tutorial.md", tutorialBody), [
    markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] }),
    prosemarkBasicSetup(),
    prosemarkBaseThemeSetup(),
  ]);
  if (chart) {
    const place = () => {
      const note = document.querySelector(
        '[data-redline-note="tutorial-insert-graph"]',
      ) as HTMLElement | null;
      const desk = document.querySelector(".desk") as HTMLElement | null;
      if (!note || !desk) return;
      const top = note.getBoundingClientRect().top;
      desk.style.transform = `translateY(-${Math.max(0, top - 180)}px)`;
      document.body.dataset.shotReady = "1";
    };
    void document.fonts?.ready.then(() => {
      requestAnimationFrame(() => requestAnimationFrame(place));
    });
  }
} else if (shot.startsWith("footer-") || shot === "keep-confirm" || shot === "keep-decline") {
  void import("@/features/document-share/footer-shot").then(({ renderFooterShot }) => {
    renderFooterShot(shot);
  });
} else {
  chrome("Alkuin — Launch plan.md", host, "Launch plan");
  const doc = `This is ${ORIGINAL} for our launch plan.\n`;
  createView(host, doc, [
    noteAt(doc, ORIGINAL, {
      id: "shot-replace",
      original: ORIGINAL,
      proposed: REPLACE_PROPOSED,
      intent: "replace",
      status: "pending",
    }),
    noteAt(doc, "launch plan.", {
      id: "shot-insert",
      original: "launch plan.",
      proposed: INSERT_PROPOSED,
      intent: "insert",
      status: "pending",
    }),
  ]);
}
if (
  shot !== "margin" &&
  !shot.startsWith("mention-") &&
  shot !== "tutorial-chart" &&
  !shot.startsWith("footer-") &&
  shot !== "keep-confirm" &&
  shot !== "keep-decline" &&
  shot !== "tick" &&
  shot !== "bubble" &&
  shot !== "ash-sel" &&
  shot !== "t1"
)
  markShotReady();

function stubMentionPeople() {
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        if (cmd === "mention_people") {
          return {
            people: [
              {
                id: PAUL_ID,
                email: "paul.smith@example.com",
                role: "accepted",
                name: "Paul Smith",
              },
              { id: QUINN_ID, email: "quinn@example.com", role: "accepted", name: "Quinn" },
            ],
          };
        }
        return null;
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    },
  });
}

function harborFile(waiting: boolean) {
  const row = document.querySelector(".files .file.active");
  if (!row) return;
  row.replaceChildren();
  const name = document.createElement("span");
  name.textContent = "Harbor.md";
  row.append(name);
  if (waiting) row.append(openTagDot());
}

function savedMention(over: Partial<RedlineNote> = {}): RedlineNote {
  return noteAt(HARBOR_DOC, HARBOR_SPAN, {
    id: "shot-mention",
    intent: "none",
    instruction: "",
    proposed: `@Paul Smith ${NOTE_ONE}`,
    status: "pending",
    mentions: [{ id: PAUL_ID, name: "Paul Smith" }],
    mentionOpen: true,
    ...over,
  });
}

async function renderMentionShot(shot: string, host: HTMLElement) {
  stubMentionPeople();
  chrome("Alkuin — Harbor.md", host, "Harbor", "");
  const waiting =
    shot === "mention-picker" || shot === "mention-picker-all" || shot === "mention-note";
  harborFile(waiting);
  if (shot === "mention-picker" || shot === "mention-picker-all") {
    createView(
      host,
      HARBOR_DOC,
      [
        noteAt(HARBOR_DOC, HARBOR_SPAN, {
          id: "shot-picker",
          status: "open",
          intent: null,
          instruction: null,
          proposed: null,
        }),
      ],
      [drawSelection()],
      true,
    );
    const prompt = document.querySelector("textarea.cm-redline-instruction");
    if (!(prompt instanceof HTMLTextAreaElement)) return;
    const typed = shot === "mention-picker-all" ? "@" : "@pa";
    prompt.focus();
    prompt.value = typed;
    prompt.setSelectionRange(typed.length, typed.length);
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    const ready = () => {
      const picker = document.querySelector(".mention-picker");
      const text = picker?.textContent ?? "";
      const open = picker instanceof HTMLElement && !picker.hidden && text.includes("Paul Smith");
      const both = shot !== "mention-picker-all" || text.includes("Quinn");
      return open && both && !text.includes("Alkuin");
    };
    const wait = (tries = 0) => {
      if (ready() || tries > 40) {
        markShotReady();
        return;
      }
      window.setTimeout(() => wait(tries + 1), 50);
    };
    wait();
    return;
  }
  if (shot === "mention-note") {
    createView(host, HARBOR_DOC, [savedMention()]);
  } else if (shot === "mention-reply") {
    createView(host, HARBOR_DOC, [
      savedMention({
        mentionOpen: false,
        mentionDone: true,
        replies: [
          {
            id: "reply-1",
            authorId: PAUL_ID,
            authorName: "Paul Smith",
            text: "I'll look at the source.",
          },
        ],
      }),
    ]);
  } else if (shot === "mention-wording") {
    createView(host, HARBOR_DOC, [
      savedMention({ mentionOpen: false, mentionDone: true }),
      noteAt(HARBOR_DOC, HARBOR_SPAN, {
        id: "shot-wording",
        intent: "replace",
        instruction: null,
        proposed: "Name the study in the last paragraph.",
        status: "pending",
        person: "Paul Smith",
        shareAccept: true,
        mentionOf: "shot-mention",
      }),
    ]);
  }
  markShotReady();
}
