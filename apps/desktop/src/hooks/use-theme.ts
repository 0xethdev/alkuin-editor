import { useSettingsStore } from "@/stores/settings-store";
import type { ThemePreference } from "@/lib/theme";

/** Light-only v1. A dark or system choice is stored as light. */
export function setThemePreference(_next?: ThemePreference) {
  void useSettingsStore.getState().setSetting("appearance.theme", "light");
}
