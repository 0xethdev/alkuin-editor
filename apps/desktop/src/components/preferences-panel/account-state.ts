import { accountReadTicket } from "@/lib/account-plan-refresh";

/** The one dialog the account section can show. It is UI, not server data, so an
 *  account refresh never closes it. A busy dialog waits for its request.
 *  Cancelling never waits on the refund quote: a cancel dialog's `line` is the
 *  quote, or null while it is on its way or could not be loaded, and the dialog
 *  then says `CANCEL_FALLBACK_LINE`. The refund call needs nothing from it. */
export type PanelDialog =
  | { kind: "none" }
  | { kind: "clear"; busy: boolean }
  | { kind: "cancel"; line: string | null; busy: boolean };

export type PanelDialogEvent =
  | { type: "ask-clear" }
  | { type: "ask-cancel"; line: string | null }
  /** Keep, on either dialog. */
  | { type: "keep" }
  | { type: "confirm" }
  /** The request the busy dialog was waiting on finished, either way. */
  | { type: "done"; kind: "clear" | "cancel" }
  /** The refund quote changed. A cancel dialog that is not busy shows the new one. */
  | { type: "preview"; line: string | null }
  /** The plan is not paid any more: nothing to cancel. Closes a cancel dialog that is not busy. */
  | { type: "not-paid" }
  /** Another account, or none. Nothing open belongs to it. */
  | { type: "account" };

export const NO_DIALOG: PanelDialog = { kind: "none" };

export function reducePanelDialog(dialog: PanelDialog, event: PanelDialogEvent): PanelDialog {
  switch (event.type) {
    case "ask-clear":
      return dialog.kind === "none" ? { kind: "clear", busy: false } : dialog;
    case "ask-cancel":
      return dialog.kind === "none" ? { kind: "cancel", line: event.line, busy: false } : dialog;
    case "keep":
      return dialog.kind !== "none" && !dialog.busy ? NO_DIALOG : dialog;
    case "confirm":
      return dialog.kind !== "none" && !dialog.busy ? { ...dialog, busy: true } : dialog;
    case "done":
      return dialog.kind === event.kind && dialog.busy ? NO_DIALOG : dialog;
    case "preview":
      return dialog.kind === "cancel" && !dialog.busy && dialog.line !== event.line
        ? { ...dialog, line: event.line }
        : dialog;
    case "not-paid":
      return dialog.kind === "cancel" && !dialog.busy ? NO_DIALOG : dialog;
    case "account":
      return dialog.kind === "none" ? dialog : NO_DIALOG;
    default:
      return dialog;
  }
}

/** Orders the panel's account writers. A read applies only if it was issued after the
 *  last read applied and after the last local write; a local write is newer than
 *  every read still in flight. */
export function createAccountOrder(ticket: () => number = accountReadTicket) {
  let floor = 0;
  return {
    wrote() {
      floor = ticket();
    },
    accept(issued: number): boolean {
      if (issued <= floor) return false;
      floor = issued;
      return true;
    },
  };
}

export type AccountOrder = ReturnType<typeof createAccountOrder>;
