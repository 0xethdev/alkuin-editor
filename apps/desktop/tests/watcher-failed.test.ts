import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { watcherFailureApplies } from "../src/hooks/use-file-watcher";

const a = { root: "/vault", epoch: 2 };

describe("watcher:failed gate", () => {
  test("shows while the folder is still opening", () => {
    expect(watcherFailureApplies(a, null)).toBe(true);
  });

  test("shows for the current workspace", () => {
    expect(watcherFailureApplies(a, { root: "/vault", epoch: 2 })).toBe(true);
  });

  test("drops a failure from an earlier open of another folder", () => {
    expect(watcherFailureApplies(a, { root: "/other", epoch: 3 })).toBe(false);
    expect(watcherFailureApplies(a, { root: "/vault", epoch: 3 })).toBe(false);
  });
});
