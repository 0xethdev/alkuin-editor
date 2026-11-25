import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  useDirectoryCache,
  useExpandedDirs,
  useInvalidatePath,
  usePinnedFiles,
  useRefreshDirectory,
  useRemovePinnedFile,
  useRemovePinnedFilesWithPrefix,
  useTogglePinnedFile,
  useToggleDirectory,
  useExpandDirectory,
} from "@/hooks/use-file-tree";
import { useOpenFile } from "@/hooks/use-tabs";
import { useBooleanSetting, useSetting } from "@/hooks/use-settings";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import * as tauri from "@/lib/tauri";
import { getFileStem, getParentDir, isCaseOnlyChange } from "@/lib/paths";
import { useMoveEntry } from "./use-move-entry";
import { useTreeDrag } from "./use-tree-drag";
import { useFileTreeContextMenus } from "./use-file-tree-context-menus";
import { DragGhost } from "./drag-ghost";
import { FileTreeNode } from "./file-tree-node";
import { flattenTree } from "./flatten-tree";
import { liveTreeSelection, treeRangeSelection } from "./tree-selection";
import { useAutoRefresh } from "./use-auto-refresh";
import type { DirEntry } from "@/types/fs";
import { useMentionDots } from "@/features/note-mention/dots";

interface FileTreeProps {
  rootPath: string;
  openFile?: (path: string) => Promise<void>;
  enableContextMenus?: boolean;
  renamingPath: string | null;
  onRenamingPathChange: (path: string | null) => void;
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot);
}

export function FileTree({
  rootPath,
  openFile: openFileOverride,
  enableContextMenus = true,
  renamingPath,
  onRenamingPathChange,
}: FileTreeProps) {
  const directoryCache = useDirectoryCache();
  const expandedDirs = useExpandedDirs();
  const toggleDirectory = useToggleDirectory();
  const expandDirectory = useExpandDirectory();
  const defaultOpenFile = useOpenFile();
  const openFile = openFileOverride ?? defaultOpenFile;
  const refreshDirectory = useRefreshDirectory();
  const invalidatePath = useInvalidatePath();
  const { applyPathChange, moveEntry } = useMoveEntry();
  const removePinnedFile = useRemovePinnedFile();
  const removePinnedFilesWithPrefix = useRemovePinnedFilesWithPrefix();
  const pinnedFiles = usePinnedFiles();
  const togglePinnedFile = useTogglePinnedFile();
  const workspaceRoot = useWorkspaceRoot();
  const fileLabelMode = useSetting("appearance.sidebar-file-label");
  const sortMode = useSetting("appearance.sidebar-sort");
  const foldersFirst = useBooleanSetting("appearance.sidebar-folders-first");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  // Anchor for shift range-select. Only read inside handlers, never rendered,
  // so a ref avoids re-renders that a useState would trigger on every change.
  const selectionAnchorRef = useRef<string | null>(null);

  // Memoized so the `?? []` fallback doesn't hand `flattenTree` a fresh array
  // reference every render (which would re-run that memo needlessly).
  const entries = useMemo(() => directoryCache.get(rootPath) ?? [], [directoryCache, rootPath]);

  // Self-heal: if root was evicted from cache, reload it
  useAutoRefresh(rootPath, entries.length === 0);

  const flatItems = useMemo(
    () =>
      flattenTree(entries, 0, directoryCache, expandedDirs, fileLabelMode, sortMode, foldersFirst),
    [directoryCache, entries, expandedDirs, fileLabelMode, sortMode, foldersFirst],
  );
  const mentionPaths = useMemo(
    () =>
      flatItems
        .filter((item) => !item.entry.is_dir && item.entry.is_markdown)
        .map((item) => item.entry.path),
    [flatItems],
  );
  useMentionDots(mentionPaths);

  const entryByPath = useMemo(() => {
    const map = new Map<string, DirEntry>();
    for (const item of flatItems) map.set(item.entry.path, item.entry);
    return map;
  }, [flatItems]);
  const orderedPaths = useMemo(() => flatItems.map((item) => item.entry.path), [flatItems]);

  // The selection as of the current tree. A renamed, moved, deleted or
  // hidden row drops out here, so rendering, drags and bulk actions never
  // act on a path that is no longer a row. Read this, not `selectedPaths`.
  const selection = useMemo(
    () => liveTreeSelection(selectedPaths, entryByPath),
    [selectedPaths, entryByPath],
  );

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    selectionAnchorRef.current = null;
  }, []);

  const { containerRef, ghostRef, draggingPaths, dropHighlight, dragGhost, beginDrag } =
    useTreeDrag({
      rootPath,
      flatItems,
      entryByPath,
      expandedDirs,
      moveEntry,
      expandDirectory,
      clearSelection,
    });

  // Clear selection on Escape
  useEffect(() => {
    if (selection.size === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedPaths(new Set());
        selectionAnchorRef.current = null;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selection.size]);

  // Selection is settled on pointer-down — before any drag — so the drag always
  // acts on the correct set and a click never has to reconcile a stale one.
  const onRowPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>, entry: DirEntry) => {
      if (event.button !== 0) return; // Primary button only.

      // Shift/Cmd presses adjust the selection and never start a drag.
      if (event.shiftKey) {
        // Range select from the anchor to this row, replacing the selection.
        const anchor = selectionAnchorRef.current ?? orderedPaths[0] ?? entry.path;
        const range = treeRangeSelection(orderedPaths, anchor, entry.path);
        selectionAnchorRef.current = range.anchor;
        setSelectedPaths(range.paths);
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        // Toggle this row in the selection.
        const next = new Set(selection);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        setSelectedPaths(next);
        selectionAnchorRef.current = entry.path;
        return;
      }

      // Plain press: decide what a drag would carry. Pressing a row already in a
      // multi-selection drags the whole selection; pressing any other row drags
      // just that row and immediately discards the previous selection.
      let dragged: DirEntry[];
      if (selection.size >= 2 && selection.has(entry.path)) {
        dragged = [...selection]
          .map((path) => entryByPath.get(path))
          .filter((item): item is DirEntry => Boolean(item));
        if (!dragged.some((item) => item.path === entry.path)) dragged.push(entry);
      } else {
        if (selectedPaths.size > 0) setSelectedPaths(new Set());
        selectionAnchorRef.current = entry.path;
        dragged = [entry];
      }
      beginDrag(event, dragged, entry);
    },
    [beginDrag, entryByPath, orderedPaths, selection, selectedPaths.size],
  );

  // A plain click (no drag — drags suppress the click) opens/toggles the row and
  // collapses any lingering multi-selection. Modifier clicks were handled on
  // pointer-down, so they no-op here.
  const onRowClick = useCallback(
    (event: MouseEvent<HTMLElement>, entry: DirEntry) => {
      if (event.shiftKey || event.metaKey || event.ctrlKey) return;
      setSelectedPaths(new Set());
      selectionAnchorRef.current = entry.path;
      if (entry.is_dir) {
        void toggleDirectory(entry.path);
      } else {
        void openFile(entry.path);
      }
    },
    [openFile, toggleDirectory],
  );

  const handleRenameSubmit = useCallback(
    async (entry: DirEntry, nextValue: string) => {
      onRenamingPathChange(null);

      const trimmed = nextValue.trim();
      if (!trimmed) return;

      const parent = getParentDir(entry.path);
      let newPath: string;
      let conflictMessage: string;
      if (entry.is_dir) {
        // For directories, the value is the full name.
        if (trimmed === entry.name) return;
        newPath = `${parent}/${trimmed}`;
        conflictMessage = `A folder named "${trimmed}" already exists.`;
      } else {
        // For files, the value is the stem only.
        const currentStem = getFileStem(entry.name);
        if (trimmed === currentStem) return;
        const ext = getExtension(entry.name);
        newPath = `${parent}/${trimmed}${ext}`;
        conflictMessage = `A file named "${trimmed}${ext}" already exists.`;
      }
      if (newPath === entry.path) return;

      try {
        if (!isCaseOnlyChange(entry.path, newPath) && (await tauri.fileExists(newPath))) {
          window.alert(conflictMessage);
          return;
        }
        await applyPathChange(entry, newPath);
      } catch (error) {
        window.alert(`Failed to rename: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [applyPathChange, onRenamingPathChange],
  );

  const handleRenameCancel = useCallback(() => {
    onRenamingPathChange(null);
  }, [onRenamingPathChange]);

  const { handleFileContextMenu, handleFolderContextMenu, handleBulkContextMenu } =
    useFileTreeContextMenus({
      openFile,
      workspaceRoot,
      pinnedFiles,
      togglePinnedFile,
      removePinnedFile,
      removePinnedFilesWithPrefix,
      expandDirectory,
      refreshDirectory,
      invalidatePath,
      setRenamingPath: onRenamingPathChange,
      clearSelection,
    });

  const handleContextMenu = useCallback(
    (_event: MouseEvent<HTMLElement>, entry: DirEntry) => {
      if (!enableContextMenus) return;

      // If multiple items are selected and the right-clicked item is in the selection,
      // show the bulk menu
      if (selection.size >= 2 && selection.has(entry.path)) {
        handleBulkContextMenu(new Set(selection));
        return;
      }

      // Clear selection for single-item context menu
      clearSelection();

      if (entry.is_dir) {
        handleFolderContextMenu(entry);
      } else {
        handleFileContextMenu(entry);
      }
    },
    [
      clearSelection,
      enableContextMenus,
      handleBulkContextMenu,
      handleFileContextMenu,
      handleFolderContextMenu,
      selection,
    ],
  );

  if (flatItems.length === 0) {
    return <div className="px-2 text-[13px] text-[var(--text-muted)]">No files</div>;
  }

  return (
    <div
      ref={containerRef}
      className="relative isolate flex flex-col gap-0.5 rounded-lg"
      role="tree"
      aria-label="File tree"
    >
      {dropHighlight && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -z-10 rounded-lg bg-[var(--surface-subtle)]"
          style={{ top: dropHighlight.top, height: dropHighlight.height }}
        />
      )}
      {flatItems.map((item) => (
        <FileTreeNode
          key={item.entry.path}
          entry={item.entry}
          depth={item.depth}
          isExpanded={item.entry.is_dir && expandedDirs.has(item.entry.path)}
          isRenaming={renamingPath === item.entry.path}
          isSelected={selection.has(item.entry.path)}
          isDragging={draggingPaths?.has(item.entry.path) ?? false}
          onToggleDir={toggleDirectory}
          onOpenFile={openFile}
          onClick={onRowClick}
          onContextMenu={enableContextMenus ? handleContextMenu : undefined}
          onPointerDown={onRowPointerDown}
          onRenameSubmit={handleRenameSubmit}
          onRenameCancel={handleRenameCancel}
          fileLabelMode={fileLabelMode}
        />
      ))}
      {dragGhost &&
        // Portal to the body so the fixed-position ghost isn't clipped by the
        // sidebar's `overflow: hidden` (an ancestor transform/filter makes the
        // sidebar the containing block for fixed descendants).
        createPortal(
          <div
            ref={ghostRef}
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-50"
            style={{ opacity: 0 }}
          >
            <DragGhost
              entry={dragGhost.entry}
              count={dragGhost.count}
              width={dragGhost.width}
              paddingLeft={dragGhost.paddingLeft}
              isExpanded={dragGhost.isExpanded}
              fileLabelMode={fileLabelMode}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
