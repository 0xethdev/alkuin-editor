import { create } from "zustand";
import type { DirEntry } from "@/types/fs";
import type { RestoreWorkspaceResponse } from "@/lib/tauri";
import * as tauri from "@/lib/tauri";
import { getParentDir } from "@/lib/paths";
import { syncGitFolder } from "@/lib/git-queue";
import { getPreference, setPreference } from "@/lib/preferences";
import {
  CLOSE_SAVE_FAILED_ONE_LINE,
  CLOSE_SAVE_FAILED_SOME_LINE,
  OPEN_SAVE_FAILED_ONE_LINE,
  OPEN_SAVE_FAILED_SOME_LINE,
} from "@/features/redline-spike/margin-copy";
import {
  cancelSave,
  createDiscardGate,
  flushAllSaves,
  scheduleSave,
  unsavedLine,
} from "@/lib/save";
import { saveSession, loadSession } from "@/lib/session";
import type { WorkspaceIdentity } from "@/lib/workspace-events";
import { getEditorSessionSnapshot, useEditorStore } from "@/stores/editor-store";
import { clearLastingNotices } from "@/components/editor-area/editor-notice-store";

export type WorkspaceChromeMode = "workspace" | "compact-file";

interface WorkspaceState {
  root: string | null;
  workspaceEpoch: number | null;
  workspaceGeneration: number;
  chromeMode: WorkspaceChromeMode;
  fileCount: number;
  isIndexing: boolean;
  isStartupResolved: boolean;
  directoryCache: Map<string, DirEntry[]>;
  expandedDirs: Set<string>;
  pinnedFiles: string[];
  sidebarMetadataVersion: number;
  recentWorkspaces: string[];

  openWorkspace: (path: string) => Promise<void>;
  /** Hydrate from a prefetched `RestoreWorkspaceResponse` (startup cold-path
   *  and user-initiated switches via the `restore_workspace` IPC). */
  restoreFromBundle: (bundle: RestoreWorkspaceResponse) => Promise<void>;
  closeWorkspace: () => Promise<void>;
  /** `index:complete` from Rust. It can arrive before the open has set root and
   *  epoch, so it is remembered and applied when they match. */
  completeIndex: (workspace: WorkspaceIdentity, fileCount: number) => void;
  setChromeMode: (mode: WorkspaceChromeMode) => void;
  setStartupResolved: () => void;
  refreshDirectory: (path: string) => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  /** Open `path` if it is not open. Never collapses; joins a read on its way. */
  expandDirectory: (path: string) => Promise<void>;
  invalidatePath: (path: string) => void;
  /** Refresh one cached file's `modified_at` from a write result. The watcher
   *  suppresses Writer's own saves, so without this the tree's copy of the
   *  timestamp would go stale and time-based sorting would not react to edits. */
  updateEntryModifiedAt: (path: string, modifiedAt: number) => void;
  rewriteExpandedDir: (oldPath: string, newPath: string) => void;
  hydratePinnedFiles: (root: string) => Promise<void>;
  togglePinnedFile: (path: string) => void;
  removePinnedFile: (path: string) => void;
  removePinnedFilesWithPrefix: (prefix: string) => void;
  rewritePinnedPath: (oldPath: string, newPath: string) => void;
  bumpSidebarMetadataVersion: () => void;
  removeRecentWorkspace: (path: string) => Promise<void>;
  /** Trash a recent folder. The list is read again after, whatever happened. */
  trashRecentWorkspace: (path: string) => Promise<string | null>;
}

function pinnedFilesPreferenceKey(root: string) {
  return `workspace:${root}:sidebar-pinned-files`;
}

function normalizePinnedFiles(root: string, paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const rootPrefix = `${root}/`;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string") continue;
    if (!path.startsWith(rootPrefix)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

async function loadPinnedFiles(root: string) {
  const paths = await getPreference<unknown>(pinnedFilesPreferenceKey(root), []);
  return normalizePinnedFiles(root, paths);
}

function persistPinnedFiles(root: string, paths: string[]) {
  void setPreference(pinnedFilesPreferenceKey(root), paths);
}

function withoutPath(paths: string[], path: string) {
  return paths.filter((candidate) => candidate !== path);
}

function dedupe(paths: string[]) {
  return [...new Set(paths)];
}

/** The last `index:complete` this window heard. It can arrive before an open has
 *  set root and epoch, so the open applies it when the identity matches. */
let lastIndexComplete: { root: string; epoch: number; fileCount: number } | null = null;

function indexedFileCount(root: string, epoch: number): number | null {
  const done = lastIndexComplete;
  return done && done.root === root && done.epoch === epoch ? done.fileCount : null;
}

/**
 * Open, restore and close run one at a time. A second open then sees the first
 * one's root and goes to its own window, instead of both restoring a session.
 */
let workspaceTransition: Promise<unknown> = Promise.resolve();

function runWorkspaceTransition<T>(task: () => Promise<T>): Promise<T> {
  const run = workspaceTransition.then(task);
  workspaceTransition = run.catch(() => {});
  return run;
}

/** True from the editor wipe until the session is restored. The session save
 *  timer must not write the empty tab list of a half-open folder. */
let workspaceOpening = false;

/** True while the close IPC runs with the editor already emptied. */
let workspaceClosing = false;

/** "Close it again to discard" for Close Folder, same rule as window close.
 *  Made on first use, so a test that mocks `@/lib/save` can still load this store. */
let folderDiscardGate: ((unsaved: readonly string[]) => boolean) | null = null;

function mayDiscardOnFolderClose(unsaved: readonly string[]): boolean {
  folderDiscardGate ??= createDiscardGate();
  return folderDiscardGate(unsaved);
}

/** The same rule for an open that would empty an editor holding unsaved words. */
let openDiscardGate: ((unsaved: readonly string[]) => boolean) | null = null;

function mayDiscardOnFolderOpen(unsaved: readonly string[]): boolean {
  openDiscardGate ??= createDiscardGate();
  return openDiscardGate(unsaved);
}

function editorDirtyPaths(): string[] {
  const paths: string[] = [];
  for (const file of useEditorStore.getState().openFiles.values()) {
    if (file.isDirty && !file.isLoading) paths.push(file.path);
  }
  return paths;
}

/**
 * Write every dirty document before the editor lets go of it (a folder close,
 * or an open that empties it). Resolves to the paths that could not be saved,
 * once nothing else is dirty: words typed into one document while another was
 * written get written too.
 */
async function flushBeforeLettingGo(): Promise<string[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const unsaved = await flushAllSaves();
    const failed = new Set(unsaved);
    if (editorDirtyPaths().every((path) => failed.has(path))) return unsaved;
  }
  return editorDirtyPaths();
}

type EditorSnapshot = Pick<
  ReturnType<typeof useEditorStore.getState>,
  "openFiles" | "tabs" | "activeTabId" | "activeFilePath"
>;

/** Empty the editor and hand back what it held. */
function takeEditorState(): EditorSnapshot {
  const { openFiles, tabs, activeTabId, activeFilePath } = useEditorStore.getState();
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
  });
  return { openFiles, tabs, activeTabId, activeFilePath };
}

/** The close failed: put the editor back, unless something was opened since. */
function restoreEditorState(editor: EditorSnapshot) {
  const current = useEditorStore.getState();
  if (current.tabs.length > 0 || current.openFiles.size > 0) return;
  useEditorStore.setState(editor);
  // Unsaved words that a discard dropped are wanted again.
  for (const path of editorDirtyPaths()) scheduleSave(path);
}

type WorkspaceSet = (
  partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>),
) => void;

/**
 * A folder's first read. While it is on its way the folder is "loading":
 * `expand` is whether it opens when the read lands, so a second click
 * during the read collapses it instead of being lost.
 */
interface DirectoryLoad {
  generation: number;
  expand: boolean;
  done: Promise<void>;
}

const directoryLoads = new Map<string, DirectoryLoad>();

function currentDirectoryLoad(path: string, generation: number): DirectoryLoad | null {
  const load = directoryLoads.get(path);
  return load && load.generation === generation ? load : null;
}

/** Expand `path`, reading it first when it is not cached. The expanded set is
 *  computed from the state at the moment of the write, not before the read. */
async function openDirectory(path: string, set: WorkspaceSet, get: () => WorkspaceState) {
  const { root, workspaceGeneration, directoryCache } = get();
  const addExpanded = (state: WorkspaceState) => {
    if (state.expandedDirs.has(path)) return state.expandedDirs;
    const expandedDirs = new Set(state.expandedDirs);
    expandedDirs.add(path);
    return expandedDirs;
  };

  if (directoryCache.has(path)) {
    set((state) => (state.expandedDirs.has(path) ? state : { expandedDirs: addExpanded(state) }));
    return;
  }

  const load: DirectoryLoad = {
    generation: workspaceGeneration,
    expand: true,
    done: Promise.resolve(),
  };
  directoryLoads.set(path, load);
  load.done = (async () => {
    try {
      const entries = await tauri.readDirectory(path);
      set((state) => {
        if (state.root !== root || state.workspaceGeneration !== workspaceGeneration) return state;
        const cache = new Map(state.directoryCache);
        cache.set(path, entries);
        return load.expand
          ? { directoryCache: cache, expandedDirs: addExpanded(state) }
          : { directoryCache: cache };
      });
    } finally {
      if (directoryLoads.get(path) === load) directoryLoads.delete(path);
    }
  })();
  await load.done;
}

function withNextWorkspaceGeneration(
  state: WorkspaceState,
  next: Partial<WorkspaceState>,
): Partial<WorkspaceState> {
  return { ...next, workspaceGeneration: state.workspaceGeneration + 1 };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: null,
  workspaceEpoch: null,
  workspaceGeneration: 0,
  chromeMode: "workspace",
  fileCount: 0,
  isIndexing: false,
  isStartupResolved: false,
  directoryCache: new Map(),
  expandedDirs: new Set(),
  pinnedFiles: [],
  sidebarMetadataVersion: 0,
  recentWorkspaces: [],

  openWorkspace: (path: string) =>
    runWorkspaceTransition(async () => {
      // Multi-window: when this window already has a workspace, open the new
      // one in a fresh in-process window instead of replacing the current
      // workspace. Each window has its own `WorkspaceState` on the Rust side
      // so file watchers, search indexes, and session state stay isolated.
      const prevRoot = get().root;
      if (prevRoot && prevRoot !== path) {
        await tauri.openWorkspaceInNewWindow(path);
        return;
      }
      if (prevRoot === path) {
        return;
      }

      // Unsaved edits go to disk before the editor is wiped. One that cannot
      // be saved refuses the open; opening again soon discards it.
      const unsaved = await flushBeforeLettingGo();
      if (!mayDiscardOnFolderOpen(unsaved)) {
        throw new Error(
          unsavedLine(unsaved, OPEN_SAVE_FAILED_ONE_LINE, OPEN_SAVE_FAILED_SOME_LINE),
        );
      }
      for (const path of unsaved) cancelSave(path);

      workspaceOpening = true;
      try {
        // Clear editor state before switching
        useEditorStore.setState({
          openFiles: new Map(),
          tabs: [],
          activeTabId: null,
          activeFilePath: null,
        });

        const info = await tauri.openWorkspace(path);
        // Read the directory and load the session under the canonical root that
        // Rust returned, not the raw input. Otherwise watcher events (which fire
        // canonical paths) miss the cache key and the sidebar goes stale on
        // aliased workspaces (e.g. `/var/...` → `/private/var/...`).
        const [entries, recents] = await Promise.all([
          tauri.readDirectory(info.root),
          tauri.getRecentWorkspaces(),
        ]);
        const indexed = indexedFileCount(info.root, info.epoch);
        set((state) =>
          withNextWorkspaceGeneration(state, {
            root: info.root,
            workspaceEpoch: info.epoch,
            chromeMode: "workspace",
            fileCount: indexed ?? info.file_count,
            isIndexing: indexed === null,
            directoryCache: new Map([[info.root, entries]]),
            expandedDirs: new Set(),
            pinnedFiles: [],
            sidebarMetadataVersion: 0,
            recentWorkspaces: recents,
          }),
        );
        // After root is set, so the sync's workspace identity is this folder.
        void syncGitFolder(info.root);
        void get().hydratePinnedFiles(info.root);

        const session = await loadSession(info.root);
        if (session && session.tabs.length > 0) {
          // `restoreSession` sets every tab before its first await; what is
          // left is loading the files. The open is done once the tabs are
          // there, so Close Folder and later opens do not wait on slow tabs,
          // and tab changes are saved again. Same as `restoreFromBundle`.
          void useEditorStore
            .getState()
            .restoreSession(session.tabs, session.activeIndex)
            .catch((error: unknown) => {
              console.error("Failed to load tabs from the restored session", error);
            });
          return;
        }

        useEditorStore.getState().ensureLauncherTab();
      } finally {
        workspaceOpening = false;
      }
    }),

  closeWorkspace: () =>
    runWorkspaceTransition(async () => {
      const root = get().root;
      if (!root) return;
      const snapshot = getEditorSessionSnapshot(useEditorStore.getState());
      void saveSession(root, snapshot.tabs, snapshot.activeIndex);
      // Unsaved edits go to disk before the editor is wiped. A failed save
      // keeps the folder open, so its words are still in the editor. Closing
      // again soon with the same documents unsaved discards them.
      const unsaved = await flushBeforeLettingGo();
      if (!mayDiscardOnFolderClose(unsaved)) {
        throw new Error(
          unsavedLine(unsaved, CLOSE_SAVE_FAILED_ONE_LINE, CLOSE_SAVE_FAILED_SOME_LINE),
        );
      }
      if (get().root !== root) return;
      for (const path of unsaved) cancelSave(path);

      // Empty the editor in the same tick as the last dirty check, before the
      // close IPC, so nothing typed while the folder closes can be lost. A
      // close that fails puts the editor back.
      const editor = takeEditorState();
      workspaceClosing = true;
      try {
        await tauri.closeWorkspace(root);
      } catch (error) {
        restoreEditorState(editor);
        throw error;
      } finally {
        workspaceClosing = false;
      }
      if (get().root !== root) return;
      set((state) =>
        withNextWorkspaceGeneration(state, {
          root: null,
          workspaceEpoch: null,
          chromeMode: "workspace",
          fileCount: 0,
          directoryCache: new Map(),
          expandedDirs: new Set(),
          pinnedFiles: [],
          sidebarMetadataVersion: 0,
          isIndexing: false,
        }),
      );
      // A file opened from the sidebar while the close ran belongs to the
      // closed folder. Unsaved words in one stay, and keep saving on their own.
      const late = useEditorStore.getState();
      if ((late.tabs.length > 0 || late.openFiles.size > 0) && editorDirtyPaths().length === 0) {
        takeEditorState();
      }
    }),

  restoreFromBundle: (bundle) =>
    runWorkspaceTransition(async () => {
      // Clear editor state in case anything was hydrated by a parallel hook.
      useEditorStore.setState({
        openFiles: new Map(),
        tabs: [],
        activeTabId: null,
        activeFilePath: null,
      });

      const indexed = indexedFileCount(bundle.workspace.root, bundle.workspace.epoch);
      set((state) =>
        withNextWorkspaceGeneration(state, {
          root: bundle.workspace.root,
          workspaceEpoch: bundle.workspace.epoch,
          chromeMode: "workspace",
          fileCount: indexed ?? bundle.workspace.file_count,
          isIndexing: indexed === null,
          directoryCache: new Map([[bundle.workspace.root, bundle.entries]]),
          expandedDirs: new Set(),
          pinnedFiles: [],
          sidebarMetadataVersion: 0,
          recentWorkspaces: bundle.recent_workspaces,
        }),
      );
      void syncGitFolder(bundle.workspace.root);
      void get().hydratePinnedFiles(bundle.workspace.root);

      if (bundle.session && bundle.session.tabs && bundle.session.tabs.length > 0) {
        // Fire-and-forget: `restoreSession` populates the active tab
        // synchronously (via prefetchedActiveFile) before it starts awaiting
        // background tab reads. We intentionally don't await the whole thing
        // so the startup flow doesn't block on tabs the user isn't looking at
        // yet — they load in the background and fill in on their own.
        void useEditorStore
          .getState()
          .restoreSession(
            bundle.session.tabs,
            bundle.session.active_index ?? null,
            bundle.active_file,
          )
          .catch((error) => {
            console.error("Failed to load background tabs from restored session", error);
          });
        return;
      }

      if (bundle.open_file) {
        // Workspace+file open (open_workspace_in_new_window with a file):
        // the requested file becomes a normal tab in workspace chrome.
        void useEditorStore.getState().openFile(bundle.open_file);
        return;
      }

      useEditorStore.getState().ensureLauncherTab();
    }),

  completeIndex: (workspace, fileCount) => {
    lastIndexComplete = { root: workspace.root, epoch: workspace.epoch, fileCount };
    set((state) =>
      state.root === workspace.root && state.workspaceEpoch === workspace.epoch
        ? {
            fileCount,
            isIndexing: false,
            sidebarMetadataVersion: state.sidebarMetadataVersion + 1,
          }
        : state,
    );
  },

  setChromeMode: (mode) => set({ chromeMode: mode }),

  setStartupResolved: () => set({ isStartupResolved: true }),

  refreshDirectory: async (path: string) => {
    const { root, workspaceGeneration } = get();
    const entries = await tauri.readDirectory(path);
    set((state) => {
      if (state.root !== root || state.workspaceGeneration !== workspaceGeneration) return state;
      const cache = new Map(state.directoryCache);
      cache.set(path, entries);
      return { directoryCache: cache };
    });
  },

  toggleDirectory: async (path: string) => {
    const load = currentDirectoryLoad(path, get().workspaceGeneration);
    if (load) {
      // A second click while the folder is still being read.
      load.expand = !load.expand;
      return;
    }
    if (get().expandedDirs.has(path)) {
      set((state) => {
        if (!state.expandedDirs.has(path)) return state;
        const expandedDirs = new Set(state.expandedDirs);
        expandedDirs.delete(path);
        return { expandedDirs };
      });
      return;
    }
    await openDirectory(path, set, get);
  },

  expandDirectory: async (path: string) => {
    const load = currentDirectoryLoad(path, get().workspaceGeneration);
    if (load) {
      load.expand = true;
      await load.done;
      return;
    }
    if (get().expandedDirs.has(path)) return;
    await openDirectory(path, set, get);
  },

  invalidatePath: (path: string) => {
    set((state) => {
      const cache = new Map(state.directoryCache);
      cache.delete(path);
      return { directoryCache: cache };
    });
  },

  updateEntryModifiedAt: (path: string, modifiedAt: number) => {
    set((state) => {
      const parent = getParentDir(path);
      const entries = state.directoryCache.get(parent);
      if (!entries) return state;
      const index = entries.findIndex((entry) => entry.path === path);
      if (index === -1 || entries[index].modified_at === modifiedAt) return state;
      const next = entries.slice();
      next[index] = { ...entries[index], modified_at: modifiedAt };
      const cache = new Map(state.directoryCache);
      cache.set(parent, next);
      return { directoryCache: cache };
    });
  },

  rewriteExpandedDir: (oldPath: string, newPath: string) => {
    set((state) => {
      const dirPrefix = `${oldPath}/`;
      const next = new Set<string>();
      let changed = false;

      for (const dir of state.expandedDirs) {
        if (dir === oldPath) {
          next.add(newPath);
          changed = true;
        } else if (dir.startsWith(dirPrefix)) {
          next.add(newPath + dir.slice(oldPath.length));
          changed = true;
        } else {
          next.add(dir);
        }
      }

      if (!changed) return state;

      // Also rekey directory cache entries under the old prefix
      const cache = new Map<string, DirEntry[]>();
      for (const [key, entries] of state.directoryCache) {
        if (key === oldPath) {
          cache.set(newPath, entries);
        } else if (key.startsWith(dirPrefix)) {
          cache.set(newPath + key.slice(oldPath.length), entries);
        } else {
          cache.set(key, entries);
        }
      }

      return { expandedDirs: next, directoryCache: cache };
    });
  },

  hydratePinnedFiles: async (root: string) => {
    const pinnedFiles = await loadPinnedFiles(root);
    if (get().root !== root) return;
    set({ pinnedFiles });
  },

  togglePinnedFile: (path: string) => {
    const root = get().root;
    if (!root || !path.startsWith(`${root}/`)) return;

    let next: string[] = [];
    set((state) => {
      next = state.pinnedFiles.includes(path)
        ? withoutPath(state.pinnedFiles, path)
        : [path, ...state.pinnedFiles];
      return { pinnedFiles: next };
    });
    persistPinnedFiles(root, next);
  },

  removePinnedFile: (path: string) => {
    const root = get().root;
    if (!root) return;

    let next: string[] | null = null;
    set((state) => {
      if (!state.pinnedFiles.includes(path)) return state;
      const updated = withoutPath(state.pinnedFiles, path);
      next = updated;
      return { pinnedFiles: updated };
    });
    if (next) persistPinnedFiles(root, next);
  },

  removePinnedFilesWithPrefix: (prefix: string) => {
    const root = get().root;
    if (!root) return;

    const prefixWithSlash = `${prefix}/`;
    let next: string[] | null = null;
    set((state) => {
      const filtered = state.pinnedFiles.filter(
        (path) => path !== prefix && !path.startsWith(prefixWithSlash),
      );
      if (filtered.length === state.pinnedFiles.length) return state;
      next = filtered;
      return { pinnedFiles: filtered };
    });
    if (next) persistPinnedFiles(root, next);
  },

  rewritePinnedPath: (oldPath: string, newPath: string) => {
    const root = get().root;
    if (!root) return;

    const oldPrefix = `${oldPath}/`;
    let next: string[] | null = null;
    set((state) => {
      let changed = false;
      const rewritten = state.pinnedFiles.map((path) => {
        if (path === oldPath) {
          changed = true;
          return newPath;
        }
        if (path.startsWith(oldPrefix)) {
          changed = true;
          return newPath + path.slice(oldPath.length);
        }
        return path;
      });
      if (!changed) return state;
      const updated = dedupe(rewritten);
      next = updated;
      return { pinnedFiles: updated };
    });
    if (next) persistPinnedFiles(root, next);
  },

  bumpSidebarMetadataVersion: () => {
    set((state) => ({ sidebarMetadataVersion: state.sidebarMetadataVersion + 1 }));
  },

  removeRecentWorkspace: async (path: string) => {
    await tauri.removeRecentWorkspace(path);
    set((state) => ({
      recentWorkspaces: state.recentWorkspaces.filter((p) => p !== path),
    }));
  },

  trashRecentWorkspace: async (path: string) => {
    try {
      return await tauri.trashRecentWorkspace(path);
    } finally {
      // Rust owns the list: trashed or already gone, the folder left it there.
      const recent = await tauri.getRecentWorkspaces().catch((error: unknown) => {
        console.error("recent_workspaces_unread", error);
        return null;
      });
      if (recent) set({ recentWorkspaces: recent });
    }
  },
}));

// Lasting lines name files of the folder that was open (where outside words went, a file
// not backed up). They go with it, whenever the folder closes or another one opens.
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspaceGeneration !== previous.workspaceGeneration) clearLastingNotices();
});

// Recent workspaces are hydrated by resolveStartup() via get_startup_state before the first render.

function saveCurrentSession() {
  // Standalone compact windows have no root, so they never persist a
  // session — the root check covers both cases. A folder that is still
  // opening has no tabs yet; saving now would erase its session.
  const root = useWorkspaceStore.getState().root;
  if (!root || workspaceOpening || workspaceClosing) return;
  const snapshot = getEditorSessionSnapshot(useEditorStore.getState());
  void saveSession(root, snapshot.tabs, snapshot.activeIndex);
}

/** Save the session whenever tabs change (debounced) and when the page unloads.
 *  Returns the unsubscribe. */
export function installSessionPersistence(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
) {
  let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const unsubscribe = useEditorStore.subscribe((state, prev) => {
    if (state.tabs === prev.tabs && state.activeTabId === prev.activeTabId) return;
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(() => {
      sessionSaveTimer = null;
      saveCurrentSession();
    }, 500);
  });

  const onUnload = () => {
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;
    saveCurrentSession();
  };
  target.addEventListener("beforeunload", onUnload);

  return () => {
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    unsubscribe();
    target.removeEventListener("beforeunload", onUnload);
  };
}

if (typeof window !== "undefined") installSessionPersistence(window);
