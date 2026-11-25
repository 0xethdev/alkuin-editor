import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SUPPORT_EMAIL } from "@/lib/account-copy";
import { appBuildLabel } from "@/lib/build-stamp";
import {
  FEEDBACK_KINDS,
  feedbackNotice,
  submitFeedback,
  type FeedbackKind,
  type FeedbackSubmit,
} from "./feedback";

function FeedbackNotice({ result }: { result: FeedbackSubmit }) {
  const line = feedbackNotice(result);
  const role = result.state === "opened" ? "status" : "alert";
  const at = line.indexOf(SUPPORT_EMAIL);
  if (result.state !== "failed" || at < 0) {
    return (
      <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]" role={role}>
        {line}
      </p>
    );
  }
  return (
    <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]" role={role}>
      {line.slice(0, at)}
      <a href={result.url} className="underline">
        {SUPPORT_EMAIL}
      </a>
      {line.slice(at + SUPPORT_EMAIL.length)}
    </p>
  );
}

export function FeedbackForm({ email }: { email: string | null }) {
  const [kind, setKind] = useState<FeedbackKind>("feature");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FeedbackSubmit | null>(null);

  return (
    <section>
      <h2 className="mb-3 text-[15px] font-medium text-[var(--text-primary)]">Feedback</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          void submitFeedback({ kind, note, email, build: appBuildLabel() }, (url) => openUrl(url))
            .then((next) => {
              setResult(next);
              if (next.state === "opened") setNote("");
            })
            .finally(() => setBusy(false));
        }}
      >
        <div
          role="radiogroup"
          aria-label="Request a feature or report a bug"
          className="inline-flex overflow-hidden rounded-lg border border-[var(--line-subtle)]"
        >
          {FEEDBACK_KINDS.map((option) => {
            const selected = kind === option.kind;
            return (
              <button
                key={option.kind}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setKind(option.kind);
                  setResult(null);
                }}
                className={
                  selected
                    ? "bg-[var(--text-primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--surface-primary)]"
                    : "px-3 py-1.5 text-[13px] text-[var(--text-secondary)]"
                }
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <label htmlFor="feedback-note" className="mt-3 block text-[12px] text-[var(--text-muted)]">
          Note
        </label>
        <textarea
          id="feedback-note"
          value={note}
          rows={4}
          disabled={busy}
          aria-invalid={result?.state === "empty" || result?.state === "too_long"}
          onChange={(event) => {
            setNote(event.target.value);
            setResult(null);
          }}
          className="mt-1.5 w-full resize-y rounded-lg border border-[var(--line-subtle)] bg-transparent px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none"
        />
        {result ? <FeedbackNotice result={result} /> : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-3 rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] px-4 py-2 text-[13px] font-medium text-[var(--text-primary)] disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}
