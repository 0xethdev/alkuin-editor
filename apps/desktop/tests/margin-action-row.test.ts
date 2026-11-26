import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { REDLINE_GUTTER_WIDTH } from "../src/features/redline-spike/gutter";

const css = readFileSync(
  new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
  "utf8",
);
const gutter = readFileSync(
  new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
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

  test("Accept, Reject and Edit ask fit one line of the note column", () => {
    const railPad = num(css, /--redline-rail-pad:\s*(\d+)px/);
    const railPadRight = num(css, /--redline-rail-pad-right:\s*(\d+)px/);
    const column = REDLINE_GUTTER_WIDTH - railPad - railPadRight;
    const noteSize = num(rule(".cm-editor .cm-redline-note"), /font-size:\s*(\d+)px/);
    const size = num(button, /font-size:\s*(\d+)px/);
    const tracking = num(button, /letter-spacing:\s*([\d.]+)em/);
    const gap = num(actions, /gap:\s*\d+px ([\d.]+)em/) * noteSize;
    // Paper Mono's advance, measured in the browser: 6.67px at 11px.
    const advance = 0.61;
    const labels = ["Accept", "Reject", "Edit ask"];
    const glyphs = labels.join("").length;
    const width = glyphs * (advance + tracking) * size + (labels.length - 1) * gap;
    expect(width).toBeLessThanOrEqual(column);
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
