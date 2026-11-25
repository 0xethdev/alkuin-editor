import { notePendingGitOp } from "@/lib/git-queue";
import { flushSave } from "@/lib/save";
import * as tauri from "@/lib/tauri";
import {
  deliverDocument,
  quietSend,
  sendWhenOnline,
  type BringOutcome,
  type DocumentHistory,
  type SendOutcome,
} from "./steps";

export function onlineNow(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function skippedBring(path: string): BringOutcome {
  return {
    path,
    overlap: false,
    otherText: null,
    localText: null,
    skipped: true,
    deleted: false,
    versionId: "",
  };
}

/** Git is the storage behind the five steps. A later log replaces this object. */
export const deskHistory: DocumentHistory = {
  /** Rejects when the write fails, so `deliverDocument` never commits the old bytes. */
  async saveFile(path) {
    await flushSave(path);
  },
  async rememberVersion(path) {
    try {
      const committed = await tauri.gitCommitFile(path);
      if (committed?.retry && !committed.committed) {
        await notePendingGitOp(path, "commit");
      }
      return { id: committed?.commit_sha ?? null };
    } catch {
      return { id: null };
    }
  },
  async sendWhenOnline(path, online) {
    try {
      const stays = (await tauri.historyStaysOnThisMac(path)) === true;
      return await sendWhenOnline(path, online, stays, {
        async queue(file) {
          await tauri.historySend(file, false);
        },
        async transmit(file) {
          const result = await tauri.historySend(file, true);
          return (
            result ?? {
              sent: false,
              waiting: false,
              refused: false,
              unconfigured: true,
            }
          );
        },
      });
    } catch {
      return quietSend;
    }
  },
  async bringOtherVersion(path) {
    try {
      const result = await tauri.historyBring(path);
      if (!result) return skippedBring(path);
      return {
        path: result.path,
        overlap: result.overlap,
        otherText: result.other_text,
        localText: result.local_text,
        skipped: result.skipped,
        deleted: result.deleted === true,
        versionId: result.version_id ?? "",
      };
    } catch {
      return skippedBring(path);
    }
  },
};

/**
 * Save, remember a version, then send. `onSaved` runs once the file is on
 * disk, before the version is remembered or sent, and not at all when the
 * save fails: for work that must not get ahead of the words it depends on.
 */
export function settleSaved(path: string, onSaved?: () => void): Promise<SendOutcome> {
  if (!onSaved) return deliverDocument(path, onlineNow(), deskHistory);
  return deliverDocument(path, onlineNow(), {
    ...deskHistory,
    async saveFile(file) {
      await deskHistory.saveFile(file);
      onSaved();
    },
  });
}
