import { describe, expect, test } from "vite-plus/test";
import type { MenuItemSpec } from "../src/components/editor-area/editor-context-menu";
import {
  MOVE_TO_TRASH,
  REMOVE_FROM_LIST,
  folderLabels,
  trashWorkspaceCopy,
  workspaceMenu,
  workspaceTrashFailure,
} from "../src/components/sidebar/workspace-menu";

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      open: (path: string) => calls.push(`open ${path}`),
      openFolder: () => calls.push("open-folder"),
      close: () => calls.push("close"),
      remove: (path: string) => calls.push(`remove ${path}`),
      trash: (path: string) => calls.push(`trash ${path}`),
    },
  };
}

function texts(items: MenuItemSpec[]): string[] {
  return items.map((item) => (item.kind === "separator" ? "---" : item.text));
}

function submenu(items: MenuItemSpec[], text: string): MenuItemSpec[] {
  const found = items.find((item) => item.kind === "submenu" && item.text === text);
  if (!found || found.kind !== "submenu") throw new Error(`no ${text}`);
  return found.items;
}

describe("workspace switcher menu", () => {
  test("the other folders can be removed from the list or moved to the Trash", () => {
    const { calls, actions } = recorder();
    const items = workspaceMenu("/u/notes", ["/u/notes", "/u/wiki", "/u/drafts"], actions);
    expect(texts(items)).toEqual([
      "wiki",
      "drafts",
      "---",
      "Open Folder…",
      "Close Workspace",
      "---",
      REMOVE_FROM_LIST,
      MOVE_TO_TRASH,
    ]);
    // The open folder is never offered: close it first.
    expect(texts(submenu(items, REMOVE_FROM_LIST))).toEqual(["wiki", "drafts"]);
    expect(texts(submenu(items, MOVE_TO_TRASH))).toEqual(["wiki", "drafts"]);
    for (const item of [...submenu(items, REMOVE_FROM_LIST), ...submenu(items, MOVE_TO_TRASH)]) {
      if (item.kind === "item") item.action();
    }
    expect(calls).toEqual([
      "remove /u/wiki",
      "remove /u/drafts",
      "trash /u/wiki",
      "trash /u/drafts",
    ]);
  });

  test("with no workspace open every listed folder is offered", () => {
    const { actions } = recorder();
    const items = workspaceMenu(null, ["/u/notes"], actions);
    expect(texts(items)).toEqual([
      "notes",
      "---",
      "Open Folder…",
      "---",
      REMOVE_FROM_LIST,
      MOVE_TO_TRASH,
    ]);
  });

  test("nothing else listed: no removal menus", () => {
    const { actions } = recorder();
    expect(texts(workspaceMenu("/u/notes", ["/u/notes"], actions))).toEqual([
      "Open Folder…",
      "Close Workspace",
    ]);
    expect(texts(workspaceMenu(null, [], actions))).toEqual(["Open Folder…"]);
  });

  test("two folders with one name show where each one is", () => {
    const labels = folderLabels(["/u/a/notes", "/u/b/notes", "/u/wiki"]);
    expect(labels.get("/u/a/notes")).toBe("notes — /u/a");
    expect(labels.get("/u/b/notes")).toBe("notes — /u/b");
    expect(labels.get("/u/wiki")).toBe("wiki");
  });

  test("the confirm names the folder and its full path", () => {
    const copy = trashWorkspaceCopy("/u/a/notes");
    expect(copy.title).toBe("Move “notes” to the Trash?");
    expect(copy.body.startsWith("/u/a/notes\n\n")).toBe(true);
    expect(copy.confirm).toBe(MOVE_TO_TRASH);
  });

  test("a refusal says what to do", () => {
    expect(workspaceTrashFailure("/u/notes", "IO error: workspace_open")).toBe(
      "“notes” is open in a window. Close it there first.",
    );
    expect(workspaceTrashFailure("/u/notes", "Not found: /u/notes")).toBe(
      "“notes” is no longer there, so it is off the list.",
    );
    expect(workspaceTrashFailure("/u/notes", new Error("IO error: denied"))).toBe(
      "Couldn't move “notes” to the Trash: IO error: denied",
    );
  });
});
