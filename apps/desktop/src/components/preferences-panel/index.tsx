import { useEffect, useRef, useState, type ReactNode } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { EditorScrollContainer } from "@/components/editor-area/editor-scroll-container";
import {
  dateLine,
  planLabel,
  preferencesStatusLine,
  type PlanKind,
  type ServerBudget,
} from "@/features/redline-spike/budget-status";
import {
  CLEAR_NEEDS_CONNECTION,
  CLEAR_STYLE_BODY,
  CLEAR_STYLE_CONFIRM,
  CLEAR_STYLE_KEEP,
  CLEAR_STYLE_TITLE,
  FORGET_STYLE_BUTTON,
  GROUP_CITE,
  GROUP_HOUSE,
  GROUP_POLISH,
  OFFLINE_PLAN_LINE,
  PLAN_FIELD_LABEL,
  PLENTY_MONTH_LINE,
  SIGN_OUT_LABEL,
  SIGNED_OUT_PLAN_LINE,
  STYLE_EMPTY,
  STYLE_FREE_LINE,
  STYLE_FREE_SAVED,
  STYLE_HEADING,
  STYLE_SUBLINE,
  styleNotesVisible,
} from "@/features/redline-spike/margin-copy";
import {
  dropVisibleStyleRule,
  forgetAllStyle,
  readStyleMemory,
  rememberStyleItems,
  styleRuleKey,
} from "@/features/redline-spike/style-memory";
import { shownStyleItems, type StyleItem } from "@/features/redline-spike/style-items";
import { rememberAccountAnswer, rememberWritingPlan } from "@/lib/account-session";
import { runDeleteAccount } from "@/lib/account-delete";
import {
  accountReadTicket,
  noteCheckoutStarted,
  subscribeAccountRefresh,
} from "@/lib/account-plan-refresh";
import { openAccountSignIn, returnToWelcome } from "@/lib/account-sign-in";
import {
  CANCEL_FALLBACK_LINE,
  DELETE_ACCOUNT_CONFIRM,
  BUY_CREDIT,
  COPY_CODE,
  CREDIT_NOTE,
  FOUNDING_NOT_CHARGED,
  FREE_CONTINUE,
  MONTHLY_PLAN,
  creditIsPositive,
  creditLine,
  checkoutButtonWeight,
  planCheckoutIntervals,
  PORTAL_BUTTON,
  PRICE_LINE,
  REF_COPIED,
  REF_HELPER,
  REFUND_BUTTON,
  REFUND_KEEP,
  RENEWAL_LINE,
  referralClipboardText,
  referralCodeText,
  SIGN_IN_LABEL,
  SUBSCRIBE_WAIT,
  YEARLY_PLAN,
  accountNoticeMessage,
  allowanceLine,
  showExtraCredit,
} from "@/lib/account-copy";
import { cancelPreview, refundPurchase, startSubscription } from "@/lib/account-billing";
import { ExternalLink, TERMS_URL } from "@/lib/legal-links";
import * as tauri from "@/lib/tauri";
import type { AccountPreferences } from "@/lib/tauri";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { MentionEmailSwitch } from "@/features/note-mention/preference";
import { appBuildLabel } from "@/lib/build-stamp";
import {
  createAccountOrder,
  NO_DIALOG,
  reducePanelDialog,
  type PanelDialog,
  type PanelDialogEvent,
} from "./account-state";
import { FeedbackForm } from "./feedback-form";

/** The groups Preferences lists. */
const GROUPS: { scope: StyleItem["scope"]; heading: string }[] = [
  { scope: "house", heading: GROUP_HOUSE },
  { scope: "polish", heading: GROUP_POLISH },
  { scope: "cite", heading: GROUP_CITE },
];

type PreferencesSnapshot = {
  signedIn: boolean;
  offline: boolean;
  email: string | null;
  effective: PlanKind | null;
  spent: number;
  softCap: number;
  hardCap: number;
  windowEnd: string | null;
  items: StyleItem[];
  euConsent: boolean;
  refundOpen: boolean;
  allowancePercent: number | null;
  usedPct: number | null;
  accountId: string | null;
  overage: boolean;
  overageMaximum: number | null;
  overageDefault: number | null;
  allowanceResets: string | null;
  credit: string;
  frozen: boolean;
  referralCode: string | null;
};

function asPlan(value: string | null | undefined): PlanKind | null {
  if (value === "paid" || value === "founding" || value === "free") return value;
  return null;
}

/** The window reads the server numbers through the shared budget helper. */
function snapshotStatus(snapshot: PreferencesSnapshot): {
  plan: string;
  date: string;
  status: string;
} | null {
  if (!snapshot.signedIn || !snapshot.effective) return null;
  const budget: ServerBudget = {
    spent: snapshot.spent,
    softCap: snapshot.softCap,
    hardCap: snapshot.hardCap,
    effective: snapshot.effective,
    windowEnd: snapshot.windowEnd,
    frozen: snapshot.frozen,
  };
  return {
    plan: planLabel(snapshot.effective),
    date: dateLine(budget),
    status: snapshot.offline ? OFFLINE_PLAN_LINE : preferencesStatusLine(budget),
  };
}

function usagePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

const PRIMARY_BUTTON =
  "rounded-lg bg-[var(--text-primary)] px-4 py-2 text-[13px] font-medium text-[var(--surface-primary)]";
const SECONDARY_BUTTON =
  "rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] px-4 py-2 text-[13px] font-medium text-[var(--text-primary)]";
const QUIET_LINK = "text-[13px] text-[var(--text-muted)] disabled:opacity-40";
const FINE_LINK = "underline underline-offset-2 hover:text-[var(--text-secondary)]";
const TEXT_LINK =
  "text-[13px] text-[var(--text-primary)] underline decoration-[var(--line-subtle)] underline-offset-[3px]";

function AccountField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-[var(--line-subtler)] px-4 py-2">
      <span className="w-20 shrink-0 pt-0.5 text-[13px] text-[var(--text-muted)]">{label}</span>
      <div className="min-w-0 flex-1 text-[14px] text-[var(--text-primary)]">{children}</div>
    </div>
  );
}

function ReferralCopy({ code }: { code: string }) {
  return (
    <span className="block">
      <span className="flex items-center gap-2">
        <span className="font-mono text-[14px] tracking-[0.04em]">{code}</span>
        <button
          type="button"
          onClick={() => {
            const text = referralClipboardText(code);
            if (!text) return;
            void writeText(text).then(
              () => showEditorNotice(REF_COPIED),
              () => undefined,
            );
          }}
          className="rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] px-3 py-1 text-[12px] font-medium text-[var(--text-primary)]"
        >
          {COPY_CODE}
        </button>
      </span>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">{REF_HELPER}</p>
    </span>
  );
}

function checkoutLabel(interval: "year" | "month" | "topup"): string {
  if (interval === "year") return YEARLY_PLAN;
  if (interval === "month") return MONTHLY_PLAN;
  return BUY_CREDIT;
}

function BillingControls({
  snapshot,
  onSubscribe,
  onPortal,
  onAskCancel,
  cancelBusy,
  onSignOut,
}: {
  snapshot: PreferencesSnapshot;
  onSubscribe: (interval: "month" | "year" | "topup", referral?: string) => void;
  onPortal: () => void;
  onAskCancel: () => void;
  cancelBusy: boolean;
  onSignOut: () => void;
}) {
  const offline = snapshot.offline || !snapshot.effective;
  const extra = showExtraCredit(snapshot.effective, snapshot.usedPct, snapshot.credit);
  const intervals = offline ? [] : planCheckoutIntervals(snapshot.effective, extra);
  const showCredit = intervals.includes("topup");
  const subscribes = intervals.some((interval) => interval !== "topup");
  return (
    <div>
      {snapshot.effective === "founding" && !offline ? (
        <p className="px-4 pt-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {FOUNDING_NOT_CHARGED}
        </p>
      ) : null}
      {snapshot.effective === "free" && !offline ? (
        <div className="px-4 pt-3">
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">{PRICE_LINE}</p>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {FREE_CONTINUE}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        {intervals.map((interval) => (
          <button
            key={interval}
            type="button"
            onClick={() => onSubscribe(interval)}
            className={
              checkoutButtonWeight(interval, snapshot.effective) === "primary"
                ? PRIMARY_BUTTON
                : SECONDARY_BUTTON
            }
          >
            {checkoutLabel(interval)}
          </button>
        ))}
        {snapshot.effective === "paid" && !offline ? (
          <button type="button" onClick={onPortal} className={TEXT_LINK}>
            {PORTAL_BUTTON}
          </button>
        ) : null}
        {snapshot.effective === "paid" && !offline ? (
          <button type="button" onClick={onAskCancel} disabled={cancelBusy} className={QUIET_LINK}>
            {REFUND_BUTTON}
          </button>
        ) : null}
        <button type="button" onClick={onSignOut} className={QUIET_LINK}>
          {SIGN_OUT_LABEL}
        </button>
      </div>
      {intervals.length > 0 ? (
        <p className="px-4 pb-3 text-[12px] leading-relaxed text-[var(--text-muted)]">
          {subscribes ? `${RENEWAL_LINE} ` : null}
          By choosing a plan, you agree to the{" "}
          <ExternalLink href={TERMS_URL} className={FINE_LINK}>
            Terms
          </ExternalLink>
          .
        </p>
      ) : null}
      {showCredit ? (
        <div className="border-t border-[var(--line-subtler)] px-4 py-3">
          {snapshot.effective === "paid" || creditIsPositive(snapshot.credit) ? (
            <p className="text-[13px] font-medium text-[var(--text-primary)]">
              {creditLine(snapshot.credit)}
            </p>
          ) : null}
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">{CREDIT_NOTE}</p>
        </div>
      ) : null}
    </div>
  );
}

function PreferencesView({
  snapshot,
  onSignIn,
  onSignOut,
  onClear,
  onKeep,
  onConfirmClear,
  onDelete,
  onForgetRule,
  onSubscribe,
  onPortal,
  onAskCancel,
  onKeepPlan,
  onConfirmCancel,
  dialog,
}: {
  snapshot: PreferencesSnapshot;
  onSignIn: () => void;
  onSignOut: () => void;
  onClear: () => void;
  onKeep: () => void;
  onConfirmClear: () => void;
  onDelete: () => void;
  onForgetRule: (item: StyleItem) => void;
  onSubscribe: (interval: "month" | "year" | "topup", referral?: string) => void;
  onPortal: () => void;
  onAskCancel: () => void;
  onKeepPlan: () => void;
  onConfirmCancel: () => void;
  dialog: PanelDialog;
}) {
  const lines = snapshotStatus(snapshot);
  const cancelBusy = dialog.kind === "cancel" && dialog.busy;
  const learned = readStyleMemory();
  const items = shownStyleItems(learned.length > 0 ? learned : snapshot.items);
  const groups = GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.scope === group.scope),
  })).filter((group) => group.items.length > 0);
  const notes = styleNotesVisible(snapshot.effective, groups.length);

  return (
    <div data-preferences-panel className="mx-auto max-w-2xl px-8 pt-32 pb-24 md:pt-[9rem]">
      <h1 className="mb-10 text-2xl font-semibold text-[var(--text-primary)]">Preferences</h1>

      <section className="mb-10">
        <h2 className="mb-3 text-[15px] font-medium text-[var(--text-primary)]">Account</h2>
        {!snapshot.signedIn ? (
          <div className="rounded-xl border border-[var(--line-subtler)] px-4 py-4">
            <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {SIGNED_OUT_PLAN_LINE}
            </p>
            <button type="button" onClick={onSignIn} className={`mt-4 ${PRIMARY_BUTTON}`}>
              {SIGN_IN_LABEL}
            </button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--line-subtler)] bg-[var(--surface-subtle)]">
            {snapshot.email ? (
              <AccountField label="Email">
                <span>{snapshot.email}</span>
              </AccountField>
            ) : null}
            {lines ? (
              <AccountField label={PLAN_FIELD_LABEL}>
                <p>{lines.plan}</p>
                {lines.date ? (
                  <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{lines.date}</p>
                ) : null}
                {lines.status && lines.status !== PLENTY_MONTH_LINE ? (
                  <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                    {lines.status}
                  </p>
                ) : null}
              </AccountField>
            ) : null}
            {snapshot.usedPct != null ? (
              <AccountField label="Usage">
                <p className="text-[14px]">{allowanceLine(usagePercent(snapshot.usedPct))}</p>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={usagePercent(snapshot.usedPct)}
                  aria-label={allowanceLine(usagePercent(snapshot.usedPct))}
                  className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--line-subtler)]"
                >
                  <div
                    className="h-full bg-[var(--text-primary)]"
                    style={{ width: `${usagePercent(snapshot.usedPct)}%` }}
                  />
                </div>
              </AccountField>
            ) : null}
            {snapshot.referralCode ? (
              <AccountField label="Referral">
                <ReferralCopy code={snapshot.referralCode} />
              </AccountField>
            ) : null}
            <BillingControls
              snapshot={snapshot}
              onSubscribe={onSubscribe}
              onPortal={onPortal}
              onAskCancel={onAskCancel}
              cancelBusy={cancelBusy}
              onSignOut={onSignOut}
            />
          </div>
        )}
      </section>

      {snapshot.signedIn ? (
        <section className="mb-16">
          <h2 className="mb-1 text-[15px] font-medium text-[var(--text-primary)]">
            {STYLE_HEADING}
          </h2>
          <p className="mb-4 text-[13px] leading-relaxed text-[var(--text-muted)]">
            {snapshot.effective === "free" ? STYLE_FREE_LINE : STYLE_SUBLINE}
          </p>
          {notes.savedLine ? (
            <p className="mb-4 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {STYLE_FREE_SAVED}
            </p>
          ) : null}
          {notes.rows ? (
            groups.map((group) => (
              <div key={group.scope} className="mb-6">
                <h3 className="mb-2 text-[13px] font-medium text-[var(--text-muted)]">
                  {group.heading}
                </h3>
                <ul className="overflow-hidden rounded-2xl border border-[var(--line-subtler)]">
                  {group.items.map((item) => (
                    <li
                      key={styleRuleKey(item)}
                      className="flex items-start justify-between gap-3 border-b border-[var(--line-subtler)] px-4 py-3 last:border-b-0"
                    >
                      <div>
                        <p className="text-[13px] text-[var(--text-primary)]">{item.rule}</p>
                        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                          {item.why}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Delete ${item.rule}`}
                        disabled={snapshot.offline}
                        onClick={() => onForgetRule(item)}
                        className="text-[16px] leading-none text-[var(--text-muted)] disabled:opacity-40"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : notes.empty ? (
            <p className="mb-4 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {STYLE_EMPTY}
            </p>
          ) : null}
          {notes.clear ? (
            <button
              type="button"
              disabled={snapshot.offline}
              onClick={onClear}
              title="Clear all"
              className="rounded-lg border border-[var(--line-subtle)] px-4 py-2 text-[13px] text-[var(--text-secondary)] disabled:opacity-40"
            >
              {FORGET_STYLE_BUTTON}
            </button>
          ) : null}
          {notes.clear && snapshot.offline ? (
            <p className="mt-2 text-[12px] text-[var(--text-muted)]">{CLEAR_NEEDS_CONNECTION}</p>
          ) : null}
        </section>
      ) : null}

      <section className="mt-2 border-t border-[var(--line-subtler)] pt-8">
        <FeedbackForm email={snapshot.email} />
        <MentionEmailSwitch signedIn={snapshot.signedIn} />
      </section>

      {snapshot.signedIn ? (
        <div className="border-t border-[var(--line-subtler)] pt-8">
          <button type="button" onClick={onDelete} className="text-[13px] text-[var(--text-muted)]">
            {DELETE_ACCOUNT_CONFIRM}
          </button>
        </div>
      ) : null}

      <p
        data-app-build
        className="mt-16 border-t border-[var(--line-subtler)] pt-8 text-[12px] text-[var(--text-muted)]"
      >
        {appBuildLabel()}
      </p>

      {dialog.kind === "cancel" ? (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-6 py-6"
          role="presentation"
        >
          <div
            className="w-full max-w-[440px]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-subscription-title"
          >
            <h2
              id="cancel-subscription-title"
              className="text-[15px] font-semibold text-[var(--text-primary)]"
            >
              {REFUND_BUTTON}
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {dialog.line ?? CANCEL_FALLBACK_LINE}
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onKeepPlan}
                disabled={dialog.busy}
                className="rounded-lg border border-[var(--line-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] disabled:opacity-40"
              >
                {REFUND_KEEP}
              </button>
              <button
                type="button"
                onClick={onConfirmCancel}
                disabled={dialog.busy}
                className="rounded-lg bg-[var(--text-primary)] px-4 py-2 text-[13px] font-medium text-[var(--surface-primary)] disabled:opacity-40"
              >
                {REFUND_BUTTON}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog.kind === "clear" ? (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-6 py-6"
          role="presentation"
        >
          <div
            className="w-full max-w-[440px]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-style-title"
          >
            <h2
              id="clear-style-title"
              className="text-[15px] font-semibold text-[var(--text-primary)]"
            >
              {CLEAR_STYLE_TITLE}
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {CLEAR_STYLE_BODY}
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onKeep}
                disabled={dialog.busy}
                className="rounded-lg border border-[var(--line-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] disabled:opacity-40"
              >
                {CLEAR_STYLE_KEEP}
              </button>
              <button
                type="button"
                onClick={onConfirmClear}
                disabled={dialog.busy}
                className="rounded-lg bg-[var(--text-primary)] px-4 py-2 text-[13px] font-medium text-[var(--surface-primary)] disabled:opacity-40"
              >
                {CLEAR_STYLE_CONFIRM}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const EMPTY: PreferencesSnapshot = {
  signedIn: false,
  offline: false,
  email: null,
  effective: null,
  spent: 0,
  softCap: 0,
  hardCap: 0,
  windowEnd: null,
  items: [],
  euConsent: true,
  refundOpen: false,
  allowancePercent: null,
  usedPct: null,
  accountId: null,
  overage: false,
  overageMaximum: null,
  overageDefault: null,
  allowanceResets: null,
  credit: "$0.00",
  frozen: false,
  referralCode: null,
};

function loadedSnapshot(
  result: AccountPreferences,
  last: PreferencesSnapshot | null,
): { next: PreferencesSnapshot; stored: PreferencesSnapshot | null } {
  rememberAccountAnswer(result);
  if (!result.signed_in) {
    return { next: EMPTY, stored: null };
  }
  if (result.offline && last) {
    return { next: { ...last, offline: true }, stored: last };
  }
  const next: PreferencesSnapshot = {
    signedIn: true,
    offline: result.offline,
    email: result.email ?? null,
    effective: asPlan(result.effective),
    spent: result.spent,
    softCap: result.soft_cap,
    hardCap: result.hard_cap,
    windowEnd: result.window_end ?? null,
    items: rememberStyleItems(result.items),
    euConsent: result.eu_consent !== false,
    refundOpen: result.refund_open === true,
    allowancePercent:
      typeof result.allowance_percent === "number" ? result.allowance_percent : null,
    usedPct: typeof result.used_pct === "number" ? result.used_pct : null,
    accountId: result.account_id ?? null,
    overage: result.overage === true,
    overageMaximum: typeof result.overage_maximum === "number" ? result.overage_maximum : null,
    overageDefault:
      typeof result.overage_default_dollars === "number" ? result.overage_default_dollars : null,
    allowanceResets: result.allowance_resets ?? null,
    credit: result.credit && result.credit.length > 0 ? result.credit : "$0.00",
    frozen: result.frozen === true,
    referralCode: referralCodeText(result.referral_code) ?? null,
  };
  return { next, stored: result.offline ? last : next };
}

export function PreferencesPanel({
  isActive,
  model,
}: {
  isActive: boolean;
  model?: PreferencesSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<PreferencesSnapshot>(model ?? EMPTY);
  const [dialog, setDialog] = useState<PanelDialog>(NO_DIALOG);
  const [cancelLine, setCancelLine] = useState<string | null>(null);
  const [order] = useState(() => createAccountOrder());
  /** The snapshot last committed. Writers start from it, not from a render's copy. */
  const shown = useRef<PreferencesSnapshot>(model ?? EMPTY);
  /** The last snapshot the server answered, for an offline answer to fall back on. */
  const last = useRef<PreferencesSnapshot | null>(model ?? null);
  /** Bumped when the account shown changes. A request started before it is dropped. */
  const account = useRef(0);
  /** Requests in flight. A second click waits for the first. */
  const inFlight = useRef({ clear: false, refund: false, remove: false, signOut: false });

  function dispatch(event: PanelDialogEvent) {
    setDialog((current) => reducePanelDialog(current, event));
  }

  /** Every snapshot change goes through here. */
  function commit(next: PreferencesSnapshot, stored: PreferencesSnapshot | null) {
    const before = shown.current;
    shown.current = next;
    last.current = stored;
    setSnapshot(next);
    if (next.signedIn !== before.signedIn || next.accountId !== before.accountId) {
      account.current += 1;
      dispatch({ type: "account" });
    }
  }

  /** A change this window made. A read issued before it no longer applies. */
  function write(next: PreferencesSnapshot, stored: PreferencesSnapshot | null = next) {
    order.wrote();
    commit(next, stored);
  }

  function applyRead(result: AccountPreferences, ticket: number) {
    if (!order.accept(ticket)) return;
    const applied = loadedSnapshot(result, last.current);
    commit(applied.next, applied.stored);
  }

  useEffect(() => {
    if (snapshot.effective !== "paid") {
      setCancelLine(null);
      dispatch({ type: "not-paid" });
      return;
    }
    if (!isActive) return;
    let cancelled = false;
    void cancelPreview().then((line) => {
      if (cancelled) return;
      setCancelLine(line);
      dispatch({ type: "preview", line });
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, snapshot.effective, snapshot.accountId]);

  useEffect(() => {
    if (model) return;
    return subscribeAccountRefresh(({ preferences }, ticket) => applyRead(preferences, ticket));
  }, [model]);

  useEffect(() => {
    if (model || !isActive) return;
    let cancelled = false;
    const ticket = accountReadTicket();
    void tauri.accountPreferences().then((result) => {
      if (!cancelled) applyRead(result, ticket);
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, model]);

  const view = model ?? snapshot;

  async function confirmClear() {
    if (inFlight.current.clear) return;
    inFlight.current.clear = true;
    dispatch({ type: "confirm" });
    const mine = account.current;
    try {
      await tauri.accountClearStyle();
      if (account.current !== mine) return;
      forgetAllStyle();
      write({ ...shown.current, items: [] });
    } catch (error) {
      if (account.current !== mine) return;
      showEditorNotice(
        accountNoticeMessage(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      inFlight.current.clear = false;
      dispatch({ type: "done", kind: "clear" });
    }
  }

  async function deleteAccount() {
    if (inFlight.current.remove) return;
    inFlight.current.remove = true;
    try {
      const result = await runDeleteAccount();
      if (result.signedOut) write(EMPTY, null);
      if (result.notice) showEditorNotice(result.notice);
    } finally {
      inFlight.current.remove = false;
    }
  }

  function signOut() {
    if (inFlight.current.signOut) return;
    inFlight.current.signOut = true;
    void tauri
      .accountSignOut()
      .then(() => {
        write(EMPTY, null);
        rememberWritingPlan(null);
        returnToWelcome();
      })
      .finally(() => {
        inFlight.current.signOut = false;
      });
  }

  function forgetRule(item: StyleItem) {
    const id = styleRuleKey(item);
    write({ ...shown.current, items: dropVisibleStyleRule(shown.current.items, id) });
    if (!item.id) return;
    void tauri.accountForgetStyle(item.id).catch((error: unknown) => {
      showEditorNotice(
        accountNoticeMessage(error instanceof Error ? error.message : String(error)),
      );
    });
  }

  function confirmCancel() {
    if (inFlight.current.refund) return;
    inFlight.current.refund = true;
    dispatch({ type: "confirm" });
    const mine = account.current;
    void refundPurchase()
      .then((result) => {
        // A refund for an account this panel no longer shows changes nothing here.
        if (!result || account.current !== mine) return;
        if (result.plan === "free") {
          setCancelLine(null);
          rememberWritingPlan("free");
          write({
            ...shown.current,
            effective: "free",
            refundOpen: false,
            overage: false,
            overageMaximum: null,
          });
        } else {
          setCancelLine(result.line);
        }
        showEditorNotice(result.line);
      })
      .finally(() => {
        inFlight.current.refund = false;
        dispatch({ type: "done", kind: "cancel" });
      });
  }

  return (
    <div
      className={
        isActive ? "relative z-10 h-full" : "pointer-events-none absolute inset-0 h-full invisible"
      }
      aria-hidden={!isActive}
    >
      <EditorScrollContainer>
        <PreferencesView
          snapshot={view}
          onSignIn={openAccountSignIn}
          onSignOut={signOut}
          onClear={() => dispatch({ type: "ask-clear" })}
          onKeep={() => dispatch({ type: "keep" })}
          onConfirmClear={() => void confirmClear()}
          onDelete={() => void deleteAccount()}
          onForgetRule={forgetRule}
          onSubscribe={(interval) => {
            void startSubscription(interval, true, null).then((opened) => {
              if (!opened) return;
              if (interval === "month" || interval === "year") noteCheckoutStarted();
              showEditorNotice(SUBSCRIBE_WAIT);
            });
          }}
          onPortal={() => {
            void import("@/lib/account-billing").then((mod) => mod.openAccountPortal());
          }}
          dialog={dialog}
          onAskCancel={() => dispatch({ type: "ask-cancel", line: cancelLine })}
          onKeepPlan={() => dispatch({ type: "keep" })}
          onConfirmCancel={confirmCancel}
        />
      </EditorScrollContainer>
    </div>
  );
}
