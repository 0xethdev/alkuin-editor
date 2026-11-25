// Multi-selection in the file tree is a set of paths plus a shift-click
// anchor. Both outlive the rows they name: a rename, move, delete, or a
// collapsed parent takes a row out of the tree without touching the
// selection. Every read goes through these helpers, so bulk actions and
// ranges only ever see rows that are in the tree now.

/** The selected paths that are still rows in the tree. Returns `selected`
 *  itself when nothing dropped out, so callers can compare by identity. */
export function liveTreeSelection(
  selected: ReadonlySet<string>,
  rows: ReadonlyMap<string, unknown>,
): ReadonlySet<string> {
  for (const path of selected) {
    if (!rows.has(path)) return new Set([...selected].filter((p) => rows.has(p)));
  }
  return selected;
}

/** Shift-click range from the anchor to `target`, in tree order. A stale
 *  anchor (its row is gone) starts the range at `target`. */
export function treeRangeSelection(
  orderedPaths: readonly string[],
  anchor: string,
  target: string,
): { paths: Set<string>; anchor: string } {
  const targetIndex = orderedPaths.indexOf(target);
  const anchorIndex = orderedPaths.indexOf(anchor);
  if (targetIndex === -1 || anchorIndex === -1) {
    return { paths: new Set([target]), anchor: target };
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return { paths: new Set(orderedPaths.slice(start, end + 1)), anchor };
}
