import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { noteAccountSignedIn, subscribeAccountSignIn } from "../src/lib/account-sign-in";
import {
  CHECKOUT_RECENT_MS,
  checkoutStillRecent,
  createPlanRefresh,
  type AccountRefreshSnapshot,
} from "../src/lib/account-plan-refresh";
import type { AccountPreferences } from "../src/lib/tauri";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

function paidSnapshot(plan: string): AccountRefreshSnapshot {
  return {
    status: { signed_in: true, email: "ada@example.com" },
    preferences: { signed_in: true, effective: plan } as AccountPreferences,
  };
}

describe("checkout plan refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a checkout is recent for half an hour", () => {
    expect(checkoutStillRecent(1_000, 1_000 + CHECKOUT_RECENT_MS - 1)).toBe(true);
    expect(checkoutStillRecent(1_000, 1_000 + CHECKOUT_RECENT_MS)).toBe(false);
    expect(checkoutStillRecent(null, 1_000)).toBe(false);
  });

  test("focus after checkout refetches now, then at 2s and 5s", async () => {
    vi.useFakeTimers();
    const plans: string[] = [];
    let plan = "free";
    const refresh = createPlanRefresh(
      async () => paidSnapshot(plan),
      () => 10_000,
    );
    refresh.subscribe((snapshot) => {
      plans.push(snapshot.preferences.effective ?? "");
    });
    refresh.noteCheckoutStarted();
    refresh.onReturn("focus");
    await vi.waitFor(() => expect(plans).toEqual(["free"]));
    plan = "paid";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plans).toEqual(["free", "paid"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(plans).toEqual(["free", "paid", "paid"]);
    refresh.dispose();
  });

  test("focus with no recent checkout does not refetch", async () => {
    let calls = 0;
    let now = 0;
    const refresh = createPlanRefresh(
      async () => {
        calls += 1;
        return paidSnapshot("free");
      },
      () => now,
    );
    refresh.onReturn("focus");
    await Promise.resolve();
    expect(calls).toBe(0);
    refresh.noteCheckoutStarted();
    now = CHECKOUT_RECENT_MS;
    refresh.onReturn("focus");
    await Promise.resolve();
    expect(calls).toBe(0);
    refresh.dispose();
  });

  test("a checkout link refetches once when the click was not recorded", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const refresh = createPlanRefresh(
      async () => {
        calls += 1;
        return paidSnapshot("paid");
      },
      () => 0,
    );
    refresh.onReturn("link");
    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(1);
    refresh.dispose();
  });
});

describe("plan refresh ordering", () => {
  test("a checkout link during a load that predates it loads once more after it", async () => {
    const plans: string[] = [];
    let plan = "free";
    let release: () => void = () => {};
    let calls = 0;
    const refresh = createPlanRefresh(
      () => {
        calls += 1;
        const read = plan;
        if (calls > 1) return Promise.resolve(paidSnapshot(read));
        return new Promise<AccountRefreshSnapshot>((resolve) => {
          release = () => resolve(paidSnapshot(read));
        });
      },
      () => 0,
    );
    refresh.subscribe((snapshot) => plans.push(snapshot.preferences.effective ?? ""));
    refresh.onReturn("link");
    plan = "paid";
    refresh.onReturn("link");
    refresh.onReturn("link");
    expect(calls).toBe(1);
    release();
    await vi.waitFor(() => expect(plans).toEqual(["free", "paid"]));
    expect(calls).toBe(2);
    refresh.dispose();
  });

  test("a cleanup before the link listener is ready still removes it", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    let ready: (stop: () => void) => void = () => {};
    vi.mocked(listen).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", new EventTarget());
    try {
      const { installAccountPlanRefresh } = await import("../src/lib/account-plan-refresh");
      const stop = vi.fn();
      const uninstall = installAccountPlanRefresh();
      uninstall();
      ready(stop);
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("account switch", () => {
  test("a finished sign-in tells open tabs", () => {
    const seen: string[] = [];
    const stop = subscribeAccountSignIn((event) => seen.push(event));
    noteAccountSignedIn();
    stop();
    expect(seen).toEqual(["signed-in"]);
  });
});
