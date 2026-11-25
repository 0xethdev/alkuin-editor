import { definePageKind } from "./types";

export type PreferencesLocation = { kind: "preferences" };

export const preferencesKind = definePageKind<"preferences", PreferencesLocation>({
  kind: "preferences",
  title: () => "Preferences",
  description: "Plan and writing style",
  keepAlive: true,
});
