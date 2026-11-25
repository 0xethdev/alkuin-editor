import { describe, expect, test } from "vite-plus/test";
import { liveTreeSelection, treeRangeSelection } from "../src/components/sidebar/tree-selection";
import { primaryButtonHeld } from "../src/components/sidebar/use-tree-drag";

describe("tree drag release", () => {
  test("a move without the primary button means the pointerup was lost", () => {
    expect(primaryButtonHeld({ buttons: 1 })).toBe(true);
    expect(primaryButtonHeld({ buttons: 3 })).toBe(true);
    expect(primaryButtonHeld({ buttons: 0 })).toBe(false);
    expect(primaryButtonHeld({ buttons: 2 })).toBe(false);
  });
});

const rows = (...paths: string[]) => new Map(paths.map((p) => [p, true]));

describe("liveTreeSelection", () => {
  test("keeps the same set when every selected row is still in the tree", () => {
    const selected = new Set(["/w/a.md", "/w/b.md"]);
    expect(liveTreeSelection(selected, rows("/w/a.md", "/w/b.md", "/w/c.md"))).toBe(selected);
  });

  test("drops rows that were renamed, deleted or hidden, so bulk actions skip them", () => {
    const selected = new Set(["/w/a.md", "/w/b.md", "/w/gone.md"]);
    // a.md was renamed to a2.md; gone.md was deleted.
    const live = liveTreeSelection(selected, rows("/w/a2.md", "/w/b.md"));
    expect([...live]).toEqual(["/w/b.md"]);
  });
});

describe("treeRangeSelection", () => {
  const order = ["/w/a.md", "/w/b.md", "/w/c.md", "/w/d.md"];

  test("selects from the anchor to the target in tree order", () => {
    expect(treeRangeSelection(order, "/w/d.md", "/w/b.md")).toEqual({
      paths: new Set(["/w/b.md", "/w/c.md", "/w/d.md"]),
      anchor: "/w/d.md",
    });
  });

  test("a stale anchor (its row was renamed or removed) restarts the range at the target", () => {
    expect(treeRangeSelection(order, "/w/renamed-away.md", "/w/c.md")).toEqual({
      paths: new Set(["/w/c.md"]),
      anchor: "/w/c.md",
    });
  });
});
