import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  getPrimaryDefs,
  SETTINGS_SCHEMA,
  suffixOf,
  type ThemeMode,
} from "../src/lib/settings-schema";
import { RUBRIC, WARM_CHROME, WARM_INK, WARM_PAGE, warmLightActive } from "../src/lib/theme";

// Every preset folder ships one JSON per mode holding exactly the editable
// primaries. Glob-load them the same way a preset picker would so adding a
// schema primary (e.g. mono-font) fails here until every preset defines it.
const presetFiles = import.meta.glob<Record<string, unknown>>("../shared/themes/*/*.json", {
  eager: true,
  import: "default",
});

describe("typography settings", () => {
  test("keep their persisted keys and CSS bindings under the Typography category", () => {
    const fonts = SETTINGS_SCHEMA.filter((def) => def.key.startsWith("fonts.")).map((def) => ({
      key: def.key,
      label: def.label,
      category: def.category,
      type: def.type,
      cssVar: def.cssVar,
    }));

    expect(fonts).toEqual([
      {
        key: "fonts.ui",
        label: "UI font",
        category: "Typography",
        type: "font",
        cssVar: "--ui-font",
      },
      {
        key: "fonts.editor",
        label: "Editor font",
        category: "Typography",
        type: "font",
        cssVar: "--editor-font",
      },
      {
        key: "fonts.mono",
        label: "Code font",
        category: "Typography",
        type: "font",
        cssVar: "--mono-font",
      },
    ]);
  });

  test("default to Paper Mono for the desk, the draft, and code", () => {
    const defaults = Object.fromEntries(
      SETTINGS_SCHEMA.filter((def) => def.key.startsWith("fonts.")).map((def) => [
        def.key,
        String(def.default),
      ]),
    );

    const paperMono = '"Paper Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
    expect(defaults["fonts.ui"]).toBe(paperMono);
    expect(defaults["fonts.editor"]).toBe(paperMono);
    expect(defaults["fonts.mono"]).toBe(paperMono);

    const width = SETTINGS_SCHEMA.find((def) => def.key === "editor.content-width");
    expect(width).toMatchObject({
      default: 75,
      cssFormat: "ch",
      cssVar: "--writer-editor-max-width",
    });
    expect(SETTINGS_SCHEMA.find((def) => def.key === "editor.font-size")?.default).toBe(14);
    expect(SETTINGS_SCHEMA.find((def) => def.key === "statusbar.show-words")?.default).toBe(true);
    expect(SETTINGS_SCHEMA.find((def) => def.key === "statusbar.show-characters")?.default).toBe(
      false,
    );
    expect(SETTINGS_SCHEMA.find((def) => def.key === "statusbar.show-paragraphs")?.default).toBe(
      false,
    );
  });
});

describe("default terminal setting", () => {
  test("exposes the cross-platform terminal preference contract", () => {
    const definition = SETTINGS_SCHEMA.find((def) => def.key === "workspace.default-terminal");
    expect(definition).toMatchObject({
      label: "Default Terminal",
      description:
        "Terminal application name on macOS. Leave blank for Alkuin's platform default; arguments are not supported.",
      category: "Workspace",
      type: "string",
      placeholder: "Platform default",
      normalize: "trim",
      scope: "global",
      default: "",
    });
  });
});

describe("theme presets", () => {
  test("at least one preset file is discovered", () => {
    expect(Object.keys(presetFiles).length).toBeGreaterThan(0);
  });

  test("the warm paper light preset is the default, and a saved theme is left alone", () => {
    const light = Object.fromEntries(
      getPrimaryDefs("light").map((def) => [suffixOf("light", def.key), def.default]),
    );
    const preset = readFileSync(
      new URL("../shared/themes/warm-paper/light.json", import.meta.url),
      "utf8",
    );
    expect(light).toMatchObject({
      accent: RUBRIC,
      background: WARM_CHROME,
      foreground: WARM_INK,
      translucent: 0,
    });
    expect(JSON.parse(preset)).toMatchObject({
      accent: RUBRIC,
      background: WARM_CHROME,
      foreground: WARM_INK,
    });
    expect(SETTINGS_SCHEMA.find((def) => def.key === "theme.light.preset")?.default).toBe(
      "warm-paper",
    );
    const warm = {
      "theme.light.background": WARM_CHROME,
      "theme.light.foreground": WARM_INK,
    };
    const saved = {
      "theme.light.background": "#FFFFFF",
      "theme.light.foreground": "#000000",
    };
    expect(warmLightActive("light", warm)).toBe(true);
    expect(warmLightActive("light", saved)).toBe(false);
    expect(warmLightActive("dark", warm)).toBe(false);
    expect(WARM_PAGE).toBe("#F7F3EC");
  });

  test("define every editable primary from the settings schema", () => {
    for (const [path, preset] of Object.entries(presetFiles)) {
      const mode: ThemeMode = path.endsWith("/dark.json") ? "dark" : "light";
      const schemaKeys = getPrimaryDefs(mode)
        .map((def) => suffixOf(mode, def.key))
        .sort();
      expect(Object.keys(preset).sort(), path).toEqual(schemaKeys);
    }
  });
});
