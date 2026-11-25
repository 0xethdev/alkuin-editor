import { useEffect, useRef, useState, type MouseEvent } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useFileStats } from "@/hooks/use-tabs";
import { useBooleanSetting, useSetSetting } from "@/hooks/use-settings";
import {
  KEEP_ON_MAC_LABEL,
  KEEP_ON_MAC_SETTING_FAILED,
  inviteHiddenWhileKept,
  setKeepOnThisMac,
} from "@/lib/keep-on-mac";
import { macOnlyGet } from "@/lib/tauri";
import {
  caretMarkFlash,
  readCaretDiagText,
  setCaretDiagEnabled,
  subscribeCaretMark,
} from "@/lib/caret-diag-log";
import {
  FOOTER_METRICS,
  footerCountLabel,
  showFooterContextMenu,
  type FooterMetricSettingKey,
} from "./footer-context-menu";
import { showEditorNotice } from "./editor-notice-store";
import { InviteControl, useShareRole } from "@/features/document-share/desk";
import { useCaretDiag } from "./use-caret-diag";

export function KeepOnMacSwitch({
  kept,
  disabled,
  onToggle,
}: {
  kept: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      data-keep-on-mac
      aria-checked={kept}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-full text-left text-[var(--text-muted)] hover:text-[var(--fg-base)]"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span
        aria-hidden="true"
        className={`relative h-4 w-7 shrink-0 rounded-full border ${
          kept
            ? "border-[var(--fg-base)] bg-[var(--fg-base)]"
            : "border-[var(--text-icon-muted)] bg-transparent"
        }`}
      >
        <span
          className={`absolute top-px left-px h-3 w-3 rounded-full border border-[color-mix(in_srgb,var(--fg-base)_18%,transparent)] bg-[var(--page-bg,var(--bg-base))] ${
            kept ? "translate-x-3" : ""
          }`}
        />
      </span>
      <span className={kept ? "text-[var(--fg-base)]" : undefined}>{KEEP_ON_MAC_LABEL}</span>
    </button>
  );
}

/**
 * The Keep on this Mac only switch for one path. Every state names its path,
 * and a result that comes back for another path is dropped, so file A's
 * answer never becomes file B's switch. The switch waits for the real value
 * before it can be toggled.
 */
type KeepState =
  | { path: string; phase: "loading" }
  | { path: string; phase: "ready"; kept: boolean }
  | { path: string; phase: "saving"; kept: boolean };

function useKeepOnMac(filePath: string): {
  kept: boolean;
  /** This path's value has not come back yet. */
  loading: boolean;
  disabled: boolean;
  toggle: () => void;
} {
  const [state, setState] = useState<KeepState>({ path: filePath, phase: "loading" });
  const shown = useRef(filePath);
  useEffect(() => {
    shown.current = filePath;
    let cancelled = false;
    void macOnlyGet(filePath).then(
      (on) => {
        if (!cancelled) setState({ path: filePath, phase: "ready", kept: on });
      },
      () => {
        if (!cancelled) setState({ path: filePath, phase: "ready", kept: false });
      },
    );
    return () => {
      cancelled = true;
      shown.current = "";
    };
  }, [filePath]);
  const current: KeepState = state.path === filePath ? state : { path: filePath, phase: "loading" };
  const kept = current.phase === "loading" ? false : current.kept;
  const toggle = () => {
    if (current.phase !== "ready") return;
    const path = current.path;
    const before = current.kept;
    setState({ path, phase: "saving", kept: before });
    void setKeepOnThisMac(path, !before).then(
      (result) => {
        if (shown.current !== path) return;
        setState({ path, phase: "ready", kept: result.kept });
        if (result.line) showEditorNotice(result.line);
      },
      () => {
        if (shown.current !== path) return;
        showEditorNotice(KEEP_ON_MAC_SETTING_FAILED);
        // A partial change (on, then the delete failed) is read back, not guessed.
        void macOnlyGet(path).then(
          (on) => {
            if (shown.current === path) setState({ path, phase: "ready", kept: on });
          },
          () => {
            if (shown.current === path) setState({ path, phase: "ready", kept: before });
          },
        );
      },
    );
  };
  return {
    kept,
    loading: current.phase === "loading",
    disabled: current.phase !== "ready",
    toggle,
  };
}

function FooterMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[var(--text-muted)]">{value.toLocaleString()}</span>
      <span>{footerCountLabel(label, value)}</span>
    </div>
  );
}

export function DocumentFooter({ filePath }: { filePath: string }) {
  const stats = useFileStats(filePath);
  const setSetting = useSetSetting();
  const visibility: Record<FooterMetricSettingKey, boolean> = {
    "statusbar.show-words": useBooleanSetting("statusbar.show-words"),
    "statusbar.show-characters": useBooleanSetting("statusbar.show-characters"),
    "statusbar.show-paragraphs": useBooleanSetting("statusbar.show-paragraphs"),
  };
  const visibleMetrics = FOOTER_METRICS.filter((metric) => visibility[metric.settingKey]);
  const diag = useCaretDiag();
  const share = useShareRole(filePath);
  const [mark, setMark] = useState(caretMarkFlash);
  const keep = useKeepOnMac(filePath);
  useEffect(() => subscribeCaretMark(() => setMark(caretMarkFlash())), []);
  useEffect(() => {
    if (!mark) return;
    const timer = window.setTimeout(() => setMark(caretMarkFlash()), 1200);
    return () => window.clearTimeout(timer);
  }, [mark]);

  const toggleDiag = () => {
    if (diag.pinned) {
      showEditorNotice("Caret diagnostics stay on until you quit this launch.");
      return;
    }
    void setCaretDiagEnabled(!diag.enabled)
      .then((next) => {
        showEditorNotice(next.enabled ? "Caret diagnostics on" : "Caret diagnostics off");
      })
      .catch(() => showEditorNotice("Caret diagnostics did not change"));
  };

  const copyDiag = () => {
    void readCaretDiagText()
      .then(async (text) => {
        if (!text) {
          showEditorNotice("No diagnostics yet");
          return;
        }
        await writeText(text);
        showEditorNotice("Diagnostics copied");
      })
      .catch(() => showEditorNotice("Could not copy diagnostics"));
  };

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    void showFooterContextMenu({
      visibility,
      onToggle: (key, visible) => {
        void setSetting(key, visible);
      },
    });
  };

  return (
    <div
      data-document-footer
      onContextMenu={handleContextMenu}
      onClick={(event) => {
        if (!event.altKey) return;
        event.preventDefault();
        toggleDiag();
      }}
      className="flex absolute bottom-0 w-full z-10 min-h-11 shrink-0 items-start justify-end gap-5 px-6 py-3 text-[13px] leading-[1.35] text-[var(--text-muted)] md:px-8"
    >
      <div className="mr-auto flex min-w-0 flex-col gap-1">
        {share.role === "invitee" ? null : (
          <div className="flex min-h-8 items-center gap-5">
            <KeepOnMacSwitch kept={keep.kept} disabled={keep.disabled} onToggle={keep.toggle} />
            {keep.loading || inviteHiddenWhileKept(keep.kept) ? null : (
              <InviteControl key={filePath} path={filePath} />
            )}
          </div>
        )}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-5">
        {diag.enabled ? (
          <span data-caret-diag className="text-[var(--text-muted)]">
            diag on
          </span>
        ) : null}
        {mark ? (
          <span data-caret-mark className="text-[var(--fg-base)]">
            {mark}
          </span>
        ) : null}
        {diag.enabled ? (
          <button
            type="button"
            className="text-[var(--text-muted)] hover:text-[var(--fg-base)]"
            onClick={(event) => {
              event.stopPropagation();
              copyDiag();
            }}
          >
            Copy diagnostics
          </button>
        ) : null}
        {visibleMetrics.map((metric) => (
          <FooterMetric
            key={metric.settingKey}
            label={metric.footerLabel}
            value={stats[metric.statKey]}
          />
        ))}
      </div>
    </div>
  );
}
