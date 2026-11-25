import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  applyCssVarBindings: vi.fn(),
}));

import { rememberWritingSession } from "../src/lib/account-session";
import { MENU_EVENT_HANDLERS } from "../src/hooks/use-menu-events";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

beforeEach(() => {
  rememberWritingSession(true);
  vi.clearAllMocks();
  useWorkspaceStore.setState({ chromeMode: "workspace" });
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
  });
});

describe("menu-events", () => {
  test("menu:open-preferences does nothing while signed out", () => {
    rememberWritingSession(false);
    MENU_EVENT_HANDLERS["menu:open-preferences"]!();
    expect(useEditorStore.getState().tabs).toHaveLength(0);
    MENU_EVENT_HANDLERS["menu:export-pdf"]!();
    expect(useEditorStore.getState().tabs).toHaveLength(0);
    rememberWritingSession(true);
  });

  test("menu:open-preferences opens a preferences tab", () => {
    const handler = MENU_EVENT_HANDLERS["menu:open-preferences"];
    expect(handler).toBeDefined();

    handler!();

    const tabs = useEditorStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.location.kind).toBe("preferences");
    expect(useEditorStore.getState().activeTabId).toBe(tabs[0]!.id);
  });

  test("menu:open-preferences focuses the existing preferences tab instead of duplicating", () => {
    const handler = MENU_EVENT_HANDLERS["menu:open-preferences"]!;

    handler();
    const firstId = useEditorStore.getState().activeTabId;
    handler();
    const secondId = useEditorStore.getState().activeTabId;

    const preferencesTabs = useEditorStore
      .getState()
      .tabs.filter((tab) => tab.location.kind === "preferences");
    expect(preferencesTabs).toHaveLength(1);
    expect(secondId).toBe(firstId);
  });

  test("menu:open-preferences opens in compact file mode and does not duplicate", () => {
    useWorkspaceStore.setState({ root: null, chromeMode: "compact-file" });
    useEditorStore.setState({
      tabs: [
        {
          id: "file-1",
          location: { kind: "file", path: "/tmp/note.md" },
          back: [],
          forward: [],
        },
      ],
      activeTabId: "file-1",
      activeFilePath: "/tmp/note.md",
    });

    MENU_EVENT_HANDLERS["menu:open-preferences"]!();
    MENU_EVENT_HANDLERS["menu:open-preferences"]!();

    const tabs = useEditorStore.getState().tabs;
    const preferences = tabs.filter((tab) => tab.location.kind === "preferences");
    expect(preferences).toHaveLength(1);
    expect(tabs.some((tab) => tab.location.kind === "file")).toBe(true);
    expect(useEditorStore.getState().activeTabId).toBe(preferences[0]!.id);
  });

  test("the titlebar gear opens preferences and the open-sidebar toggle is the collapsed one", () => {
    const layout = readFileSync(
      new URL("../src/components/app-layout.tsx", import.meta.url),
      "utf8",
    );
    const button = readFileSync(
      new URL("../src/components/preferences-button.tsx", import.meta.url),
      "utf8",
    );
    const compact = readFileSync(
      new URL("../src/components/compact-file-layout.tsx", import.meta.url),
      "utf8",
    );
    expect(button).toContain('aria-label="Preferences"');
    expect(button).toContain('title="Preferences ⌘,"');
    expect(button).toContain("onClick={openPreferences}");
    expect(layout).toContain("<PreferencesButton />");
    expect(layout).toContain("{isSidebarCollapsed ? <SidebarToggleButton /> : null}");
    expect(layout).toContain("isSidebarCollapsed ? 84 : 52");
    expect(compact).toContain("<PreferencesButton />");
  });
});
