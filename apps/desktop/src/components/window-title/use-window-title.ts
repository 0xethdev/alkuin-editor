import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

export function useWindowTitle(title: string) {
  useEffect(() => {
    document.title = title;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void getCurrentWindow().setTitle(title);
    }
  }, [title]);
}
