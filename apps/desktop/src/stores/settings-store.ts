import { create } from "zustand";
import * as tauri from "@/lib/tauri";
import {
  applyCssVarBindings,
  applyTheme,
  forceLightSettings,
  readStoredAppearance,
  themeNeedsLightMigration,
} from "@/lib/theme";
import type { SettingsMap, SettingKey } from "@/lib/settings-schema";

interface SettingsState {
  /** Flat record from key → value. Stored as `Record<string, unknown>` since
   *  IPC returns untyped JSON; per-key reads should go through the typed
   *  `useSetting<K>` hook (or `getSetting<K>`) which narrows via SettingsMap. */
  settings: Record<string, unknown>;
  isLoaded: boolean;

  loadSettings: () => Promise<void>;
  getSetting: <K extends SettingKey>(key: K) => SettingsMap[K] | undefined;
  setSetting: (key: string, value: unknown, scope?: "global" | "workspace") => Promise<void>;
  resetSetting: (key: string, scope?: "global" | "workspace") => Promise<void>;
  /** Single entry point for hydrating settings from the backend. Sets
   *  `isLoaded`, replaces the store, and runs side effects (theme tokens,
   *  data-theme attribute, css-var bindings). Call from startup and from
   *  any future "reload from backend" path — never push settings via setState
   *  elsewhere. The schema is not stored: it's a static import from
   *  `@/lib/settings-schema`. */
  hydrateFromBackend: (payload: { settings: Record<string, unknown> }) => void;
}

function applySettingsSideEffects(settings: Record<string, unknown>) {
  applyTheme(settings["appearance.theme"], settings);
  applyCssVarBindings(settings);
}

interface PersistedSettingValue {
  exists: boolean;
  value: unknown;
}

interface SettingWriteQueue {
  tail: Promise<unknown>;
  latestVersion: number;
  lastPersisted: PersistedSettingValue;
}

// One ordered persistence lane per key. Settings remain optimistic in Zustand
// and CSS, but an older IPC write can never finish after a newer write.
const settingWriteQueues = new Map<string, SettingWriteQueue>();

// One clock for reloads and settled writes. A reload carries the tick it was
// issued at, so it can tell which keys this window wrote after it read the file.
let settingsClock = 0;
let appliedReload = 0;
const writtenAt = new Map<string, number>();

function getWriteQueue(key: string, settings: Record<string, unknown>): SettingWriteQueue {
  const existing = settingWriteQueues.get(key);
  if (existing) return existing;
  const queue: SettingWriteQueue = {
    tail: Promise.resolve(),
    latestVersion: 0,
    lastPersisted: {
      exists: Object.prototype.hasOwnProperty.call(settings, key),
      value: settings[key],
    },
  };
  settingWriteQueues.set(key, queue);
  return queue;
}

function persistedValueFor(key: string, settings: Record<string, unknown>): PersistedSettingValue {
  return {
    exists: Object.prototype.hasOwnProperty.call(settings, key),
    value: settings[key],
  };
}

function replaceSettingValue(
  settings: Record<string, unknown>,
  key: string,
  persisted: PersistedSettingValue,
): Record<string, unknown> {
  const nextSettings = { ...settings };
  if (persisted.exists) nextSettings[key] = persisted.value;
  else delete nextSettings[key];
  return nextSettings;
}

function settingValueMatches(
  settings: Record<string, unknown>,
  key: string,
  persisted: PersistedSettingValue,
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(settings, key) === persisted.exists &&
    (!persisted.exists || settingValuesEqual(settings[key], persisted.value))
  );
}

function settingValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

/** A full reload of `loaded`, issued at `issuedAt`, merged with this window's own
 *  writes: a key with a write in flight keeps its optimistic value, and a key
 *  written after the reload was issued keeps the written value. A write in flight
 *  rolls back to the reloaded value when the reload is newer than its last success. */
function withLocalWrites(
  loaded: Record<string, unknown>,
  current: Record<string, unknown>,
  issuedAt: number,
): Record<string, unknown> {
  let merged = loaded;
  const keys = new Set([...settingWriteQueues.keys(), ...writtenAt.keys()]);
  for (const key of keys) {
    const queue = settingWriteQueues.get(key);
    const written = writtenAt.get(key) ?? 0;
    if (queue && issuedAt > written) queue.lastPersisted = persistedValueFor(key, loaded);
    if (!queue && written < issuedAt) continue;
    const local = persistedValueFor(key, current);
    if (settingValueMatches(merged, key, local)) continue;
    merged = replaceSettingValue(merged, key, local);
  }
  return merged;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: {},
  isLoaded: false,

  loadSettings: async () => {
    const issuedAt = ++settingsClock;
    const settings = await tauri.getSettings();
    // An older reload that lands after a newer one has nothing new to say.
    if (issuedAt < appliedReload) return;
    appliedReload = issuedAt;
    settleLightTheme(settings, issuedAt, set, get);
  },

  getSetting: <K extends SettingKey>(key: K): SettingsMap[K] | undefined => {
    return get().settings[key as string] as SettingsMap[K] | undefined;
  },

  setSetting: async (key: string, value: unknown, scope: "global" | "workspace" = "global") => {
    const queue = getWriteQueue(key, get().settings);
    const version = ++queue.latestVersion;

    let didOptimisticallyChange = false;
    set((state) => {
      if (
        Object.prototype.hasOwnProperty.call(state.settings, key) &&
        settingValuesEqual(state.settings[key], value)
      ) {
        return state;
      }
      didOptimisticallyChange = true;
      return { settings: { ...state.settings, [key]: value } };
    });
    if (didOptimisticallyChange) applySettingsSideEffects(get().settings);

    const write = queue.tail
      .catch(() => {
        // A later queued value still gets a chance to persist after an earlier
        // failure; rollback is decided by mutation version below.
      })
      .then(() => tauri.setSetting(key, value, scope));
    queue.tail = write;

    try {
      const persistedValue = await write;
      queue.lastPersisted = { exists: true, value: persistedValue };
      writtenAt.set(key, ++settingsClock);
      if (queue.latestVersion === version) {
        let didReconcile = false;
        set((state) => {
          const persisted = { exists: true, value: persistedValue };
          if (settingValueMatches(state.settings, key, persisted)) return state;
          didReconcile = true;
          return { settings: replaceSettingValue(state.settings, key, persisted) };
        });
        if (didReconcile) applySettingsSideEffects(get().settings);
      }
    } catch (error) {
      if (queue.latestVersion === version) {
        let didRollBack = false;
        set((state) => {
          if (settingValueMatches(state.settings, key, queue.lastPersisted)) return state;
          didRollBack = true;
          return { settings: replaceSettingValue(state.settings, key, queue.lastPersisted) };
        });
        if (didRollBack) applySettingsSideEffects(get().settings);
      }
      throw error;
    } finally {
      if (queue.tail === write) settingWriteQueues.delete(key);
    }
  },

  resetSetting: async (key: string, scope: "global" | "workspace" = "global") => {
    const queue = getWriteQueue(key, get().settings);
    const version = ++queue.latestVersion;
    let resetValue = queue.lastPersisted;

    const write = queue.tail
      .catch(() => {
        // Reset still runs after a failed earlier mutation in this key's lane.
      })
      .then(async () => {
        await tauri.resetSetting(key, scope);
        resetValue = persistedValueFor(key, await tauri.getSettings());
      });
    queue.tail = write;

    try {
      await write;
      queue.lastPersisted = resetValue;
      writtenAt.set(key, ++settingsClock);
      if (queue.latestVersion === version) {
        let didReset = false;
        set((state) => {
          if (settingValueMatches(state.settings, key, resetValue)) return state;
          didReset = true;
          return { settings: replaceSettingValue(state.settings, key, resetValue) };
        });
        if (didReset) applySettingsSideEffects(get().settings);
      }
    } catch (error) {
      if (queue.latestVersion === version) {
        let didRollBack = false;
        set((state) => {
          if (settingValueMatches(state.settings, key, queue.lastPersisted)) return state;
          didRollBack = true;
          return { settings: replaceSettingValue(state.settings, key, queue.lastPersisted) };
        });
        if (didRollBack) applySettingsSideEffects(get().settings);
      }
      throw error;
    } finally {
      if (queue.tail === write) settingWriteQueues.delete(key);
    }
  },

  hydrateFromBackend: ({ settings }) => {
    const issuedAt = ++settingsClock;
    appliedReload = issuedAt;
    settleLightTheme(settings, issuedAt, set, get);
  },
}));

function settleLightTheme(
  settings: Record<string, unknown>,
  issuedAt: number,
  set: (partial: Partial<SettingsState>) => void,
  get: () => SettingsState,
) {
  const stored = readStoredAppearance();
  const fromFile = settings["appearance.theme"];
  const next = forceLightSettings(withLocalWrites(settings, get().settings, issuedAt));
  set({ settings: next, isLoaded: true });
  applySettingsSideEffects(next);
  if (!themeNeedsLightMigration(fromFile, stored)) return;
  void get()
    .setSetting("appearance.theme", "light")
    .catch(() => {
      // The desk is already light. The file write is retried on the next open.
    });
}

// Settings are hydrated by resolveStartup() via get_startup_state before the first render.
// loadSettings() remains available for runtime reloads (e.g. settings page).
