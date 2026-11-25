import { useWorkspaceStore } from "@/stores/workspace-store";

export function useDirectoryCache() {
  return useWorkspaceStore((s) => s.directoryCache);
}

export function useExpandedDirs() {
  return useWorkspaceStore((s) => s.expandedDirs);
}

export function useToggleDirectory() {
  return useWorkspaceStore((s) => s.toggleDirectory);
}

/** Open a folder if it is not open. Never collapses, so it suits "make sure
 *  it is open" call sites (create inside, drag hover) better than a toggle. */
export function useExpandDirectory() {
  return useWorkspaceStore((s) => s.expandDirectory);
}

export function useRefreshDirectory() {
  return useWorkspaceStore((s) => s.refreshDirectory);
}

export function useInvalidatePath() {
  return useWorkspaceStore((s) => s.invalidatePath);
}

export function useRewriteExpandedDir() {
  return useWorkspaceStore((s) => s.rewriteExpandedDir);
}

export function usePinnedFiles() {
  return useWorkspaceStore((s) => s.pinnedFiles);
}

export function useWorkspaceFileCount() {
  return useWorkspaceStore((s) => s.fileCount);
}

export function useTogglePinnedFile() {
  return useWorkspaceStore((s) => s.togglePinnedFile);
}

export function useRemovePinnedFile() {
  return useWorkspaceStore((s) => s.removePinnedFile);
}

export function useRemovePinnedFilesWithPrefix() {
  return useWorkspaceStore((s) => s.removePinnedFilesWithPrefix);
}

export function useRewritePinnedPath() {
  return useWorkspaceStore((s) => s.rewritePinnedPath);
}

export function useSidebarMetadataVersion() {
  return useWorkspaceStore((s) => s.sidebarMetadataVersion);
}
