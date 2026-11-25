import { useCallback } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  getOpenFile,
  getOpenFiles,
  openFileInNewTab as openFileInNewTabAction,
  removePathsWithPrefix,
} from "@/hooks/editor-api";
import {
  cloudRemovalFailure,
  confirmPlaceholder,
  deleteDocument,
  deletionKind,
  trashEntry,
} from "@/features/document-removal/delete";
import * as tauri from "@/lib/tauri";
import { closeLedgersUnder } from "@/features/document-share/baseline";
import { quiesceSave, resumeSave } from "@/lib/save";
import { getWorkspaceIdentity, isCurrentWorkspaceIdentity } from "@/hooks/workspace-api";
import { getParentDir, getRelativePath } from "@/lib/paths";
import { duplicateFile } from "./duplicate-file";
import { showFileContextMenu } from "./file-context-menu";
import { showFolderContextMenu } from "./folder-context-menu";
import { showBulkContextMenu } from "./bulk-context-menu";
import { createSidebarEntryAndRename } from "./create-sidebar-entry-and-rename";
import { createFolderTerminalAction } from "./sidebar-terminal-action";
import type { DirEntry } from "@/types/fs";

interface UseFileTreeContextMenusArgs {
  openFile: (path: string) => Promise<void>;
  workspaceRoot: string | null;
  pinnedFiles: string[];
  togglePinnedFile: (path: string) => void;
  removePinnedFile: (path: string) => void;
  removePinnedFilesWithPrefix: (prefix: string) => void;
  expandDirectory: (path: string) => Promise<void>;
  refreshDirectory: (path: string) => Promise<void>;
  invalidatePath: (path: string) => void;
  setRenamingPath: (path: string | null) => void;
  clearSelection: () => void;
}

export function useFileTreeContextMenus({
  openFile,
  workspaceRoot,
  pinnedFiles,
  togglePinnedFile,
  removePinnedFile,
  removePinnedFilesWithPrefix,
  expandDirectory,
  refreshDirectory,
  invalidatePath,
  setRenamingPath,
  clearSelection,
}: UseFileTreeContextMenusArgs) {
  const createChildEntry = useCallback(
    (entry: DirEntry, kind: tauri.SidebarEntryKind) => {
      const identity = getWorkspaceIdentity();
      void createSidebarEntryAndRename(kind, {
        expandParent: () => expandDirectory(entry.path),
        createEntry: (entryKind) => tauri.createSidebarEntry(entry.path, entryKind),
        refreshRoot: () => refreshDirectory(entry.path),
        startRenaming: setRenamingPath,
        isCurrentWorkspace: () => isCurrentWorkspaceIdentity(identity),
      }).catch((error: unknown) => {
        window.alert(
          `Failed to create ${kind}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    [expandDirectory, refreshDirectory, setRenamingPath, workspaceRoot],
  );

  const handleFileContextMenu = useCallback(
    (entry: DirEntry) => {
      const parent = getParentDir(entry.path);
      const relative = workspaceRoot ? getRelativePath(entry.path, workspaceRoot) : entry.path;

      void showFileContextMenu({
        isPinned: pinnedFiles.includes(entry.path),
        onOpen: () => {
          void openFile(entry.path);
        },
        onOpenInNewTab: () => {
          void openFileInNewTabAction(entry.path).catch((error: unknown) => {
            window.alert(
              `Failed to open in new tab: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        },
        onDuplicate: () => {
          void (async () => {
            try {
              const newPath = await duplicateFile(entry.path);
              await refreshDirectory(parent);
              await openFileInNewTabAction(newPath);
            } catch (error) {
              window.alert(
                `Failed to duplicate: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          })();
        },
        onTogglePin: () => {
          togglePinnedFile(entry.path);
        },
        onCopyRelativePath: () => {
          void writeText(relative);
        },
        onCopyAbsolutePath: () => {
          void writeText(entry.path);
        },
        onReveal: () => {
          void tauri.revealInFileManager(entry.path).catch((error: unknown) => {
            window.alert(
              `Failed to reveal: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        },
        onRename: () => {
          setRenamingPath(entry.path);
        },
        onDelete: () => {
          void (async () => {
            const openFileState = getOpenFile(entry.path);
            if (openFileState?.isDirty) {
              const confirmed = window.confirm(
                `"${entry.name}" has unsaved changes. Delete anyway?`,
              );
              if (!confirmed) return;
            }
            try {
              const removed = await deleteDocument(entry.path);
              if (!removed) return;
              removePinnedFile(entry.path);
              await refreshDirectory(parent);
            } catch (error) {
              window.alert(
                cloudRemovalFailure(error) ??
                  `Failed to delete: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          })();
        },
      });
    },
    [
      openFile,
      pinnedFiles,
      refreshDirectory,
      removePinnedFile,
      setRenamingPath,
      togglePinnedFile,
      workspaceRoot,
    ],
  );

  const handleFolderContextMenu = useCallback(
    (entry: DirEntry) => {
      const parent = getParentDir(entry.path);
      const relative = workspaceRoot ? getRelativePath(entry.path, workspaceRoot) : entry.path;

      void showFolderContextMenu({
        onNewFile: () => {
          createChildEntry(entry, "file");
        },
        onNewFolder: () => {
          createChildEntry(entry, "folder");
        },
        onCopyRelativePath: () => {
          void writeText(relative);
        },
        onCopyAbsolutePath: () => {
          void writeText(entry.path);
        },
        onOpenInTerminal: createFolderTerminalAction(entry),
        onReveal: () => {
          void tauri.revealInFileManager(entry.path).catch((error: unknown) => {
            window.alert(
              `Failed to reveal: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        },
        onRename: () => {
          setRenamingPath(entry.path);
        },
        onDelete: () => {
          void (async () => {
            // Check if any open files inside this folder are dirty
            const openFiles = getOpenFiles();
            const dirPrefix = `${entry.path}/`;
            let dirtyCount = 0;
            for (const [path, file] of openFiles) {
              if (path.startsWith(dirPrefix) && file.isDirty) {
                dirtyCount += 1;
              }
            }

            if (dirtyCount > 0) {
              const confirmed = window.confirm(
                `"${entry.name}" contains ${dirtyCount} unsaved file${dirtyCount > 1 ? "s" : ""}. Delete anyway?`,
              );
              if (!confirmed) return;
            }

            try {
              if (!(await confirmPlaceholder("owner"))) return;
              // Writes under the folder must land before the trash, or they re-create it.
              await quiesceSave(entry.path);
              let report: tauri.DeleteReport;
              try {
                report = await tauri.deleteEntryReport(entry.path);
              } catch (error) {
                // The Trash failed and nothing else ran: the folder is still there.
                resumeSave(entry.path);
                throw error;
              }
              closeLedgersUnder(entry.path);
              removePathsWithPrefix(entry.path);
              removePinnedFilesWithPrefix(entry.path);
              invalidatePath(entry.path);
              await refreshDirectory(parent);
              // The folder is gone. A failed shared-copy erase is queued; say so.
              if (report.cloud_error != null) throw new Error(report.cloud_error);
            } catch (error) {
              window.alert(
                cloudRemovalFailure(error) ??
                  `Failed to delete: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          })();
        },
      });
    },
    [
      createChildEntry,
      invalidatePath,
      refreshDirectory,
      removePinnedFilesWithPrefix,
      setRenamingPath,
      workspaceRoot,
    ],
  );

  const handleBulkContextMenu = useCallback(
    (paths: Set<string>) => {
      const pathArray = [...paths];

      void showBulkContextMenu(
        {
          onCopyRelativePaths: () => {
            const relatives = pathArray.map((p) =>
              workspaceRoot ? getRelativePath(p, workspaceRoot) : p,
            );
            void writeText(relatives.join("\n"));
          },
          onCopyAbsolutePaths: () => {
            void writeText(pathArray.join("\n"));
          },
          onDelete: () => {
            void (async () => {
              // Check for dirty files, including those inside a selected folder.
              const openFilesMap = getOpenFiles();
              let dirtyCount = 0;
              for (const [path, file] of openFilesMap) {
                if (!file.isDirty) continue;
                if (pathArray.some((p) => path === p || path.startsWith(`${p}/`))) dirtyCount += 1;
              }

              if (dirtyCount > 0) {
                const confirmed = window.confirm(
                  `${dirtyCount} of ${pathArray.length} selected items have unsaved changes. Delete anyway?`,
                );
                if (!confirmed) return;
              }

              const tagged = await Promise.all(
                pathArray.map(async (p) => ({ p, kind: await deletionKind(p) })),
              );
              const kinds = new Set(tagged.map((item) => item.kind));
              const approved = new Set<"owner" | "invitee">();
              try {
                if (kinds.size === 1) {
                  const kind = tagged[0]?.kind ?? "owner";
                  if (!(await confirmPlaceholder(kind))) return;
                  approved.add(kind);
                }
              } catch (error) {
                window.alert(
                  cloudRemovalFailure(error) ??
                    `Failed to delete: ${error instanceof Error ? error.message : String(error)}`,
                );
                return;
              }

              const parentDirs = new Set<string>();
              for (const item of tagged) {
                try {
                  if (!approved.has(item.kind) && !(await confirmPlaceholder(item.kind))) continue;
                  await trashEntry(item.p);
                  removePinnedFile(item.p);
                  removePinnedFilesWithPrefix(item.p);
                  parentDirs.add(getParentDir(item.p));
                } catch (error) {
                  window.alert(
                    cloudRemovalFailure(error) ??
                      `Failed to delete "${item.p}": ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }

              clearSelection();
              await Promise.all([...parentDirs].map((dir) => refreshDirectory(dir)));
            })();
          },
        },
        pathArray.length,
      );
    },
    [
      clearSelection,
      refreshDirectory,
      removePinnedFile,
      removePinnedFilesWithPrefix,
      workspaceRoot,
    ],
  );

  return { handleFileContextMenu, handleFolderContextMenu, handleBulkContextMenu };
}
