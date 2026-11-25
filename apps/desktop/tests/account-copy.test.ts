import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  CODE_ENTRY_ERROR,
  CODE_ENTRY_EXPIRED,
  CODE_ENTRY_LOCKED,
  CODE_ENTRY_RATE_LIMITED_FALLBACK,
  CODE_ENTRY_MISSING_SUPABASE,
  CODE_ENTRY_UNREACHABLE,
  BILLING_UNAVAILABLE,
  DELETE_ACCOUNT_BILLING_FAILED,
  DELETE_ACCOUNT_FAILED,
  DELETE_ACCOUNT_BODY,
  DELETE_ACCOUNT_CANCEL,
  DELETE_ACCOUNT_CONFIRM,
  DELETE_ACCOUNT_DONE,
  DELETE_ACCOUNT_HEADING,
  DELETE_ACCOUNT_NEED_SIGN_IN,
  CHECKOUT_FAILED,
  CHECKOUT_RATE_MESSAGE,
  CODE_SEND_FAILED,
  accountNoticeMessage,
  checkoutFailureMessage,
  referralCodeText,
  codeRequestNotice,
  codeSendFailedParts,
  deleteAccountConfirmText,
  deleteAccountFailureMessage,
  INVITE_NOT_ADMITTED_LINE,
  NO_CLIENT_IP_LINE,
  NOT_ADMITTED_LINE,
  SIGNUP_CAP_LINE,
  SIGNUP_IP_LINE,
  codeEntryPrompt,
  rateLimitedMessage,
  signedInAs,
  signInRefusalMessage,
} from "../src/lib/account-copy";

describe("account desk copy", () => {
  test("delete confirmation is the signed wording", () => {
    expect(DELETE_ACCOUNT_HEADING).toBe("Delete your Alkuin account?");
    expect(DELETE_ACCOUNT_BODY).toBe("This can’t be undone.");
    expect(deleteAccountConfirmText()).toBe(DELETE_ACCOUNT_BODY);
    expect(deleteAccountConfirmText()).not.toMatch(
      /30 days|scrambled|document|trial|writing help/i,
    );
    expect(DELETE_ACCOUNT_CONFIRM).toBe("Delete account");
    expect(DELETE_ACCOUNT_CANCEL).toBe("Keep account");
    expect(DELETE_ACCOUNT_DONE).toBe(
      "Your Alkuin account is deleted. Your documents are still on your computer.",
    );
    expect(DELETE_ACCOUNT_NEED_SIGN_IN).toBe("Sign in to delete your account.");
    expect(DELETE_ACCOUNT_BILLING_FAILED).toBe(
      "We couldn't end your subscription, so your account was not deleted. Try again in a moment.",
    );
    expect(deleteAccountFailureMessage("billing_unavailable")).toBe(DELETE_ACCOUNT_BILLING_FAILED);
    expect(deleteAccountFailureMessage("command plugin:dialog|message not found")).toBe(
      DELETE_ACCOUNT_FAILED,
    );
    expect(deleteAccountFailureMessage("nope")).toBe(DELETE_ACCOUNT_FAILED);
    expect(DELETE_ACCOUNT_FAILED).not.toBe(CODE_ENTRY_ERROR);
    expect(accountNoticeMessage("billing_unavailable")).toBe(BILLING_UNAVAILABLE);
    expect(checkoutFailureMessage("billing_unavailable")).toBe(CHECKOUT_FAILED);
    expect(checkoutFailureMessage("unreachable")).toBe(CHECKOUT_FAILED);
    expect(checkoutFailureMessage("eu_consent")).toBe(
      "Agree that Alkuin starts immediately, then try again.",
    );
    expect(checkoutFailureMessage("checkout_rate")).toBe(CHECKOUT_RATE_MESSAGE);
    expect(checkoutFailureMessage("bad_jwt")).toBe("Sign in to open your account.");
    expect(checkoutFailureMessage("referral_self")).toBe("You can't use your own code.");
    expect(checkoutFailureMessage("referral_taken")).toBe("That code has already been used.");
    expect(referralCodeText(" ABCD2345 ")).toBe("abcd2345");
    expect(referralCodeText("nope")).toBeNull();
    expect(deleteAccountFailureMessage("unreachable")).toBe(CODE_ENTRY_UNREACHABLE);
    const flow = readFileSync(new URL("../src/lib/account-delete.ts", import.meta.url), "utf8");
    const preferences = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    const palette = readFileSync(
      new URL("../src/components/command-palette/index.tsx", import.meta.url),
      "utf8",
    );
    expect(flow).toContain("deleteAccountFailureMessage(");
    expect(preferences).toContain("runDeleteAccount(");
    expect(palette).toContain("runDeleteAccount(");
  });

  test("signed lockout plural, both forms and the fallback", () => {
    expect(rateLimitedMessage(1)).toBe("We've sent several codes already. Try again in 1 minute.");
    expect(rateLimitedMessage(60)).toBe("We've sent several codes already. Try again in 1 minute.");
    expect(rateLimitedMessage(61)).toBe(
      "We've sent several codes already. Try again in 2 minutes.",
    );
    expect(rateLimitedMessage(120)).toBe(
      "We've sent several codes already. Try again in 2 minutes.",
    );
    expect(rateLimitedMessage(null)).toBe(CODE_ENTRY_RATE_LIMITED_FALLBACK);
    expect(rateLimitedMessage(0)).toBe(
      "We've sent several codes already. Try again in a little while.",
    );
    expect(rateLimitedMessage(Number.NaN)).toBe(CODE_ENTRY_RATE_LIMITED_FALLBACK);
    expect(CODE_ENTRY_RATE_LIMITED_FALLBACK).not.toMatch(/\d/);
    expect(accountNoticeMessage("over_email_send_rate_limit:60")).toBe(
      "We've sent several codes already. Try again in 1 minute.",
    );
    expect(accountNoticeMessage("over_request_rate_limit:120")).toBe(
      "We've sent several codes already. Try again in 2 minutes.",
    );
    expect(accountNoticeMessage("over_email_send_rate_limit")).toBe(
      CODE_ENTRY_RATE_LIMITED_FALLBACK,
    );
    expect(accountNoticeMessage("over_request_rate_limit")).toBe(CODE_ENTRY_RATE_LIMITED_FALLBACK);
    expect(accountNoticeMessage("over_email_send_rate_limit:not-a-number")).toBe(
      CODE_ENTRY_RATE_LIMITED_FALLBACK,
    );
    expect(accountNoticeMessage("over_email_send_rate_limit:60")).not.toMatch(
      /limit|times|6 codes/i,
    );
  });

  test("signed sign-in sentences, and locked is not expired", () => {
    expect(codeEntryPrompt("ada@example.com")).toBe("Enter the code we sent to ada@example.com.");
    expect(CODE_ENTRY_ERROR).toBe("That code didn't work. Check it and try again.");
    expect(CODE_ENTRY_EXPIRED).toBe("That code expired. Send a new one.");
    expect(CODE_ENTRY_LOCKED).toBe("That code has had too many wrong tries. Send a new one.");
    expect(CODE_ENTRY_LOCKED).not.toBe(CODE_ENTRY_EXPIRED);
    expect(CODE_ENTRY_UNREACHABLE).toBe("Can't reach Alkuin right now. Try again in a moment.");
    expect(CODE_ENTRY_MISSING_SUPABASE).toBe(
      "This build of Alkuin is missing its sign-in settings. See the terminal for details.",
    );
    expect(CODE_ENTRY_MISSING_SUPABASE).not.toContain("Try again later");
    expect(CODE_ENTRY_MISSING_SUPABASE).not.toContain("REDLINE_SUPABASE");
    expect(accountNoticeMessage("missing_supabase")).toBe(CODE_ENTRY_MISSING_SUPABASE);
    expect(accountNoticeMessage("missing_supabase")).not.toBe(CODE_ENTRY_UNREACHABLE);
    expect(accountNoticeMessage("unreachable")).toBe(CODE_ENTRY_UNREACHABLE);
    expect(signedInAs("ada@example.com")).toBe("Signed in as ada@example.com.");
    expect(accountNoticeMessage("locked")).toBe(CODE_ENTRY_LOCKED);
    expect(accountNoticeMessage("expired")).toBe(CODE_ENTRY_EXPIRED);
    expect(accountNoticeMessage("otp_expired")).toBe(CODE_ENTRY_ERROR);
    expect(accountNoticeMessage("bad_code")).toBe(CODE_ENTRY_ERROR);
    expect(SIGNUP_IP_LINE).toBe(
      "Too many sign-ups from this network. Try again later. If you already have an account, check the email you entered.",
    );
    expect(accountNoticeMessage("signup_rate")).toBe(SIGNUP_IP_LINE);
    expect(accountNoticeMessage("signup_rate")).not.toBe(rateLimitedMessage(300));
    expect(NO_CLIENT_IP_LINE).toBe(
      "Alkuin can't take a sign-up from this connection right now. Try again later, or from a different network.",
    );
    expect(NO_CLIENT_IP_LINE).not.toBe(SIGNUP_IP_LINE);
    expect(accountNoticeMessage("no_client_ip")).toBe(NO_CLIENT_IP_LINE);
    expect(accountNoticeMessage("no_client_ip")).not.toBe(accountNoticeMessage("signup_rate"));
    expect(SIGNUP_CAP_LINE).toBe(
      "Alkuin isn't taking new accounts right now. Try again tomorrow. If you already have an account, check the email you entered.",
    );
    expect(accountNoticeMessage("signup_cap")).toBe(SIGNUP_CAP_LINE);
    // Not on the invitation list is not the daily cap: tomorrow would not help.
    expect(NOT_ADMITTED_LINE).toBe(
      "Alkuin is invite-only while it's in testing, and this email isn't on the list. If someone invited you, check you're using the address they invited, or ask them to get you added.",
    );
    expect(INVITE_NOT_ADMITTED_LINE).toBe(
      "You've been invited to this document, but Alkuin is invite-only while it's in testing and this email isn't on the list yet. Ask the person who shared it with you to get you added.",
    );
    expect(accountNoticeMessage("not_admitted")).toBe(NOT_ADMITTED_LINE);
    for (const line of [NOT_ADMITTED_LINE, INVITE_NOT_ADMITTED_LINE]) {
      expect(line).not.toMatch(/tomorrow/i);
    }
    // Someone who opened a document invite is told what the invite is waiting on.
    expect(signInRefusalMessage("not_admitted")).toBe(NOT_ADMITTED_LINE);
    expect(signInRefusalMessage("not_admitted:invite")).toBe(INVITE_NOT_ADMITTED_LINE);
    // Outside sign-in the same code reads as the plain refusal.
    expect(accountNoticeMessage("not_admitted:invite")).toBe(NOT_ADMITTED_LINE);
    // Any other refusal reads as it always did.
    for (const code of ["bad_code", "signup_cap", "expired", "over_request_rate_limit:90"]) {
      expect(signInRefusalMessage(code)).toBe(accountNoticeMessage(code));
    }
    expect(accountNoticeMessage("session_expired")).toBe(DELETE_ACCOUNT_NEED_SIGN_IN);
    expect(accountNoticeMessage("bad_jwt")).toBe(DELETE_ACCOUNT_NEED_SIGN_IN);
    expect(accountNoticeMessage("session_not_found")).toBe(DELETE_ACCOUNT_NEED_SIGN_IN);
    expect(accountNoticeMessage("validation_failed")).toBe("Enter an email address.");
    expect(accountNoticeMessage("email_address_not_authorized")).toBe(
      "Can't send a sign-in code right now.",
    );
    expect(CODE_SEND_FAILED).toBe(
      "We couldn't send your code. Try again later, or write to support@alkuin.app.",
    );
    expect(codeSendFailedParts().href).toBe("mailto:support@alkuin.app");
    expect(
      codeSendFailedParts().before + codeSendFailedParts().email + codeSendFailedParts().after,
    ).toBe(CODE_SEND_FAILED);
    expect(CODE_SEND_FAILED).not.toMatch(/limit|resend/i);
    expect(codeRequestNotice("mail_failed")).toBe(CODE_SEND_FAILED);
    expect(codeRequestNotice("email_address_not_authorized")).toBe(CODE_SEND_FAILED);
    expect(codeRequestNotice("over_email_send_rate_limit:60")).toBe(CODE_SEND_FAILED);
    expect(codeRequestNotice("over_request_rate_limit")).toBe(CODE_SEND_FAILED);
    expect(codeRequestNotice("validation_failed")).toBe("Enter an email address.");
    expect(codeRequestNotice("missing_supabase")).toBe(CODE_ENTRY_MISSING_SUPABASE);
    expect(codeRequestNotice("unreachable")).toBe(CODE_ENTRY_UNREACHABLE);
    expect(codeRequestNotice("bad_code")).toBe(CODE_ENTRY_ERROR);
  });

  test("desk copy has no git words and no trial or budget sentence", () => {
    const source = readFileSync(new URL("../src/lib/account-copy.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bgit\b|\bcommit\b|\bbranch\b|\brepository\b|\bmerge\b/i);
    expect(source).not.toContain("You've used this month's writing help.");
    expect(source).not.toContain("trial");
    expect(source).not.toContain("budget");
  });
});
