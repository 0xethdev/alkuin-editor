import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";

export function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function parentOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = normalized.lastIndexOf("/");
  return cut > 0 ? normalized.slice(0, cut) : "/";
}

/** Folder names for the menu. Two folders with one name also show where each one is. */
export function folderLabels(paths: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const name = folderName(path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(
    paths.map((path) => {
      const name = folderName(path);
      return [path, (counts.get(name) ?? 0) > 1 ? `${name} — ${parentOf(path)}` : name];
    }),
  );
}

export const REMOVE_FROM_LIST = "Remove from List";
export const MOVE_TO_TRASH = "Move to Trash";

/** The confirm before a whole folder goes to the Trash. Not yet through Copy. */
export function trashWorkspaceCopy(path: string) {
  return {
    title: `Move “${folderName(path)}” to the Trash?`,
    body: `${path}\n\nEverything in this folder goes to the Trash. Its documents are removed from Alkuin, and everyone you invited to one loses access.`,
    confirm: MOVE_TO_TRASH,
    cancel: "Cancel",
  };
}

/** What a failed Move to Trash says. The folder is untouched unless it was already gone. */
export function workspaceTrashFailure(path: string, error: unknown): string {
  const name = folderName(path);
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("workspace_open")) {
    return `“${name}” is open in a window. Close it there first.`;
  }
  if (text.startsWith("Not found")) {
    return `“${name}” is no longer there, so it is off the list.`;
  }
  return `Couldn't move “${name}” to the Trash: ${text}`;
}

export type WorkspaceMenuActions = {
  open: (path: string) => void;
  openFolder: () => void;
  close: () => void;
  remove: (path: string) => void;
  trash: (path: string) => void;
};

/**
 * The workspace switcher's menu: the other recent folders, Open Folder…, Close
 * Workspace, then Remove from List and Move to Trash for those other folders.
 * The open folder is never offered for removal: close it first.
 */
export function workspaceMenu(
  root: string | null,
  recent: string[],
  actions: WorkspaceMenuActions,
): MenuItemSpec[] {
  const others = recent.filter((path) => path !== root);
  const labels = folderLabels(others);
  const per = (prefix: string, run: (path: string) => void): MenuItemSpec[] =>
    others.map((path) => ({
      kind: "item",
      id: `${prefix}:${path}`,
      text: labels.get(path) ?? folderName(path),
      action: () => run(path),
    }));
  const items: MenuItemSpec[] = [...per("switch", actions.open)];
  if (others.length > 0) items.push({ kind: "separator" });
  items.push({ kind: "item", id: "open-folder", text: "Open Folder…", action: actions.openFolder });
  if (root) {
    items.push({
      kind: "item",
      id: "close-workspace",
      text: "Close Workspace",
      action: actions.close,
    });
  }
  if (others.length > 0) {
    items.push({ kind: "separator" });
    items.push({ kind: "submenu", text: REMOVE_FROM_LIST, items: per("remove", actions.remove) });
    items.push({ kind: "submenu", text: MOVE_TO_TRASH, items: per("trash", actions.trash) });
  }
  return items;
}
