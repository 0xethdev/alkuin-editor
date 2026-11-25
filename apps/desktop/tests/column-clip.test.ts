import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const theme = readFileSync(
  new URL("../src/components/editor-area/prosemark-theme.css", import.meta.url),
  "utf8",
);
const mermaid = readFileSync(
  new URL("../src/components/editor-area/mermaid-canvas.css", import.meta.url),
  "utf8",
);

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
});

const chrome = [
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/local/bin/google-chrome",
].find((path) => existsSync(path));

function dumpDom(page: string, profile: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const chromeArgs = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      // Same hang set as the Paper Mono dump. Without --no-zygote the zygote
      // can sit forever, and --dump-dom never prints (empty stderr).
      "--disable-component-update",
      "--disable-extensions",
      "--disable-sync",
      "--disable-breakpad",
      "--no-zygote",
      "--password-store=basic",
      "--use-mock-keychain",
      "--hide-scrollbars",
      "--window-size=1200,900",
      "--virtual-time-budget=5000",
      `--user-data-dir=${profile}`,
      "--dump-dom",
      page,
    ];
    const stdbuf = "/usr/bin/stdbuf";
    const child: ChildProcess = spawn(
      existsSync(stdbuf) ? stdbuf : chrome!,
      existsSync(stdbuf) ? ["-o0", "-e0", chrome!, ...chromeArgs] : chromeArgs,
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: "disabled:",
          DBUS_SYSTEM_BUS_ADDRESS: "disabled:",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      finish(new Error(`chrome dump timed out\n${stderr.slice(-1500)}`));
    }, 30_000);
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      finish(new Error("chrome stdio missing"));
      return;
    }
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
      if (/data-measure="([^"]+)"/.test(stdout)) finish();
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const events = child as unknown as EventEmitter;
    events.on("error", (error: Error) => finish(error));
    events.on("close", () => finish());
  });
}

// A killed Chrome leaves its profile lock, so each attempt gets a new directory.
// Retry only when the dump never arrives. The geometry checks still run once,
// on a dump that contains data-measure.
async function dumpColumn(page: string, dir: string) {
  const attempts = 3;
  let failure = "chrome dump missing measure";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const dumped = await dumpDom(page, join(dir, `chrome-${attempt}`));
      if (/data-measure="([^"]+)"/.test(dumped.stdout)) return dumped;
      failure = `chrome dump missing measure\n${dumped.stderr.slice(-1500)}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${failure}\n(after ${attempts} chrome dumps)`);
}

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
      const dumped = await dumpColumn(page, dir);
      const match = dumped.stdout.match(/data-measure="([^"]+)"/);
      expect(match, dumped.stderr.slice(-1500)).toBeTruthy();
      const measured = JSON.parse(match![1].replaceAll("&quot;", '"').replaceAll("&amp;", "&")) as {
        wide: ColumnMeasure;
        narrow: ColumnMeasure;
      };

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

const BASE_THEME = `
.base .cm-scroller { display: flex !important; align-items: flex-start !important; font-family: monospace; line-height: 1.4; height: 100%; overflow-x: auto; position: relative; }
.base .cm-content { margin: 0; flex-grow: 2; flex-shrink: 0; display: block; white-space: pre; box-sizing: border-box; min-height: 100%; padding: 4px 0; }
.base .cm-lineWrapping { white-space: break-spaces; word-break: break-word; overflow-wrap: anywhere; flex-shrink: 1; }
.base .cm-line { display: block; padding: 0 2px 0 6px; }
`;
