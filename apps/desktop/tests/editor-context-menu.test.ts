import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/menu/menu", () => ({ Menu: { new: vi.fn() } }));
vi.mock("@tauri-apps/api/menu/predefinedMenuItem", () => ({
  PredefinedMenuItem: { new: vi.fn() },
}));
vi.mock("@tauri-apps/api/menu/menuItem", () => ({ MenuItem: { new: vi.fn() } }));
vi.mock("@tauri-apps/api/menu/submenu", () => ({ Submenu: { new: vi.fn() } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(),
  readText: vi.fn(),
}));

import {
  buildEditorBodyMenuItemsSpec,
  buildTabMenuItemsSpec,
  buildTitleMenuItemsSpec,
  type EditorBodyMenuHandlers,
  type TabMenuHandlers,
  type TitleMenuHandlers,
} from "../src/components/editor-area/editor-context-menu";
import {
  ContextMenuRanges,
  resolveContextMenuRange,
} from "../src/components/editor-area/editor-body-menu";
import { ChangeSet } from "@codemirror/state";

function makeBodyHandlers(): EditorBodyMenuHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onCut: () => calls.push("cut"),
    onCopy: () => calls.push("copy"),
    onPaste: () => calls.push("paste"),
    onSelectAll: () => calls.push("select-all"),
    onOpenLink: () => calls.push("open-link"),
    onCopyLink: () => calls.push("copy-link"),
  };
}

function makeTabHandlers(): TabMenuHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onClose: () => calls.push("close"),
    onCloseOthers: () => calls.push("close-others"),
    onCloseAll: () => calls.push("close-all"),
    onRevealInSidebar: () => calls.push("reveal-in-sidebar"),
    onCopyPath: () => calls.push("copy-path"),
  };
}

function makeTitleHandlers(): TitleMenuHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onRename: () => calls.push("rename"),
    onReveal: () => calls.push("reveal"),
    onCopyPath: () => calls.push("copy-path"),
  };
}

describe("buildEditorBodyMenuItemsSpec", () => {
  test("emits base items without link actions when hasLink is false", () => {
    const spec = buildEditorBodyMenuItemsSpec(makeBodyHandlers(), false);
    const summary = spec.map((e) =>
      e.kind === "separator" ? "---" : e.kind === "submenu" ? `[${e.text}]` : e.id,
    );
    expect(summary).toEqual(["cut", "copy", "paste", "---", "select-all"]);
  });

  test("appends link actions when hasLink is true", () => {
    const spec = buildEditorBodyMenuItemsSpec(makeBodyHandlers(), true);
    const summary = spec.map((e) =>
      e.kind === "separator" ? "---" : e.kind === "submenu" ? `[${e.text}]` : e.id,
    );
    expect(summary).toEqual([
      "cut",
      "copy",
      "paste",
      "---",
      "select-all",
      "---",
      "open-link",
      "copy-link",
    ]);
  });

  test("each item invokes the matching handler", () => {
    const handlers = makeBodyHandlers();
    const spec = buildEditorBodyMenuItemsSpec(handlers, true);
    for (const entry of spec) {
      if (entry.kind === "item") entry.action();
    }
    expect(handlers.calls).toEqual([
      "cut",
      "copy",
      "paste",
      "select-all",
      "open-link",
      "copy-link",
    ]);
  });

  test("appends one redline action when the handler is provided", () => {
    const handlers = makeBodyHandlers();
    const spec = buildEditorBodyMenuItemsSpec(
      {
        ...handlers,
        onAddRedlineNote: () => handlers.calls.push("redline-note"),
      },
      false,
    );
    const summary = spec.map((e) =>
      e.kind === "separator" ? "---" : e.kind === "submenu" ? `[${e.text}]` : e.id,
    );
    expect(summary).toEqual(["cut", "copy", "paste", "---", "select-all", "---", "redline-note"]);
    const note = spec.find((e) => e.kind === "item" && e.id === "redline-note");
    expect(note?.kind === "item" ? note.text : "").toBe("Add a margin note");
    expect(summary).not.toContain("redline-ask");
    if (note?.kind === "item") note.action();
    expect(handlers.calls).toEqual(["redline-note"]);
  });

  test("palette and body menu keep one compose action, not a second Ask item", () => {
    const palette = readFileSync(
      new URL("../src/components/command-palette/index.tsx", import.meta.url),
      "utf8",
    );
    expect(palette).toMatch(/id: "redline-add-note"/);
    expect(palette).toMatch(/askAgentAtSelection/);
    expect(palette).not.toMatch(/id: "redline-preferences"/);
    expect(palette).not.toMatch(/redlineClearPreferences/);
    expect(palette).toMatch(
      /matchesSearch\(c\.label, trimmedSearch\) \|\| matchesSearch\(c\.description, trimmedSearch\)/,
    );
    expect(palette).not.toMatch(/redline-ask-agent/);
    expect(palette).not.toMatch(/addNoteAtSelection/);

    const bodyMenu = readFileSync(
      new URL("../src/components/editor-area/editor-body-menu.ts", import.meta.url),
      "utf8",
    );
    expect(bodyMenu).toMatch(/askAgentFromMenu/);
    expect(bodyMenu).not.toMatch(/onAskAgentRewrite/);
    expect(bodyMenu).not.toMatch(/addNoteFromMenu/);
  });

  test("no submenus when onRunCommand is not provided", () => {
    const spec = buildEditorBodyMenuItemsSpec(makeBodyHandlers(), false);
    const submenus = spec.filter((e) => e.kind === "submenu");
    expect(submenus).toHaveLength(0);
  });

  test("includes Format, Paragraph, Insert submenus when onRunCommand is provided", () => {
    const handlers = makeBodyHandlers();
    handlers.onRunCommand = () => {};
    const spec = buildEditorBodyMenuItemsSpec(handlers, false);
    const topLevel = spec
      .filter((e) => e.kind !== "separator")
      .map((e) => (e.kind === "submenu" ? `[${e.text}]` : e.id));
    expect(topLevel).toEqual([
      "cut",
      "copy",
      "paste",
      "[Format]",
      "[Paragraph]",
      "[Insert]",
      "select-all",
    ]);
  });

  test("Format submenu contains expected items", () => {
    const handlers = makeBodyHandlers();
    handlers.onRunCommand = () => {};
    const spec = buildEditorBodyMenuItemsSpec(handlers, false);
    const formatSubmenu = spec.find((e) => e.kind === "submenu" && e.text === "Format");
    expect(formatSubmenu).toBeDefined();
    if (formatSubmenu?.kind !== "submenu") throw new Error("expected submenu");
    const items = formatSubmenu.items.filter((e) => e.kind === "item").map((e) => e.id);
    expect(items).toContain("fmt.bold");
    expect(items).toContain("fmt.italic");
    expect(items).toContain("fmt.strikethrough");
    expect(items).toContain("fmt.code");
    expect(items).toContain("fmt.link");
    expect(items).toContain("fmt.clear");
  });

  test("Paragraph submenu contains heading and list items", () => {
    const handlers = makeBodyHandlers();
    handlers.onRunCommand = () => {};
    const spec = buildEditorBodyMenuItemsSpec(handlers, false);
    const paraSubmenu = spec.find((e) => e.kind === "submenu" && e.text === "Paragraph");
    expect(paraSubmenu).toBeDefined();
    if (paraSubmenu?.kind !== "submenu") throw new Error("expected submenu");
    const items = paraSubmenu.items.filter((e) => e.kind === "item").map((e) => e.id);
    expect(items).toContain("para.h1");
    expect(items).toContain("para.h6");
    expect(items).toContain("para.bullet");
    expect(items).toContain("para.numbered");
    expect(items).toContain("para.task");
    expect(items).toContain("para.blockquote");
    expect(items).toContain("para.codeblock");
  });

  test("Insert submenu contains expected items", () => {
    const handlers = makeBodyHandlers();
    handlers.onRunCommand = () => {};
    const spec = buildEditorBodyMenuItemsSpec(handlers, false);
    const insertSubmenu = spec.find((e) => e.kind === "submenu" && e.text === "Insert");
    expect(insertSubmenu).toBeDefined();
    if (insertSubmenu?.kind !== "submenu") throw new Error("expected submenu");
    const items = insertSubmenu.items.filter((e) => e.kind === "item").map((e) => e.id);
    expect(items).toContain("ins.link");
    expect(items).toContain("ins.table");
    expect(items).toContain("ins.hr");
    expect(items).toContain("ins.date");
    expect(items).toContain("ins.time");
  });

  test("submenu items have accelerator strings", () => {
    const handlers = makeBodyHandlers();
    handlers.onRunCommand = () => {};
    const spec = buildEditorBodyMenuItemsSpec(handlers, false);
    const formatSubmenu = spec.find((e) => e.kind === "submenu" && e.text === "Format");
    if (formatSubmenu?.kind !== "submenu") throw new Error("expected submenu");
    const bold = formatSubmenu.items.find((e) => e.kind === "item" && e.id === "fmt.bold");
    expect(bold && bold.kind === "item" ? bold.accelerator : undefined).toBe("CmdOrCtrl+B");
  });

  test("onRunCommand callback is invoked with correct id", () => {
    const calls: string[] = [];
    const handlers = makeBodyHandlers();
    handlers.onRunCommand = (id: string) => calls.push(id);
    const spec = buildEditorBodyMenuItemsSpec(handlers, false);
    const formatSubmenu = spec.find((e) => e.kind === "submenu" && e.text === "Format");
    if (formatSubmenu?.kind !== "submenu") throw new Error("expected submenu");
    const bold = formatSubmenu.items.find((e) => e.kind === "item" && e.id === "fmt.bold");
    if (bold?.kind === "item") bold.action();
    expect(calls).toEqual(["format.bold"]);
  });
});

describe("buildTabMenuItemsSpec", () => {
  test("emits items in the spec order with separator", () => {
    const spec = buildTabMenuItemsSpec(makeTabHandlers());
    const summary = spec.map((e) => (e.kind === "separator" ? "---" : `${e.id}:${e.text}`));
    expect(summary).toEqual([
      "close:Close",
      "close-others:Close others",
      "close-all:Close all",
      "---",
      "reveal-in-sidebar:Reveal in sidebar",
      "copy-path:Copy path",
    ]);
  });

  test("each item invokes the matching handler", () => {
    const handlers = makeTabHandlers();
    const spec = buildTabMenuItemsSpec(handlers);
    for (const entry of spec) {
      if (entry.kind === "item") entry.action();
    }
    expect(handlers.calls).toEqual([
      "close",
      "close-others",
      "close-all",
      "reveal-in-sidebar",
      "copy-path",
    ]);
  });
});

describe("buildTitleMenuItemsSpec", () => {
  test("uses platform-specific reveal label", () => {
    const macSpec = buildTitleMenuItemsSpec(makeTitleHandlers(), "macos");
    const reveal = macSpec.find((e) => e.kind === "item" && e.id === "reveal");
    expect(reveal && reveal.kind === "item" ? reveal.text : null).toBe("Reveal in Finder");

    const winSpec = buildTitleMenuItemsSpec(makeTitleHandlers(), "windows");
    const winReveal = winSpec.find((e) => e.kind === "item" && e.id === "reveal");
    expect(winReveal && winReveal.kind === "item" ? winReveal.text : null).toBe(
      "Reveal in Explorer",
    );
  });

  test("each item invokes the matching handler", () => {
    const handlers = makeTitleHandlers();
    const spec = buildTitleMenuItemsSpec(handlers, "linux");
    for (const entry of spec) {
      if (entry.kind === "item") entry.action();
    }
    expect(handlers.calls).toEqual(["rename", "reveal", "copy-path"]);
  });
});

describe("resolveContextMenuRange", () => {
  test("live range wins over a pointer snapshot", () => {
    expect(
      resolveContextMenuRange({
        liveFrom: 2,
        liveTo: 8,
        pointerFrom: 0,
        pointerTo: 10,
        lastFrom: 0,
        lastTo: 10,
        clickPos: 3,
      }),
    ).toEqual({ from: 2, to: 8 });
  });

  test("collapsed live uses the pointer-down snapshot", () => {
    expect(
      resolveContextMenuRange({
        liveFrom: 4,
        liveTo: 4,
        pointerFrom: 0,
        pointerTo: 12,
        lastFrom: 0,
        lastTo: 12,
        clickPos: 4,
      }),
    ).toEqual({ from: 0, to: 12 });
  });

  test("collapsed live and pointer still ask when the click is inside the last range", () => {
    expect(
      resolveContextMenuRange({
        liveFrom: 9,
        liveTo: 9,
        pointerFrom: 9,
        pointerTo: 9,
        lastFrom: 2,
        lastTo: 14,
        clickPos: 8,
      }),
    ).toEqual({ from: 2, to: 14 });
  });

  test("click outside a collapsed last range stays a no-op empty range", () => {
    expect(
      resolveContextMenuRange({
        liveFrom: 20,
        liveTo: 20,
        pointerFrom: 20,
        pointerTo: 20,
        lastFrom: 2,
        lastTo: 14,
        clickPos: 20,
      }),
    ).toEqual({ from: 20, to: 20 });
  });
});

describe("ContextMenuRanges", () => {
  const DOC_LENGTH = 40;
  const sel = (from: number, to = from) => ({ from, to });
  const noEdit = (selection: { from: number; to: number }) => ({
    docChanged: false,
    changes: ChangeSet.empty(DOC_LENGTH),
    selection,
    swapped: false,
  });

  test("a right-click snapshot serves the menu it opens, then is consumed", () => {
    const ranges = new ContextMenuRanges();
    ranges.press(sel(5, 10), 7, true);
    // WKWebView collapsed the live selection before contextmenu fired.
    expect(ranges.open(sel(7), 7)).toEqual({ from: 5, to: 10 });
    ranges.observe(noEdit(sel(20)));
    // A keyboard-opened menu later (no press) must not reuse it.
    expect(ranges.open(sel(20), null)).toEqual({ from: 20, to: 20 });
  });

  test("a plain press drops a pending snapshot", () => {
    const ranges = new ContextMenuRanges();
    ranges.press(sel(5, 10), 7, true);
    ranges.press(sel(20), null, false);
    expect(ranges.open(sel(20), null)).toEqual({ from: 20, to: 20 });
  });

  test("the open menu's range follows edits made while it is open", () => {
    const ranges = new ContextMenuRanges();
    ranges.open(sel(5, 10), 7);
    ranges.observe({
      docChanged: true,
      changes: ChangeSet.of({ from: 0, insert: "abc" }, DOC_LENGTH),
      selection: sel(0),
      swapped: false,
    });
    expect(ranges.menuRange()).toEqual({ from: 8, to: 13 });
  });

  test("a range whose text was deleted is dropped, not left pointing elsewhere", () => {
    const ranges = new ContextMenuRanges();
    ranges.open(sel(5, 10), 7);
    ranges.observe({
      docChanged: true,
      changes: ChangeSet.of({ from: 4, to: 11 }, DOC_LENGTH),
      selection: sel(4),
      swapped: false,
    });
    expect(ranges.menuRange()).toEqual({ from: 0, to: 0 });
    // The last non-empty selection went with it, so a click there can't revive it.
    expect(ranges.open(sel(6), 6)).toEqual({ from: 6, to: 6 });
  });

  test("a swap to another document clears every snapshot", () => {
    const ranges = new ContextMenuRanges();
    ranges.press(sel(5, 10), 7, true);
    ranges.observe({ ...noEdit(sel(0)), swapped: true });
    expect(ranges.open(sel(0), 7)).toEqual({ from: 0, to: 0 });
  });
});
