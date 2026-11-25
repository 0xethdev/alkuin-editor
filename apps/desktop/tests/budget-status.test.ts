import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  fillHelpLine,
  marginBudgetState,
  preferencesStatusLine,
  readBudget,
  type PlanKind,
  type ServerBudget,
} from "../src/features/redline-spike/budget-status";
import {
  ACCOUNT_PAUSED_LINE,
  ASK_CANCELLED_LINE,
  ASK_REFUSED_LINE,
  CLEAR_STYLE_BODY,
  DAILY_CAP_LINE,
  FREE_MONTH_LINE,
  FREE_SLICE_LINE,
  FROZEN_LINE,
  HARD_CAP_LINE,
  FREE_DAY_LINE,
  MODEL_UNREACHABLE_LINE,
  PAID_CAP_LINE,
  PAUSED_LINE,
  PLENTY_MONTH_LINE,
  RESET_ON_LINE,
  RUNNING_LOW_MONTH_LINE,
  SERVER_ERROR_LINE,
  STYLE_FREE_LINE,
  STYLE_FREE_SAVED,
  TOO_MANY_ASKS_FALLBACK,
  TOO_MANY_ASKS_LINE,
  TOO_MANY_ASKS_ONE,
  buyCreditFor,
  seePlansFor,
  styleNotesVisible,
} from "../src/features/redline-spike/margin-copy";
import { shownStyleItems } from "../src/features/redline-spike/style-items";

/**
 * The status line's cuts.
 * Exactly 80% (spent * 100 >= cap * 80) is Running low on a paid plan.
 * One unit under that is Plenty.
 * Exactly the hard cap is Used.
 * Free stays Plenty until the hard cap. There is no soft warn.
 */

const WINDOW = "2026-10-22T00:00:00.000Z";

function budget(
  effective: PlanKind,
  spent: number,
  softCap: number,
  hardCap: number,
): ServerBudget {
  return {
    spent,
    softCap,
    hardCap,
    effective,
    windowEnd: WINDOW,
  };
}

function expectAgree(input: ServerBudget, band: "plenty" | "running_low" | "used", line: string) {
  const read = readBudget(input);
  const statusLine = preferencesStatusLine(input);
  const margin = marginBudgetState(input);
  expect(read.band).toBe(band);
  expect(statusLine).toBe(read.statusLine);
  expect(margin).toEqual(read.margin);
  expect(statusLine).toBe(line);
  expect(margin.band).toBe(band);
  expect(margin.hardCap).toBe(band === "used");
  expect(margin.softReached).toBe(input.spent >= input.softCap);
  if (band === "used") expect(margin.line).toBeTruthy();
  else expect(margin.line).toBeNull();
}

describe("preferences status and the margin share one budget read", () => {
  test("paid crosses plenty, running low, and used on the server cuts", () => {
    const soft = 1000;
    const hard = 2000;
    expectAgree(budget("paid", 799, soft, hard), "plenty", PLENTY_MONTH_LINE);
    expectAgree(budget("paid", 800, soft, hard), "running_low", RUNNING_LOW_MONTH_LINE);
    expectAgree(budget("paid", soft - 1, soft, hard), "running_low", RUNNING_LOW_MONTH_LINE);
    expectAgree(budget("paid", soft, soft, hard), "running_low", RUNNING_LOW_MONTH_LINE);
    expectAgree(budget("paid", hard - 1, soft, hard), "running_low", RUNNING_LOW_MONTH_LINE);
    expectAgree(
      { ...budget("paid", soft, soft, hard), windowEnd: null },
      "running_low",
      RUNNING_LOW_MONTH_LINE,
    );
    expectAgree(budget("paid", hard, soft, hard), "used", HARD_CAP_LINE);
    expect(RESET_ON_LINE).toBe("Writing help resets on {date}.");
    expect(marginBudgetState(budget("paid", hard, soft, hard)).line).toBe(
      fillHelpLine(PAID_CAP_LINE, WINDOW),
    );
    expect(seePlansFor(PAID_CAP_LINE)).toBe(false);
    expect(buyCreditFor(fillHelpLine(PAID_CAP_LINE, WINDOW))).toBe(true);
  });

  test("founding uses the paid lines and the paid cuts", () => {
    expectAgree(budget("founding", 1000, 1000, 2000), "running_low", RUNNING_LOW_MONTH_LINE);
    expectAgree(budget("founding", 2000, 1000, 2000), "used", HARD_CAP_LINE);
    expect(marginBudgetState(budget("founding", 2000, 1000, 2000)).line).toBe(
      fillHelpLine(PAID_CAP_LINE, WINDOW),
    );
  });

  test("free has no lighter state and no soft warn", () => {
    const hard = 1000;
    expectAgree(budget("free", 799, hard, hard), "plenty", PLENTY_MONTH_LINE);
    expectAgree(budget("free", 800, hard, hard), "plenty", PLENTY_MONTH_LINE);
    expectAgree(budget("free", hard - 1, hard, hard), "plenty", PLENTY_MONTH_LINE);
    expectAgree(budget("free", hard, hard, hard), "used", HARD_CAP_LINE);
    expect(marginBudgetState(budget("free", hard, hard, hard)).line).toBe(
      fillHelpLine(FREE_MONTH_LINE, WINDOW),
    );
    // A soft cap under the free cap must not invent a lighter model or a warn.
    expectAgree(budget("free", 500, 400, hard), "plenty", PLENTY_MONTH_LINE);
    expectAgree(budget("free", 800, 400, hard), "plenty", PLENTY_MONTH_LINE);
    expectAgree(budget("free", 999, 400, hard), "plenty", PLENTY_MONTH_LINE);
    const lines = [500, 800, 999, 1000].map((spent) =>
      preferencesStatusLine(budget("free", spent, 400, hard)),
    );
    expect(lines.some((line) => line.includes("lighter"))).toBe(false);
    expect(lines.filter((line) => line === RUNNING_LOW_MONTH_LINE)).toEqual([]);
  });
});

describe("clear confirm", () => {
  test("says remaining writing help is left alone", () => {
    expect(CLEAR_STYLE_BODY).toBe(
      "Alkuin will forget everything it has learned from your suggestions, starting with your next ask. Your documents, your plan and your remaining writing help aren't affected. This can't be undone.",
    );
  });
});

describe("learned items the window shows", () => {
  test("seen under 2 stays hidden, and a six-word copy never renders", () => {
    const draft = "one two three four five extra words here";
    const hidden = shownStyleItems(
      [
        {
          rule: "Prefer short sentences.",
          why: "You usually accept redlines that split a long sentence.",
          scope: "polish",
          seen: 1,
        },
        {
          rule: "one two three four five extra.",
          why: "Kept from the draft itself.",
          scope: "polish",
          seen: 2,
        },
        {
          rule: "one two three four five.",
          why: "Five words stay.",
          scope: "polish",
          seen: 2,
        },
        {
          rule: "Write numbers under ten as words.",
          why: "You change digits to words when a suggestion leaves them in.",
          scope: "house",
          seen: 2,
        },
      ],
      [draft],
    );
    expect(hidden.map((item) => item.rule)).toEqual([
      "one two three four five.",
      "Write numbers under ten as words.",
    ]);
  });

  test("a free account with saved rows still shows them and can clear them", () => {
    expect(STYLE_FREE_LINE).toBe(
      "Upgrade to the Alkuin plan if you want Alkuin to learn your personal style and give more tailored suggestions.",
    );
    expect(STYLE_FREE_SAVED).toBe(
      "Your earlier style notes are saved but not used. You can clear them below.",
    );
    expect(styleNotesVisible("free", 2)).toEqual({
      savedLine: true,
      rows: true,
      clear: true,
      empty: false,
    });
    expect(styleNotesVisible("free", 0)).toEqual({
      savedLine: false,
      rows: false,
      clear: false,
      empty: false,
    });
    expect(styleNotesVisible("paid", 0)).toEqual({
      savedLine: false,
      rows: false,
      clear: true,
      empty: true,
    });
    expect(styleNotesVisible("paid", 2).empty).toBe(false);
    expect(styleNotesVisible("founding", 0).empty).toBe(true);
    expect(styleNotesVisible("founding", 3).savedLine).toBe(false);
    const source = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("styleNotesVisible(snapshot.effective, groups.length)");
    expect(source).toContain('snapshot.effective === "free" ? STYLE_FREE_LINE : STYLE_SUBLINE');
    expect(source).toContain("{STYLE_FREE_SAVED}");
    expect(source).toContain("notes.empty");
    expect(source).toContain("notes.clear");
    expect(source).toContain("onClear");
  });

  test("the writing-style view leaves research off the page", () => {
    const source = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    const groups = source.slice(
      source.indexOf("const GROUPS"),
      source.indexOf("type PreferencesSnapshot"),
    );
    expect(groups).toContain('scope: "house"');
    expect(groups).toContain('scope: "polish"');
    expect(groups).toContain('scope: "cite"');
    expect(groups).not.toContain("research");
  });
});

describe("ask failure maps the server response to the approved line", () => {
  test("the Rust ask lines are the same sentences", () => {
    // redline.rs maps the ask error before the margin sees it. Both sides must say the same thing.
    const rust = readFileSync(
      new URL("../src-tauri/src/commands/redline.rs", import.meta.url),
      "utf8",
    );
    const rustLine = (name: string): string | undefined =>
      new RegExp(`const ${name}: &str =\\s*"([^"]*)"`).exec(rust)?.[1];
    const pairs: [string, string][] = [
      ["FROZEN_LINE", FROZEN_LINE],
      ["PAUSED_LINE", PAUSED_LINE],
      ["ACCOUNT_PAUSED_LINE", ACCOUNT_PAUSED_LINE],
      ["DAILY_CAP_LINE", DAILY_CAP_LINE],
      ["TOO_MANY_ASKS_ONE", TOO_MANY_ASKS_ONE],
      ["TOO_MANY_ASKS_LINE", TOO_MANY_ASKS_LINE],
      ["TOO_MANY_ASKS_FALLBACK", TOO_MANY_ASKS_FALLBACK],
      ["FREE_SLICE_LINE", FREE_SLICE_LINE],
      ["FREE_DAY_LINE", FREE_DAY_LINE],
      ["FREE_MONTH_LINE", FREE_MONTH_LINE],
      ["PAID_CAP_LINE", PAID_CAP_LINE],
      ["HARD_CAP_UNDATED", HARD_CAP_LINE],
      ["SERVER_ERROR_LINE", SERVER_ERROR_LINE],
      ["MODEL_UNREACHABLE_LINE", MODEL_UNREACHABLE_LINE],
      ["ASK_CANCELLED_LINE", ASK_CANCELLED_LINE],
      ["ASK_REFUSED_LINE", ASK_REFUSED_LINE],
    ];
    for (const [name, line] of pairs) {
      expect(rustLine(name), name).toBe(line);
    }
  });
});
