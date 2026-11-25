import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import {
  CLOSE_WINDOW_SAVE_FAILED_ONE_LINE,
  CLOSE_WINDOW_SAVE_FAILED_SOME_LINE,
} from "@/features/redline-spike/margin-copy";
import { createDiscardGate, flushAllSaves, unsavedLine } from "@/lib/save";

interface CloseGuardDeps {
  flushAllSaves: () => Promise<string[]>;
  /** False when the native layer hid the window instead of closing it (macOS main window). */
  isVisible: () => Promise<boolean>;
  /** Stop intercepting closes, then close the window for real. */
  close: () => Promise<void>;
  showUnsaved: (paths: string[]) => void;
  /** Clock for the discard window. Tests pass a fake one. */
  now?: () => number;
}

/**
 * The close-requested handler. Saves every dirty document first. A failed save
 * keeps the window open and says so. Closing again soon, with the same
 * documents still unsaved, goes ahead without saving, so a disk that keeps
 * failing cannot trap the window (`createDiscardGate`). Anything else warns again.
 */
export function createCloseGuard(deps: CloseGuardDeps): () => Promise<void> {
  let running = false;
  const mayDiscard = createDiscardGate(deps.now);

  return async function onCloseRequested() {
    if (running) return;
    running = true;
    try {
      let unsaved: string[];
      try {
        unsaved = await deps.flushAllSaves();
      } catch (error) {
        console.error("[close] saving before close failed", error);
        unsaved = [""];
      }
      if (!mayDiscard(unsaved)) {
        deps.showUnsaved(unsaved.filter(Boolean));
        return;
      }
      const visible = await deps.isVisible().catch(() => true);
      if (visible) await deps.close();
    } finally {
      running = false;
    }
  };
}

/**
 * Save before this window closes. Registering a close-requested listener makes
 * Tauri hold every close until the listener closes the window itself. The macOS
 * main window is hidden by `lib.rs` instead; it stays hidden and keeps its state.
 *
 * ponytail: Quit does not come through here. Rust has to ask the windows first.
 */
export function useSaveBeforeClose() {
  useEffect(() => {
    const win = getCurrentWindow();
    let stopped = false;
    let unlisten: UnlistenFn | null = null;

    const guard = createCloseGuard({
      flushAllSaves,
      isVisible: () => win.isVisible(),
      close: async () => {
        stopped = true;
        // Typed `void`, but it returns the unregister IPC. Wait for it, or Tauri
        // can still see a listener and hold the close below as well.
        await Promise.resolve(unlisten?.());
        unlisten = null;
        await win.close();
      },
      showUnsaved: (paths) => {
        showEditorNotice(
          unsavedLine(paths, CLOSE_WINDOW_SAVE_FAILED_ONE_LINE, CLOSE_WINDOW_SAVE_FAILED_SOME_LINE),
          { sticky: true },
        );
      },
    });

    void win
      .listen("tauri://close-requested", () => {
        void guard();
      })
      .then((fn) => {
        if (stopped) {
          fn();
          return;
        }
        unlisten = fn;
      });

    return () => {
      stopped = true;
      unlisten?.();
      unlisten = null;
    };
  }, []);
}
