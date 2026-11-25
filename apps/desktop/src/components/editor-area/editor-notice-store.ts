import { SYNC_CONFLICT_LINE, SYNC_REMOVED_LINE } from "@/features/redline-spike/margin-copy";
import { create } from "zustand";

const DISMISS_AFTER_MS = 4000;

export interface OverlapNotice {
  path: string;
  localText: string;
  otherText: string;
  deleted: boolean;
  versionId: string;
}

// One banner slot, two kinds of notice:
//   - toast:    a transient line ("Diagnostics copied", a rejected paste).
//               Self-dismisses unless sticky. A new toast replaces the old,
//               except a lasting one (where outside words went, a file that
//               was not backed up): it stays until dismissed, a second lasting
//               line waits behind it, and a passing line shows first and the
//               lasting line comes back after it.
//   - overlaps: unresolved sync-conflict decisions, oldest first, at most one
//               per path (a newer conflict for the same path replaces it).
//               They never time out and a toast never removes one: they
//               leave only when settled or dismissed.
// The slot shows the toast while there is one, else the first overlap.
// `message` and `overlap` are that visible notice, derived in `visibleNotice`
// on every change; nothing else writes them.
interface EditorNoticeState {
  toast: string | null;
  overlaps: OverlapNotice[];
  /** The visible line: the toast, or the first overlap's line. */
  message: string | null;
  /** The visible overlap decision, when the slot is showing one. */
  overlap: OverlapNotice | null;
  showNotice: (message: string, sticky?: boolean, lasting?: boolean, key?: string) => void;
  showOverlap: (overlap: OverlapNotice) => void;
  /** Dismiss the visible notice: the toast if one is up, else the first overlap. */
  dismissNotice: () => void;
  /** Drop the overlap decision for `path`, visible or queued. */
  dismissOverlap: (path: string) => void;
}

type NoticeSlots = Pick<EditorNoticeState, "toast" | "overlaps">;

export function visibleNotice({
  toast,
  overlaps,
}: NoticeSlots): Pick<EditorNoticeState, "message" | "overlap"> {
  if (toast !== null) return { message: toast, overlap: null };
  const first = overlaps[0];
  if (!first) return { message: null, overlap: null };
  return { message: first.deleted ? SYNC_REMOVED_LINE : SYNC_CONFLICT_LINE, overlap: first };
}

function slots(next: NoticeSlots): Partial<EditorNoticeState> {
  return { ...next, ...visibleNotice(next) };
}

// The auto-dismiss timer belongs to the current toast only.
let dismissTimer: number | null = null;

function clearDismissTimer() {
  if (dismissTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(dismissTimer);
  }
  dismissTimer = null;
}

// A lasting line, and the key it holds: at most one line per key shows or waits, and a
// newer line for the same key replaces the older one where it is (one per document, so a
// program that rewrites the file after every save does not pile up lines).
interface LastingLine {
  message: string;
  key: string | null;
}

// The toast showing is lasting (`shownLasting`). Lasting lines that could not show yet
// wait here, in order, and show one at a time as the slot frees.
let shownLasting: LastingLine | null = null;
const waitingLasting: LastingLine[] = [];

function waitLasting(line: LastingLine, first = false) {
  const same = waitingLasting.findIndex(
    (waiting) =>
      waiting.message === line.message || (line.key !== null && waiting.key === line.key),
  );
  if (same !== -1) {
    waitingLasting[same] = line;
    return;
  }
  if (first) waitingLasting.unshift(line);
  else waitingLasting.push(line);
}

/** Notices shown over the editor: transient toasts (unresolved anchor links,
 *  rejected pastes, and similar "that didn't happen, here's why" cases) and
 *  sync-conflict decisions that wait for an answer. */
export const useEditorNoticeStore = create<EditorNoticeState>((set, get) => {
  /** The toast leaves. A lasting line that was waiting takes the slot. */
  const clearToast = () => {
    clearDismissTimer();
    shownLasting = null;
    set(slots({ toast: null, overlaps: get().overlaps }));
    const next = waitingLasting.shift();
    if (next !== undefined) get().showNotice(next.message, true, true, next.key ?? undefined);
  };
  return {
    toast: null,
    overlaps: [],
    message: null,
    overlap: null,
    showNotice: (message, sticky = false, lasting = false, key) => {
      const { toast, overlaps } = get();
      const line: LastingLine = { message, key: key ?? null };
      if (lasting && line.key !== null && shownLasting?.key === line.key) {
        // The newer line for this key replaces the one showing, in place.
        shownLasting = line;
        set(slots({ toast: message, overlaps }));
        return;
      }
      if (lasting && line.key !== null && waitingLasting.some((w) => w.key === line.key)) {
        waitLasting(line);
        return;
      }
      if (shownLasting && toast !== null && toast !== message) {
        // A lasting line is not replaced before it is read.
        if (lasting) {
          waitLasting(line);
          return;
        }
        waitLasting(shownLasting, true);
      }
      clearDismissTimer();
      shownLasting = lasting ? line : null;
      set(slots({ toast: message, overlaps }));
      if (sticky || lasting || typeof window === "undefined") return;
      dismissTimer = window.setTimeout(() => {
        dismissTimer = null;
        clearToast();
      }, DISMISS_AFTER_MS);
    },
    showOverlap: (overlap) => {
      const { toast, overlaps } = get();
      const index = overlaps.findIndex((o) => o.path === overlap.path);
      const next =
        index === -1 ? [...overlaps, overlap] : overlaps.map((o, i) => (i === index ? overlap : o));
      set(slots({ toast, overlaps: next }));
    },
    dismissNotice: () => {
      const { toast, overlaps } = get();
      if (toast !== null) {
        clearToast();
        return;
      }
      if (overlaps.length === 0) return;
      set(slots({ toast, overlaps: overlaps.slice(1) }));
    },
    dismissOverlap: (path) => {
      const { toast, overlaps } = get();
      if (!overlaps.some((o) => o.path === path)) return;
      set(slots({ toast, overlaps: overlaps.filter((o) => o.path !== path) }));
    },
  };
});

/**
 * `lasting`: a line the writer must read. No later toast takes it away (see above).
 * `key`: at most one lasting line per key; a newer one replaces the older, showing or
 * waiting.
 */
export function showEditorNotice(
  message: string,
  options?: { sticky?: boolean; lasting?: boolean; key?: string },
) {
  useEditorNoticeStore
    .getState()
    .showNotice(message, options?.sticky ?? false, options?.lasting ?? false, options?.key);
}

export function dismissEditorNotice() {
  useEditorNoticeStore.getState().dismissNotice();
}

/** A line that is no longer true leaves: off the screen, and out of the lasting lines waiting. */
export function withdrawEditorNotice(message: string) {
  const at = waitingLasting.findIndex((line) => line.message === message);
  if (at !== -1) waitingLasting.splice(at, 1);
  const { toast, dismissNotice } = useEditorNoticeStore.getState();
  if (toast === message) dismissNotice();
}

/**
 * Lasting lines name files of the folder that was open. When the folder changes they go:
 * the ones waiting, and the one showing. A passing toast and the overlaps stay.
 */
export function clearLastingNotices() {
  waitingLasting.length = 0;
  if (shownLasting === null) return;
  shownLasting = null;
  clearDismissTimer();
  const { overlaps } = useEditorNoticeStore.getState();
  useEditorNoticeStore.setState(slots({ toast: null, overlaps }));
}

export function resetEditorNoticesForTest() {
  clearDismissTimer();
  shownLasting = null;
  waitingLasting.length = 0;
  useEditorNoticeStore.setState({ toast: null, overlaps: [], message: null, overlap: null });
}
