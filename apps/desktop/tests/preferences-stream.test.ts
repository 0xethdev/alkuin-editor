import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  MONTHLY_PLAN,
  YEARLY_PLAN,
  checkoutButtonWeight,
  creditIsPositive,
  deleteAccountConfirmText,
  overageDollars,
  planCheckoutIntervals,
  CREDIT_NOTE,
  REF_COPIED,
  REF_HELPER,
  referralClipboardText,
  showExtraCredit,
  DELETE_ACCOUNT_BODY,
} from "../src/lib/account-copy";
import {
  dropVisibleStyleRule,
  forgetAllStyle,
  forgetStyleRule,
  readStyleMemory,
  rememberStyleItems,
} from "../src/features/redline-spike/style-memory";
import {
  APPEARANCE_STORAGE_KEY,
  activeMode,
  applyTheme,
  themeNeedsLightMigration,
} from "../src/lib/theme";

const memory = new Map<string, string>();
const themeDataset: { theme?: string } = {};
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  },
  document: {
    documentElement: {
      dataset: themeDataset,
      setAttribute(name: string, value: string) {
        if (name === "data-theme") themeDataset.theme = value;
      },
      style: { setProperty() {}, removeProperty() {} },
    },
  },
  window: {
    matchMedia(query: string) {
      return {
        matches: query.includes("dark"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      };
    },
  },
});

const RULE = {
  id: "11111111-1111-4111-8111-111111111111",
  rule: "Write numbers under ten as words.",
  why: "The draft did.",
  scope: "house",
  seen: 2,
};

afterEach(() => {
  localStorage.removeItem("alkuin-style-memory");
  localStorage.removeItem(APPEARANCE_STORAGE_KEY);
});

describe("preferences stream", () => {
  test("plan buttons, delete confirm, and the credit gate", () => {
    expect(MONTHLY_PLAN).toBe("Monthly, $19.99");
    expect(YEARLY_PLAN).toBe("Yearly, $209.99");
    const panel = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    // Free never buys credit, whatever its usage.
    expect(planCheckoutIntervals("free", false)).toEqual(["year", "month"]);
    expect(planCheckoutIntervals("free", true)).toEqual(["year", "month"]);
    expect(planCheckoutIntervals("paid", true)).toEqual(["topup"]);
    expect(planCheckoutIntervals("paid", false)).toEqual([]);
    expect(planCheckoutIntervals("founding", true)).toEqual([]);
    expect(checkoutButtonWeight("year", "free")).toBe("primary");
    expect(checkoutButtonWeight("month", "free")).toBe("primary");
    expect(checkoutButtonWeight("topup", "free")).toBe("secondary");
    expect(checkoutButtonWeight("topup", "paid")).toBe("primary");
    expect(referralClipboardText("abcd2345")).toBe("abcd2345");
    expect(referralClipboardText("  ABCD2345 ")).toBe("abcd2345");
    expect(referralClipboardText("use abcd2345 on alkuin.app")).toBe("");
    expect(REF_HELPER).toBe(
      "Share this code. When a friend first pays for Alkuin, you both get $10 Ask credit. They enter it at checkout.",
    );
    expect(REF_COPIED).toBe("Copied. They enter it at checkout.");
    expect(CREDIT_NOTE).toBe("Use extra credit when this month’s included usage runs out.");
    expect(panel).toContain("REF_HELPER");
    expect(panel).toContain("showEditorNotice(REF_COPIED)");
    expect(panel).not.toMatch(/redeem/i);
    expect(panel).toContain("planCheckoutIntervals");
    expect(panel).toContain("referralClipboardText");
    expect(panel).toContain("writeText(text)");
    expect(panel.indexOf("<FeedbackForm")).toBeGreaterThan(panel.indexOf(">Account<"));
    expect(deleteAccountConfirmText()).toBe(DELETE_ACCOUNT_BODY);
    expect(showExtraCredit("free", 100, "$0.00")).toBe(false);
    expect(showExtraCredit("paid", 99, "$0.00")).toBe(false);
    expect(showExtraCredit("paid", 100, "$0.00")).toBe(true);
    expect(showExtraCredit("paid", 40, "$1.20")).toBe(true);
    expect(creditIsPositive("$0.00")).toBe(false);
    expect(overageDollars(null, null)).toBe(10);
    expect(overageDollars(25, 10)).toBe(25);
  });

  test("style memory keeps, drops, and clears a rule", () => {
    const other = { ...RULE, id: "22222222-2222-4222-8222-222222222222", rule: "Keep the dash." };
    rememberStyleItems([RULE, other]);
    expect(readStyleMemory()).toHaveLength(2);
    expect(forgetStyleRule(RULE.id).map((rule) => rule.rule)).toEqual(["Keep the dash."]);
    expect(forgetAllStyle()).toEqual([]);
    expect(readStyleMemory()).toEqual([]);
    expect(dropVisibleStyleRule([RULE, other], RULE.id).map((rule) => rule.rule)).toEqual([
      "Keep the dash.",
    ]);
  });

  test("appearance stays light when a dark or system choice is stored", () => {
    applyTheme("dark", {});
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("system", {});
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("nope", {});
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(activeMode("dark")).toBe("light");
    expect(themeNeedsLightMigration("dark", null)).toBe(true);
    expect(themeNeedsLightMigration("light", "system")).toBe(true);
    expect(themeNeedsLightMigration("light", null)).toBe(false);
    expect(themeNeedsLightMigration("light", "light")).toBe(false);
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('<script src="/theme-init.js"></script>');
    const themeInit = readFileSync(new URL("../public/theme-init.js", import.meta.url), "utf8");
    expect(themeInit).toContain('setAttribute("data-theme", "light")');
    expect(themeInit).not.toContain("prefers-color-scheme");
    expect(html).not.toContain("prefers-color-scheme");
    const panel = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    expect(panel).not.toContain("AppearancePicker");
    expect(panel).not.toContain(">Dark<");
    expect(panel).not.toContain(">System<");
  });

  test("preferences drops the old billing chrome and shows the bar", () => {
    const source = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('role="progressbar"');
    expect(source).toContain("PLENTY_MONTH_LINE");
    expect(source).not.toContain("STARTS_NOW");
    expect(source).not.toContain("OVERAGE_OPT");
    expect(source).toContain("FORGET_STYLE_BUTTON");
    expect(source).not.toContain("AppearancePicker");
    expect(source).toContain("startSubscription(interval, true,");
    expect(source).toContain("showExtraCredit");
    const mention = readFileSync(
      new URL("../src/features/note-mention/preference.tsx", import.meta.url),
      "utf8",
    );
    expect(mention).toContain("inline-flex");
    expect(mention).toContain('alignItems: "center"');
    expect(mention).toContain("margin: 0");
  });
});
