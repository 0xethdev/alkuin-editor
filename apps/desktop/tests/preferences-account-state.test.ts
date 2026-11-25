import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  createAccountOrder,
  NO_DIALOG,
  reducePanelDialog,
  type PanelDialog,
  type PanelDialogEvent,
} from "../src/components/preferences-panel/account-state";
import {
  accountReadTicket,
  createPlanRefresh,
  type AccountRefreshSnapshot,
} from "../src/lib/account-plan-refresh";
import type { AccountPreferences } from "../src/lib/tauri";

function run(events: PanelDialogEvent[], from: PanelDialog = NO_DIALOG): PanelDialog {
  return events.reduce(reducePanelDialog, from);
}

describe("preferences dialog", () => {
  test("clear style: confirm once, Keep and a second confirm wait for the request", () => {
    const busy = run([{ type: "ask-clear" }, { type: "confirm" }]);
    expect(busy).toEqual({ kind: "clear", busy: true });
    expect(reducePanelDialog(busy, { type: "confirm" })).toBe(busy);
    expect(reducePanelDialog(busy, { type: "keep" })).toBe(busy);
    expect(reducePanelDialog(busy, { type: "done", kind: "cancel" })).toBe(busy);
    expect(reducePanelDialog(busy, { type: "done", kind: "clear" })).toEqual(NO_DIALOG);
  });

  test("an account refresh is not a dialog event, so it cannot close one", () => {
    const source = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("confirming");
    expect(source).toContain('dialog.kind === "clear"');
  });

  test("cancel plan: the dialog never waits on the refund quote", () => {
    // No quote yet, or it failed: the dialog still opens, with the fallback line.
    const unquoted = run([{ type: "ask-cancel", line: null }]);
    expect(unquoted).toEqual({ kind: "cancel", line: null, busy: false });
    // A quote that lands while it is open is shown; a failed one falls back again.
    const open = reducePanelDialog(unquoted, { type: "preview", line: "Refund $19.99" });
    expect(open).toEqual({ kind: "cancel", line: "Refund $19.99", busy: false });
    expect(reducePanelDialog(open, { type: "preview", line: null })).toEqual(unquoted);
    expect(reducePanelDialog(open, { type: "preview", line: "Refund $19.99" })).toBe(open);
    // A closed dialog has nothing for a later preview to pop up.
    expect(run([{ type: "preview", line: "Refund" }])).toEqual(NO_DIALOG);
    // A plan that is no longer paid has nothing to cancel.
    expect(reducePanelDialog(open, { type: "not-paid" })).toEqual(NO_DIALOG);
    const refunding = reducePanelDialog(unquoted, { type: "confirm" });
    expect(refunding).toEqual({ kind: "cancel", line: null, busy: true });
    expect(reducePanelDialog(refunding, { type: "not-paid" })).toBe(refunding);
    expect(reducePanelDialog(refunding, { type: "preview", line: "Refund" })).toBe(refunding);
    expect(reducePanelDialog(refunding, { type: "done", kind: "cancel" })).toEqual(NO_DIALOG);
  });

  test("the cancel dialog says the fallback line until a quote comes, and Cancel is never disabled for it", () => {
    const source = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("{dialog.line ?? CANCEL_FALLBACK_LINE}");
    expect(source).not.toContain("disabled={!cancelLine");
  });

  test("another account closes whatever is open, busy or not", () => {
    const refunding = run([{ type: "ask-cancel", line: "Refund" }, { type: "confirm" }]);
    expect(reducePanelDialog(refunding, { type: "account" })).toEqual(NO_DIALOG);
    expect(run([{ type: "ask-clear" }, { type: "account" }])).toEqual(NO_DIALOG);
  });

  test("one dialog at a time", () => {
    const clear = run([{ type: "ask-clear" }]);
    expect(reducePanelDialog(clear, { type: "ask-cancel", line: "Refund" })).toBe(clear);
  });
});

describe("account writer order", () => {
  test("a read issued before a local write does not undo it", () => {
    let clock = 0;
    const order = createAccountOrder(() => ++clock);
    const before = ++clock;
    order.wrote();
    expect(order.accept(before)).toBe(false);
    expect(order.accept(++clock)).toBe(true);
  });

  test("an older read that lands after a newer one is dropped", () => {
    let clock = 0;
    const order = createAccountOrder(() => ++clock);
    const older = ++clock;
    const newer = ++clock;
    expect(order.accept(newer)).toBe(true);
    expect(order.accept(older)).toBe(false);
  });

  test("the plan refresh hands each listener the ticket its read was issued with", async () => {
    let release: () => void = () => {};
    const refresh = createPlanRefresh(
      () =>
        new Promise<AccountRefreshSnapshot>((resolve) => {
          release = () =>
            resolve({
              status: { signed_in: true },
              preferences: { signed_in: true } as AccountPreferences,
            });
        }),
      () => 0,
    );
    const seen: number[] = [];
    refresh.subscribe((_snapshot, ticket) => seen.push(ticket));
    refresh.onReturn("link");
    const writtenLater = accountReadTicket();
    release();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBeLessThan(writtenLater);
    refresh.dispose();
  });
});
