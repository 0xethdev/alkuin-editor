import { AGE_BLOCKED, AGE_INVALID } from "./age-gate.ts";
import { resetDateText } from "../features/redline-spike/reset-date.ts";
import {
  NO_CLIENT_IP_LINE,
  SIGNUP_CAP_LINE,
  SIGNUP_IP_LINE,
} from "../features/redline-spike/margin-copy.ts";

export const SIGN_IN_LABEL = "Sign in";

export const WELCOME_BUTTON = "Email me a code";
/** Off. The app menu does not show this. */
export const ACCOUNT_MENU_ENABLED = false;
export const MANAGE_ACCOUNT_LABEL = "Manage Account Online";
/** Off, with the menu item. */
export const BILLING_PORTAL_ENABLED = false;

export function manageAccountLabel(): string | null {
  return BILLING_PORTAL_ENABLED ? MANAGE_ACCOUNT_LABEL : null;
}
export const ACCOUNT_MENU_LABEL = "Account…";
export const CODE_DIFFERENT_EMAIL = "Use a different email";

export const BUY_CREDIT = "Buy $10 of credit + tax";
export const COPY_CODE = "Copy";
export const REF_HELPER =
  "Share this code. When a friend first pays for Alkuin, you both get $10 Ask credit. They enter it at checkout.";
export const REF_COPIED = "Copied. They enter it at checkout.";
export const CREDIT_NOTE = "Use extra credit when this month’s included usage runs out.";
export const CREDIT_LINE = "Credit: {credit}";
export const CREDIT_EMPTY = "Credit: $0.00";
export const PRICE_LINE = "Alkuin is $19.99 a month or $209.99 a year, plus tax.";

export function creditLine(credit: string | null | undefined): string {
  if (!credit || credit === "$0.00") return CREDIT_EMPTY;
  return CREDIT_LINE.replace("{credit}", credit);
}
export const MONTHLY_PLAN = "Monthly, $19.99";
export const YEARLY_PLAN = "Yearly, $209.99";
export const FREE_CONTINUE = "You can keep writing on Free.";
export const STARTS_NOW = "I agree Alkuin starts immediately.";
/** The same sentence as the website's terms. */
export const RENEWAL_LINE =
  "Pro renews automatically every month or year at the same price until you cancel. Cancel anytime on your account page or in the app's Preferences; Pro then runs to the end of the period you paid for.";
/** Shown in the cancel dialog when the refund amount couldn't be loaded. Cancelling still works. */
export const CANCEL_FALLBACK_LINE =
  "Cancelling stops the next renewal. If your first Pro charge was in the last 14 days, the unused time is refunded and Pro ends now. Otherwise Pro runs to the end of the period you paid for.";
export const FOUNDING_NOT_CHARGED = "Founding members aren't charged.";
export const REFUND_BUTTON = "Cancel subscription";
export const REFUND_KEEP = "Keep my plan";
export const REFUND_CLOSED = "The 14-day refund window has closed.";
export const PORTAL_BUTTON = "Open your account";
export const PORTAL_NEEDS_SIGN_IN = "Sign in to open your account.";
export const PORTAL_NONE = "Subscribe to Alkuin from Settings.";
export const BILLING_UNAVAILABLE = "Alkuin can't reach billing right now. Try again in a moment.";
export const CHECKOUT_FAILED =
  "Checkout didn't start. Try again in a minute. If it keeps happening, write to support@alkuin.app.";
export const REFERRAL_CODE_BAD = "Enter the 8-character code.";
export const REFERRAL_UNKNOWN = "That code isn't recognized.";
export const REFERRAL_SELF = "You can't use your own code.";
export const REFERRAL_TAKEN = "That code has already been used.";
export const REFERRAL_LATE = "That code can't be used on this account.";

const REFERRAL_CODE = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;

/** Eight-character code, or null when the field is blank or not that shape. */
export function referralCodeText(value: string | null | undefined): string | null {
  const code = value?.trim().toLowerCase() ?? "";
  if (!code) return null;
  return REFERRAL_CODE.test(code) ? code : null;
}

/** Clipboard payload for Copy. The short code alone, never an invite sentence. */
export function referralClipboardText(code: string): string {
  return referralCodeText(code) ?? "";
}

/**
 * Checkout buttons, primary first.
 * Free subscribes (year, then month). Free never buys credit.
 * Paid top-up stays behind `showCredit` (`showExtraCredit`). Founding checks out nothing.
 */
export function planCheckoutIntervals(
  plan: string | null | undefined,
  showCredit: boolean,
): Array<"year" | "month" | "topup"> {
  if (plan === "free") return ["year", "month"];
  if (plan === "paid" && showCredit) return ["topup"];
  return [];
}

/** A Free top-up would be secondary. Preferences does not offer one. */
export function checkoutButtonWeight(
  interval: "year" | "month" | "topup",
  plan: string | null | undefined,
): "primary" | "secondary" {
  return interval === "topup" && plan === "free" ? "secondary" : "primary";
}

export const CHECKOUT_RATE_MESSAGE = "Too many checkout attempts. Try again in a few minutes.";
export const SUBSCRIBE_WAIT = "Finish in the browser. Your plan updates when the payment is done.";
export const EU_RETRY = "Agree that Alkuin starts immediately, then try again.";
export const OVERAGE_OPT = "Keep the full model after this month's writing help runs out";
export const OVERAGE_MAX_LABEL = "Monthly maximum";
export const OVERAGE_MAX_PLACEHOLDER = "$10";
export const OVERAGE_SAVE = "Save";
export const OVERAGE_NEED_MAX = "Enter a monthly maximum, like $10.";
export const LIGHTER_NOTE =
  "Once you reach your maximum, Alkuin switches to the lighter model until {reset date}.";
export const OVERAGE_PROMPT_TITLE = "You've used 100% of this month's writing help";
export const OVERAGE_PROMPT_BODY =
  "Keep the full model at {price} per ask, up to a monthly maximum you set. Or switch to a lighter model until {reset date}, at no cost.";
export const OVERAGE_PROMPT_ON = "Keep the full model";
export const OVERAGE_PROMPT_LIGHTER = "Use the lighter model";

export function lighterNote(resetDate: string): string {
  return LIGHTER_NOTE.replace("{reset date}", resetDate);
}

/** `{price}` comes from the server. A missing price is left blank rather than invented. */
export function overagePromptBody(price: string | null, resetDate: string): string {
  const amount = price && /^\$\d/.test(price) ? price : "";
  return OVERAGE_PROMPT_BODY.replace("{price}", amount).replace("{reset date}", resetDate);
}

/** The server date, or the next UTC month when that field is missing. */
export function allowanceResetText(iso: string | null | undefined, now = Date.now()): string {
  const given = resetDateText(iso ?? null);
  if (given) return given;
  const date = new Date(now);
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return resetDateText(next.toISOString());
}

/** Whole dollars from a field. Empty and anything that is not a dollar amount are refused. */
export function dollarsFromField(value: string): number | null {
  const trimmed = value.trim().replace(/^\$/, "");
  if (!/^[1-9]\d{0,5}$/.test(trimmed)) return null;
  const dollars = Number(trimmed);
  return dollars >= 1 && dollars <= 100_000 ? dollars : null;
}

export function dollarFieldText(saved: number | null, fallback: number | null): string {
  const value =
    saved != null && saved >= 1 ? saved : fallback != null && fallback >= 1 ? fallback : null;
  return value == null ? "" : `$${value}`;
}

/** Keep a dollar sign in the field while the writer types. */
export function withDollarSign(value: string): string {
  const body = value.replace(/\$/g, "");
  if (body.trim() === "") return value.includes("$") ? "$" : "";
  return `$${body.replace(/^\s+/, "")}`;
}

export function allowanceLine(percent: number): string {
  return `${percent}% of this month's writing help`;
}

/** Paid, and either the month is used up or bought credit is already on the account. */
export function showExtraCredit(
  plan: string | null | undefined,
  usedPct: number | null | undefined,
  credit: string | null | undefined,
): boolean {
  if (plan !== "paid") return false;
  if ((usedPct ?? 0) >= 100) return true;
  return creditIsPositive(credit);
}

export function creditIsPositive(credit: string | null | undefined): boolean {
  if (!credit) return false;
  const amount = Number(credit.replace(/[$,]/g, ""));
  return Number.isFinite(amount) && amount > 0;
}

/** Dollars saved for overage, the server default, or $10. */
export function overageDollars(saved: number | null, fallback: number | null): number {
  if (saved != null && saved >= 1) return saved;
  if (fallback != null && fallback >= 1) return fallback;
  return 10;
}

export const EMAIL_PROMPT = "Enter your email.";
/** The two doors. Not yet through Copy. */
export const CREATE_ACCOUNT_LABEL = "Create account";
export const CREATE_ACCOUNT_PROMPT = "Create your Alkuin account.";
export const TO_CREATE_ACCOUNT = "New to Alkuin? Create an account";
export const TO_SIGN_IN = "Already have an account? Sign in";
export const NO_ACCOUNT_LINE = "No Alkuin account uses this email. Check it, or create an account.";
export const ACCOUNT_EXISTS_LINE =
  "You already have an Alkuin account with this email. Sign in instead.";
export const EMAIL_SEND = "Send code";
export const EMAIL_INVALID = "Enter an email address.";

export function codeEntryPrompt(email: string): string {
  return `Enter the code we sent to ${email}.`;
}

export const CODE_ENTRY_ERROR = "That code didn't work. Check it and try again.";
export const CODE_ENTRY_RESEND = "Send a new code";

/** Gone at 0, so the resend button can come back. Exactly 1 is singular. */
export function resendCooldownLine(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const n = Math.ceil(seconds);
  if (n === 1) return "You can send a new code in 1 second.";
  return `You can send a new code in ${n} seconds.`;
}
export const CODE_ENTRY_EXPIRED = "That code expired. Send a new one.";
export const CODE_ENTRY_LOCKED = "That code has had too many wrong tries. Send a new one.";
export const CODE_ENTRY_CODES_ONE = "We've sent several codes already. Try again in 1 minute.";
export const CODE_ENTRY_CODES_LINE =
  "We've sent several codes already. Try again in {minutes} minutes.";
export const CODE_ENTRY_RATE_LIMITED_FALLBACK =
  "We've sent several codes already. Try again in a little while.";

/**
 * Whole minutes, rounded up. Exactly 1 is singular. Every other count is plural.
 * No number, zero, and no limit count, use the fallback.
 */
export function rateLimitedMessage(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds == null || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return CODE_ENTRY_RATE_LIMITED_FALLBACK;
  }
  const minutes = Math.ceil(retryAfterSeconds / 60);
  if (minutes === 1) return CODE_ENTRY_CODES_ONE;
  return CODE_ENTRY_CODES_LINE.replace("{minutes}", String(minutes));
}

export { NO_CLIENT_IP_LINE, SIGNUP_CAP_LINE, SIGNUP_IP_LINE };

/**
 * This address is not on the invitation list. It is not the daily cap
 * (`SIGNUP_CAP_LINE`), so it does not say to come back tomorrow.
 * The same sentence as the website.
 */
export const NOT_ADMITTED_LINE =
  "Alkuin is invite-only while it's in testing, and this email isn't on the list. If someone invited you, check you're using the address they invited, or ask them to get you added.";
/** The same refusal, for someone who got here by opening a document invite. */
export const INVITE_NOT_ADMITTED_LINE =
  "You've been invited to this document, but Alkuin is invite-only while it's in testing and this email isn't on the list yet. Ask the person who shared it with you to get you added.";

export const CODE_ENTRY_UNREACHABLE = "Can't reach Alkuin right now. Try again in a moment.";
export const CODE_ENTRY_MISSING_SUPABASE =
  "This build of Alkuin is missing its sign-in settings. See the terminal for details.";
export const CODE_ENTRY_MAIL_FAILED = "Can't send a sign-in code right now.";

export const SUPPORT_EMAIL = "support@alkuin.app";
export const CODE_SEND_FAILED =
  "We couldn't send your code. Try again later, or write to support@alkuin.app.";

/** The support address is the only link. The sentence stays one string. */
export function codeSendFailedParts(): {
  before: string;
  email: string;
  href: string;
  after: string;
} {
  const at = CODE_SEND_FAILED.indexOf(SUPPORT_EMAIL);
  return {
    before: CODE_SEND_FAILED.slice(0, at),
    email: SUPPORT_EMAIL,
    href: `mailto:${SUPPORT_EMAIL}`,
    after: CODE_SEND_FAILED.slice(at + SUPPORT_EMAIL.length),
  };
}

const CODE_REQUEST_FAILURES = new Set([
  "mail_failed",
  "email_address_not_authorized",
  "over_email_send_rate_limit",
  "over_request_rate_limit",
]);

/** OTP send failures. Validation, a missing build, and a network miss keep their lines. */
export function codeRequestNotice(raw: string): string {
  const code = raw.trim().split(":")[0] ?? "";
  if (CODE_REQUEST_FAILURES.has(code)) return CODE_SEND_FAILED;
  return accountNoticeMessage(raw);
}

export function signedInAs(email: string): string {
  return `Signed in as ${email}.`;
}

export const DELETE_ACCOUNT_HEADING = "Delete your Alkuin account?";
export const DELETE_ACCOUNT_BODY = "This can’t be undone.";
export const DELETE_ACCOUNT_CONFIRM = "Delete account";
export const DELETE_ACCOUNT_CANCEL = "Keep account";
export const DELETE_ACCOUNT_DONE =
  "Your Alkuin account is deleted. Your documents are still on your computer.";
export const DELETE_ACCOUNT_NEED_SIGN_IN = "Sign in to delete your account.";
export const DELETE_ACCOUNT_BILLING_FAILED =
  "We couldn't end your subscription, so your account was not deleted. Try again in a moment.";
export const DELETE_ACCOUNT_FAILED =
  "Alkuin couldn't delete your account. It is still there. Try again in a moment.";

export function deleteAccountConfirmText(): string {
  return DELETE_ACCOUNT_BODY;
}

const CODE_MESSAGES: Record<string, string> = {
  bad_code: CODE_ENTRY_ERROR,
  no_account: NO_ACCOUNT_LINE,
  account_exists: ACCOUNT_EXISTS_LINE,
  age_required: AGE_INVALID,
  age_blocked: AGE_BLOCKED,
  expired: CODE_ENTRY_EXPIRED,
  locked: CODE_ENTRY_LOCKED,
  validation_failed: EMAIL_INVALID,
  unreachable: CODE_ENTRY_UNREACHABLE,
  missing_supabase: CODE_ENTRY_MISSING_SUPABASE,
  mail_failed: CODE_ENTRY_MAIL_FAILED,
  email_address_not_authorized: CODE_ENTRY_MAIL_FAILED,
  bad_jwt: DELETE_ACCOUNT_NEED_SIGN_IN,
  session_expired: DELETE_ACCOUNT_NEED_SIGN_IN,
  session_not_found: DELETE_ACCOUNT_NEED_SIGN_IN,
  unauthorized: DELETE_ACCOUNT_NEED_SIGN_IN,
  signup_cap: SIGNUP_CAP_LINE,
  not_admitted: NOT_ADMITTED_LINE,
  signup_rate: SIGNUP_IP_LINE,
  no_client_ip: NO_CLIENT_IP_LINE,
  founding: FOUNDING_NOT_CHARGED,
  eu_consent: EU_RETRY,
  checkout_rate: CHECKOUT_RATE_MESSAGE,
  billing_unavailable: BILLING_UNAVAILABLE,
  refund_closed: REFUND_CLOSED,
  not_paid: PORTAL_NONE,
  no_billing: PORTAL_NONE,
  bad_interval: BILLING_UNAVAILABLE,
  bad_body: BILLING_UNAVAILABLE,
};

const RATE_LIMIT_CODES = new Set(["over_email_send_rate_limit", "over_request_rate_limit"]);

/** Map a Supabase or command code to the sentence a person reads. */
export function accountNoticeMessage(raw: string): string {
  const trimmed = raw.trim();
  const splitAt = trimmed.indexOf(":");
  const code = splitAt === -1 ? trimmed : trimmed.slice(0, splitAt);
  const extra = splitAt === -1 ? "" : trimmed.slice(splitAt + 1);
  if (RATE_LIMIT_CODES.has(code)) {
    if (extra === "") return rateLimitedMessage(null);
    const seconds = Number(extra);
    return rateLimitedMessage(Number.isFinite(seconds) ? seconds : null);
  }
  const known = CODE_MESSAGES[code];
  if (known) return known;
  if (Object.values(CODE_MESSAGES).includes(trimmed)) return trimmed;
  return CODE_ENTRY_ERROR;
}

/** How the Mac app names "not on the list" for a sign-in that follows an invite link opened signed out. */
export const NOT_ADMITTED_AFTER_INVITE = "not_admitted:invite";

/**
 * A refused sign-in. Someone who opened a document invite and is not on the
 * list is told what the invite is waiting on; everyone else gets the usual line.
 * Rust knows whether an invite is waiting, in every window, and says so in the code.
 */
export function signInRefusalMessage(raw: string): string {
  if (raw.trim() === NOT_ADMITTED_AFTER_INVITE) return INVITE_NOT_ADMITTED_LINE;
  return accountNoticeMessage(raw);
}

const CHECKOUT_SIGN_IN = new Set([
  "bad_jwt",
  "unauthorized",
  "session_expired",
  "session_not_found",
]);

/** Checkout failures use one sentence. Consent, founding, and the rate limit keep theirs. */
export function checkoutFailureMessage(raw: string): string {
  const code = raw.trim().split(":")[0] ?? "";
  if (CHECKOUT_SIGN_IN.has(code)) return PORTAL_NEEDS_SIGN_IN;
  if (code === "checkout_rate" || code === "eu_consent" || code === "founding") {
    return accountNoticeMessage(raw);
  }
  if (code === "referral_unknown") return REFERRAL_UNKNOWN;
  if (code === "referral_self") return REFERRAL_SELF;
  if (code === "referral_taken") return REFERRAL_TAKEN;
  if (code === "referral_late") return REFERRAL_LATE;
  return CHECKOUT_FAILED;
}

/** Delete is the only place this code means the account is still there. */
export function deleteAccountFailureMessage(raw: string): string {
  const trimmed = raw.trim();
  const splitAt = trimmed.indexOf(":");
  const code = splitAt === -1 ? trimmed : trimmed.slice(0, splitAt);
  if (code === "billing_unavailable") return DELETE_ACCOUNT_BILLING_FAILED;
  const known = accountNoticeMessage(raw);
  if (known === CODE_ENTRY_ERROR) return DELETE_ACCOUNT_FAILED;
  return known;
}
