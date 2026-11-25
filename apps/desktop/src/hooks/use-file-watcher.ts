import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import * as editorApi from "./editor-api";
import * as tauri from "@/lib/tauri";
import { isSaveActive } from "@/lib/save";
import { isWorkspaceEventCurrent, type WorkspaceIdentity } from "@/lib/workspace-events";
import type { WriteResult } from "@/types/fs";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";

interface FileChangePayload {
  path: string;
  kind: "modified" | "created" | "deleted" | "renamed";
  workspace: WorkspaceIdentity | null;
}

interface IndexCompletePayload {
  workspace: WorkspaceIdentity;
  fileCount: number;
}

interface WatcherFailedPayload {
  path: string;
  message: string;
  workspace: WorkspaceIdentity | null;
}

export const WATCHER_FAILED_NOTICE =
  "Alkuin can't watch this folder for outside changes. Reopen it to try again.";

/**
 * `watcher:failed` can arrive while the folder is still opening, before root
 * and epoch are set, so only a different workspace that is already current
 * drops it.
 */
export function watcherFailureApplies(
  eventWorkspace: WorkspaceIdentity | null,
  current: WorkspaceIdentity | null,
): boolean {
  return current === null || isWorkspaceEventCurrent(eventWorkspace, current);
}

const WATCHER_DEBUG = import.meta.env.DEV;

/**
 * Apply an `fs:file-changed` echo to an open file.
 *
 * A save writes a snapshot, then the watcher can read those bytes back while
 * the user is still typing. Reloading that older text replaces the document
 * and leaves the caret on the shorter string (`tes|t` once a later echo
 * restores the saved prefix). Skip the reload while keystrokes are unsaved
 * or a save is still queued, and drop a read that raced a newer `diskContent`.
 *
 * ponytail: external edits during typing are ignored until the buffer is
 * clean. Upgrade path is a conflict prompt, not a merge.
 */
export async function handleWatchedFileChange(path: string): Promise<void> {
  if (isSaveActive(path)) return;
  const file = editorApi.getOpenFile(path);
  if (!file || file.isDirty) return;

  const diskAtStart = file.diskContent;
  const first = await tauri.readFile(path);
  const latest = editorApi.getOpenFile(path);
  if (!canApplyDiskRead(latest, diskAtStart)) return;
  if (first.content === latest.diskContent) return;

  // One stale read of an older save must not replace the buffer. Reload only
  // when a second read still shows the same new bytes.
  const again = await tauri.readFile(path);
  const after = editorApi.getOpenFile(path);
  if (!canApplyDiskRead(after, diskAtStart)) return;
  if (again.content !== first.content || again.content === after.diskContent) return;

  if (WATCHER_DEBUG) console.debug("[watcher] reload-from-disk", path);
  editorApi.reloadFromDisk(path, again.content, { policy: "if-clean", expectedDisk: diskAtStart });
}

function canApplyDiskRead(
  file: ReturnType<typeof editorApi.getOpenFile>,
  diskAtStart: string,
): file is NonNullable<ReturnType<typeof editorApi.getOpenFile>> {
  return (
    file != null && !file.isDirty && !isSaveActive(file.path) && file.diskContent === diskAtStart
  );
}

function currentWorkspaceIdentity(): WorkspaceIdentity | null {
  const { root, workspaceEpoch } = useWorkspaceStore.getState();
  return root !== null && workspaceEpoch !== null ? { root, epoch: workspaceEpoch } : null;
}

export function useFileWatcher() {
  useEffect(() => {
    const unlistenFile = listen<FileChangePayload>("fs:file-changed", (event) => {
      const { path, kind, workspace } = event.payload;
      if (WATCHER_DEBUG) console.debug("[watcher] fs:file-changed", kind, path, workspace);
      if (!isWorkspaceEventCurrent(workspace, currentWorkspaceIdentity())) return;
      useWorkspaceStore.getState().bumpSidebarMetadataVersion();
      const openFiles = editorApi.getOpenFiles();
      const file = openFiles.get(path);

      if (!file) return;
      if (kind === "deleted") return;
      void handleWatchedFileChange(path);
    });

    const unlistenWatcherFailed = listen<WatcherFailedPayload>("watcher:failed", (event) => {
      const { path, message, workspace } = event.payload;
      console.error("[watcher] could not watch", path, message);
      if (!watcherFailureApplies(workspace, currentWorkspaceIdentity())) return;
      showEditorNotice(WATCHER_FAILED_NOTICE, { sticky: true });
    });

    const unlistenIndexComplete = listen<IndexCompletePayload>("index:complete", (event) => {
      if (WATCHER_DEBUG) console.debug("[watcher] index:complete", event.payload);
      // Not gated on the current identity: it can arrive before the open has
      // set root and epoch. The store keeps it until they match.
      useWorkspaceStore.getState().completeIndex(event.payload.workspace, event.payload.fileCount);
    });

    const unlistenSidebarMetadata = listen<WriteResult>("sidebar:metadata-changed", (event) => {
      if (WATCHER_DEBUG) console.debug("[watcher] sidebar:metadata-changed", event.payload.path);
      const { bumpSidebarMetadataVersion, updateEntryModifiedAt } = useWorkspaceStore.getState();
      bumpSidebarMetadataVersion();
      updateEntryModifiedAt(event.payload.path, event.payload.modified_at);
    });

    const unlistenSettings = listen<WorkspaceIdentity>("settings:changed", (event) => {
      if (WATCHER_DEBUG) console.debug("[watcher] settings:changed", event.payload);
      if (!isWorkspaceEventCurrent(event.payload, currentWorkspaceIdentity())) return;
      void useSettingsStore.getState().loadSettings();
    });

    const unlistenDir = listen<FileChangePayload>("fs:directory-changed", (event) => {
      const { path, workspace } = event.payload;
      if (WATCHER_DEBUG) console.debug("[watcher] fs:directory-changed", path, workspace);
      if (!isWorkspaceEventCurrent(workspace, currentWorkspaceIdentity())) return;
      const { root, expandedDirs, invalidatePath, refreshDirectory, bumpSidebarMetadataVersion } =
        useWorkspaceStore.getState();
      bumpSidebarMetadataVersion();

      // For visible directories (expanded or root), refresh in-place so the
      // old entries stay visible until new data arrives.  Calling
      // invalidatePath first would delete the cache, causing the tree to
      // flash empty while the async refresh is in flight.
      if (expandedDirs.has(path) || path === root) {
        void refreshDirectory(path);
      } else {
        invalidatePath(path);
      }

      const parent = path.substring(0, path.lastIndexOf("/"));
      if (parent) {
        if (expandedDirs.has(parent) || parent === root) {
          void refreshDirectory(parent);
        } else {
          invalidatePath(parent);
        }
      }
    });

    return () => {
      void unlistenFile.then((fn) => fn());
      void unlistenWatcherFailed.then((fn) => fn());
      void unlistenIndexComplete.then((fn) => fn());
      void unlistenSidebarMetadata.then((fn) => fn());
      void unlistenSettings.then((fn) => fn());
      void unlistenDir.then((fn) => fn());
    };
  }, []);
}
