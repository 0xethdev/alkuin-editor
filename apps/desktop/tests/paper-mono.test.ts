import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { chrome, readChromeDump } from "./helpers/chrome-dump";
const css = readFileSync(new URL("../src/fonts/paper-mono.css", import.meta.url), "utf8");
const ofl = readFileSync(new URL("../public/fonts/paper-mono/OFL.txt", import.meta.url), "utf8");
const scribble = readFileSync(
  new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
  "utf8",
);

describe("Paper Mono", () => {
  test("loads the local face and keeps the OFL beside it", () => {
    expect(css).toContain('font-family: "Paper Mono"');
    expect(css).toContain('url("/fonts/paper-mono/PaperMono-wght.woff2")');
    expect(css).not.toMatch(/https?:/);
    expect(
      existsSync(
        fileURLToPath(new URL("../public/fonts/paper-mono/PaperMono-wght.woff2", import.meta.url)),
      ),
    ).toBe(true);
    expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(scribble).toContain('--redline-scribble: "Nothing You Could Do"');
    const handLicence = readFileSync(
      new URL("../src/features/redline-spike/fonts/OFL.txt", import.meta.url),
      "utf8",
    );
    expect(handLicence).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(handLicence).toContain("Kimberly Geswein");
  });

  test("draft text does not enable stylistic sets or metric overrides", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/ss0[123]/);
    expect(rules).not.toMatch(/font-feature-settings/);
    expect(rules).not.toMatch(
      /font-kerning|text-rendering|font-variant-ligatures|optimizeLegibility/,
    );
  });
});

test.skipIf(!chrome)(
  "computed font-feature-settings stay off the chrome",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "paper-mono-"));
    try {
      const page = join(dir, "features.html");
      writeFileSync(
        page,
        `<!doctype html><meta charset="utf-8"><style>
      :root { font-family: "Paper Mono", ui-monospace, monospace; }
      ${css}
    </style>
    <div class="cm-editor">
      <div class="cm-content" id="draft">Draft line</div>
      <div class="cm-redline-gutter" id="gutter"><span id="note-label" class="cm-redline-note-label">note</span></div>
    </div>
    <aside id="sidebar">Files</aside>
    <div id="tab" role="tab">room</div>
    <label id="label">Font</label>
    <script>
      const read = (id) => getComputedStyle(document.getElementById(id));
      const pack = (id) => ({ features: read(id).fontFeatureSettings, family: read(id).fontFamily });
      document.body.dataset.features = JSON.stringify({
        draft: pack("draft"),
        gutter: pack("gutter"),
        label: pack("note-label"),
        sidebar: pack("sidebar"),
        tab: pack("tab"),
        field: pack("label"),
      });
    </script>`,
      );
      const features = await readChromeDump<Record<string, { features: string; family: string }>>(
        page,
        dir,
        "data-features",
      );
      expect(features.draft.features).toBe("normal");
      expect(features.draft.family).toContain("Paper Mono");
      for (const id of ["gutter", "label", "sidebar", "tab", "field"] as const) {
        expect(features[id].features).toBe("normal");
        expect(features[id].family).toContain("Paper Mono");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  40_000,
);
