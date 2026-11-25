import { useEffect, useRef, useState } from "react";
import { useGoogleDocImportStore } from "@/lib/office-exchange";

export function GoogleDocImportDialog() {
  const phase = useGoogleDocImportStore((state) => state.phase);
  if (phase.kind === "closed") return null;
  // A fresh opening starts with an empty field.
  return <GoogleDocImportForm key={phase.session} />;
}

function GoogleDocImportForm() {
  const phase = useGoogleDocImportStore((state) => state.phase);
  const closeDialog = useGoogleDocImportStore((state) => state.closeDialog);
  const clearError = useGoogleDocImportStore((state) => state.clearError);
  const submitLink = useGoogleDocImportStore((state) => state.submit);
  const [url, setUrl] = useState("");
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => field.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const busy = phase.kind === "importing";
  const error = phase.kind === "editing" ? phase.error : null;

  function submit() {
    if (!url.trim() || busy) return;
    void submitLink(url);
  }

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-6 py-6"
      role="presentation"
    >
      <div
        className="w-full max-w-[440px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="google-doc-import-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeDialog();
          }
        }}
      >
        <h2
          id="google-doc-import-title"
          className="text-[15px] font-semibold text-[var(--text-primary)]"
        >
          Import from Google Docs
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
          Paste a link. The document has to be shared so anyone with the link can view it. Alkuin
          downloads Google's Word export and does not sign in to Google.
        </p>
        <label className="mt-5 block">
          <span className="text-[12px] font-medium text-[var(--text-secondary)]">Link</span>
          <input
            ref={field}
            type="url"
            value={url}
            placeholder="https://docs.google.com/document/d/…"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              setUrl(event.target.value);
              clearError();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
            className="mt-1.5 h-9 w-full rounded-lg border border-transparent bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-secondary)] font-[inherit] outline-none focus:border-[var(--focus-border)] focus-visible:outline-none"
          />
        </label>
        {error ? (
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-primary)]">{error}</p>
        ) : null}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={closeDialog}
            disabled={busy}
            className="rounded-lg border border-[var(--line-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || url.trim().length === 0}
            className="rounded-lg bg-[var(--text-primary)] px-4 py-2 text-[13px] font-medium text-[var(--surface-primary)] disabled:opacity-40"
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
