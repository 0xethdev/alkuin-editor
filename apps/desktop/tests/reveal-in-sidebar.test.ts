import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  applyCssVarBindings: vi.fn(),
  readStoredAppearance: () => null,
}));

import { invoke } from "@tauri-apps/api/core";
import { revealPathInSidebar } from "../src/lib/reveal-in-sidebar";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

const mockedInvoke = vi.mocked(invoke);
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

function ancestors(root: string, leaf: string): string[] {
  const relative = leaf.slice(root.length + 1);
  const segments = relative.split("/");
  segments.pop();
  const chain: string[] = [];
  let accum = root;
  for (const segment of segments) {
    accum = `${accum}/${segment}`;
    chain.push(accum);
  }
  return chain;
}

const scrolled: string[] = [];

function installDom() {
  scrolled.length = 0;
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("document", {
    querySelector(selector: string) {
      const match = /^\[data-tree-path="([\s\S]*)"\]$/.exec(selector);
      if (!match) return null;
      const path = match[1];
      const { root, expandedDirs } = useWorkspaceStore.getState();
      if (!root || !ancestors(root, path).every((dir) => expandedDirs.has(dir))) return null;
      return {
        scrollIntoView(options: ScrollIntoViewOptions) {
          scrolled.push(`${path}:${options.behavior}:${options.block}`);
        },
      };
    },
  });
}

describe("revealPathInSidebar", () => {
  const originalExpand = useWorkspaceStore.getState().expandDirectory;

  beforeEach(() => {
    vi.clearAllMocks();
    scrolled.length = 0;
    installDom();
    mockedInvoke.mockImplementation(async (cmd, args) => {
      const payload = args && typeof args === "object" && !Array.isArray(args) ? args : {};
      if (cmd === "read_directory") return [];
      if (cmd === "set_setting") return "value" in payload ? payload.value : undefined;
      if (cmd === "read_file") {
        return { path: "path" in payload ? payload.path : "", content: "hello", modified_at: 1 };
      }
      return null;
    });
    useWorkspaceStore.setState({
      root: "/ws",
      workspaceGeneration: 1,
      directoryCache: new Map(),
      expandedDirs: new Set(),
      expandDirectory: originalExpand,
    });
    useSettingsStore.setState({
      settings: { "appearance.sidebar-visible": true },
      isLoaded: true,
    });
    useEditorStore.setState({
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
      openFiles: new Map(),
    });
  });

  test("expands collapsed ancestors in order and scrolls the row", async () => {
    const expanded: string[] = [];
    useWorkspaceStore.setState({
      expandDirectory: async (path: string) => {
        expanded.push(path);
        await originalExpand(path);
      },
    });

    await revealPathInSidebar("/ws/a/b/note.md");

    expect(expanded).toEqual(["/ws/a", "/ws/a/b"]);
    expect(useWorkspaceStore.getState().expandedDirs.has("/ws/a")).toBe(true);
    expect(useWorkspaceStore.getState().expandedDirs.has("/ws/a/b")).toBe(true);
    expect(useWorkspaceStore.getState().directoryCache.has("/ws/a")).toBe(true);
    expect(useWorkspaceStore.getState().directoryCache.has("/ws/a/b")).toBe(true);
    expect(scrolled).toEqual(["/ws/a/b/note.md:auto:nearest"]);
  });

  test("does not collapse an ancestor that is already expanded", async () => {
    useWorkspaceStore.setState({
      expandedDirs: new Set(["/ws/a"]),
      directoryCache: new Map([["/ws/a", []]]),
    });

    await revealPathInSidebar("/ws/a/note.md");

    expect(useWorkspaceStore.getState().expandedDirs.has("/ws/a")).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(scrolled).toEqual(["/ws/a/note.md:auto:nearest"]);
  });

  test("no-ops outside the workspace, with no root, and on the root itself", async () => {
    await revealPathInSidebar("/other/note.md");
    expect(useWorkspaceStore.getState().expandedDirs.size).toBe(0);
    expect(scrolled).toEqual([]);

    useWorkspaceStore.setState({ root: null });
    await revealPathInSidebar("/ws/note.md");
    expect(scrolled).toEqual([]);

    useWorkspaceStore.setState({ root: "/ws" });
    await revealPathInSidebar("/ws");
    expect(scrolled).toEqual([]);
  });

  test("showSidebar forces the sidebar visible before expanding", async () => {
    useSettingsStore.setState({
      settings: { "appearance.sidebar-visible": false },
    });

    await revealPathInSidebar("/ws/a/note.md", { showSidebar: true });

    expect(useSettingsStore.getState().settings["appearance.sidebar-visible"]).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("set_setting", {
      key: "appearance.sidebar-visible",
      value: true,
      scope: "global",
    });
    expect(useWorkspaceStore.getState().expandedDirs.has("/ws/a")).toBe(true);
    expect(scrolled).toEqual(["/ws/a/note.md:auto:nearest"]);
  });

  test("omitting showSidebar leaves a hidden sidebar hidden", async () => {
    useSettingsStore.setState({
      settings: { "appearance.sidebar-visible": false },
    });

    await revealPathInSidebar("/ws/note.md");

    expect(useSettingsStore.getState().settings["appearance.sidebar-visible"]).toBe(false);
    expect(scrolled).toEqual(["/ws/note.md:auto:nearest"]);
  });

  test("a later reveal cancels an in-flight scroll", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    useWorkspaceStore.setState({
      expandDirectory: async (path: string) => {
        calls += 1;
        if (calls === 1) await gate;
        const expandedDirs = new Set(useWorkspaceStore.getState().expandedDirs);
        expandedDirs.add(path);
        useWorkspaceStore.setState({ expandedDirs });
      },
    });

    const first = revealPathInSidebar("/ws/a/one.md");
    const second = revealPathInSidebar("/ws/b/two.md");
    await second;
    releaseFirst();
    await first;

    expect(scrolled).toEqual(["/ws/b/two.md:auto:nearest"]);
    expect(useWorkspaceStore.getState().expandedDirs.has("/ws/a")).toBe(true);
    expect(useWorkspaceStore.getState().expandedDirs.has("/ws/b")).toBe(true);
  });

  test("opening a file does not expand the tree", async () => {
    await useEditorStore.getState().openFile("/ws/a/b/note.md");

    expect(useEditorStore.getState().activeFilePath).toBe("/ws/a/b/note.md");
    expect(useWorkspaceStore.getState().expandedDirs.size).toBe(0);
    expect(scrolled).toEqual([]);
  });

  test("only the tab context menu calls reveal", () => {
    const callers = sourceFiles(srcRoot)
      .filter((file) => !file.endsWith(`${join("lib", "reveal-in-sidebar.ts")}`))
      .filter((file) => readFileSync(file, "utf8").includes("revealPathInSidebar"))
      .map((file) => file.slice(srcRoot.length + 1));

    expect(callers).toEqual([join("components", "editor-area", "editor-tabs.tsx")]);

    const tabs = readFileSync(join(srcRoot, "components/editor-area/editor-tabs.tsx"), "utf8");
    expect(tabs).toContain("revealPathInSidebar(filePath, { showSidebar: true })");
    expect(tabs).toContain("setActiveTab(tab.id)");

    const node = readFileSync(join(srcRoot, "components/sidebar/file-tree-node.tsx"), "utf8");
    expect(node).toContain("data-tree-path={entry.path}");

    const reveal = readFileSync(join(srcRoot, "lib/reveal-in-sidebar.ts"), "utf8");
    expect(reveal).not.toContain("useEffect");
  });
});
