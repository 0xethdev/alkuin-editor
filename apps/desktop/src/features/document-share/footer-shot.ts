import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { DocumentFooter } from "@/components/editor-area/document-footer";
import { EditorNoticeBanner } from "@/components/editor-area/editor-notice-banner";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { confirmCopy } from "@/features/document-removal/copy";
import { DELETE_ONLINE_LEFT } from "@/lib/keep-on-mac";
import { useEditorStore } from "@/stores/editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import "@/App.css";
import "@/fonts/paper-mono.css";

const PATH = "/notes/Tutorial.md";

function mockTauri(kept: boolean) {
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        if (cmd === "mac_only_get") return kept;
        if (cmd === "share_role") {
          return { role: "none", share_id: null, document_id: "tutorial" };
        }
        if (cmd === "caret_diag_status") return { enabled: false, pinned: false, path: "" };
        return null;
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    },
  });
}

function seedDesk() {
  useSettingsStore.setState({
    isLoaded: true,
    settings: {
      "statusbar.show-words": true,
      "statusbar.show-characters": false,
      "statusbar.show-paragraphs": false,
      "appearance.theme": "light",
      "theme.light.background": "#F3EEE4",
      "theme.light.foreground": "#141312",
    },
  });
  useEditorStore.setState({
    openFiles: new Map([
      [
        PATH,
        {
          path: PATH,
          stats: { words: 254, characters: 1462, paragraphs: 14 },
          isLoading: false,
        },
      ],
    ]) as never,
  });
  document.documentElement.style.setProperty("--page-bg", "#F7F3EC");
  document.documentElement.style.setProperty("--bg-base", "#F3EEE4");
  document.documentElement.style.setProperty("--fg-base", "#141312");
  document.documentElement.style.setProperty("--text-muted", "#6F6A62");
  document.documentElement.style.setProperty("--text-icon-muted", "#6F6A62");
  document.documentElement.style.setProperty("--accent", "#D33C33");
}

const VARIANT_B = `
  [data-variant="b"] .invite-footer {
    height: 32px;
    margin-left: 4px;
    padding: 0 4px 0 12px;
    border: 0;
    border-left: 1px solid color-mix(in srgb, var(--fg-base) 22%, transparent);
    border-radius: 0;
    background: transparent;
    font-weight: 500;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  [data-variant="b"] .invite-footer:hover {
    background: transparent;
  }
`;

function pageChrome(kept: boolean) {
  document.documentElement.style.width = "1280px";
  document.documentElement.style.height = "800px";
  document.body.style.margin = "0";
  document.body.style.width = "1280px";
  document.body.style.height = "800px";
  document.body.style.overflow = "hidden";
  document.body.style.background = "#F7F3EC";
  document.body.style.color = "#141312";
  document.body.style.fontFamily = '"Paper Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  document.body.replaceChildren();
  const frame = document.createElement("div");
  frame.dataset.footerFrame = "true";
  frame.style.cssText =
    "position:relative;width:1280px;height:800px;background:#F7F3EC;display:flex;flex-direction:column;";
  const bar = document.createElement("div");
  bar.style.cssText =
    "height:36px;display:flex;align-items:center;justify-content:center;background:#F3EEE4;color:#6F6A62;font-size:12px;border-bottom:1px solid rgba(20,19,18,0.08);";
  bar.textContent = "Alkuin — Tutorial.md";
  const draft = document.createElement("div");
  draft.style.cssText =
    "padding:48px 72px 120px;font-size:14px;line-height:1.8;max-width:680px;color:#2A2723;";
  const heading = document.createElement("h2");
  heading.textContent = "Invite and tag";
  heading.style.cssText = "margin:0 0 12px;font-size:16px;font-weight:500;";
  const paragraph = document.createElement("p");
  paragraph.style.margin = "0";
  paragraph.textContent = kept
    ? "Keep on this Mac only is on. Invite someone leaves this footer until the switch is off."
    : "Find Invite someone at the bottom of the document, beside Keep on this Mac only.";
  draft.append(heading, paragraph);
  const mount = document.createElement("div");
  mount.style.cssText = "position:relative;flex:1;min-height:0;";
  frame.append(bar, draft, mount);
  document.body.append(frame);
  return mount;
}

function confirmCard() {
  const copy = confirmCopy("mac-only");
  const veil = document.createElement("div");
  veil.dataset.keepConfirm = "true";
  veil.style.cssText =
    "position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(20,19,18,0.28);";
  const card = document.createElement("div");
  card.style.cssText =
    "width:420px;padding:24px;background:#F7F3EC;color:#141312;border:1px solid rgba(20,19,18,0.16);border-radius:12px;";
  const title = document.createElement("h2");
  title.textContent = copy.title;
  title.style.cssText = "margin:0 0 12px;font-size:16px;font-weight:500;";
  const body = document.createElement("p");
  body.textContent = copy.body;
  body.style.cssText = "margin:0 0 20px;font-size:14px;line-height:1.45;";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:16px;";
  for (const [label, primary] of [
    [copy.cancel, false],
    [copy.confirm, true],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = primary
      ? "height:32px;padding:0 12px;border-radius:8px;border:1px solid #141312;background:#141312;color:#F7F3EC;font:inherit;font-size:13px;"
      : "height:32px;padding:0 12px;border:0;background:transparent;color:#141312;font:inherit;font-size:13px;";
    actions.append(button);
  }
  card.append(title, body, actions);
  veil.append(card);
  return veil;
}

export function renderFooterShot(shot: string) {
  const kept = shot === "footer-kept" || shot === "keep-decline";
  mockTauri(kept);
  seedDesk();
  if (shot === "footer-invite-b") document.body.dataset.variant = "b";
  const style = document.createElement("style");
  style.textContent = VARIANT_B;
  document.head.append(style);
  const mount = pageChrome(kept);
  const footerHost = document.createElement("div");
  footerHost.style.cssText = "position:absolute;inset:0;";
  mount.append(footerHost);
  if (shot === "keep-confirm") {
    const frame = document.querySelector("[data-footer-frame]");
    (frame ?? mount).append(confirmCard());
  }
  if (shot === "keep-decline") {
    showEditorNotice(DELETE_ONLINE_LEFT);
    const frame = document.querySelector("[data-footer-frame]");
    const host = document.createElement("div");
    host.dataset.keepDecline = "true";
    host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:30;";
    (frame ?? mount).append(host);
    createRoot(host).render(createElement(EditorNoticeBanner));
  }
  createRoot(footerHost).render(createElement(DocumentFooter, { filePath: PATH }));
  const ready = () => {
    document.body.dataset.shotReady = "1";
  };
  const wait = () => {
    const invite = document.querySelector("[data-invite]");
    const helper = document.querySelector("[data-keep-helper]");
    const toggle = document.querySelector("[data-keep-on-mac]");
    const on = toggle?.getAttribute("aria-checked") === "true";
    if (helper || !toggle) return false;
    if (shot === "keep-decline") {
      return (
        on &&
        !invite &&
        (document.body.textContent ?? "").includes(
          "The online copy is still there. Nothing new will be sent.",
        )
      );
    }
    if (kept) return on && !invite;
    if (shot === "keep-confirm" && !document.querySelector("[data-keep-confirm]")) return false;
    return Boolean(invite) && !on;
  };
  const poll = () => {
    if (wait()) {
      requestAnimationFrame(ready);
      return;
    }
    window.setTimeout(poll, 50);
  };
  window.setTimeout(poll, 50);
}
