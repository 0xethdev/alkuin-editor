import { afterEach, describe, expect, test, vi } from "vite-plus/test";

function fakeStorage(initial: Record<string, string> = {}, quota = Infinity) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => {
      const used = [...data.values()].reduce((n, s) => n + s.length, 0) + v.length;
      if (used > quota) throw new DOMException("full", "QuotaExceededError");
      data.set(k, v);
    }),
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => data.clear(),
  };
}

async function load() {
  vi.resetModules();
  return await import("../src/features/document-share/baseline");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("baseline default store", () => {
  test("opened text is not written to localStorage", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    const { rememberOpenedText } = await load();
    rememberOpenedText("/a.md", "secret body");
    expect([...storage.data.keys()].some((k) => k.startsWith("alkuin-share-opened"))).toBe(false);
  });

  test("a share baseline still starts from the text at open", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    const { rememberOpenedText, ensureBaseline } = await load();
    rememberOpenedText("/a.md", "at open");
    expect(ensureBaseline("s1", "/a.md", "later")).toBe("at open");
    expect(storage.data.get("alkuin-share-baseline:s1:/a.md")).toBe("at open");
  });

  test("a full localStorage does not throw", async () => {
    const storage = fakeStorage({}, 0);
    vi.stubGlobal("localStorage", storage);
    const { rememberOpenedText, ensureBaseline, rememberShare, loadShare } = await load();
    expect(() => rememberOpenedText("/a.md", "body")).not.toThrow();
    expect(() => ensureBaseline("s1", "/a.md", "later")).not.toThrow();
    expect(() => rememberShare("s1", "/a.md", "owner")).not.toThrow();
    expect(loadShare("/a.md")).toEqual({ shareId: "s1", role: "owner" });
  });

  test("copies left by older builds are removed", async () => {
    const storage = fakeStorage({
      "alkuin-share-opened:/old.md": "old body",
      "alkuin-share-baseline:s1:/a.md": "keep",
    });
    vi.stubGlobal("localStorage", storage);
    const { loadShare } = await load();
    loadShare("/x.md");
    expect(storage.data.has("alkuin-share-opened:/old.md")).toBe(false);
    expect(storage.data.get("alkuin-share-baseline:s1:/a.md")).toBe("keep");
  });

  test("a value kept in memory after a full store wins over the stale disk copy", async () => {
    const storage = fakeStorage({ "alkuin-share-baseline:s1:/a.md": "old" }, 0);
    vi.stubGlobal("localStorage", storage);
    const { advanceBaseline, ensureBaseline } = await load();
    advanceBaseline("s1", "/a.md", "new");
    expect(ensureBaseline("s1", "/a.md", "x")).toBe("new");
  });

  test("a write that succeeds after a failed one is not hidden by the memory copy", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem.mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const { advanceBaseline, ensureBaseline } = await load();
    advanceBaseline("s1", "/a.md", "first");
    advanceBaseline("s1", "/a.md", "second");
    expect(storage.data.get("alkuin-share-baseline:s1:/a.md")).toBe("second");
    expect(ensureBaseline("s1", "/a.md", "x")).toBe("second");
  });

  test("an outbox written while the store was full counts as unsent", async () => {
    const storage = fakeStorage({}, 0);
    vi.stubGlobal("localStorage", storage);
    const { saveOutbox, clearOutbox, shareHasUnsent } = await load();
    const plan = {
      changes: [{ payloadRef: "r1", passage: "p", original: "o", body: "b" }],
      withdraw: [],
    };
    saveOutbox("s1", "/a.md", plan);
    expect(storage.data.size).toBe(0);
    expect(shareHasUnsent("s1")).toBe(true);
    expect(shareHasUnsent("s2")).toBe(false);
    clearOutbox("s1", "/a.md");
    expect(shareHasUnsent("s1")).toBe(false);
  });

  test("an outbox on disk counts as unsent until it is cleared", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    const { saveOutbox, clearOutbox, shareHasUnsent } = await load();
    saveOutbox("s1", "/a.md", { changes: [], withdraw: ["r2"] });
    expect(shareHasUnsent("s1")).toBe(true);
    clearOutbox("s1", "/a.md");
    expect(shareHasUnsent("s1")).toBe(false);
  });

  test("closing a ledger removes it from the disk and from memory", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    const {
      advanceBaseline,
      closeLedger,
      ensureBaseline,
      rememberOpenedText,
      saveOutbox,
      shareHasUnsent,
    } = await load();
    rememberOpenedText("/a.md", "at open");
    advanceBaseline("s1", "/a.md", "on disk");
    // A full disk keeps this outbox in memory.
    storage.setItem.mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    saveOutbox("s1", "/a.md", { changes: [], withdraw: ["r1"] });
    expect(storage.data.has("alkuin-share-outbox:s1:/a.md")).toBe(false);
    expect(shareHasUnsent("s1")).toBe(true);
    closeLedger("s1");
    expect(storage.data.has("alkuin-share-baseline:s1:/a.md")).toBe(false);
    expect(shareHasUnsent("s1")).toBe(false);
    // The opened text for that path is gone too: a later invite starts from the text now.
    expect(ensureBaseline("s1", "/a.md", "fresh")).toBe("fresh");
  });
});
