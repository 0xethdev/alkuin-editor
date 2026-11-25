import {
  DELETE_ACCOUNT_CANCEL,
  DELETE_ACCOUNT_CONFIRM,
  DELETE_ACCOUNT_DONE,
  DELETE_ACCOUNT_HEADING,
  DELETE_ACCOUNT_NEED_SIGN_IN,
  deleteAccountConfirmText,
  deleteAccountFailureMessage,
} from "@/lib/account-copy";
import { returnToWelcome } from "@/lib/account-sign-in";
import { confirmWarning } from "@/lib/native-dialog";
import * as tauri from "@/lib/tauri";

export interface DeleteAccountResult {
  notice: string | null;
  signedOut: boolean;
}

/** Confirm with the dialog command the app registers, then delete. Cancel leaves the session. */
export async function runDeleteAccount(): Promise<DeleteAccountResult> {
  try {
    const status = await tauri.accountStatus();
    if (!status.signed_in) {
      return { notice: DELETE_ACCOUNT_NEED_SIGN_IN, signedOut: false };
    }
    const accepted = await confirmWarning({
      title: DELETE_ACCOUNT_HEADING,
      body: deleteAccountConfirmText(),
      confirm: DELETE_ACCOUNT_CONFIRM,
      cancel: DELETE_ACCOUNT_CANCEL,
    });
    if (!accepted) return { notice: null, signedOut: false };
    await tauri.accountDelete();
    returnToWelcome();
    return { notice: DELETE_ACCOUNT_DONE, signedOut: true };
  } catch (error) {
    return {
      notice: deleteAccountFailureMessage(error instanceof Error ? error.message : String(error)),
      signedOut: false,
    };
  }
}
