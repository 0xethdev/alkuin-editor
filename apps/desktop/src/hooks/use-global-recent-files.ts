import { useCallback, useEffect, useRef, useState } from "react";
import * as tauri from "@/lib/tauri";
import type { RecentFile } from "@/lib/tauri";

// This hook's `files` state is populated from async Tauri IPC and optimistically
// mutated by remove() — it is not derivable during render, so no-derived-state
// does not apply here.
/* eslint-disable react-doctor/no-derived-state */

interface GlobalRecentFiles {
  files: RecentFile[];
  /** False until a fetch resolves. Consumers should not render an empty state
   *  while this is false — `files` starts `[]` regardless of what is persisted.
   *  A failed fetch leaves it false (the list is unknown, not empty); the next
   *  enable or mount fetches again. */
  loaded: boolean;
  /** Remove one entry from the global recents (optimistic + persisted). */
  remove: (path: string) => void;
  /** Re-fetch the list from the backend. */
  refresh: () => void;
}

type Removal = { at: number; settled: boolean };

/** A fetch issued at `issued` read the list before this removal reached the backend. */
function removedSince(removal: Removal | undefined, issued: number): boolean {
  return removal !== undefined && (removal.at > issued || !removal.settled);
}

/** Global recently-opened files (cross-workspace, persisted in app data).
 *  Fetched whenever `enabled` becomes true (and on mount when it already
 *  is), so always-mounted consumers like the command palette refresh per
 *  open while per-open-mounted consumers fetch once. Entries are already
 *  pruned of deleted files server-side. */
export function useGlobalRecentFiles(limit = 30, enabled = true): GlobalRecentFiles {
  const [files, setFiles] = useState<RecentFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** Orders fetches against each other and against remove(). */
  const clock = useRef(0);
  const applied = useRef(0);
  const removals = useRef(new Map<string, Removal>());

  const refresh = useCallback(() => {
    let cancelled = false;
    const issued = ++clock.current;
    void tauri
      .getRecentFilesGlobal(limit)
      .then((entries) => {
        // A fetch older than the one shown has nothing newer to say.
        if (cancelled || issued < applied.current) return;
        applied.current = issued;
        setFiles(entries.filter((file) => !removedSince(removals.current.get(file.path), issued)));
        setLoaded(true);
      })
      .catch((error: unknown) => {
        console.error("Failed to read global recent files", error);
      });
    return () => {
      cancelled = true;
    };
  }, [limit]);

  useEffect(() => {
    if (!enabled) return;
    return refresh();
  }, [enabled, refresh]);

  const remove = useCallback((path: string) => {
    const removal: Removal = { at: ++clock.current, settled: false };
    removals.current.set(path, removal);
    setFiles((prev) => prev.filter((file) => file.path !== path));
    void tauri
      .removeRecentFile(path)
      .catch((error: unknown) => {
        console.error("Failed to remove recent file", error);
      })
      .finally(() => {
        removal.settled = true;
      });
  }, []);

  return { files, loaded, remove, refresh };
}
