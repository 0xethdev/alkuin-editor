import { describe, expect, test } from "vite-plus/test";

describe("vite config font inlining", () => {
  test("never inlines fonts, keeps the default for other assets", async () => {
    const factory = (await import("../vite.config")).default;
    const config =
      typeof factory === "function"
        ? await factory({ command: "build", mode: "production" } as never)
        : factory;
    const limit = (config as { build?: { assetsInlineLimit?: unknown } }).build?.assetsInlineLimit;
    expect(typeof limit).toBe("function");
    const fn = limit as (file: string) => boolean | undefined;
    expect(fn("/x/KaTeX_Size3-Regular.woff2")).toBe(false);
    expect(fn("/x/a.ttf")).toBe(false);
    expect(fn("/x/logo.png")).toBeUndefined();
  });
});
