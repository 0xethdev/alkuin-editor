import { describe, expect, test } from "vite-plus/test";
import {
  AGE_BLOCK_KEY,
  AGE_BLOCK_MS,
  AGE_BLOCKED,
  AGE_INVALID,
  AGE_LABEL,
  AGE_STEP_PROMPT,
  MINIMUM_AGE,
  ageAnswer,
  ageOn,
  ageState,
  rememberUnderAge,
} from "../src/lib/age-gate";

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

const TODAY = new Date(2026, 10, 18);

describe("age gate", () => {
  test("counts whole years and the birthday itself", () => {
    expect(ageOn("2010-11-18", TODAY)).toBe(16);
    expect(ageOn("2010-11-19", TODAY)).toBe(15);
    expect(ageOn("2010-12-01", TODAY)).toBe(15);
    expect(ageOn("1990-01-01", TODAY)).toBe(36);
  });

  test("refuses dates that aren't real or are in the future", () => {
    expect(ageOn("", TODAY)).toBeNull();
    expect(ageOn("2010-02-30", TODAY)).toBeNull();
    expect(ageOn("18/11/2010", TODAY)).toBeNull();
    expect(ageOn("2030-01-01", TODAY)).toBeNull();
    expect(ageOn("1800-01-01", TODAY)).toBeNull();
  });

  test("the answer is ok from the minimum age on", () => {
    expect(ageAnswer("2010-11-18", TODAY)).toBe("ok");
    expect(ageAnswer("2010-11-19", TODAY)).toBe("under");
    expect(ageAnswer("nope", TODAY)).toBe("invalid");
  });

  test("an under-age answer blocks the date step for a day", () => {
    const store = memory();
    expect(ageState(store, 1000)).toBe("ok");
    rememberUnderAge(store, 1000);
    expect(store.data.get(AGE_BLOCK_KEY)).toBe("1000");
    expect(ageState(store, 1000 + AGE_BLOCK_MS - 1)).toBe("blocked");
    expect(ageState(store, 1000 + AGE_BLOCK_MS)).toBe("ok");
  });

  test("a passed answer from an older build is not read", () => {
    const store = memory();
    store.setItem("alkuin_age_ok", "1");
    expect(ageState(store)).toBe("ok");
  });
});

describe("age copy", () => {
  test("the copy never names the cutoff", () => {
    for (const line of [AGE_LABEL, AGE_INVALID, AGE_BLOCKED, AGE_STEP_PROMPT]) {
      expect(line).not.toMatch(/\d/);
      expect(line.toLowerCase()).not.toContain(String(MINIMUM_AGE));
    }
  });
});
