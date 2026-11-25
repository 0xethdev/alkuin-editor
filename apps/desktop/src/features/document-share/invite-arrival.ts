// An invite link (`alkuin://share/…`) that arrived and could not be opened.
// Rust redeems the link with the signed-in session and keeps what became of it
// (`src-tauri/src/invite_arrival.rs`), one copy for every window:
//   - nobody signed in: the next refused sign-in carries it (`not_admitted:invite`),
//     so nothing is read here;
//   - signed in and refused: the code waits until one window asks. The link can
//     arrive before the window is listening (a cold start from the email), so
//     the answer is pulled, once the listener exists and again on the event.

import { listenInThisWindow } from "@/lib/window-events";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { INVITE_NOT_ADMITTED_LINE } from "@/lib/account-copy";
import * as tauri from "@/lib/tauri";
import { useWorkspaceStore } from "@/stores/workspace-store";

/** The sentence for a link refused for the signed-in account. Only "not on the list" has one. */
export function inviteRefusalLine(raw: string | null): string | null {
  if (raw === null) return null;
  const code = raw.trim().split(":")[0] ?? "";
  return code === "not_admitted" ? INVITE_NOT_ADMITTED_LINE : null;
}

/**
 * Rust hands the refusal over once, so the line has to be read here: it stays
 * until dismissed, and a passing notice shows over it and gives the place back.
 * One key, so a second refused link replaces the line and does not queue behind it.
 */
function say(line: string) {
  showEditorNotice(line, { sticky: true, lasting: true, key: "invite-refused" });
}

/**
 * Startup opens the folder from the last run, and opening a folder clears
 * lasting lines (they name that folder's files). So the refusal stays in Rust
 * until startup has resolved. Startup always resolves, also when it fails.
 */
function afterStartup(): Promise<void> {
  if (useWorkspaceStore.getState().isStartupResolved) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = useWorkspaceStore.subscribe((state) => {
      if (!state.isStartupResolved) return;
      stop();
      resolve();
    });
  });
}

/** Read what Rust kept, now and whenever this window is told a link was refused. Returns the unlisten. */
export function watchInviteRefusals(notify: (line: string) => void = say): () => void {
  const read = () =>
    void afterStartup()
      .then(() => tauri.shareInviteRefusal())
      .then(
        (raw) => {
          const line = inviteRefusalLine(raw);
          if (line) notify(line);
        },
        () => {
          // No answer is no refusal to show.
        },
      );
  // Listen first. A refusal noted between a read and the listener existing
  // would otherwise wait for the next link.
  const unlisten = listenInThisWindow("share:invite-refused", read);
  void unlisten.then(read, read);
  return () =>
    void unlisten.then(
      (stop) => stop(),
      () => {
        // Never listening: nothing to stop.
      },
    );
}
