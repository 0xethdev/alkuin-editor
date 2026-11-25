import "@/wdyr";
import { createRoot } from "react-dom/client";
import { InvitePreview } from "./preview";

/**
 * Throwaway desk for the invite preview. Off unless Vite is in development.
 * The app entry never imports this file, and the desktop bundle does not.
 */

function applyDeskTheme() {
  const root = document.documentElement;
  root.dataset.theme = "light";
  root.style.setProperty("--bg-base", "#ffffff");
  root.style.setProperty("--fg-base", "#2c2824");
  root.style.setProperty("--accent", "#ff6a00");
  root.style.setProperty("--bg-opacity", "1");
  root.style.setProperty("--contrast", "0.36");
  root.style.setProperty(
    "--ui-font",
    '"Paper Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  );
  root.style.setProperty(
    "--editor-font",
    '"Paper Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  );
  root.style.setProperty(
    "--mono-font",
    '"Paper Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  );
  root.style.setProperty("--writer-editor-font-size", "16.5px");
  root.style.setProperty("--writer-editor-line-height", "1.65");
  root.style.setProperty("--writer-editor-max-width", "62ch");
  root.style.setProperty("--writer-editor-side-padding", "2.5rem");
}

const enabled = import.meta.env.DEV;

if (!enabled) {
  document.documentElement.dataset.invitePreview = "off";
} else {
  applyDeskTheme();
  const params = new URLSearchParams(location.search);
  const screen = params.get("screen");
  const shown = screen === "copy" || screen === "margin" || screen === "invite" ? screen : "invite";
  document.body.dataset.invitePreview = "on";
  createRoot(document.getElementById("root") as HTMLElement).render(
    <InvitePreview screen={shown} />,
  );
}
