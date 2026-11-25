import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushAllSaves } from "@/lib/save";
import * as tauri from "@/lib/tauri";

/**
 * Answer Rust's quit round (`app:save-before-quit`, see `src-tauri/src/quit.rs`):
 * write every pending save in this window, then report the round. Rust quits
 * once every window has answered without a failure, and asks first otherwise.
 * The listener is window-scoped because Rust emits the round to each window.
 */
export function useSaveBeforeQuit() {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void getCurrentWindow()
      .listen<{ round: number }>("app:save-before-quit", (event) => {
        const { round } = event.payload;
        flushAllSaves()
          .then((unsaved) => tauri.reportQuitSaves(round, unsaved.length > 0))
          .catch((error: unknown) => {
            console.error("[quit] save before quit failed", error);
            return tauri.reportQuitSaves(round, true);
          })
          .catch((error: unknown) => console.error("[quit] report failed", error));
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
