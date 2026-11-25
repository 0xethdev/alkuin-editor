const SHORT_COMMIT = /^[0-9a-f]{7,40}$/i;
const BUILD_DAY = /^\d{4}-\d{2}-\d{2}$/;

function envValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `Version 0.7.2 (c371ac0) · 2026-10-24`. A missing commit or day is left out. */
export function formatBuildLabel(version: string, commit: string, built: string): string {
  const number = version.trim();
  const sha = commit.trim().toLowerCase();
  const short = SHORT_COMMIT.test(sha) ? sha.slice(0, 7) : "";
  const day = BUILD_DAY.test(built.trim()) ? built.trim() : "";
  const head = number ? `Version ${number}` : "Version";
  if (short && day) return `${head} (${short}) · ${day}`;
  if (short) return `${head} (${short})`;
  if (day) return `${head} · ${day}`;
  return head;
}

export const APP_VERSION = envValue(import.meta.env.ALKUIN_APP_VERSION);
export const APP_COMMIT = envValue(import.meta.env.ALKUIN_GIT_COMMIT);
export const APP_BUILT = envValue(import.meta.env.ALKUIN_BUILD_DATE);

export function appBuildLabel(): string {
  return formatBuildLabel(APP_VERSION, APP_COMMIT, APP_BUILT);
}
