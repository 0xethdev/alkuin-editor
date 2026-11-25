import {
  getPrimaryDefs,
  SETTINGS_SCHEMA,
  suffixOf,
  type PrimarySuffix,
  type SettingDef,
  type ThemeMode,
} from "./settings-schema";

export type ThemePreference = "system" | "light" | "dark";

/** Preferences writes the choice here. The settings file is the other copy. */
export const APPEARANCE_STORAGE_KEY = "alkuin-appearance";

export function readStoredAppearance(): ThemePreference | null {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "system") return raw;
  } catch {
    return null;
  }
  return null;
}

export function writeStoredAppearance(preference: ThemePreference): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // The settings file still has the choice when that write succeeds.
  }
}

function setThemeAttribute(isDark: boolean) {
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
}

/** True when the file or the browser copy is not already light. */
export function themeNeedsLightMigration(fileValue: unknown, stored: unknown): boolean {
  return fileValue !== "light" || (stored !== null && stored !== undefined && stored !== "light");
}

/** Same record when the theme is already light. */
export function forceLightSettings(settings: Record<string, unknown>): Record<string, unknown> {
  if (settings["appearance.theme"] === "light") return settings;
  return { ...settings, "appearance.theme": "light" };
}

/** How the translucent/contrast sliders translate into CSS-var values. The CSS
 *  expects normalized inputs (`--bg-opacity` 0–1, `--contrast` 0–2), not the
 *  raw slider ranges the user manipulates, so the mapping happens here rather
 *  than as a 1:1 cssVar binding. */
const DERIVED_PRIMARIES: Partial<Record<PrimarySuffix, (v: unknown) => [string, string]>> = {
  translucent: (v) => {
    const t = clamp(Number(v) || 0, 0, 100);
    return ["--bg-opacity", String(1 - (t / 100) * 0.95)];
  },
  contrast: (v) => {
    // Slider 0-100 maps to effective 0.2-1.0
    const c = clamp(Number(v) || 0, 0, 100);
    return ["--contrast", String(0.2 + (c / 100) * 0.8)];
  },
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/** Coerce an unknown setting value into a CSS string. Returns null for
 *  values we can't sensibly stringify (objects, arrays) so the caller can
 *  skip them rather than write `[object Object]` into a CSS variable. */
function formatCssValue(value: unknown, format: SettingDef["cssFormat"]): string | null {
  let str: string;
  if (typeof value === "string") str = value;
  else if (typeof value === "number") str = value.toString();
  else return null;
  if (format === "px" || format === "ch") return `${str}${format}`;
  return str;
}

/** Push the active mode's primaries onto :root. Direct 1:1 bindings come
 *  from each schema entry's `cssVar`; derived tokens (translucent → bg-opacity,
 *  contrast → /100) are mapped explicitly via `DERIVED_PRIMARIES`. */
function applyPrimaries(mode: ThemeMode, settings: Record<string, unknown>) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const def of getPrimaryDefs(mode)) {
    const value = settings[def.key];
    if (value === undefined || value === null) continue;
    const derive = DERIVED_PRIMARIES[suffixOf(mode, def.key)];
    if (derive) {
      const [varName, formatted] = derive(value);
      root.style.setProperty(varName, formatted);
    } else if (def.cssVar) {
      const formatted = formatCssValue(value, def.cssFormat);
      if (formatted !== null) root.style.setProperty(def.cssVar, formatted);
    }
  }
}

/** Generic side effect: any non-theme schema entry with a `cssVar` binding gets
 *  pushed to :root automatically. New CSS-var-driven settings declare the
 *  binding in JSON; no view code needs to change. Mode-aware tokens
 *  (`theme.{mode}.*`) are handled by `applyPrimaries` instead — only the
 *  active mode's values flow through. */
export function applyCssVarBindings(settings: Record<string, unknown>) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const def of SETTINGS_SCHEMA) {
    if (!def.cssVar) continue;
    if (def.key.startsWith("theme.")) continue;
    const value = settings[def.key];
    if (value === undefined || value === null) continue;
    const formatted = formatCssValue(value, def.cssFormat);
    if (formatted !== null) root.style.setProperty(def.cssVar, formatted);
  }
}

/** Warm Margin light. Chrome is Paper, the page is Vellum, text is Ink.
 *  Quieter lines are Ink 2 and Ink 3. Applied only while the light background
 *  and foreground are still these defaults, so a saved theme keeps its colours. */
export const WARM_CHROME = "#F3EEE4";
export const WARM_PAGE = "#F7F3EC";
export const WARM_INK = "#141312";
export const WARM_INK_2 = "#55524D";
export const WARM_INK_3 = "#6F6A62";
export const RUBRIC = "#D33C33";

const WARM_SURFACE_VARS = ["--page-bg", "--text-secondary", "--text-muted", "--text-icon-muted"];

function sameColor(value: unknown, hex: string): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === hex.toLowerCase();
}

export function warmLightActive(mode: ThemeMode, settings: Record<string, unknown>): boolean {
  return (
    mode === "light" &&
    sameColor(settings["theme.light.background"], WARM_CHROME) &&
    sameColor(settings["theme.light.foreground"], WARM_INK)
  );
}

function applyWarmSurfaces(mode: ThemeMode, settings: Record<string, unknown>) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!warmLightActive(mode, settings)) {
    for (const name of WARM_SURFACE_VARS) root.style.removeProperty(name);
    return;
  }
  root.style.setProperty("--page-bg", WARM_PAGE);
  root.style.setProperty("--text-secondary", WARM_INK_2);
  root.style.setProperty("--text-muted", WARM_INK_3);
  root.style.setProperty("--text-icon-muted", WARM_INK_3);
}

function pushForMode(mode: ThemeMode, settings: Record<string, unknown>) {
  setThemeAttribute(mode === "dark");
  applyPrimaries(mode, settings);
  applyWarmSurfaces(mode, settings);
}

/**
 * Paint the desk. Called only by the settings store.
 * ponytail: v1 is light paper only. `preference` is accepted so a stored
 * dark or system value does not throw, and it is not followed. Honor it
 * again when Appearance offers a choice.
 */
export function applyTheme(_preference: unknown, settings: Record<string, unknown>) {
  writeStoredAppearance("light");
  if (typeof document === "undefined") return;
  pushForMode("light", settings);
}

/** The mode the desk paints. Light, whatever was stored. */
export function activeMode(_preference: unknown): ThemeMode {
  return "light";
}
