import { useEffect } from "react";
import { armGitQueueOnlineFlush, syncGitFolder, syncHistoryCopies } from "@/lib/git-queue";
import { useWorkspaceStore } from "@/stores/workspace-store";

/** Same interval as `PULL_EVERY_MS` in `commands/history.rs`. */
const PULL_EVERY_MS = 3 * 60 * 1000;

/** Replay a queued commit or push, then bring in the other copy, when the machine comes back online. */
export function useGitQueueOnlineFlush(): void {
  useEffect(() => {
    const root = () => useWorkspaceStore.getState().root;
    const stopOnline = armGitQueueOnlineFlush(root);
    const onFocus = () => {
      void syncGitFolder(root());
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      void syncHistoryCopies(root());
    }, PULL_EVERY_MS);
    return () => {
      stopOnline();
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, []);
}
