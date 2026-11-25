import { describe, expect, it } from "vite-plus/test";
import { nextRedlineId } from "../src/features/redline-spike/notes";

describe("nextRedlineId", () => {
  it("returns distinct ids that fit the server limit", () => {
    const a = nextRedlineId();
    const b = nextRedlineId();
    expect(a).not.toBe(b);
    for (const id of [a, b]) {
      expect(id).toMatch(/^redline-[0-9a-f-]{36}$/);
      expect(id.length).toBeLessThanOrEqual(80);
    }
  });
});
