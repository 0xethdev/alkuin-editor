import { Text } from "@codemirror/state";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  PROMISE_INK,
  PROMISE_SIZE,
  PROMISE_TEXT,
  TITLE_INK,
  TITLE_FAMILY,
  HASH_INK,
  TITLE_SIZE,
  TITLE_TRACKING,
  TITLE_WEIGHT,
  heading1Altitude,
  isBlankDraft,
  isBlankDraftDoc,
} from "../src/components/editor-area/type-altitude";

const css = readFileSync(
  new URL("../src/components/editor-area/type-altitude.css", import.meta.url),
  "utf8",
);
const appCss = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

describe("T1 type altitude", () => {
  test("blank draft is an empty buffer or the new-file title stub", () => {
    expect(isBlankDraft("")).toBe(true);
    expect(isBlankDraft("\n\n")).toBe(true);
    expect(isBlankDraft("#")).toBe(true);
    expect(isBlankDraft("# ")).toBe(true);
    expect(isBlankDraft("# Creatine and training")).toBe(false);
    expect(isBlankDraft("#\n\nbody")).toBe(false);
    expect(isBlankDraft("hello")).toBe(false);
  });

  test("isBlankDraftDoc agrees with isBlankDraft without copying the doc", () => {
    const samples = [
      "",
      "\n\n",
      "#",
      "# ",
      " \n# \n",
      "# Title",
      "#\n\nbody",
      "hello",
      "##",
      " ".repeat(200),
      "x".repeat(500),
    ];
    for (const sample of samples) {
      expect(isBlankDraftDoc(Text.of(sample.split("\n")))).toBe(isBlankDraft(sample));
    }
  });

  test("H1 uses the editor face and the empty promise shares that stylesheet", () => {
    expect(heading1Altitude.fontFamily).toBe(TITLE_FAMILY);
    expect(heading1Altitude.fontSize).toBe(TITLE_SIZE);
    expect(heading1Altitude.fontWeight).toBe(TITLE_WEIGHT);
    expect(heading1Altitude.letterSpacing).toBe(TITLE_TRACKING);
    expect(css).toContain(TITLE_FAMILY);
    expect(css).toContain(`font-size: ${TITLE_SIZE}`);
    expect(appCss).toContain("--writer-editor-font-size: 14px");
    expect(appCss).toContain("--writer-title-size: calc(var(--writer-editor-font-size) * 17 / 11)");
    expect(appCss).toContain(
      "--writer-section-size: calc(var(--writer-editor-font-size) * 13 / 11)",
    );
    expect(css).toContain(`font-weight: ${TITLE_WEIGHT}`);
    expect(css).toContain(`letter-spacing: ${TITLE_TRACKING}`);
    expect(css).toContain(TITLE_INK);
    expect(PROMISE_TEXT).toBe("Write in the center. Help in the margin.");
    expect(css).toContain(`font-size: ${PROMISE_SIZE}`);
    expect(css).not.toContain("font-style: italic");
    expect(css).not.toContain("0.012em");
    expect(css).not.toContain("Iowan");
    expect(css).toContain(PROMISE_INK);
    expect(css).toContain(".cm-heading-line-1");
    expect(css).toContain(".cm-heading-line-1 .cm-heading-hash");
    expect(css).toMatch(
      /\.cm-heading-line-1 \.cm-heading-hash[\s\S]*font-size: var\(--writer-title-size\) !important/,
    );
    expect(css).toContain(HASH_INK.toLowerCase());
    expect(css).toMatch(/\.cm-heading-line-1 \.cm-heading-hash[\s\S]*font-weight: 400/);
    expect(css).toMatch(/\.cm-heading-line-1 \.cm-heading-hash[\s\S]*line-height: 1\.25/);
    expect(css).toContain(".cm-blank-promise");
    expect(css).not.toMatch(/\.cm-content/);
    expect(css).not.toMatch(/\.cm-heading-line-2/);
    expect(css).not.toMatch(/Rock Salt/);
    expect(css).not.toMatch(/cm-redline/);
    expect(css).not.toMatch(/selection-bubble/);
    expect(css).not.toMatch(/gradient/);
    expect(css).not.toMatch(/box-shadow/);
  });
});
