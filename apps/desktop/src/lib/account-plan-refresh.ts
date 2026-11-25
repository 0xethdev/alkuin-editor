import { listen } from "@tauri-apps/api/event";
import { applyWritingSession, rememberAccountAnswer } from "@/lib/account-session";
import * as tauri from "@/lib/tauri";
import type { AccountPreferences, AccountStatus } from "@/lib/tauri";

/** A checkout return is still "just now" inside this window. */
export const CHECKOUT_RECENT_MS = 30 * 60 * 1000;
export const CHECKOUT_FOLLOW_UP_MS = [2_000, 5_000] as const;

export type AccountRefreshSnapshot = {
  status: AccountStatus;
  preferences: AccountPreferences;
};

export function checkoutStillRecent(startedAt: number | null, now: number): boolean {
  return startedAt !== null && now >= startedAt && now - startedAt < CHECKOUT_RECENT_MS;
}

type Load = () => Promise<AccountRefreshSnapshot>;

type RefreshListener = (snapshot: AccountRefreshSnapshot, ticket: number) => void;

let reads = 0;

/** One counter for every account read and local account write in this window. A read
 *  takes a ticket when it is issued, so a reader can drop one that something newer
 *  already overtook. */
export function accountReadTicket(): number {
  reads += 1;
  return reads;
}

/**
 * Focus after Monthly or Yearly checkout refetches the plan, then again
 * 2s and 5s later. A checkout deep link refetches even if the click was
 * not recorded in this process.
 */
export function createPlanRefresh(load: Load, now: () => number) {
  let startedAt: number | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let pending: Promise<void> | null = null;
  /** A return came in while a load was in flight. That load may predate it, so
   *  one more load runs after it. */
  let again = false;
  const listeners = new Set<RefreshListener>();

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  function run(): Promise<void> {
    if (pending) {
      again = true;
      return pending;
    }
    const ticket = accountReadTicket();
    pending = load()
      .then((snapshot) => {
        for (const listener of listeners) listener(snapshot, ticket);
      })
      .catch(() => {
        // The open panel keeps the plan it already shows.
      })
      .finally(() => {
        pending = null;
        if (!again) return;
        again = false;
        void run();
      });
    return pending;
  }

  return {
    noteCheckoutStarted() {
      startedAt = now();
    },
    onReturn(kind: "focus" | "link") {
      const recent = checkoutStillRecent(startedAt, now());
      if (kind === "focus" && !recent) return;
      clearTimers();
      void run();
      if (!recent) return;
      for (const delay of CHECKOUT_FOLLOW_UP_MS) {
        timers.push(setTimeout(() => void run(), delay));
      }
    },
    subscribe(listener: RefreshListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      clearTimers();
      again = false;
      listeners.clear();
    },
  };
}

const planRefresh = createPlanRefresh(
  async () => {
    const [status, preferences] = await Promise.all([
      tauri.accountStatus(),
      tauri.accountPreferences(),
    ]);
    // Auth answered: an offline desk is back online.
    if (status.signed_in) applyWritingSession({ type: "reachable" });
    rememberAccountAnswer(preferences);
    return { status, preferences };
  },
  () => Date.now(),
);

export function noteCheckoutStarted() {
  planRefresh.noteCheckoutStarted();
}

export function subscribeAccountRefresh(listener: RefreshListener) {
  return planRefresh.subscribe(listener);
}

/** Window focus, becoming visible, and a checkout deep link. */
export function installAccountPlanRefresh(): () => void {
  const onFocus = () => planRefresh.onReturn("focus");
  const onVisible = () => {
    if (document.visibilityState === "visible") planRefresh.onReturn("focus");
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  // `listen` resolves later. A cleanup that runs first (StrictMode) still unlistens.
  let removed = false;
  let stopLink = () => {};
  void listen("account:checkout-return", () => {
    planRefresh.onReturn("link");
  }).then((stop) => {
    if (removed) stop();
    else stopLink = stop;
  });
  return () => {
    removed = true;
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisible);
    stopLink();
  };
}
