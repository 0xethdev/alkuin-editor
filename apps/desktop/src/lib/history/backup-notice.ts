import {
  showEditorNotice,
  withdrawEditorNotice,
} from "@/components/editor-area/editor-notice-store";
import { BACKUP_REFUSED_LINE } from "@/features/redline-spike/margin-copy";
import { getFileName } from "@/lib/paths";

/** Files whose refused backup was already said. Cleared when a later copy of that file is stored. */
const told = new Set<string>();

/**
 * Say once per file that the sync server would not store its copy (`stopped`). A save
 * every second, and the queue's retry, must not repeat it. The save (`save.ts`) and the
 * queue (`git-queue.ts`) both report here, so the rule lives in one place.
 */
export function noteBackupOutcome(
  path: string,
  outcome: { sent?: boolean; stopped?: boolean } | null | undefined,
): void {
  const line = BACKUP_REFUSED_LINE.replace("{document}", getFileName(path));
  // A later copy was stored, so the line is no longer true.
  if (outcome?.sent && told.delete(path)) withdrawEditorNotice(line);
  if (!outcome?.stopped || told.has(path)) return;
  told.add(path);
  // Lasting: two files refused in one flush are both said, one after the other, and a
  // passing toast does not take the line away before it is read.
  showEditorNotice(line, { sticky: true, lasting: true, key: `backup-refused:${path}` });
}

export function resetBackupNoticesForTest(): void {
  told.clear();
}
