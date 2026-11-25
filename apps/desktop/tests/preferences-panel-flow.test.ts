import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react", async () => (await import("./helpers/hook-harness")).reactHooks);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const linkReturn = vi.hoisted(() => ({ fire: () => {} }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: () => void) => {
    linkReturn.fire = handler;
    return () => {};
  }),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(),
}));

vi.mock("@/components/editor-area/editor-notice-store", () => ({
  showEditorNotice: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { renderOnce, unmountAll } from "./helpers/hook-harness";
import { showEditorNotice } from "../src/components/editor-area/editor-notice-store";
// @ts-expect-error the panel module is JSX and this test file sits outside that project
import { PreferencesPanel } from "../src/components/preferences-panel";
import type { PanelDialog } from "../src/components/preferences-panel/account-state";
import { installAccountPlanRefresh } from "../src/lib/account-plan-refresh";
import { rememberWritingSession, writingPlan } from "../src/lib/account-session";
import type { AccountPreferences } from "../src/lib/tauri";

const mockedInvoke = vi.mocked(invoke);
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", new EventTarget());
installAccountPlanRefresh();

type ViewProps = {
  snapshot: { signedIn: boolean; effective: string | null; items: { rule: string }[] };
  dialog: PanelDialog;
  onClear: () => void;
  onConfirmClear: () => void;
  onAskCancel: () => void;
  onConfirmCancel: () => void;
  onSignOut: () => void;
  onForgetRule: (item: {
    id?: string;
    rule: string;
    why: string;
    scope: string;
    seen: number;
  }) => void;
};

const RULE = {
  id: "rule-1",
  rule: "Write numbers under ten as words.",
  why: "House style.",
  scope: "house",
  seen: 2,
};

function paid(items: (typeof RULE)[] = []): AccountPreferences {
  return {
    signed_in: true,
    offline: false,
    email: "ada@example.com",
    effective: "paid",
    spent: 0,
    soft_cap: 0,
    hard_cap: 0,
    items,
    account_id: "acct-1",
  };
}

function view(): ViewProps {
  const panel = renderOnce(() => PreferencesPanel({ isActive: true })) as ReactElement<{
    children: ReactElement<{ children: ReactElement<ViewProps> }>;
  }>;
  return panel.props.children.props.children.props;
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** Answers each command with the next queued answer, or the fallback. */
function answer(fallback: Record<string, unknown>, queued: Record<string, unknown[]> = {}) {
  mockedInvoke.mockImplementation((command) => {
    const next = queued[command]?.shift();
    if (next !== undefined) return next instanceof Promise ? next : Promise.resolve(next);
    return Promise.resolve(fallback[command]);
  });
}

beforeEach(() => {
  unmountAll();
  mockedInvoke.mockReset();
  vi.mocked(showEditorNotice).mockClear();
  rememberWritingSession(true);
});

describe("preferences account panel", () => {
  test("an account refresh while Clear is confirming keeps the dialog open", async () => {
    const clearing = deferred<void>();
    answer(
      {
        account_preferences: paid([RULE]),
        account_status: { signed_in: true },
        account_cancel_preview: { plan: "paid", line: "Refund" },
      },
      { account_clear_style: [clearing.promise] },
    );
    view();
    await settle();
    view().onClear();
    view().onConfirmClear();
    expect(view().dialog).toEqual({ kind: "clear", busy: true });
    linkReturn.fire();
    await settle();
    expect(view().dialog).toEqual({ kind: "clear", busy: true });
    clearing.resolve();
    await settle();
    expect(view().dialog).toEqual({ kind: "none" });
    expect(view().snapshot.items).toEqual([]);
    const clears = mockedInvoke.mock.calls.filter(([command]) => command === "account_clear_style");
    expect(clears).toHaveLength(1);
  });

  test("a refund that lands after sign-out changes nothing", async () => {
    const refund = deferred<{ plan: string; line: string }>();
    answer(
      {
        account_preferences: paid(),
        account_cancel_preview: { plan: "paid", line: "Refund $19.99" },
        account_sign_out: undefined,
      },
      { account_refund: [refund.promise] },
    );
    view();
    await settle();
    // The paid plan starts the cancel preview; its line arms the button.
    view();
    await settle();
    view().onAskCancel();
    expect(view().dialog).toEqual({ kind: "cancel", line: "Refund $19.99", busy: false });
    view().onConfirmCancel();
    view().onSignOut();
    await settle();
    expect(view().snapshot.signedIn).toBe(false);
    refund.resolve({ plan: "free", line: "Refunded" });
    await settle();
    expect(view().snapshot.signedIn).toBe(false);
    expect(view().snapshot.effective).toBeNull();
    expect(view().dialog).toEqual({ kind: "none" });
    expect(showEditorNotice).not.toHaveBeenCalledWith("Refunded");
    expect(writingPlan()).toBeNull();
  });

  test("Cancel opens and refunds while the refund quote is still on its way", async () => {
    const quote = deferred<{ plan: string; line: string }>();
    answer(
      {
        account_preferences: paid(),
        account_refund: { plan: "free", line: "Refunded" },
      },
      { account_cancel_preview: [quote.promise] },
    );
    view();
    await settle();
    view();
    await settle();
    view().onAskCancel();
    expect(view().dialog).toEqual({ kind: "cancel", line: null, busy: false });
    view().onConfirmCancel();
    await settle();
    const refunds = mockedInvoke.mock.calls.filter(([command]) => command === "account_refund");
    expect(refunds).toHaveLength(1);
    expect(view().dialog).toEqual({ kind: "none" });
    expect(view().snapshot.effective).toBe("free");
    expect(showEditorNotice).toHaveBeenCalledWith("Refunded");
    quote.resolve({ plan: "paid", line: "Refund $19.99" });
    await settle();
    expect(view().dialog).toEqual({ kind: "none" });
  });

  test("a read issued before Forget does not bring the rule back", async () => {
    const stale = deferred<AccountPreferences>();
    answer(
      {
        account_status: { signed_in: true },
        account_cancel_preview: { plan: "paid", line: "Refund" },
        account_forget_style: undefined,
      },
      { account_preferences: [paid([RULE]), stale.promise, paid()] },
    );
    view();
    await settle();
    expect(view().snapshot.items.map((item) => item.rule)).toEqual([RULE.rule]);
    linkReturn.fire();
    await settle();
    view().onForgetRule(RULE);
    expect(view().snapshot.items).toEqual([]);
    stale.resolve(paid([RULE]));
    await settle();
    expect(view().snapshot.items).toEqual([]);
  });
});
