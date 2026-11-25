import { useRef } from "react";
import { useCloseWorkspace, useWorkspace } from "@/hooks/use-workspace";
import * as tauri from "@/lib/tauri";
import { confirmWarning } from "@/lib/native-dialog";
import { showNativeContextMenu } from "@/components/editor-area/editor-context-menu";
import { cloudRemovalFailure } from "@/features/document-removal/delete";
import {
  folderName,
  trashWorkspaceCopy,
  workspaceMenu,
  workspaceTrashFailure,
} from "./workspace-menu";

export function WorkspaceSwitcher() {
  const { root, recentWorkspaces, openWorkspace, removeRecentWorkspace, trashRecentWorkspace } =
    useWorkspace();
  const closeWorkspace = useCloseWorkspace();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const workspaceName = root ? folderName(root) : "No Workspace";

  async function handleOpenFolder() {
    const picked = await tauri.pickWorkspace();
    if (picked) {
      await openWorkspace(picked);
    }
  }

  /** Confirm, then Trash the folder and everything in it. The folder is not open anywhere. */
  async function trashFolder(path: string) {
    if (!(await confirmWarning(trashWorkspaceCopy(path)))) return;
    try {
      const cloudError = await trashRecentWorkspace(path);
      // In the Trash; the shared-copy erase is queued and tried again.
      if (cloudError != null) {
        window.alert(cloudRemovalFailure(new Error(cloudError)) ?? cloudError);
      }
    } catch (error) {
      window.alert(workspaceTrashFailure(path, error));
    }
  }

  async function showMenu() {
    const items = workspaceMenu(root, recentWorkspaces, {
      open: (path) => void openWorkspace(path),
      openFolder: () => void handleOpenFolder(),
      close: () => closeWorkspace(),
      remove: (path) => {
        void removeRecentWorkspace(path).catch((error: unknown) => {
          window.alert(
            `Couldn't remove \u201c${folderName(path)}\u201d from the list: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
      trash: (path) => void trashFolder(path),
    });

    const rect = buttonRef.current?.getBoundingClientRect();
    const itemRowHeight = 22;
    const separatorHeight = 12;
    const verticalPadding = 8;
    const itemCount = items.filter((i) => i.kind !== "separator").length;
    const separatorCount = items.filter((i) => i.kind === "separator").length;
    const estimatedMenuHeight =
      itemCount * itemRowHeight + separatorCount * separatorHeight + verticalPadding;

    const position = rect
      ? { x: Math.round(rect.left), y: Math.round(rect.top - estimatedMenuHeight) }
      : undefined;

    await showNativeContextMenu(items, position);
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => void showMenu()}
      aria-label="Switch workspace"
      className="flex h-[32px] w-full items-center gap-1.5 overflow-hidden rounded-lg pl-[10px] pr-2 text-left text-[13px] leading-[1.15] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--fg-base)]"
    >
      <span
        className="flex w-5 shrink-0 items-center justify-center text-current"
        aria-hidden="true"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" strokeLinejoin="round">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8.71 2.4C8.32 2.01 7.68 2.01 7.29 2.4L4.47 5.22L3.94 5.75L5 6.81L5.53 6.28L8 3.81L10.47 6.28L11 6.81L12.06 5.75L11.53 5.22L8.71 2.4ZM5.53 9.72L5 9.19L3.94 10.25L4.47 10.78L7.29 13.6C7.68 13.99 8.32 13.99 8.71 13.6L11.53 10.78L12.06 10.25L11 9.19L10.47 9.72L8 12.19L5.53 9.72Z"
            fill="currentColor"
          />
        </svg>
      </span>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {workspaceName}
      </span>
    </button>
  );
}
