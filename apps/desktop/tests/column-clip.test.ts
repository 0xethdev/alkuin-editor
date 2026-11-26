import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { markNotesShown } from "../src/features/redline-spike/gutter";
import { chrome, readChromeDump } from "./helpers/chrome-dump";

const theme = readFileSync(
  new URL("../src/components/editor-area/prosemark-theme.css", import.meta.url),
  "utf8",
);
const mermaid = readFileSync(
  new URL("../src/components/editor-area/mermaid-canvas.css", import.meta.url),
  "utf8",
);
const redline = readFileSync(
  new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
  "utf8",
);
const pane = readFileSync(
  new URL("../src/components/editor-area/editor-pane.tsx", import.meta.url),
  "utf8",
);

const NOTES_SCROLLER =
  '.cm-editor[data-redline-notes]:not([data-redline-notes="0"]) > .cm-scroller';
const NOTES_PANEL =
  '[data-pane][data-redline-notes]:not([data-redline-notes="0"]) [data-properties-column]';

/** Every rule in `css` that declares `name`, as its selector list. */
function rulesDeclaring(css: string, name: string): string[] {
  const out: string[] = [];
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (new RegExp(`(^|[;\\s])${name}\\s*:`).test(match[2]!)) {
      out.push(match[1]!.trim().replace(/\s*,\s*/g, ", "));
    }
  }
  return out;
}

describe("draft column", () => {
  test("content box beats CodeMirror's adopted base theme", () => {
    expect(theme).toMatch(/\.cm-editor > \.cm-scroller > \.cm-content \{/);
    expect(theme).toMatch(/\.cm-editor > \.cm-scroller > \.cm-content > \.cm-line,/);
    expect(theme).toMatch(/html \.cm-editor > \.cm-scroller \{/);
    const lineRule = theme.indexOf(".cm-editor > .cm-scroller > .cm-content > .cm-line,");
    const fenceRule = theme.indexOf(
      ".cm-editor > .cm-scroller > .cm-content > .cm-fenced-code-line {",
    );
    const quoteRule = theme.indexOf(
      ".cm-editor > .cm-scroller > .cm-content > .cm-blockquote-line {",
    );
    expect(fenceRule).toBeGreaterThan(lineRule);
    expect(quoteRule).toBeGreaterThan(lineRule);
    expect(mermaid).toContain(
      ".cm-mermaid-canvas .cm-mermaid-canvas-editor .cm-editor > .cm-scroller > .cm-content {",
    );
    expect(mermaid).toContain(
      ".cm-mermaid-canvas .cm-mermaid-canvas-editor .cm-editor > .cm-scroller > .cm-content > .cm-line {",
    );
  });

  test("with properties, the top gap is above the panel, not between it and the body", () => {
    expect(theme).toMatch(
      /\[data-pane\]\[data-has-frontmatter\] \[data-properties-column\] \{\n {2}padding-top: var\(--writer-editor-top-padding/,
    );
    expect(theme).toMatch(
      /\[data-pane\]\[data-has-frontmatter\] \.cm-editor > \.cm-scroller > \.cm-content \{\n {2}padding-top: 0;/,
    );
  });
});

describe("properties panel column", () => {
  test("the panel and the draft read one set of pads", () => {
    expect(rulesDeclaring(theme, "--writer-column-pad-right")).toEqual([
      ".cm-editor .cm-scroller, [data-properties-column]",
    ]);
    // The centred maths is written once, for both elements.
    for (const name of [
      "--writer-unit",
      "--writer-half",
      "--writer-column-pad-left",
      "--writer-column-pad-right",
      "--redline-gutter-inset-right",
    ]) {
      expect(rulesDeclaring(redline, name), name).toEqual([`${NOTES_SCROLLER}, ${NOTES_PANEL}`]);
    }
    expect(rulesDeclaring(theme, "--writer-half")).toEqual([]);
    expect(rulesDeclaring(theme, "--writer-column-pad-left")).toEqual([]);
  });

  test("the pane gives the panel its column and nothing else", () => {
    expect(pane).toMatch(/<div data-properties-column>\s*<FrontmatterPanel /);
    expect(pane).not.toMatch(/padding(Left|Right)/);
  });

  test("the pane carries the count the editor carries, written only when it changes", () => {
    const editor = { dataset: {} as DOMStringMap };
    let paneWrites = 0;
    const stored: DOMStringMap = {};
    const paneData = new Proxy(stored, {
      set(target, key, value) {
        paneWrites++;
        return Reflect.set(target, key, value);
      },
    });
    markNotesShown(editor, { dataset: paneData }, 2);
    expect(editor.dataset.redlineNotes).toBe("2");
    expect(stored.redlineNotes).toBe("2");
    markNotesShown(editor, { dataset: paneData }, 2);
    expect(paneWrites).toBe(1);
    markNotesShown(editor, { dataset: paneData }, 0);
    expect(editor.dataset.redlineNotes).toBe("0");
    expect(stored.redlineNotes).toBe("0");
    expect(paneWrites).toBe(2);
    // An editor outside a pane still gets its count.
    markNotesShown(editor, null, 1);
    expect(editor.dataset.redlineNotes).toBe("1");
  });
});

interface ColumnMeasure {
  padL: number;
  padR: number;
  linePad: number;
  colW: number;
  ch66: number;
  firstL: number;
  colL: number;
  colR: number;
  firstHit: string | null;
  bulletL: number;
  bulletHit: string | null;
  textR: number;
  gapL: number;
  gapR: number;
  scrollerFont: string;
}

test.skipIf(!chrome)(
  "a line and a bullet stay inside the column",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "column-clip-"));
    try {
      const fontSrc = new URL("../public/fonts/paper-mono/PaperMono-wght.woff2", import.meta.url);
      writeFileSync(join(dir, "PaperMono-wght.woff2"), readFileSync(fontSrc));
      const page = join(dir, "column.html");
      writeFileSync(page, columnPage(theme));
      const measured = await readChromeDump<{ wide: ColumnMeasure; narrow: ColumnMeasure }>(
        page,
        dir,
        "data-measure",
        ["--hide-scrollbars", "--window-size=1200,900", "--virtual-time-budget=5000"],
      );

      expectColumn(measured.wide, "wide");
      expect(measured.wide.gapL).toBeLessThan(1);
      expect(measured.wide.gapR).toBeLessThan(1);
      expect(Math.abs(measured.wide.colW - measured.wide.ch66)).toBeLessThan(1.5);

      expectColumn(measured.narrow, "narrow");
      expect(measured.narrow.colW).toBeLessThan(measured.narrow.ch66 - 8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  100_000,
);

function expectColumn(box: ColumnMeasure, label: string) {
  expect(box.padL, label).toBe(75);
  expect(box.linePad, label).toBe(0);
  expect(box.scrollerFont, label).toContain("Paper Mono");
  expect(box.firstL, label).toBeGreaterThanOrEqual(box.colL - 0.5);
  expect(box.firstL, label).toBeLessThan(box.colL + 1);
  expect(box.bulletL, label).toBeGreaterThanOrEqual(box.colL - 0.5);
  expect(box.bulletL, label).toBeLessThan(box.colL + 1);
  expect(box.textR, label).toBeLessThanOrEqual(box.colR + 1);
  expect(box.firstHit, label).toBeTruthy();
  expect(box.bulletHit, label).toBeTruthy();
}

interface PanelMeasure {
  padL: number;
  colL: number;
  colR: number;
  colW: number;
  ch: number;
  firstL: number;
  panelL: number;
  panelR: number;
  keyL: number;
  valueW: number;
  rowR: number;
  columnFont: string;
  panelFont: string;
}

// The panes a 1440, a 1000 and the smallest (800) window give: the 240px
// sidebar and both 18px scrollbar gutters come off.
const PANEL_CASES = {
  wideNotes: { width: 1164, notes: 1 },
  wideNone: { width: 1164, notes: 0 },
  narrowNotes: { width: 724, notes: 1 },
  narrowNone: { width: 724, notes: 0 },
  smallestNotes: { width: 524, notes: 1 },
} as const;
// The narrowest the panel goes, so a property row keeps its value (prosemark-theme.css).
const PANEL_MIN_WIDTH = 17 * 16;

test.skipIf(!chrome)(
  "the properties panel shares the draft's column, with and without notes",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-column-"));
    try {
      const fontSrc = new URL("../public/fonts/paper-mono/PaperMono-wght.woff2", import.meta.url);
      writeFileSync(join(dir, "PaperMono-wght.woff2"), readFileSync(fontSrc));
      const page = join(dir, "panel.html");
      writeFileSync(page, panelPage(theme, redline));
      const measured = await readChromeDump<Record<keyof typeof PANEL_CASES, PanelMeasure>>(
        page,
        dir,
        "data-measure",
        ["--hide-scrollbars", "--window-size=1200,900", "--virtual-time-budget=5000"],
      );

      for (const [label, box] of Object.entries(measured)) {
        expect(Math.abs(box.panelL - box.colL), label).toBeLessThan(0.5);
        expect(Math.abs(box.keyL - box.colL), label).toBeLessThan(0.5);
        expect(Math.abs(box.firstL - box.colL), label).toBeLessThan(1);
        expect(Math.abs(box.rowR - box.panelR), label).toBeLessThan(0.5);
        expect(box.valueW, label).toBeGreaterThan(120);
        // The rows end where the lines end, unless the draft is narrower than a row.
        if (box.colW >= PANEL_MIN_WIDTH) {
          expect(Math.abs(box.panelR - box.colR), label).toBeLessThan(0.5);
        }
        // `ch` in the pads is the draft's; the rows keep the interface face.
        expect(box.columnFont, label).toContain("Paper Mono");
        expect(box.panelFont, label).toBe("sans-serif");
      }
      // With room, notes centre the draft and the rail, and the panel moves with them.
      expect(measured.wideNotes.padL).toBeGreaterThan(100);
      expect(Math.abs(measured.wideNotes.colW - 66 * measured.wideNotes.ch)).toBeLessThan(1.5);
      expect(measured.wideNone.padL).toBe(75);
      expect(Math.abs(measured.wideNone.colW - 66 * measured.wideNone.ch)).toBeLessThan(1.5);
      // Too narrow to centre: the 75px step holds and the line gives way to the rail.
      expect(measured.narrowNotes.padL).toBe(75);
      expect(measured.narrowNotes.colW).toBeLessThan(66 * measured.narrowNotes.ch - 8);
      expect(measured.narrowNone.padL).toBe(75);
      // The smallest window: the draft is narrower than a row, so the panel holds its
      // minimum and runs on over the space above the rail.
      expect(measured.smallestNotes.colW).toBeLessThan(PANEL_MIN_WIDTH - 100);
      expect(
        Math.abs(measured.smallestNotes.panelR - measured.smallestNotes.panelL - PANEL_MIN_WIDTH),
      ).toBeLessThan(0.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  100_000,
);

function panelPage(themeCss: string, redlineCss: string): string {
  const panes = Object.entries(PANEL_CASES)
    .map(
      ([id, { width, notes }]) => `
<div data-pane data-redline-notes="${notes}" id="${id}" style="width: ${width}px">
  <div data-properties-column>
    <div data-frontmatter><div class="row">
      <input data-field="key" value="title"><input data-field="value" value="Writing is thinking"><button></button>
    </div></div>
  </div>
  <div class="cm-editor base" data-redline-notes="${notes}"><div class="cm-scroller"><div class="cm-content cm-lineWrapping">
    <div class="cm-line" id="${id}-line">This is just testing the column so the first letter stays put and the line does not run off the right edge of the page at all.</div>
  </div></div></div>
</div>`,
    )
    .join("");
  return (
    `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: "Paper Mono"; src: url("PaperMono-wght.woff2") format("woff2"); font-weight: 100 900; font-display: block; }
:root {
  --writer-column-pad-left: 75px;
  --writer-editor-max-width: 66ch;
  --writer-editor-font-family: "Paper Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --writer-editor-font-size: 14px;
  --writer-editor-line-height: 1.8;
  --writer-editor-letter-spacing: 0em;
  --ui-font: sans-serif;
  font-size: 16px;
}
` +
    themeCss +
    redlineCss +
    `
body { margin: 0; }
/* FrontmatterRow's layout: the row bleeds 12px each side for its focus fill. */
.row { display: flex; align-items: center; gap: 1rem; margin: 0 -0.75rem; padding: 6px 0.75rem; }
input { margin: 0; border: 0; padding: 0; font: inherit; font-size: 13px; }
[data-field="key"] { width: clamp(5rem, 25%, 9rem); flex-shrink: 0; }
[data-field="value"] { min-width: 0; flex: 1; }
button { width: 20px; height: 20px; flex-shrink: 0; margin: 0; border: 0; padding: 0; }
</style>
${panes}
<script>
const sheet = new CSSStyleSheet();
sheet.replaceSync(${JSON.stringify(BASE_THEME)});
document.adoptedStyleSheets = [sheet];
${PAGE_HELPERS}
function measure(id) {
  const pane = document.getElementById(id);
  const content = pane.querySelector(".cm-content");
  const cs = getComputedStyle(content);
  const box = content.getBoundingClientRect();
  const colL = box.left + parseFloat(cs.paddingLeft);
  const colR = box.right - parseFloat(cs.paddingRight);
  const column = pane.querySelector("[data-properties-column]");
  const ps = getComputedStyle(column);
  const panel = column.getBoundingClientRect();
  return {
    padL: parseFloat(cs.paddingLeft),
    colL, colR,
    colW: colR - colL,
    ch: chOf(content),
    firstL: glyph(id + "-line", 0).left,
    panelL: panel.left + parseFloat(ps.paddingLeft),
    panelR: panel.right - parseFloat(ps.paddingRight),
    keyL: pane.querySelector('[data-field="key"]').getBoundingClientRect().left,
    valueW: pane.querySelector('[data-field="value"]').getBoundingClientRect().width,
    rowR: pane.querySelector("button").getBoundingClientRect().right,
    columnFont: ps.fontFamily,
    panelFont: getComputedStyle(pane.querySelector("[data-frontmatter]")).fontFamily,
  };
}
document.fonts.ready.then(() => {
  const out = {};
  for (const id of ${JSON.stringify(Object.keys(PANEL_CASES))}) out[id] = measure(id);
  document.body.dataset.measure = JSON.stringify(out);
});
</script>`
  );
}

function columnPage(themeCss: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: "Paper Mono"; src: url("PaperMono-wght.woff2") format("woff2"); font-weight: 100 900; font-display: block; }
:root {
  --writer-editor-max-width: 66ch;
  --writer-editor-padding: clamp(3rem, 12vh, 9rem);
  --writer-editor-side-padding: min(var(--writer-editor-padding), 3rem);
  --writer-editor-outer-width: calc(var(--writer-editor-max-width) + var(--writer-editor-side-padding) + var(--writer-editor-side-padding));
  --writer-editor-font-family: "Paper Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --writer-editor-font-size: 16px;
  --writer-editor-line-height: 1.8;
  --writer-editor-letter-spacing: 0em;
  font-size: 16px;
}
` +
    themeCss +
    `
.cm-list-prefix { display: inline-block; position: relative; width: 3ch; color: transparent; }
.cm-list-prefix::before { content: "•"; position: absolute; inset-inline-start: 0; width: 3ch; color: #222; text-align: center; }
.wide { width: 980px; }
.narrow { width: 520px; }
body { margin: 0; }
</style>
<div class="cm-editor base narrow" id="narrow">
  <div class="cm-scroller"><div class="cm-content cm-lineWrapping" id="nc">
    <div class="cm-line" id="nl">This is just testing the column so the first letter stays put and the line does not run off the right edge of the page at all.</div>
    <div class="cm-line" id="nb" style="padding-inline-start: 3ch; text-indent: -3ch;"><span class="cm-list-prefix" id="nmark"></span>Creatine stays inside.</div>
  </div></div>
</div>
<div class="cm-editor base wide" id="wide">
  <div class="cm-scroller"><div class="cm-content cm-lineWrapping" id="wc">
    <div class="cm-line" id="wl">This is just testing the column so the first letter stays put and the line does not run off the right edge of the page at all.</div>
    <div class="cm-line" id="wb" style="padding-inline-start: 3ch; text-indent: -3ch;"><span class="cm-list-prefix" id="wmark"></span>Creatine monohydrate is a well researched supplement.</div>
  </div></div>
</div>
<script>
const sheet = new CSSStyleSheet();
sheet.replaceSync(${JSON.stringify(BASE_THEME)});
document.adoptedStyleSheets = [sheet];
${PAGE_HELPERS}
function hit(rect) {
  const node = document.elementFromPoint(rect.left + Math.min(2, rect.width / 2), rect.top + rect.height / 2);
  return node ? node.id || null : null;
}
function measure(prefix) {
  const content = document.getElementById(prefix + "c");
  content.parentElement.parentElement.scrollIntoView();
  const cs = getComputedStyle(content);
  const box = content.getBoundingClientRect();
  const scroller = content.parentElement.getBoundingClientRect();
  const padL = parseFloat(cs.paddingLeft);
  const padR = parseFloat(cs.paddingRight);
  const colL = box.left + padL;
  const colR = box.right - padR;
  const first = glyph(prefix + "l", 0);
  const mark = document.getElementById(prefix + "mark").getBoundingClientRect();
  return {
    padL, padR,
    linePad: parseFloat(getComputedStyle(document.getElementById(prefix + "l")).paddingLeft),
    colW: colR - colL,
    ch66: 66 * chOf(content),
    firstL: first.left,
    colL, colR,
    firstHit: hit(first),
    bulletL: mark.left,
    bulletHit: hit(mark),
    textR: textRight(prefix + "l"),
    gapL: box.left - scroller.left,
    gapR: scroller.right - box.right,
    scrollerFont: getComputedStyle(content.parentElement).fontFamily,
  };
}
document.fonts.ready.then(() => {
  document.body.dataset.measure = JSON.stringify({ narrow: measure("n"), wide: measure("w") });
});
</script>`
  );
}

// Measuring helpers both pages run.
const PAGE_HELPERS = `
function chOf(el) {
  const probe = document.createElement("span");
  probe.textContent = "0";
  const cs = getComputedStyle(el);
  probe.style.font = cs.font;
  probe.style.fontFeatureSettings = cs.fontFeatureSettings;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}
function glyph(id, start) {
  const el = document.getElementById(id);
  const range = document.createRange();
  range.setStart(el.firstChild, start);
  range.setEnd(el.firstChild, start + 1);
  return range.getBoundingClientRect();
}
function textRight(id) {
  const el = document.getElementById(id);
  const range = document.createRange();
  range.selectNodeContents(el);
  return Math.max(...[...range.getClientRects()].map((rect) => rect.right));
}
`;

const BASE_THEME = `
.base .cm-scroller { display: flex !important; align-items: flex-start !important; font-family: monospace; line-height: 1.4; height: 100%; overflow-x: auto; position: relative; }
.base .cm-content { margin: 0; flex-grow: 2; flex-shrink: 0; display: block; white-space: pre; box-sizing: border-box; min-height: 100%; padding: 4px 0; }
.base .cm-lineWrapping { white-space: break-spaces; word-break: break-word; overflow-wrap: anywhere; flex-shrink: 1; }
.base .cm-line { display: block; padding: 0 2px 0 6px; }
`;
