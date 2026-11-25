import { useEffect, useRef, useState } from "react";
import { onWriterAsk, saveOverage } from "@/lib/account-billing";
import {
  OVERAGE_MAX_LABEL,
  OVERAGE_MAX_PLACEHOLDER,
  OVERAGE_NEED_MAX,
  OVERAGE_PROMPT_LIGHTER,
  OVERAGE_PROMPT_ON,
  OVERAGE_PROMPT_TITLE,
  allowanceResetText,
  dollarFieldText,
  dollarsFromField,
  overagePromptBody,
  withDollarSign,
} from "@/lib/account-copy";
import { accountReadTicket } from "@/lib/account-plan-refresh";
import { rememberAccountAnswer } from "@/lib/account-session";
import * as tauri from "@/lib/tauri";
import type { AccountPreferences } from "@/lib/tauri";

type Prompt =
  | { kind: "closed" }
  | {
      kind: "open";
      maximum: string;
      price: string | null;
      resetDate: string;
      note: string | null;
      busy: boolean;
    };

const CLOSED: Prompt = { kind: "closed" };

function openPrompt(result: AccountPreferences): Prompt {
  const saved = typeof result.overage_maximum === "number" ? result.overage_maximum : null;
  const fallback =
    typeof result.overage_default_dollars === "number" ? result.overage_default_dollars : null;
  return {
    kind: "open",
    maximum: dollarFieldText(saved, fallback),
    price: typeof result.overage_ask_price === "string" ? result.overage_ask_price : null,
    resetDate: allowanceResetText(result.allowance_resets),
    note: null,
    busy: false,
  };
}

/** Once a paid writer reaches the monthly allowance, ask once that month. */
export function OveragePrompt() {
  const [prompt, setPrompt] = useState<Prompt>(CLOSED);
  /** The read ticket when the last answer was saved. A look issued before it read
   *  the account before the answer, so it cannot open the prompt again. */
  const answered = useRef(0);
  const choosing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const look = () => {
      const ticket = accountReadTicket();
      void tauri
        .accountPreferences()
        .then((result) => {
          if (cancelled) return;
          rememberAccountAnswer(result);
          if (result.overage_prompt !== true || ticket < answered.current) return;
          setPrompt((current) => (current.kind === "open" ? current : openPrompt(result)));
        })
        .catch(() => undefined);
    };
    look();
    const stop = onWriterAsk(() => {
      if (!cancelled) look();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  if (prompt.kind !== "open") return null;
  const { maximum, price, resetDate, note, busy } = prompt;

  function edit(change: Partial<Extract<Prompt, { kind: "open" }>>) {
    setPrompt((current) => (current.kind === "open" ? { ...current, ...change } : current));
  }

  async function choose(overage: boolean) {
    if (busy || choosing.current) return;
    const parsed = overage ? dollarsFromField(maximum) : null;
    if (overage && parsed == null) {
      edit({ note: OVERAGE_NEED_MAX });
      return;
    }
    choosing.current = true;
    edit({ busy: true });
    const saved = await saveOverage(overage, parsed, true);
    choosing.current = false;
    if (saved) {
      answered.current = accountReadTicket();
      setPrompt(CLOSED);
      return;
    }
    edit({ busy: false });
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
        aria-labelledby="overage-prompt-title"
      >
        <h2
          id="overage-prompt-title"
          className="text-[15px] font-semibold text-[var(--text-primary)]"
        >
          {OVERAGE_PROMPT_TITLE}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
          {overagePromptBody(price, resetDate)}
        </p>
        <label className="mt-4 block text-[12px] text-[var(--text-muted)]">
          {OVERAGE_MAX_LABEL}
          <input
            className="mt-1 block w-32 rounded-lg border border-[var(--line-subtle)] bg-transparent px-2 py-1 text-[13px] text-[var(--text-primary)]"
            inputMode="decimal"
            placeholder={OVERAGE_MAX_PLACEHOLDER}
            value={maximum}
            onChange={(event) => edit({ maximum: withDollarSign(event.target.value) })}
          />
        </label>
        {note ? <p className="mt-2 text-[12px] text-[var(--text-secondary)]">{note}</p> : null}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose(false)}
            className="rounded-lg border border-[var(--line-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] disabled:opacity-40"
          >
            {OVERAGE_PROMPT_LIGHTER}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose(true)}
            className="rounded-lg bg-[var(--text-primary)] px-4 py-2 text-[13px] font-medium text-[var(--surface-primary)] disabled:opacity-40"
          >
            {OVERAGE_PROMPT_ON}
          </button>
        </div>
      </div>
    </div>
  );
}
