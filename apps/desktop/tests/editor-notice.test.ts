import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  clearLastingNotices,
  dismissEditorNotice,
  resetEditorNoticesForTest,
  showEditorNotice,
  useEditorNoticeStore,
  withdrawEditorNotice,
  type OverlapNotice,
} from "../src/components/editor-area/editor-notice-store";
import { SYNC_CONFLICT_LINE, SYNC_REMOVED_LINE } from "../src/features/redline-spike/margin-copy";

function overlapFor(path: string, versionId = "v1", deleted = false): OverlapNotice {
  return { path, localText: "ours\n", otherText: "theirs\n", deleted, versionId };
}

function visible() {
  const { message, overlap } = useEditorNoticeStore.getState();
  return { message, overlap: overlap?.path ?? null };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The store schedules its auto-dismiss on `window`.
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  });
  useEditorNoticeStore.setState({ toast: null, overlaps: [], message: null, overlap: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("editor notice slot", () => {
  test("a toast covers an unresolved overlap but does not evict it", () => {
    useEditorNoticeStore.getState().showOverlap(overlapFor("/a.md"));
    showEditorNotice("Diagnostics copied");
    expect(visible()).toEqual({ message: "Diagnostics copied", overlap: null });

    dismissEditorNotice();
    expect(visible()).toEqual({ message: SYNC_CONFLICT_LINE, overlap: "/a.md" });
  });

  test("the toast's auto-dismiss brings the overlap back and never removes it", () => {
    useEditorNoticeStore.getState().showOverlap(overlapFor("/a.md"));
    showEditorNotice("Image not pasted");
    vi.advanceTimersByTime(4000);
    expect(visible()).toEqual({ message: SYNC_CONFLICT_LINE, overlap: "/a.md" });
    vi.advanceTimersByTime(60_000);
    expect(visible().overlap).toBe("/a.md");
  });

  test("overlaps queue per path: a second path waits, the same path is replaced", () => {
    const store = useEditorNoticeStore.getState();
    store.showOverlap(overlapFor("/a.md", "v1"));
    store.showOverlap(overlapFor("/b.md", "v1", true));
    store.showOverlap(overlapFor("/a.md", "v2"));
    const { overlaps, overlap } = useEditorNoticeStore.getState();
    expect(overlaps.map((o) => `${o.path}@${o.versionId}`)).toEqual(["/a.md@v2", "/b.md@v1"]);
    expect(overlap?.versionId).toBe("v2");

    dismissEditorNotice();
    expect(visible()).toEqual({ message: SYNC_REMOVED_LINE, overlap: "/b.md" });
  });

  test("dismissOverlap drops only that path's decision", () => {
    const store = useEditorNoticeStore.getState();
    store.showOverlap(overlapFor("/a.md"));
    store.showOverlap(overlapFor("/b.md"));
    store.dismissOverlap("/b.md");
    expect(useEditorNoticeStore.getState().overlaps.map((o) => o.path)).toEqual(["/a.md"]);
    store.dismissOverlap("/a.md");
    expect(visible()).toEqual({ message: null, overlap: null });
  });

  test("a sticky toast stays until dismissed, and dismissing it clears only the toast", () => {
    useEditorNoticeStore.getState().showOverlap(overlapFor("/a.md"));
    showEditorNotice("Sharing failed", { sticky: true });
    vi.advanceTimersByTime(60_000);
    expect(visible().message).toBe("Sharing failed");
    dismissEditorNotice();
    expect(visible().overlap).toBe("/a.md");
  });

  test("a newer toast replaces the old one and owns the timer", () => {
    showEditorNotice("first");
    vi.advanceTimersByTime(3000);
    showEditorNotice("second");
    vi.advanceTimersByTime(3000);
    expect(visible().message).toBe("second");
    vi.advanceTimersByTime(1000);
    expect(visible().message).toBeNull();
  });
});

describe("lasting lines", () => {
  beforeEach(() => {
    resetEditorNoticesForTest();
  });

  test("a passing toast shows over a lasting line, which comes back when it times out", () => {
    showEditorNotice("Saved beside it", { sticky: true, lasting: true });
    showEditorNotice("Diagnostics copied");
    expect(visible().message).toBe("Diagnostics copied");
    vi.advanceTimersByTime(4000);
    expect(visible().message).toBe("Saved beside it");
    vi.advanceTimersByTime(60_000);
    expect(visible().message).toBe("Saved beside it");
  });

  test("a second lasting line waits its turn, and a withdrawn one never shows", () => {
    showEditorNotice("first", { sticky: true, lasting: true });
    showEditorNotice("second", { sticky: true, lasting: true });
    showEditorNotice("third", { sticky: true, lasting: true });
    expect(visible().message).toBe("first");
    withdrawEditorNotice("second");
    dismissEditorNotice();
    expect(visible().message).toBe("third");
    dismissEditorNotice();
    expect(visible().message).toBeNull();
  });

  test("one line per key: a newer one replaces the line showing, or the one waiting", () => {
    showEditorNotice("a.md copy 1", { sticky: true, lasting: true, key: "a" });
    showEditorNotice("a.md copy 2", { sticky: true, lasting: true, key: "a" });
    expect(visible().message).toBe("a.md copy 2");
    showEditorNotice("b.md copy 1", { sticky: true, lasting: true, key: "b" });
    showEditorNotice("b.md copy 2", { sticky: true, lasting: true, key: "b" });
    dismissEditorNotice();
    expect(visible().message).toBe("b.md copy 2");
    dismissEditorNotice();
    expect(visible().message).toBeNull();
  });

  test("a folder change clears lasting lines and leaves overlaps", () => {
    useEditorNoticeStore.getState().showOverlap(overlapFor("/a.md"));
    showEditorNotice("first", { sticky: true, lasting: true });
    showEditorNotice("second", { sticky: true, lasting: true });
    clearLastingNotices();
    expect(visible()).toEqual({ message: SYNC_CONFLICT_LINE, overlap: "/a.md" });
    dismissEditorNotice();
    expect(visible().message).toBeNull();
  });

  test("an overlap waits behind a lasting line and is not lost", () => {
    showEditorNotice("lasting", { sticky: true, lasting: true });
    useEditorNoticeStore.getState().showOverlap(overlapFor("/a.md"));
    expect(visible().message).toBe("lasting");
    dismissEditorNotice();
    expect(visible()).toEqual({ message: SYNC_CONFLICT_LINE, overlap: "/a.md" });
  });
});
