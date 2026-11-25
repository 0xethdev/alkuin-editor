import { openUrl } from "@tauri-apps/plugin-opener";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import {
  BILLING_UNAVAILABLE,
  PORTAL_NEEDS_SIGN_IN,
  accountNoticeMessage,
  checkoutFailureMessage,
} from "@/lib/account-copy";
import * as tauri from "@/lib/tauri";

const SIGN_IN_CODES = new Set([
  "bad_jwt",
  "unauthorized",
  "session_expired",
  "session_not_found",
  "not_admitted",
]);

export function polarPageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "polar.sh" && !host.endsWith(".polar.sh")) return null;
  return url.toString();
}

export async function openBillingUrl(value: string): Promise<void> {
  const safe = polarPageUrl(value);
  if (!safe) {
    showEditorNotice(BILLING_UNAVAILABLE);
    return;
  }
  await openUrl(safe);
}

function noticeFrom(error: unknown): void {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.split(":")[0]?.trim() ?? raw;
  if (SIGN_IN_CODES.has(code)) {
    showEditorNotice(PORTAL_NEEDS_SIGN_IN);
    return;
  }
  showEditorNotice(accountNoticeMessage(raw));
}

export async function openAccountPortal(): Promise<void> {
  try {
    await openBillingUrl(await tauri.accountPortal());
  } catch (error) {
    noticeFrom(error);
  }
}

export async function startSubscription(
  interval: "month" | "year" | "topup",
  serviceStartsNow: boolean,
  referral?: string | null,
): Promise<boolean> {
  try {
    await openBillingUrl(await tauri.accountCheckout(interval, serviceStartsNow, referral));
    return true;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    showEditorNotice(checkoutFailureMessage(raw));
    return false;
  }
}

export async function cancelPreview(): Promise<string | null> {
  try {
    return (await tauri.accountCancelPreview()).line;
  } catch (error) {
    noticeFrom(error);
    return null;
  }
}

export async function refundPurchase(): Promise<{ plan: string; line: string } | null> {
  try {
    return await tauri.accountRefund();
  } catch (error) {
    noticeFrom(error);
    return null;
  }
}

const askListeners = new Set<() => void>();

/** The allowance prompt checks again after a writing ask. */
export function onWriterAsk(listener: () => void): () => void {
  askListeners.add(listener);
  return () => askListeners.delete(listener);
}

export function noteWriterAsk(): void {
  for (const listener of askListeners) listener();
}

export async function saveOverage(
  overage: boolean,
  maximum: number | null,
  prompt = false,
): Promise<boolean> {
  try {
    await tauri.accountUsage(overage, maximum, prompt);
    return true;
  } catch (error) {
    noticeFrom(error);
    return false;
  }
}
