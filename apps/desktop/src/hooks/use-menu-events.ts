import { useEffect } from "react";
import { writingSignedIn } from "@/lib/account-session";
import { createPreferencesTab, useEditorStore } from "@/stores/editor-store";
import { exportOpenDocumentPdf } from "@/lib/export-pdf";
import {
  exportOpenDocumentDocx,
  exportOpenDocumentGoogleDoc,
  importWordDocument,
  openGoogleDocImport,
} from "@/lib/office-exchange";
import { onUpdaterSaveBeforeRestart } from "@/lib/update-restart";
import { listenInThisWindow } from "@/lib/window-events";

/** The session starts unknown, so a menu item does nothing until the gate opens the desk. */
function onDesk(run: () => void): () => void {
  return () => {
    if (!writingSignedIn()) return;
    run();
  };
}

// Native menu items that drive in-app navigation emit a Tauri event from the
// Rust menu handler. Add the (event-name → handler) pair here to subscribe;
// the hook below registers each entry once for the window's lifetime.
//
// Handlers must read store state at call time (`useStore.getState()`) rather
// than closing over hook callbacks, so the listener registration can stay
// stable across renders.
export const MENU_EVENT_HANDLERS: Record<string, () => void> = {
  "menu:open-preferences": onDesk(openPreferences),
  "menu:import-docx": onDesk(() => {
    void importWordDocument();
  }),
  "menu:import-google-doc": onDesk(() => {
    openGoogleDocImport();
  }),
  "menu:export-docx": onDesk(() => {
    void exportOpenDocumentDocx();
  }),
  "menu:export-google-doc": onDesk(() => {
    void exportOpenDocumentGoogleDoc();
  }),
  "menu:export-pdf": onDesk(() => {
    void exportOpenDocumentPdf();
  }),
  "menu:open-account": onDesk(() => {
    void import("@/lib/account-billing").then((mod) => mod.openAccountPortal());
  }),
  "updater:save-before-restart": () => {
    void onUpdaterSaveBeforeRestart();
  },
};

export function openPreferences() {
  useEditorStore
    .getState()
    .openOrFocus((tab) => tab.location.kind === "preferences", createPreferencesTab);
}

export function useMenuEvents() {
  useEffect(() => {
    const unlistens = Object.entries(MENU_EVENT_HANDLERS).map(([event, handler]) =>
      // Rust sends a menu choice to the focused window only.
      listenInThisWindow(event, handler),
    );
    return () => {
      for (const p of unlistens) {
        void p.then((fn) => fn());
      }
    };
  }, []);
}
