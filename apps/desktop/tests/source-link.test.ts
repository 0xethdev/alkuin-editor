import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { LICENCE_LINE, SOURCE_LIVE, SOURCE_URL } from "../src/lib/licence";

describe("source and licence in Preferences", () => {
  test("the line names the licence, the freedom to share and change, and no warranty", () => {
    expect(LICENCE_LINE).toContain("GNU General Public License, version 3");
    expect(LICENCE_LINE).toContain("share it and change it");
    expect(LICENCE_LINE).toContain("no warranty");
    expect(LICENCE_LINE).not.toContain("—");
  });

  test("the source link is a public https address", () => {
    const url = new URL(SOURCE_URL);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("github.com");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  test("the Legal section shows the line always, and the link once the source is public", () => {
    const panel = readFileSync(
      new URL("../src/components/settings-panel/index.tsx", import.meta.url),
      "utf8",
    );
    expect(panel).toContain("{LICENCE_LINE}");
    expect(panel).toContain('...(SOURCE_LIVE ? ([["Source code", SOURCE_URL]] as const) : [])');
    expect(typeof SOURCE_LIVE).toBe("boolean");
  });
});
