import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react", async () => (await import("./helpers/hook-harness")).reactHooks);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { renderOnce, unmountAll } from "./helpers/hook-harness";
import { useGlobalRecentFiles } from "../src/hooks/use-global-recent-files";
import type { RecentFile } from "../src/lib/tauri";

const mockedInvoke = vi.mocked(invoke);

function recent(path: string): RecentFile {
  return { path, name: path.split("/").pop() ?? path } as RecentFile;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function render() {
  return renderOnce(() => useGlobalRecentFiles());
}

beforeEach(() => {
  unmountAll();
  mockedInvoke.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("global recent files", () => {
  test("a fetch that read the list before a remove does not bring the row back", async () => {
    const first = deferred<RecentFile[]>();
    const removing = deferred<void>();
    mockedInvoke.mockImplementation((command) => {
      if (command === "get_recent_files_global") return first.promise;
      if (command === "remove_recent_file") return removing.promise;
      return Promise.resolve(undefined);
    });
    render();
    render().remove("/notes/a.md");
    first.resolve([recent("/notes/a.md"), recent("/notes/b.md")]);
    await settle();
    expect(render().files.map((file) => file.path)).toEqual(["/notes/b.md"]);
    expect(render().loaded).toBe(true);
  });

  test("a manual refresh while the remove is still in flight keeps the row gone", async () => {
    const removing = deferred<void>();
    const lists = [
      [recent("/notes/a.md"), recent("/notes/b.md")],
      [recent("/notes/a.md"), recent("/notes/b.md")],
      [recent("/notes/a.md")],
    ];
    mockedInvoke.mockImplementation((command) => {
      if (command === "get_recent_files_global") return Promise.resolve(lists.shift());
      if (command === "remove_recent_file") return removing.promise;
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    render().remove("/notes/a.md");
    render().refresh();
    await settle();
    expect(render().files.map((file) => file.path)).toEqual(["/notes/b.md"]);
    removing.resolve();
    await settle();
    // Opened again later: a fetch after the remove settled shows it.
    render().refresh();
    await settle();
    expect(render().files.map((file) => file.path)).toEqual(["/notes/a.md"]);
  });

  test("an older refresh that lands after a newer one is dropped", async () => {
    const older = deferred<RecentFile[]>();
    const newer = deferred<RecentFile[]>();
    const reads = [Promise.resolve([] as RecentFile[]), older.promise, newer.promise];
    mockedInvoke.mockImplementation((command) => {
      if (command === "get_recent_files_global") return reads.shift()!;
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    render().refresh();
    render().refresh();
    newer.resolve([recent("/notes/new.md")]);
    await settle();
    older.resolve([recent("/notes/old.md")]);
    await settle();
    expect(render().files.map((file) => file.path)).toEqual(["/notes/new.md"]);
  });

  test("a failed fetch leaves the list unknown, not empty", async () => {
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("io")));
    render();
    await settle();
    expect(render().loaded).toBe(false);
  });
});
