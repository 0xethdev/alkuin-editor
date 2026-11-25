import type { OverlapNotice } from "@/components/editor-area/editor-notice-store";
import {
  showEditorNotice,
  useEditorNoticeStore,
} from "@/components/editor-area/editor-notice-store";
import { SYNC_EMPTY_COPY_LINE } from "@/features/redline-spike/margin-copy";
import { reloadFromDisk, removePathReferences } from "@/hooks/editor-api";
import { quiesceSave, resumeSave } from "@/lib/save";
import * as tauri from "@/lib/tauri";

/**
 * Accept takes the other copy, or removes the file when that copy was deleted.
 * Reject keeps the words here and sends them so the suggestion does not return.
 * Neither choice opens a compare view.
 *
 * Accept holds autosave for the file until the buffer has the other copy, so a
 * save on its way cannot land over the words Rust just wrote. A settle that
 * fails puts the same suggestion back, so the choice can be made again.
 */
export async function settleOverlap(
  overlap: OverlapNotice,
  choice: "accept" | "reject",
): Promise<void> {
  // An empty suggestion with no version is not their copy. Accepting it would
  // replace the open document with nothing. Checked before anything is held or
  // dismissed, so the decision stays up and Reject is still there.
  if (
    choice === "accept" &&
    !overlap.deleted &&
    overlap.otherText === "" &&
    overlap.versionId === ""
  ) {
    showEditorNotice(SYNC_EMPTY_COPY_LINE);
    return;
  }
  // Dismiss this overlap first, so a second click cannot send the choice twice.
  // Only this path's decision goes: a toast or another file's overlap stays.
  useEditorNoticeStore.getState().dismissOverlap(overlap.path);
  const accepting = choice === "accept";
  try {
    if (accepting) await quiesceSave(overlap.path);
    const result = await tauri.historySettle(
      overlap.path,
      choice,
      overlap.versionId,
      overlap.otherText,
      overlap.deleted,
    );
    if (accepting && overlap.deleted) {
      // The copy is gone. Unsaved words here must not save it back.
      removePathReferences(overlap.path);
      return;
    }
    if (accepting) {
      reloadFromDisk(overlap.path, overlap.otherText, { policy: "force" });
      return;
    }
    if (result?.conflict && result.local_text != null && result.other_text != null) {
      useEditorNoticeStore.getState().showOverlap({
        path: overlap.path,
        localText: result.local_text,
        otherText: result.other_text,
        deleted: result.deleted === true,
        versionId: result.version_id ?? "",
      });
    }
  } catch (error) {
    console.error("[history] settle failed", error);
    useEditorNoticeStore.getState().showOverlap(overlap);
  } finally {
    if (accepting) resumeSave(overlap.path);
  }
}
