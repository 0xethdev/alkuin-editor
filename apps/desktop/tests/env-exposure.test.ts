import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

// Vite replaces `import.meta.env` used as an object with every variable it
// exposes, so one such read ships the whole exposed build environment in the
// app bundle. Reads must name the variable.

const SRC = new URL("../src", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Code with comments blanked, so prose about the rule is not a hit. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** `import.meta.env` not followed by `.NAME`, and `(import.meta as …).env`. */
export function wholeEnvReads(source: string): string[] {
  const text = codeOnly(source);
  const found: string[] = [];
  for (const match of text.matchAll(/import\.meta\.env(?!\.[A-Za-z_$])/g)) {
    found.push(text.slice(match.index, match.index + 40));
  }
  for (const match of text.matchAll(/\(\s*import\.meta\s+as\b[^)]*\)\s*\.env\b/g)) {
    found.push(match[0]);
  }
  return found;
}

describe("build variables in the webview bundle", () => {
  test("the scanner catches an object read and passes a named read", () => {
    expect(wholeEnvReads("const env = import.meta.env;")).toHaveLength(1);
    expect(wholeEnvReads("const { MODE } = import.meta.env")).toHaveLength(1);
    expect(
      wholeEnvReads("(import.meta as ImportMeta & { env?: X }).env?.ALKUIN_CARET_DIAG"),
    ).toHaveLength(1);
    expect(wholeEnvReads("import.meta.env.ALKUIN_CARET_DIAG")).toHaveLength(0);
    expect(wholeEnvReads("import.meta.env.DEV && x")).toHaveLength(0);
    expect(wholeEnvReads("// reading `import.meta.env` as an object\nconst a = 1;")).toHaveLength(
      0,
    );
    expect(
      wholeEnvReads(
        "/* import.meta.env */ const url = 'https://x.test'; const e = import.meta.env;",
      ),
    ).toHaveLength(1);
  });

  test("no source file reads import.meta.env as an object", () => {
    const offenders = sources(SRC).flatMap((path) =>
      wholeEnvReads(readFileSync(path, "utf8")).map((hit) => `${path.slice(SRC.length)}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  test("only VITE_ names are exposed by prefix; ALKUIN_ names are defined one by one", () => {
    const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(config).not.toMatch(/envPrefix/);
    for (const name of [
      "ALKUIN_APP_VERSION",
      "ALKUIN_GIT_COMMIT",
      "ALKUIN_BUILD_DATE",
      "ALKUIN_CARET_DIAG",
    ]) {
      expect(config).toContain(`"import.meta.env.${name}"`);
    }
  });
});
