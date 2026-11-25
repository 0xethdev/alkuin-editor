import { invoke } from "@tauri-apps/api/core";
import { SAVE_FAILED_ONE_LINE, SAVE_FAILED_SOME_LINE } from "@/features/redline-spike/margin-copy";
import { saveDirtyOpenDocuments } from "@/lib/save-all";

interface UpdateRestartResult {
  restart: boolean;
  deferred: boolean;
  /** Dialog body when a save failed. Null when every open document saved. */
  line: string | null;
  failed: string[];
}

/** One failed document names it. More than one uses the other sentence. */
function saveFailedLine(documents: readonly string[]): string {
  if (documents.length === 1) {
    return SAVE_FAILED_ONE_LINE.replace("{document}", documents[0] ?? "");
  }
  return SAVE_FAILED_SOME_LINE;
}

/**
 * Save every open document, then say whether Install and Restart may continue.
 * A failed save leaves the text in memory and defers the update to the next launch.
 */
async function runUpdateRestart(): Promise<UpdateRestartResult> {
  const failed = await saveDirtyOpenDocuments();
  if (failed.length === 0) {
    return { restart: true, deferred: false, line: null, failed };
  }
  return { restart: false, deferred: true, line: saveFailedLine(failed), failed };
}

/** Reply to `updater:save-before-restart`. Rust restarts only when every window reports no failures. */
export async function onUpdaterSaveBeforeRestart(): Promise<UpdateRestartResult> {
  try {
    const result = await runUpdateRestart();
    await invoke("report_update_saves", { failed: result.failed, missed: false });
    return result;
  } catch {
    await invoke("report_update_saves", { failed: [], missed: true }).catch(() => {});
    return {
      restart: false,
      deferred: true,
      line: SAVE_FAILED_SOME_LINE,
      failed: [],
    };
  }
}
