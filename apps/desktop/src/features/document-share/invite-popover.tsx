import { SurfaceCard } from "@/components/surface-card";
import "./share.css";
import { EMAIL_LABEL, INVITE_HEADING, INVITE_SEND, ONE_DOCUMENT } from "./copy";

export function InvitePopover({
  title,
  email,
  onEmail,
  onSend,
  readOnly,
  sending,
}: {
  title: string;
  email: string;
  onEmail?: (value: string) => void;
  onSend: () => void;
  readOnly?: boolean;
  /** An invite is on its way. Send waits for it. */
  sending?: boolean;
}) {
  return (
    <SurfaceCard
      role="dialog"
      aria-label={INVITE_HEADING}
      className="absolute bottom-[calc(100%+12px)] left-0 z-20 w-[320px] p-4"
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[13px] text-[var(--fg-base)]">{title}</p>
        <p className="m-0 text-[13px] text-[var(--text-muted)]">{ONE_DOCUMENT}</p>
        <label className="flex flex-col gap-1.5 text-[12px] text-[var(--text-muted)]">
          {EMAIL_LABEL}
          <input
            readOnly={readOnly || sending}
            value={email}
            aria-label={EMAIL_LABEL}
            onChange={(event) => onEmail?.(event.target.value)}
            className="h-[32px] rounded-lg bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-primary)] outline-none"
          />
        </label>
        <button
          type="button"
          className="invite-action"
          disabled={sending}
          aria-busy={sending || undefined}
          onClick={onSend}
        >
          {INVITE_SEND}
        </button>
      </div>
    </SurfaceCard>
  );
}
