import { useEffect } from "react";
import { AppLayout } from "./components/app-layout";
import { installAccountPlanRefresh } from "@/lib/account-plan-refresh";
import { watchInviteRefusals } from "@/features/document-share/invite-arrival";
import { SignInGate } from "./components/sign-in-gate";
import { CommandPalette } from "./components/command-palette";
import { GoogleDocImportDialog } from "./components/google-doc-import-dialog";
import { OveragePrompt } from "./components/overage-prompt";
import { TelemetryConsentDialog } from "./components/telemetry-consent-dialog";
import { WindowTitle } from "./components/window-title";
import { useIsStartupResolved } from "./hooks/use-workspace";
import { useFileWatcher } from "./hooks/use-file-watcher";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { useMenuEvents } from "./hooks/use-menu-events";
import { useGitQueueOnlineFlush } from "./hooks/use-git-queue";
import { useOpenDrop } from "./hooks/use-open-drop";
import { useSaveBeforeClose } from "./hooks/use-save-before-close";
import { useSaveBeforeQuit } from "./hooks/use-save-before-quit";
import "./lib/global-recents";
import "./lib/standalone-watch";
import "./App.css";

function App() {
  const isStartupResolved = useIsStartupResolved();

  useEffect(() => installAccountPlanRefresh(), []);
  useEffect(() => watchInviteRefusals(), []);
  useFileWatcher();
  useKeyboardShortcuts();
  useMenuEvents();
  useOpenDrop();
  useGitQueueOnlineFlush();
  useSaveBeforeClose();
  useSaveBeforeQuit();

  if (!isStartupResolved) {
    return null;
  }

  return (
    <>
      <WindowTitle />
      <SignInGate>
        <AppLayout />
        {/* Inside the gate: it asks once the desk is up. Mounted beside the
            gate it opened under the sign-in screen, unseen, and its key
            handler took Tab and Escape from the sign-in form. */}
        <TelemetryConsentDialog />
      </SignInGate>
      <CommandPalette />
      <OveragePrompt />
      <GoogleDocImportDialog />
    </>
  );
}

export default App;
