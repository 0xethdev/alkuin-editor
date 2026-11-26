import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  APP_BUILT,
  APP_COMMIT,
  APP_VERSION,
  appBuildLabel,
  formatBuildLabel,
} from "../src/lib/build-stamp";

describe("build stamp", () => {
  test("the line is the version, the short commit, and the day", () => {
    expect(formatBuildLabel("0.7.2", "c371ac0", "2026-10-24")).toBe(
      "Version 0.7.2 (c371ac0) · 2026-10-24",
    );
    expect(formatBuildLabel("0.7.2", "C371AC0ABCDEF", "2026-10-24")).toBe(
      "Version 0.7.2 (c371ac0) · 2026-10-24",
    );
    expect(formatBuildLabel("0.7.2", "c371ac0", "")).toBe("Version 0.7.2 (c371ac0)");
    expect(formatBuildLabel("0.7.2", "not-a-commit", "2026-10-24")).toBe(
      "Version 0.7.2 · 2026-10-24",
    );
    expect(formatBuildLabel(" 0.7.2 ", "", "nope")).toBe("Version 0.7.2");
  });

  test("dev and the release build bake the same three values", () => {
    expect(APP_VERSION).toBe("0.7.12");
    expect(APP_COMMIT).toMatch(/^[0-9a-f]{7}$/);
    expect(APP_BUILT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(appBuildLabel()).toBe(`Version ${APP_VERSION} (${APP_COMMIT}) · ${APP_BUILT}`);
  });

  test("Preferences shows the line", () => {
    const panel = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    expect(panel).toContain("data-app-build");
    expect(panel).toContain("appBuildLabel()");
  });
});
