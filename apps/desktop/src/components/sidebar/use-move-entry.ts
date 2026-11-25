import { useCallback } from "react";
import {
  useRefreshDirectory,
  useRewriteExpandedDir,
  useRewritePinnedPath,
} from "@/hooks/use-file-tree";
import { moveParkedNotes } from "@/features/redline-spike/parked-notes";
import { renameOpenFile, rewritePathPrefix } from "@/hooks/editor-api";
import * as tauri from "@/lib/tauri";
import { getParentDir } from "@/lib/paths";
import { quiesceSave, resumeSave } from "@/lib/save";
import type { DirEntry } from "@/types/fs";
import { canMoveInto, computeMovePath } from "./tree-move";

export type MoveOutcome =
  | { status: "moved"; entry: DirEntry; newPath: string }
  | { status: "skipped"; entry: DirEntry }
  | { status: "exists"; entry: DirEntry; newPath: string }
  | { status: "error"; entry: DirEntry; error: unknown };

/**
 * Rename `from` (a file, or a folder and everything under it) on disk, with
 * autosave held for the old path. A write already on its way lands first, so
 * it cannot re-create the old path after the rename; edits made meanwhile
 * wait. The caller moves the open documents next (`renameOpenFile`,
 * `rewritePathPrefix`), which carries the waiting writes to the new path. A
 * failed rename gives the hold back, so they land at the old path instead.
 */
export async function renameHoldingSaves(from: string, to: string): Promise<void> {
  await quiesceSave(from);
  try {
    await tauri.renameEntry(from, to);
  } catch (error) {
    resumeSave(from);
    throw error;
  }
  // Margin notes of a file not shown right now wait under its path. They move with it.
  moveParkedNotes(from, to);
}

/**
 * The single write path for relocating a file or folder. Both inline rename and
 * drag-to-move funnel through here so on-disk renames and the corresponding
 * editor/workspace state rewrites stay in lockstep.
 */
export function useMoveEntry() {
  const refreshDirectory = useRefreshDirectory();
  const rewriteExpandedDir = useRewriteExpandedDir();
  const rewritePinnedPath = useRewritePinnedPath();

  // Rename `entry` on disk to `newPath`, then rewrite editor/workspace state and
  // refresh the affected directories. `newPath` may differ from `entry.path` in
  // its name (rename) or its parent (move) — the handling is identical.
  // The state rewrite moves the writes held for the old path over.
  const applyPathChange = useCallback(
    async (entry: DirEntry, newPath: string): Promise<void> => {
      await renameHoldingSaves(entry.path, newPath);
      if (entry.is_dir) {
        rewritePathPrefix(entry.path, newPath);
        rewriteExpandedDir(entry.path, newPath);
        rewritePinnedPath(entry.path, newPath);
      } else {
        renameOpenFile(entry.path, newPath);
        rewritePinnedPath(entry.path, newPath);
      }
      const fromParent = getParentDir(entry.path);
      const toParent = getParentDir(newPath);
      await refreshDirectory(fromParent);
      if (toParent !== fromParent) await refreshDirectory(toParent);
    },
    [refreshDirectory, rewriteExpandedDir, rewritePinnedPath],
  );

  // Move `entry` into `destDir`, preserving its name. Returns an outcome instead
  // of alerting so callers can batch many moves and surface a single summary.
  const moveEntry = useCallback(
    async (entry: DirEntry, destDir: string): Promise<MoveOutcome> => {
      if (!canMoveInto(entry.path, entry.is_dir, destDir)) {
        return { status: "skipped", entry };
      }
      const newPath = computeMovePath(entry, destDir);
      if (await tauri.fileExists(newPath)) {
        return { status: "exists", entry, newPath };
      }
      try {
        await applyPathChange(entry, newPath);
        return { status: "moved", entry, newPath };
      } catch (error) {
        return { status: "error", entry, error };
      }
    },
    [applyPathChange],
  );

  return { applyPathChange, moveEntry };
}
