import { useEffect, useRef, useState } from "react";
import { shareKeepsCopy } from "@/features/document-share/baseline";
import {
  cloudRemovalFailure,
  confirmPlaceholder,
  leaveAcceptedShare,
} from "@/features/document-removal/delete";
import { subscribeAccountSignIn } from "@/lib/account-sign-in";
import * as tauri from "@/lib/tauri";
import type { ShareDesk } from "@/lib/tauri";
import { createDeskLoader, createRowGuard, type DeskState } from "./desk-loader";

/**
 * ponytail: polls every 20s and on focus. A removed share disappears on the
 * next successful read. Upgrade path is a push when access changes.
 */
const REFRESH_MS = 20_000;

export function useSharedDesk(paths: readonly string[], openFile: (path: string) => Promise<void>) {
  const [state, setState] = useState<DeskState>({ kind: "loading" });
  const pathKey = paths.join("\n");
  const loaderRef = useRef<ReturnType<typeof createDeskLoader> | null>(null);
  if (!loaderRef.current) {
    loaderRef.current = createDeskLoader({
      status: () => tauri.accountStatus(),
      desk: (list) => tauri.shareDesk(list),
      set: setState,
    });
  }
  const loader = loaderRef.current;
  const rowsRef = useRef<ReturnType<typeof createRowGuard> | null>(null);
  if (!rowsRef.current) rowsRef.current = createRowGuard();
  const rows = rowsRef.current;
  const pathsRef = useRef<string[]>([]);
  const reload = () => loader.load(pathsRef.current);

  useEffect(() => {
    pathsRef.current = pathKey ? pathKey.split("\n") : [];
    const load = () => void loader.load(pathsRef.current);
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    const unsubscribe = subscribeAccountSignIn((event) => {
      if (event === "signed-out") loader.signedOut();
      else if (event === "signed-in") load();
    });
    return () => {
      loader.stop();
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
      unsubscribe();
    };
  }, [loader, pathKey]);

  async function open(id: string) {
    await rows.run(id, async () => {
      try {
        const path = await tauri.shareOpenAccepted(id, shareKeepsCopy(id));
        await openFile(path);
      } catch {
        // The row may be gone. The refresh shows the list as it is now.
        await reload();
      }
    });
  }

  async function answer(id: string, accept: boolean) {
    await rows.run(id, async () => {
      try {
        await tauri.shareAnswer(id, accept);
      } catch {
        // The next read shows whether the invite is still there.
      }
      await reload();
    });
  }

  async function leave(id: string) {
    await rows.run(id, async () => {
      try {
        if (!(await leaveAcceptedShare(id))) return;
      } catch (error) {
        window.alert(
          cloudRemovalFailure(error) ??
            `Couldn't remove this document: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await reload();
    });
  }

  async function restore(documentId: string) {
    await rows.run(`restore:${documentId}`, async () => {
      try {
        if (!(await confirmPlaceholder("restore"))) return;
        await tauri.shareRestoreDocument(documentId);
      } catch (error) {
        window.alert(
          cloudRemovalFailure(error) ??
            `Couldn't restore this document: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await reload();
    });
  }

  const desk: ShareDesk | null = state.kind === "ready" ? state.desk : null;
  return { desk, state, open, answer, leave, restore };
}
