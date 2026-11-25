import {
  showEditorNotice,
  useEditorNoticeStore,
} from "@/components/editor-area/editor-notice-store";
import { loadShare } from "@/features/document-share/baseline";
import { SAVED_BESIDE_LINE } from "@/features/redline-spike/margin-copy";
import { noteBackupOutcome } from "@/lib/history/backup-notice";
import { useSettingsStore } from "@/stores/settings-store";
import type { OpenFile } from "@/hooks/editor-api";
import { serializeDocument } from "@/lib/frontmatter";
import { getFileName } from "@/lib/paths";
import * as tauri from "@/lib/tauri";

const THROTTLE_MS = 1000;

/** A failed write tries again on its own: 5 s, then 10, 20, 40, then every 60 s. */
const RETRY_FIRST_MS = 5000;
const RETRY_MAX_MS = 60_000;

/** How long a flush or a quiesce waits for a write that is already on its way. */
export const SAVE_WAIT_MS = 10_000;

export const SAVE_TOO_SLOW = "Saving is taking too long. Try again in a moment.";
export const SAVE_HELD = "This document is being moved. Try again in a moment.";

/** How long "close it again to discard" stays armed after the warning. */
export const DISCARD_CONFIRM_MS = 2 * 60_000;

/**
 * The second step of a close that could not save. The first close with unsaved
 * documents is refused and arms the gate for exactly those paths. Only the next
 * close within `DISCARD_CONFIRM_MS`, with the same paths still unsaved, may
 * discard them. A clean close, a different set, or a late close warns afresh.
 */
export function createDiscardGate(now: () => number = Date.now) {
  let armed: { key: string; at: number } | null = null;
  return function mayDiscard(unsaved: readonly string[]): boolean {
    if (unsaved.length === 0) {
      armed = null;
      return true;
    }
    const key = [...unsaved].sort().join("\n");
    const confirmed = armed !== null && armed.key === key && now() - armed.at <= DISCARD_CONFIRM_MS;
    armed = confirmed ? null : { key, at: now() };
    return confirmed;
  };
}

/** One unsaved document names it (title, else file name). More than one uses `some`. */
export function unsavedLine(paths: readonly string[], one: string, some: string): string {
  if (paths.length !== 1) return some;
  const path = paths[0]!;
  const title = requireStore().getOpenFile(path)?.title.trim();
  return one.replace("{document}", title || getFileName(path));
}

/** After the file is on disk. Not awaited, so the editor does not wait on the network. */
export const HISTORY_AFTER_SAVE_MS = 1500;

const historyCopyTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The disk text a save of `file` checks the file against, on every save. Rust keeps any
 * other version it finds beside the file, and skips only bytes it already kept this run
 * (`write_file_expecting`). A hosted copy of someone else's document is not checked: live
 * sharing writes the owner's text into that file itself (`refreshIdleCopy`), and settles
 * the difference.
 */
function expectedOnDisk(path: string, file: OpenFile): string | undefined {
  if (loadShare(path)?.role === "invitee") return undefined;
  return file.diskContent;
}

function scheduleHistoryCopy(path: string) {
  const pending = historyCopyTimers.get(path);
  if (pending) clearTimeout(pending);
  historyCopyTimers.set(
    path,
    setTimeout(() => {
      historyCopyTimers.delete(path);
      const online = typeof navigator === "undefined" || navigator.onLine !== false;
      void Promise.resolve(tauri.historySend(path, online))
        .then((result) => {
          noteBackupOutcome(path, result);
          if (!result?.conflict || result.local_text == null || result.other_text == null) return;
          useEditorNoticeStore.getState().showOverlap({
            path,
            localText: result.local_text,
            otherText: result.other_text,
            deleted: result.deleted === true,
            versionId: result.version_id ?? "",
          });
        })
        .catch(() => {
          // The file is already on disk. The next save or reconnect tries again.
        });
    }, HISTORY_AFTER_SAVE_MS),
  );
}

/**
 * The slice of editor-store behavior the save engine needs. The store injects
 * it via `registerSaveStore` at startup so this `lib/` module never imports
 * `stores/editor-store` — that back-edge would invert the stores → lib layering
 * and form an import cycle (the store already imports the save engine).
 */
export interface SaveStoreAccess {
  getOpenFile: (path: string) => OpenFile | undefined;
  markSaved: (path: string, diskContent: string, hasNewerChanges: boolean) => void;
  setSaveError: (path: string, error: string) => void;
  /** Loaded documents with unsaved edits, sorted by path. */
  dirtyPaths: () => string[];
}

let storeAccess: SaveStoreAccess | null = null;

/** Wire the save engine to the editor store. Called once from editor-store at
 *  module init. */
export function registerSaveStore(access: SaveStoreAccess) {
  storeAccess = access;
}

function requireStore(): SaveStoreAccess {
  if (!storeAccess) {
    throw new Error("[save] used before registerSaveStore() — editor store not wired");
  }
  return storeAccess;
}

/** How one write attempt ended. `cancelled`: a cancel or reload came first, so
 *  the result was not reported. `held`: a rename or delete holds this path. */
type SaveOutcome =
  | { kind: "saved" }
  | { kind: "clean" }
  | { kind: "held" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };

/**
 * One path's autosave. The states:
 * - idle: no entry in `saveControllers`.
 * - throttled: `timer` set, `pending` true. The write starts when it fires.
 * - writing: `inFlight` set. `pending` true means newer edits wait for a follow-up.
 * - failed: the last write failed, `timer` is the retry (`failures` sets its delay).
 * - held: the path is in `holds`. Writes wait; `pending` remembers that one is wanted.
 *
 * `generation` is bumped by cancel, relocate and discard. A write that settles
 * under an older generation reports nothing to the store and arms no retry.
 */
interface SaveController {
  lastSaveTime: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<SaveOutcome> | null;
  pending: boolean;
  generation: number;
  failures: number;
}

const saveControllers = new Map<string, SaveController>();

/**
 * Files and folders whose writes wait for a rename, trash, import or settle,
 * with how many of those hold each one. Only the owners release a hold:
 * `resumeSave` gives one back; `relocateSave` and `discardSave` drop the path's
 * holds because nothing is left at it. `cancelSave` (a reload, a closed tab)
 * never touches them.
 */
const holds = new Map<string, number>();

function covers(prefix: string, path: string): boolean {
  if (path === prefix) return true;
  return path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function isHeld(path: string): boolean {
  if (holds.size === 0) return false;
  for (const held of holds.keys()) {
    if (covers(held, path)) return true;
  }
  return false;
}

function getSaveController(path: string): SaveController {
  let controller = saveControllers.get(path);
  if (!controller) {
    controller = {
      lastSaveTime: 0,
      timer: null,
      inFlight: null,
      pending: false,
      generation: 0,
      failures: 0,
    };
    saveControllers.set(path, controller);
  }
  return controller;
}

function clearSaveTimer(controller: SaveController) {
  if (!controller.timer) return;
  clearTimeout(controller.timer);
  controller.timer = null;
}

function cleanupSaveController(path: string, controller: SaveController) {
  if (controller.inFlight || controller.pending || controller.timer) return;
  if (saveControllers.get(path) === controller) saveControllers.delete(path);
}

/** Stop the waiting write. A write already on its way still lands, but reports nothing. */
function stopController(path: string, controller: SaveController) {
  controller.pending = false;
  controller.generation += 1;
  clearSaveTimer(controller);
  cleanupSaveController(path, controller);
}

function controllersUnder(prefix: string): [string, SaveController][] {
  return [...saveControllers].filter(([path]) => covers(prefix, path));
}

function historyCopyKeysUnder(prefix: string): string[] {
  return [...historyCopyTimers.keys()].filter((path) => covers(prefix, path));
}

function withinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  tooSlow: () => Error = () => new Error(SAVE_TOO_SLOW),
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(tooSlow());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(tooSlow()), remaining);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function scheduleSave(path: string) {
  const controller = getSaveController(path);
  controller.pending = true;
  queueSave(path, controller);
}

export function isSaveInFlight(path: string) {
  return saveControllers.get(path)?.inFlight != null;
}

/** A save is writing, or newer keystrokes are waiting for the throttle or a retry. */
export function isSaveActive(path: string) {
  const controller = saveControllers.get(path);
  if (!controller) return false;
  return controller.inFlight !== null || controller.pending || controller.timer !== null;
}

/** Drop the waiting write for `path` (closed tab, reload). A write already on
 *  its way lands, but cannot mark the buffer saved or dirty. A hold on the path
 *  belongs to the rename or delete that took it and stays. */
export function cancelSave(path: string) {
  const controller = saveControllers.get(path);
  if (!controller) return;
  stopController(path, controller);
}

/**
 * The file or folder at `path` was deleted. Drop every waiting write and
 * history copy at or under it, and its holds: nothing is left to protect.
 */
export function discardSave(path: string) {
  holds.delete(path);
  for (const [key, controller] of controllersUnder(path)) stopController(key, controller);
  for (const key of historyCopyKeysUnder(path)) {
    clearTimeout(historyCopyTimers.get(key));
    historyCopyTimers.delete(key);
  }
}

/**
 * Hold writes to `path` (a file, or a folder and everything under it) and wait
 * for the write already on its way. Call before renaming or deleting on disk,
 * so a late write cannot re-create the old path. Edits made while held wait.
 * Each call takes one hold; the caller gives it back with `resumeSave`, or
 * `relocateSave` / `discardSave` drops it once the path moved or is gone.
 * Rejects and gives the hold back when a write is still running after `SAVE_WAIT_MS`.
 */
export async function quiesceSave(path: string): Promise<void> {
  holds.set(path, (holds.get(path) ?? 0) + 1);
  const deadline = Date.now() + SAVE_WAIT_MS;
  try {
    for (;;) {
      const writing: Promise<SaveOutcome>[] = [];
      for (const [, controller] of controllersUnder(path)) {
        if (controller.timer) {
          // A throttle or retry was due. Remember it, so the release restarts it.
          clearSaveTimer(controller);
          controller.pending = true;
        }
        if (controller.inFlight) writing.push(controller.inFlight);
      }
      if (writing.length === 0) return;
      await withinDeadline(Promise.all(writing), deadline);
    }
  } catch (error) {
    resumeSave(path);
    throw error;
  }
}

/** Give back one hold on `path` (the rename or delete did not happen, or the
 *  import or settle is done). When none are left, held writes start again. */
export function resumeSave(path: string) {
  const count = holds.get(path);
  if (count === undefined) return;
  if (count > 1) {
    holds.set(path, count - 1);
    return;
  }
  holds.delete(path);
  for (const [key, controller] of controllersUnder(path)) {
    if (controller.pending || controller.failures > 0) queueSave(key, controller);
  }
}

/**
 * `from` (a file or folder) now lives at `to` on disk. Waiting writes and
 * history copies move to the new path, and the holds on `from` are dropped:
 * nothing is left there to protect.
 */
export function relocateSave(from: string, to: string) {
  holds.delete(from);
  const moved = (path: string) => to + path.slice(from.length);

  for (const [key, controller] of controllersUnder(from)) {
    const wanted =
      controller.pending ||
      controller.timer !== null ||
      controller.inFlight !== null ||
      controller.failures > 0;
    const lastSaveTime = controller.lastSaveTime;
    stopController(key, controller);
    if (!wanted) continue;
    const target = getSaveController(moved(key));
    target.lastSaveTime = Math.max(target.lastSaveTime, lastSaveTime);
    target.pending = true;
    queueSave(moved(key), target);
  }

  for (const key of historyCopyKeysUnder(from)) {
    clearTimeout(historyCopyTimers.get(key));
    historyCopyTimers.delete(key);
    scheduleHistoryCopy(moved(key));
  }
}

/**
 * The write behind an Accept, a restart or a close did not reach the disk.
 * The message is the write's own error, `SAVE_HELD` or `SAVE_TOO_SLOW`.
 */
export class SaveFailedError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "SaveFailedError";
  }
}

/**
 * Write `path` now. Resolves once the buffer as it is now is on disk, or
 * there was nothing to write. Rejects with `SaveFailedError` when the write
 * fails, when the path is held by a rename or delete, or when a write on its
 * way takes longer than `SAVE_WAIT_MS`. Callers that commit or restart must
 * not continue on a reject.
 */
export async function flushSave(path: string): Promise<void> {
  const deadline = Date.now() + SAVE_WAIT_MS;
  const tooSlow = () => new SaveFailedError(path, SAVE_TOO_SLOW);
  for (;;) {
    const controller = getSaveController(path);
    controller.pending = true;
    clearSaveTimer(controller);
    if (controller.inFlight) {
      await withinDeadline(controller.inFlight, deadline, tooSlow);
      continue;
    }
    const outcome = await withinDeadline(performSave(path, controller), deadline, tooSlow);
    if (outcome.kind === "failed") throw new SaveFailedError(path, outcome.error);
    if (outcome.kind === "held") throw new SaveFailedError(path, SAVE_HELD);
    return;
  }
}

/** Rounds of `flushAllSaves` before a document that keeps changing counts as unsaved. */
const FLUSH_ALL_ROUNDS = 4;

/**
 * Write every dirty open document now, in parallel. Resolves to the paths that
 * are still unsaved: the write failed, timed out, or the text kept changing.
 * A document that becomes dirty while the others are written is written too.
 */
export async function flushAllSaves(): Promise<string[]> {
  const unsaved = new Set<string>();
  // A document edited while the others were being written is not in the
  // first list. Look again after every round, so it is written too.
  for (let round = 0; round < FLUSH_ALL_ROUNDS; round++) {
    const paths = requireStore()
      .dirtyPaths()
      .filter((path) => !unsaved.has(path));
    if (paths.length === 0) return [...unsaved].sort();
    const saved = await Promise.all(paths.map((path) => flushUntilClean(path)));
    paths.forEach((path, index) => {
      if (!saved[index]) unsaved.add(path);
    });
  }
  // ponytail: documents still changing after the last round count as unsaved.
  for (const path of requireStore().dirtyPaths()) unsaved.add(path);
  return [...unsaved].sort();
}

async function flushUntilClean(path: string): Promise<boolean> {
  // ponytail: four tries. A file that keeps changing while it is written counts as unsaved.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await flushSave(path);
    } catch {
      return false;
    }
    const file = requireStore().getOpenFile(path);
    if (!file || !file.isDirty) return true;
  }
  return false;
}

function queueSave(path: string, controller: SaveController) {
  if (controller.inFlight) return;

  clearSaveTimer(controller);
  // A write is wanted until one starts. A hold or a quiesce relies on this flag.
  controller.pending = true;
  if (isHeld(path)) return;

  const elapsed = Date.now() - controller.lastSaveTime;
  if (elapsed >= THROTTLE_MS) {
    void performSave(path, controller);
    return;
  }

  controller.timer = setTimeout(() => {
    controller.timer = null;
    void performSave(path, controller);
  }, THROTTLE_MS - elapsed);
}

function armRetry(path: string, controller: SaveController) {
  clearSaveTimer(controller);
  const delay = Math.min(RETRY_FIRST_MS * 2 ** (controller.failures - 1), RETRY_MAX_MS);
  controller.timer = setTimeout(() => {
    controller.timer = null;
    void performSave(path, controller);
  }, delay);
}

function applyFileProcessing(content: string): string {
  const settings = useSettingsStore.getState().settings;
  let result = content;

  if (settings["files.trim-trailing-whitespace"]) {
    result = result
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n");
  }

  if (settings["files.insert-final-newline"]) {
    if (!result.endsWith("\n")) {
      result += "\n";
    }
  }

  return result;
}

function serializeForSave(file: OpenFile) {
  return applyFileProcessing(serializeDocument(file.frontmatter, file.content));
}

function performSave(path: string, controller: SaveController): Promise<SaveOutcome> {
  if (controller.inFlight) return controller.inFlight;
  if (isHeld(path)) {
    controller.pending = true;
    return Promise.resolve({ kind: "held" });
  }

  const store = requireStore();
  const file = store.getOpenFile(path);
  if (!file || !file.isDirty || file.isLoading) {
    controller.pending = false;
    controller.failures = 0;
    cleanupSaveController(path, controller);
    return Promise.resolve({ kind: "clean" });
  }

  controller.pending = false;
  controller.lastSaveTime = Date.now();

  let settle!: (outcome: SaveOutcome) => void;
  const write = new Promise<SaveOutcome>((resolve) => {
    settle = resolve;
  });
  // Set before the write starts, so a write that fails at once still clears it.
  controller.inFlight = write;
  void writeAndReport(
    path,
    controller,
    controller.generation,
    serializeForSave(file),
    expectedOnDisk(path, file),
  ).then(settle);
  return write;
}

/**
 * The file changed under the writer: their words are in it, the outside version beside
 * it. The line names the newest copy. A copy Rust skipped as already kept has no
 * `other_copy`, so it says nothing. The line is lasting: a passing toast cannot take it
 * away before the writer has read where the outside words went. One line per document:
 * a newer copy replaces the older line, showing or waiting, so a program that rewrites
 * the file after every save leaves one line, not one per autosave.
 */
function noticeSavedBeside(path: string, copy: string): void {
  showEditorNotice(
    SAVED_BESIDE_LINE.replace("{document}", getFileName(path)).replace("{copy}", getFileName(copy)),
    { sticky: true, lasting: true, key: `saved-beside:${path}` },
  );
}

async function writeAndReport(
  path: string,
  controller: SaveController,
  generation: number,
  full: string,
  expected: string | undefined,
): Promise<SaveOutcome> {
  const store = requireStore();
  let outcome: SaveOutcome;
  let shouldReschedule = false;

  try {
    // The disk text this editor is built on goes with the save. If the file holds
    // something else by now, Rust keeps that version beside it before writing.
    const written = await tauri.writeFile(path, full, expected);
    // Said even when the save was cancelled: the copy is on disk either way.
    if (written?.other_copy) noticeSavedBeside(path, written.other_copy);
    if (controller.generation !== generation) {
      outcome = { kind: "cancelled" };
    } else {
      const latestFile = store.getOpenFile(path);
      if (latestFile) {
        shouldReschedule = serializeForSave(latestFile) !== full;
        store.markSaved(path, full, shouldReschedule);
        scheduleHistoryCopy(path);
        if (loadShare(path)?.role === "owner") {
          void tauri.sharePublish(path).catch(() => {
            // The file is on disk. The next save tries the hosted copy again.
          });
        }
      }
      controller.failures = 0;
      outcome = { kind: "saved" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (controller.generation !== generation) {
      outcome = { kind: "cancelled" };
    } else {
      console.error(`[save] Failed to save ${path}:`, err);
      store.setSaveError(path, message);
      controller.failures += 1;
      outcome = { kind: "failed", error: message };
    }
  }

  controller.inFlight = null;
  if (saveControllers.get(path) !== controller) return outcome;

  if (controller.pending || shouldReschedule) {
    queueSave(path, controller);
  } else if (outcome.kind === "failed") {
    // Held by a rename, trash or settle: keep the controller as wanted, so
    // resumeSave or relocateSave restarts it. A dirty buffer must not go quiet.
    if (isHeld(path)) controller.pending = true;
    else armRetry(path, controller);
  } else {
    cleanupSaveController(path, controller);
  }
  return outcome;
}
