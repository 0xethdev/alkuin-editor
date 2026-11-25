// Carries a heading slug across the gap between `navigateToFile` (which
// triggers an async load + an editor swap) and the editor's first render
// of the new document. Keyed by absolute file path. Consumed exactly once,
// or cleared when that navigation does not land on the file (a failed load,
// a rollback, or a newer navigation in the same tab).

const pending = new Map<string, string>();

export function setPendingAnchor(path: string, anchor: string): void {
  pending.set(path, anchor);
}

export function consumePendingAnchor(path: string): string | undefined {
  const anchor = pending.get(path);
  if (anchor !== undefined) pending.delete(path);
  return anchor;
}

/** The navigation that set this anchor did not open the file. A later,
 *  unrelated open of the same file must not scroll to it. */
export function clearPendingAnchor(path: string): void {
  pending.delete(path);
}
