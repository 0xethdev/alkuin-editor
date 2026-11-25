import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const theme = readFileSync(
  new URL("../src/components/editor-area/prosemark-theme.css", import.meta.url),
  "utf8",
);
const altitude = readFileSync(
  new URL("../src/components/editor-area/type-altitude.css", import.meta.url),
  "utf8",
);
const highlights = readFileSync(
  new URL("../src/lib/prosemark-core/syntaxHighlighting.ts", import.meta.url),
  "utf8",
);
const weights = readFileSync(
  new URL("../src/components/editor-area/editor-extensions.ts", import.meta.url),
  "utf8",
);

describe("heading hash size", () => {
  test("every ATX level sizes the hash with the heading, not a smaller mark", () => {
    expect(altitude).toMatch(
      /\.cm-heading-line-1 \.cm-heading-hash[\s\S]*font-size: var\(--writer-title-size\) !important/,
    );
    expect(altitude).toMatch(/\.cm-heading-line-1 \.cm-heading-hash[\s\S]*line-height: 1\.25/);
    expect(altitude).toContain("#a8a39a");
    expect(theme).toMatch(
      /\.cm-heading-line-2 \.cm-heading-hash[\s\S]*font-size: var\(--writer-section-size\) !important/,
    );
    expect(theme).toContain("#a8a39a");
    expect(highlights).toContain('"var(--writer-title-size)"');
    expect(highlights).toContain('"var(--writer-section-size)"');
    expect(weights).toContain('fontWeight: "700", fontSize: SECTION_SIZE');
    expect(theme).toMatch(/\.cm-heading-hash[\s\S]*line-height: inherit/);
    expect(theme).toMatch(
      /\.cm-heading-hash \.cm-hidden-token \{\s*font-size: inherit !important;/,
    );
    const rules = theme.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/cm-heading-hash[\s\S]*font-size:\s*0/);
  });
});
