import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  LIGHTER_NOTE,
  OVERAGE_MAX_PLACEHOLDER,
  OVERAGE_NEED_MAX,
  OVERAGE_OPT,
  OVERAGE_PROMPT_BODY,
  OVERAGE_PROMPT_LIGHTER,
  OVERAGE_PROMPT_ON,
  OVERAGE_PROMPT_TITLE,
  allowanceResetText,
  dollarFieldText,
  dollarsFromField,
  lighterNote,
  overagePromptBody,
  withDollarSign,
} from "../src/lib/account-copy";

const LINES = [
  OVERAGE_PROMPT_TITLE,
  OVERAGE_PROMPT_BODY,
  OVERAGE_PROMPT_ON,
  OVERAGE_PROMPT_LIGHTER,
  OVERAGE_OPT,
  OVERAGE_NEED_MAX,
  OVERAGE_MAX_PLACEHOLDER,
  LIGHTER_NOTE,
];

const RESET = "1 November 2026";

describe("overage copy", () => {
  test("the strings carry no price and no token counts", () => {
    const copy = readFileSync(new URL("../src/lib/account-copy.ts", import.meta.url), "utf8");
    expect(copy).not.toContain("0.05");
    for (const line of LINES) {
      expect(line).not.toContain("—");
      expect(line.toLowerCase()).not.toContain("token");
    }
  });

  test("a dollar field shows the sign and stays empty until a maximum is set", () => {
    expect(dollarsFromField("")).toBeNull();
    expect(dollarsFromField("$10")).toBe(10);
    expect(dollarsFromField("10")).toBe(10);
    expect(dollarsFromField("0")).toBeNull();
    expect(dollarFieldText(null, null)).toBe("");
    expect(dollarFieldText(null, 10)).toBe("$10");
    expect(dollarFieldText(25, 10)).toBe("$25");
    expect(withDollarSign("10")).toBe("$10");
    expect(withDollarSign("$")).toBe("$");
    expect(withDollarSign("")).toBe("");
  });

  test("the prompt and the lighter note fill the price and the reset date", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    expect(allowanceResetText("2026-11-01T00:00:00.000Z", now)).toBe(RESET);
    expect(allowanceResetText(null, now)).toBe(RESET);
    expect(overagePromptBody("$0.05", RESET)).toBe(
      "Keep the full model at $0.05 per ask, up to a monthly maximum you set. Or switch to a lighter model until 1 November 2026, at no cost.",
    );
    expect(overagePromptBody(null, RESET)).not.toContain("0.05");
    expect(lighterNote(RESET)).toBe(
      "Once you reach your maximum, Alkuin switches to the lighter model until 1 November 2026.",
    );
  });
});
