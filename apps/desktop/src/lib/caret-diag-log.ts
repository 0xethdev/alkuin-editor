import { invoke } from "@tauri-apps/api/core";
import { keymap, type EditorView, type KeyBinding, ViewPlugin } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import {
  caretDiagFields,
  caretDiagRequested,
  caretMarkLabel,
  formatCaretDiagLine,
  joinCaretDiagCopy,
  type CaretOffsets,
} from "@/lib/caret-diag";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";

export type CaretDiagStatus = {
  enabled: boolean;
  pinned: boolean;
  path: string;
};

const EMPTY: CaretDiagStatus = { enabled: false, pinned: false, path: "" };

// Read by name. Reading `import.meta.env` as an object makes Vite inline every
// exposed build variable into the bundle.
function viteDiagRaw(): string | undefined {
  return import.meta.env.ALKUIN_CARET_DIAG;
}

function pinEnv(next: CaretDiagStatus): CaretDiagStatus {
  if (!caretDiagRequested(viteDiagRaw())) return next;
  return { ...next, enabled: true, pinned: true };
}

let status = pinEnv(EMPTY);
let loading: Promise<CaretDiagStatus> | null = null;
const listeners = new Set<(next: CaretDiagStatus) => void>();
const pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Flushes run one after another, so batches reach the file in order and a failed
 *  batch goes back to the front before any later line is sent. */
let flushing: Promise<void> = Promise.resolve();
let markedAt = 0;
let markLogged = false;
const markListeners = new Set<() => void>();

function publish(next: CaretDiagStatus) {
  status = pinEnv(next);
  for (const listener of listeners) listener(status);
}

export function caretDiagStatus(): CaretDiagStatus {
  return status;
}

export function subscribeCaretDiag(listener: (next: CaretDiagStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function loadCaretDiag(): Promise<CaretDiagStatus> {
  if (!loading) {
    loading = invoke<CaretDiagStatus>("caret_diag_status")
      .then((next) => {
        publish(next);
        if (status.pinned && !next.enabled) void setCaretDiagEnabled(true).catch(() => {});
        return status;
      })
      .catch(() => {
        loading = null;
        publish(status);
        return status;
      });
  }
  return loading;
}

export async function setCaretDiagEnabled(enabled: boolean): Promise<CaretDiagStatus> {
  if (!enabled) await flushCaretDiag();
  const next = await invoke<CaretDiagStatus>("caret_diag_set_enabled", { enabled });
  publish(next);
  return status;
}

/** Test and harness hook: queue one formatted line as the editor would. */
export function enqueueCaretDiag(line: string) {
  pending.push(line);
  if (pending.length >= 30) {
    void flushCaretDiag();
    return;
  }
  if (flushTimer == null) flushTimer = setTimeout(() => void flushCaretDiag(), 200);
}

/** Resolves once every line queued before the call has been tried once. */
export function flushCaretDiag(): Promise<void> {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushing = flushing.then(sendPending);
  return flushing;
}

async function sendPending(): Promise<void> {
  if (pending.length === 0 || !status.enabled) return;
  const batch = pending.splice(0, pending.length);
  try {
    const written = await invoke<number>("caret_diag_append", { lines: batch.join("\n") });
    if (written === 0) pending.unshift(...batch);
  } catch {
    pending.unshift(...batch);
  }
}

export async function readCaretDiagText(): Promise<string> {
  const buffered = pending.slice();
  await flushCaretDiag();
  let file = "";
  try {
    file = await invoke<string>("caret_diag_copy");
  } catch {
    file = "";
  }
  if (pending.length > 0 || !file) {
    return joinCaretDiagCopy(file, pending.length > 0 ? pending : buffered);
  }
  return file.trim();
}

export function caretDiagPendingText(): string {
  return pending.join("\n");
}

/** Test and harness hook. The dev app still learns the real switch from Rust. */
export function setCaretDiagLocal(enabled: boolean) {
  publish({ ...status, enabled, pinned: status.pinned && enabled });
}

export function caretMarkFlash(now = Date.now()): "marked" | "diag off" | null {
  return caretMarkLabel(markedAt, markLogged, now);
}

export function subscribeCaretMark(listener: () => void): () => void {
  markListeners.add(listener);
  return () => markListeners.delete(listener);
}

function offsetsOf(view: EditorView): CaretOffsets {
  const main = view.state.selection.main;
  return [main.anchor, main.head];
}

function blockLen(view: EditorView, head: number): number {
  const doc = view.state.doc;
  const pos = Math.max(0, Math.min(head, doc.length));
  return doc.lineAt(pos).length;
}

function noteMark(logged: boolean) {
  markedAt = Date.now();
  markLogged = logged;
  for (const listener of markListeners) listener();
  showEditorNotice(logged ? "Marked" : "Diagnostics are off");
}

function writeMark(view: EditorView) {
  const before = offsetsOf(view);
  const line = formatCaretDiagLine({
    t: "mark",
    us: Math.round(performance.now() * 1000),
    inputType: "",
    code: "",
    keyCode: 0,
    composing: false,
    before,
    after: before,
    doc: view.state.doc.length,
    block: blockLen(view, before[1]),
  });
  if (line) enqueueCaretDiag(line);
}

const markBinding: KeyBinding = {
  key: "Ctrl-Alt-m",
  run(view) {
    if (status.enabled) writeMark(view);
    noteMark(status.enabled);
    return true;
  },
};

type OpenSample = {
  us: number;
  before: CaretOffsets;
  after: CaretOffsets | null;
  settled: boolean;
  fields: NonNullable<ReturnType<typeof caretDiagFields>>;
};

const DIAG_EVENTS = ["keydown", "keyup", "beforeinput", "input"] as const;

export function caretDiagExtension(): Extension {
  return [
    Prec.highest(keymap.of([markBinding])),
    ViewPlugin.define((view) => {
      const open: OpenSample[] = [];

      const commit = (item: OpenSample) => {
        if (item.settled || !view.dom.isConnected) return;
        item.settled = true;
        const after = item.after ?? offsetsOf(view);
        const head = after[1];
        const line = formatCaretDiagLine({
          ...item.fields,
          us: item.us,
          before: item.before,
          after,
          doc: view.state.doc.length,
          block: blockLen(view, head),
        });
        if (line) enqueueCaretDiag(line);
      };

      const onCapture = (event: Event) => {
        if (!status.enabled) return;
        const target = event.target;
        if (!(target instanceof Node) || !view.dom.contains(target)) return;
        const fields = caretDiagFields(event);
        if (!fields) return;
        const item: OpenSample = {
          us: Math.round(performance.now() * 1000),
          before: offsetsOf(view),
          after: null,
          settled: false,
          fields,
        };
        open.push(item);
        const finish = () => {
          window.removeEventListener(event.type, finish, false);
          if (item.after == null) item.after = offsetsOf(view);
          queueMicrotask(() => {
            commit(item);
            const index = open.indexOf(item);
            if (index >= 0) open.splice(index, 1);
          });
        };
        window.addEventListener(event.type, finish, false);
      };

      for (const type of DIAG_EVENTS) window.addEventListener(type, onCapture, true);
      return {
        update() {
          const after = offsetsOf(view);
          for (const item of open) {
            if (!item.settled) item.after = after;
          }
        },
        destroy() {
          for (const type of DIAG_EVENTS) window.removeEventListener(type, onCapture, true);
        },
      };
    }),
  ];
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    void flushCaretDiag();
  });
}

void loadCaretDiag();
