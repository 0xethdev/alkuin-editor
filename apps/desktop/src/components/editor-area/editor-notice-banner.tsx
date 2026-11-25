import { overlapPreview, showOverlap } from "@/lib/history/steps";
import { settleOverlap } from "@/lib/history/settle";
import { dismissEditorNotice, useEditorNoticeStore } from "./editor-notice-store";

const bannerStyle = {
  background: "var(--surface-card)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  border: "1px solid var(--line-subtler)",
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
  color: "var(--text-secondary)",
  letterSpacing: "-0.01em",
} as const;

export function EditorNoticeBanner() {
  const message = useEditorNoticeStore((s) => s.message);
  const overlap = useEditorNoticeStore((s) => s.overlap);
  if (!message && !overlap) return null;
  const suggestion = overlap
    ? showOverlap(overlap.localText, overlap.otherText, overlap.deleted)
    : null;
  if (!overlap || !suggestion) {
    return (
      <button
        type="button"
        onClick={dismissEditorNotice}
        className="pointer-events-auto absolute left-1/2 top-6 z-30 max-w-[90%] -translate-x-1/2 cursor-pointer rounded-lg border-0 px-3 py-2 text-left text-[13px]"
        style={bannerStyle}
      >
        {message}
      </button>
    );
  }
  const preview = overlapPreview(suggestion.otherText);
  return (
    <div
      className="pointer-events-auto absolute left-1/2 top-6 z-30 max-w-[90%] -translate-x-1/2 rounded-lg px-3 py-2 text-left text-[13px]"
      style={bannerStyle}
    >
      {suggestion.line ? <p>{suggestion.line}</p> : null}
      {preview ? <p className="mt-1">{preview}</p> : null}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => void settleOverlap(overlap, "accept")}>
          {suggestion.acceptLabel}
        </button>
        <button type="button" onClick={() => void settleOverlap(overlap, "reject")}>
          {suggestion.rejectLabel}
        </button>
      </div>
    </div>
  );
}
