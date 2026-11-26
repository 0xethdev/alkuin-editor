import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { REDLINE_GUTTER_WIDTH } from "../src/features/redline-spike/gutter";
import {
  ASK_ALKUIN_LABEL,
  COMPOSE_CANCEL_LABEL,
  LEAVE_NOTE_LABEL,
} from "../src/features/redline-spike/margin-copy";
import { chrome, readChromeDump } from "./helpers/chrome-dump";

const css = readFileSync(
  new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
  "utf8",
);
const gutter = readFileSync(
  new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
  "utf8",
);
const theme = readFileSync(
  new URL("../src/components/editor-area/prosemark-theme.css", import.meta.url),
  "utf8",
);
const scrollContainer = readFileSync(
  new URL("../src/components/editor-area/editor-scroll-container.tsx", import.meta.url),
  "utf8",
);

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
}

function num(source: string, pattern: RegExp): number {
  const match = pattern.exec(source);
  expect(match, String(pattern)).not.toBeNull();
  return Number(match![1]);
}

/** Every rule that styles a row of margin buttons, by its selector. */
function rowRules(): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = match[1].trim();
    if (/cm-redline-(note|compose)-actions/.test(selector))
      rules.push({ selector, body: match[2] });
  }
  return rules;
}

/** The markup line that names a button's classes, found by its label. */
function classesOf(label: string): string {
  const at = gutter.indexOf(`\n        ${label},`);
  const fallback = gutter.indexOf(`\n          ${label},`);
  const end = at >= 0 ? at : fallback;
  expect(end, label).toBeGreaterThan(0);
  const line = gutter.slice(gutter.lastIndexOf("\n", end - 1), end);
  return line.trim();
}

describe("margin action row", () => {
  const actions = rule(".cm-editor .cm-redline-note-actions");
  const button = rule(".cm-editor .cm-redline-btn");

  // A longer row (a thread's Reply and Done, the plan offers) wraps. A click on
  // a label has to reach that label's own button.
  test("the hit boxes of two wrapped lines never overlap", () => {
    expect(actions).toMatch(/flex-wrap:\s*wrap/);
    const rowGap = num(actions, /gap:\s*(\d+)px\b/);
    const padding = num(button, /padding:\s*(\d+)px 0;/);
    const margin = num(button, /margin:\s*-(\d+)px 0;/);
    // The padding is taken back by the margin, so the row does not move.
    expect(margin).toBe(padding);
    // Each box reaches `padding` above and below its line.
    expect(rowGap).toBeGreaterThanOrEqual(2 * padding);
    const height = num(button, /min-height:\s*(\d+)px;/);
    expect(height).toBeGreaterThanOrEqual(24);
  });

  test("the button sets its own case and tracking, so the row's never reaches it", () => {
    // The Mac webview let the row's tracking reach the buttons, and Edit ask
    // wrapped onto its own line. The row no longer sets either.
    expect(button).toMatch(/letter-spacing:\s*0\.15em/);
    expect(button).toMatch(/text-transform:\s*uppercase/);
    expect(button).toMatch(/white-space:\s*nowrap/);
    expect(actions).not.toMatch(/letter-spacing/);
    expect(actions).not.toMatch(/text-transform/);
  });

  const railPad = num(css, /--redline-rail-pad:\s*(\d+)px/);
  const railPadRight = num(css, /--redline-rail-pad-right:\s*(\d+)px/);
  const column = REDLINE_GUTTER_WIDTH - railPad - railPadRight;
  const noteSize = num(rule(".cm-editor .cm-redline-note"), /font-size:\s*(\d+)px/);

  /** One line of buttons: the labels at the button's type, and `gapEm` of the row between. */
  function lineWidth(labels: readonly string[], gapEm: number): number {
    const size = num(button, /font-size:\s*(\d+)px/);
    const tracking = num(button, /letter-spacing:\s*([\d.]+)em/);
    // Paper Mono's advance, measured in the browser: 6.67px at 11px.
    const advance = 0.61;
    const glyphs = labels.join("").length;
    return glyphs * (advance + tracking) * size + (labels.length - 1) * gapEm * noteSize;
  }

  test("Accept, Reject and Edit ask fit one line of the note column", () => {
    const gap = num(actions, /gap:\s*\d+px ([\d.]+)em/);
    expect(lineWidth(["Accept", "Reject", "Edit ask"], gap)).toBeLessThanOrEqual(column);
  });

  // Ask Alkuin, Leave note and Cancel are about 251px against the 198px column.
  // Held on one line, Cancel ran past the rail and the pane scrolled sideways.
  test("no row of buttons is held to one line, the composer's included", () => {
    const rows = rowRules();
    expect(rows.map((row) => row.selector)).toContain(
      ".cm-editor .cm-redline-note-actions.cm-redline-compose-actions",
    );
    for (const row of rows) expect(row.body, row.selector).not.toMatch(/flex-wrap:\s*nowrap/);

    const compose = rule(".cm-editor .cm-redline-note-actions.cm-redline-compose-actions");
    const rowGap = num(compose, /gap:\s*(\d+)px [\d.]+em/);
    const gap = num(compose, /gap:\s*\d+px ([\d.]+)em/);
    // A wrapped Cancel's hit box stays off the line above.
    expect(rowGap).toBeGreaterThanOrEqual(2 * num(button, /padding:\s*(\d+)px 0;/));
    // The main pair keeps its line. Cancel takes the next one, at the far end.
    expect(lineWidth([ASK_ALKUIN_LABEL, LEAVE_NOTE_LABEL], gap)).toBeLessThanOrEqual(column);
    expect(classesOf("COMPOSE_CANCEL_LABEL")).toContain("cm-redline-btn-aside");
  });

  test("no separators: the buttons stand apart by the gap", () => {
    expect(css).not.toMatch(/\.cm-redline-btn::before/);
    expect(css).not.toMatch(/content:\s*"·"/);
    expect(css).not.toMatch(/--redline-sep-width/);
  });

  test("the main action is underlined in ink and the aside sits at the far end", () => {
    const primary = rule(".cm-editor .cm-redline-btn-primary");
    expect(primary).toMatch(/color:\s*var\(--redline-compose-ink/);
    expect(primary).toMatch(/background-image:\s*linear-gradient\(currentColor, currentColor\)/);
    // The line stops at the last letter, not under its tracking.
    expect(primary).toMatch(/background-size:\s*calc\(100% - 0\.15em\) 1px/);
    expect(rule(".cm-editor .cm-redline-btn-aside")).toMatch(/margin-left:\s*auto/);
    // Accept is no longer green and Reject no longer red.
    expect(css).not.toMatch(/data-redline-action="accept"\]/);
    expect(css).not.toMatch(/data-redline-action="reject"\]/);

    expect(classesOf("ASK_ALKUIN_LABEL")).toContain("cm-redline-btn-primary");
    expect(classesOf('"Accept"')).toContain("cm-redline-btn-primary");
    expect(classesOf("SIGN_IN_LABEL")).toContain("cm-redline-btn-primary");
    expect(classesOf("TRY_AGAIN_LABEL")).toContain("cm-redline-btn-primary");
    expect(classesOf("SHARE_CHANGES_LABEL")).toContain("cm-redline-btn-primary");
    expect(classesOf('"Reject"')).toBe('"cm-redline-btn",');
    expect(classesOf('"Edit ask"')).toContain("cm-redline-btn-aside");
  });
});

interface CardMeasure {
  card: string;
  left: number;
  right: number;
  /** Anything in the card past its left or right edge. */
  outside: string[];
  buttons: { label: string; top: number; right: number }[];
}

interface PaneMeasure {
  font: boolean;
  scrollWidth: number;
  clientWidth: number;
  innerLeft: number;
  innerRight: number;
  cards: CardMeasure[];
}

const WINDOWS = [800, 1000, 1440] as const;
const SIDEBAR = 240;

// The scroll container's sideways scroll is the symptom: a 1000px window with a
// 240px sidebar scrolled 11px with a note open, because the composer's Cancel
// ended at x=996 against a content box ending at x=985.
test.skipIf(!chrome)(
  "a margin card stays inside its column and never scrolls the pane sideways",
  async () => {
    // The page copies the pane's scroll container. Fail here if that changes.
    expect(scrollContainer).toContain("overflow-y-auto [scrollbar-gutter:stable_both-edges]");
    expect(gutter).toContain('"cm-redline-note-actions cm-redline-compose-actions"');

    const dir = mkdtempSync(join(tmpdir(), "margin-card-"));
    try {
      writeFileSync(
        join(dir, "PaperMono-wght.woff2"),
        readFileSync(new URL("../public/fonts/paper-mono/PaperMono-wght.woff2", import.meta.url)),
      );
      mkdirSync(join(dir, "fonts"));
      writeFileSync(
        join(dir, "fonts", "NothingYouCouldDo-latin-400.woff2"),
        readFileSync(
          new URL(
            "../src/features/redline-spike/fonts/NothingYouCouldDo-latin-400.woff2",
            import.meta.url,
          ),
        ),
      );
      const page = join(dir, "card.html");
      writeFileSync(page, cardPage());
      const measured = await readChromeDump<Record<string, PaneMeasure>>(
        page,
        dir,
        "data-measure",
        ["--window-size=1600,900", "--virtual-time-budget=5000"],
      );

      for (const width of WINDOWS) {
        const pane = measured[width];
        const label = `${width}px window`;
        expect(pane.font, label).toBe(true);
        expect(pane.scrollWidth, label).toBeLessThanOrEqual(pane.clientWidth);
        expect(pane.cards.map((card) => card.card)).toEqual(["compose", "suggestion"]);
        for (const card of pane.cards) {
          const where = `${card.card}, ${label}`;
          expect(card.outside, where).toEqual([]);
          expect(card.left, where).toBeGreaterThanOrEqual(pane.innerLeft - 0.5);
          expect(card.right, where).toBeLessThanOrEqual(pane.innerRight + 0.5);
          // The aside ends where the rule ends, at the card's right edge.
          const aside = card.buttons[card.buttons.length - 1];
          expect(Math.abs(aside.right - card.right), where).toBeLessThan(1);
        }
        const [ask, leave] = pane.cards[0].buttons;
        expect(ask.top, label).toBe(leave.top);
        const [accept, reject, editAsk] = pane.cards[1].buttons;
        expect(new Set([accept.top, reject.top, editAsk.top]).size, label).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  100_000,
);

/** A button as `renderRedlineNote` makes it: its classes are read from gutter.ts. */
function buttonHtml(source: string, label: string): string {
  const classes = classesOf(source).replace(/^"|",$/g, "");
  return `<button type="button" class="${classes}">${label}</button>`;
}

function cardPage(): string {
  const compose = `
    <div class="cm-redline-note cm-redline-ink cm-redline-note-none cm-redline-compose" data-card="compose" style="top: 40px">
      <span class="cm-redline-note-label">NOTE</span>
      <div class="cm-redline-note-body"></div>
      <div class="cm-redline-compose-field"><span class="cm-redline-compose-mark"></span><textarea class="cm-redline-instruction" rows="2" placeholder="Make this clearer"></textarea></div>
      <div class="cm-redline-compose-rule"></div>
      <div class="cm-redline-note-actions cm-redline-compose-actions">
        ${buttonHtml("ASK_ALKUIN_LABEL", ASK_ALKUIN_LABEL)}
        ${buttonHtml("LEAVE_NOTE_LABEL", LEAVE_NOTE_LABEL)}
        ${buttonHtml("COMPOSE_CANCEL_LABEL", COMPOSE_CANCEL_LABEL)}
      </div>
    </div>`;
  const suggestion = `
    <div class="cm-redline-note cm-redline-ink cm-redline-note-replace" data-redline-intent="replace" data-card="suggestion" style="top: 360px">
      <span class="cm-redline-note-label"><span class="cm-redline-ai">AI</span> · replace</span>
      <div class="cm-redline-note-body">Say this in fewer words.</div>
      <div class="cm-redline-note-actions">
        ${buttonHtml('"Accept"', "Accept")}
        ${buttonHtml('"Reject"', "Reject")}
        ${buttonHtml('"Edit ask"', "Edit ask")}
      </div>
    </div>`;
  const lines = Array.from(
    { length: 24 },
    () =>
      `<div class="cm-line">The creatine works good for training, and the note sits beside it.</div>`,
  ).join("");
  const windows = WINDOWS.map(
    (width) => `
    <div class="window" style="width: ${width}px">
      <aside class="sidebar"></aside>
      <div data-pane class="pane">
        <div class="scroll" id="scroll-${width}">
          <div class="cm-editor" data-redline-notes="2">
            <div class="cm-scroller">
              <div class="cm-content cm-lineWrapping">${lines}</div>
              <div class="cm-redline-gutter" style="top: 0; height: 100%">${compose}${suggestion}</div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  ).join("");
  return `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>
@font-face { font-family: "Paper Mono"; src: url("PaperMono-wght.woff2") format("woff2"); font-weight: 100 900; font-display: block; }
:root { --editor-font: "Paper Mono", ui-monospace, monospace; --ui-font: "Paper Mono", ui-monospace, monospace; }
body { margin: 0; }
/* CodeMirror's base theme, below the app's rules as in the app. */
.cm-editor { position: relative; box-sizing: border-box; display: flex; flex-direction: column; }
.cm-scroller { display: flex; align-items: flex-start; height: 100%; overflow-x: auto; position: relative; z-index: 0; }
.cm-content { margin: 0; flex-grow: 2; flex-shrink: 0; display: block; box-sizing: border-box; min-height: 100%; padding: 4px 0; }
.cm-lineWrapping { white-space: break-spaces; word-break: break-word; overflow-wrap: anywhere; flex-shrink: 1; }
/* The window: sidebar, then the pane's EditorScrollContainer. */
.window { display: flex; height: 800px; }
.sidebar { width: ${SIDEBAR}px; flex-shrink: 0; }
.pane { flex: 1; min-width: 0; height: 100%; position: relative; }
.scroll { height: 100%; overflow-y: auto; scrollbar-gutter: stable both-edges; border-top: 12px solid transparent; border-bottom: 12px solid transparent; box-sizing: border-box; }
${theme}
${css}
</style>
${windows}
<script>
function measure(width) {
  const scroll = document.getElementById("scroll-" + width);
  const cs = getComputedStyle(scroll);
  const box = scroll.getBoundingClientRect();
  const borderL = parseFloat(cs.borderLeftWidth);
  const borderR = parseFloat(cs.borderRightWidth);
  const scrollGutter = (scroll.offsetWidth - borderL - borderR - scroll.clientWidth) / 2;
  const innerLeft = box.left + borderL + scrollGutter;
  const cards = [...scroll.querySelectorAll(".cm-redline-note")].map((note) => {
    const edge = note.getBoundingClientRect();
    const outside = [];
    for (const el of note.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < edge.left - 0.5 || r.right > edge.right + 0.5) {
        outside.push(el.className + " " + r.left.toFixed(1) + "–" + r.right.toFixed(1));
      }
    }
    const buttons = [...note.querySelectorAll(".cm-redline-btn")].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: b.textContent, top: r.top, right: r.right };
    });
    return { card: note.dataset.card, left: edge.left, right: edge.right, outside, buttons };
  });
  return {
    font: document.fonts.check('11px "Paper Mono"'),
    scrollWidth: scroll.scrollWidth,
    clientWidth: scroll.clientWidth,
    innerLeft,
    innerRight: innerLeft + scroll.clientWidth,
    cards,
  };
}
document.fonts.load('11px "Paper Mono"').then(() => document.fonts.ready).then(() => {
  const out = {};
  for (const width of ${JSON.stringify(WINDOWS)}) out[width] = measure(width);
  document.body.dataset.measure = JSON.stringify(out);
});
</script></html>`;
}
