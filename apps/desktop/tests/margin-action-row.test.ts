import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const css = readFileSync(
  new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
  "utf8",
);

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
}

function px(source: string, pattern: RegExp): number {
  const match = pattern.exec(source);
  expect(match, String(pattern)).not.toBeNull();
  return Number(match![1]);
}

// The note column is narrower than Accept, Reject and Edit ask together, so the
// action row wraps. A click on a label has to reach that label's own button.
describe("margin action row", () => {
  const actions = rule(".cm-editor .cm-redline-note-actions");
  const button = rule(".cm-editor .cm-redline-btn");

  test("the hit boxes of two wrapped lines never overlap", () => {
    expect(actions).toMatch(/flex-wrap:\s*wrap/);
    const rowGap = px(actions, /gap:\s*(\d+)px 0;/);
    const padding = px(button, /padding:\s*(\d+)px 0;/);
    const margin = px(button, /margin:\s*-(\d+)px 0;/);
    // The padding is taken back by the margin, so the row does not move.
    expect(margin).toBe(padding);
    // Each box reaches `padding` above and below its line.
    expect(rowGap).toBeGreaterThanOrEqual(2 * padding);
    const height = px(button, /min-height:\s*(\d+)px;/);
    expect(height).toBeGreaterThanOrEqual(24);
  });

  test("a wrapped line does not start with a middot", () => {
    // A dot on every following sibling leads the second line.
    expect(css).not.toMatch(/\.cm-redline-btn \+ \.cm-redline-btn::before/);
    const dot = rule(".cm-editor .cm-redline-note-actions .cm-redline-btn::before");
    expect(dot).toMatch(/content:\s*"·"/);
    expect(dot).toMatch(/width:\s*var\(--redline-sep-width\)/);
    const row = rule(".cm-editor .cm-redline-note-actions:not(.cm-redline-compose-actions)");
    expect(row).toMatch(/margin-left:\s*calc\(-1 \* var\(--redline-sep-width\)\)/);
    expect(row).toMatch(/clip-path:\s*inset\([^)]*var\(--redline-sep-width\)\)/);
    // The composer row has no dots, so it is not pulled or clipped.
    expect(rule(".cm-editor .cm-redline-compose-actions .cm-redline-btn::before")).toMatch(
      /content:\s*none/,
    );
  });
});
