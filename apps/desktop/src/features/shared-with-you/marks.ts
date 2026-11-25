import type { DirEntry } from "@/types/fs";

/** A dot means at least one open mention. Zero is no dot. */
export function showsDot(open: number): boolean {
  return open > 0;
}

/** Markdown paths the sidebar already has, plus pinned and recent files. */
export function collectMarkdownPaths(
  cache: ReadonlyMap<string, readonly DirEntry[]>,
  extra: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const path of extra) add(path);
  for (const entries of cache.values()) {
    for (const entry of entries) {
      if (entry.is_markdown) add(entry.path);
    }
  }
  return out;
}
