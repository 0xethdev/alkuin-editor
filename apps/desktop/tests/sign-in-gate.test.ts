import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { AGE_BLOCKED } from "../src/lib/age-gate";
import {
  ACCOUNT_MENU_ENABLED,
  ACCOUNT_MENU_LABEL,
  CREATE_ACCOUNT_LABEL,
  CREATE_ACCOUNT_PROMPT,
  TO_CREATE_ACCOUNT,
  TO_SIGN_IN,
  BILLING_PORTAL_ENABLED,
  CODE_DIFFERENT_EMAIL,
  CODE_ENTRY_ERROR,
  CODE_ENTRY_EXPIRED,
  CODE_ENTRY_LOCKED,
  CODE_ENTRY_MAIL_FAILED,
  CODE_ENTRY_MISSING_SUPABASE,
  CODE_SEND_FAILED,
  DELETE_ACCOUNT_BODY,
  CODE_ENTRY_RATE_LIMITED_FALLBACK,
  CODE_ENTRY_RESEND,
  CODE_ENTRY_UNREACHABLE,
  EMAIL_PROMPT,
  MANAGE_ACCOUNT_LABEL,
  manageAccountLabel,
  SIGN_IN_LABEL,
  WELCOME_BUTTON,
  deleteAccountConfirmText,
  rateLimitedMessage,
  resendCooldownLine,
} from "../src/lib/account-copy";
import {
  deskEntry,
  editorUnlocked,
  enterFromStoredSession,
  reduceSignIn,
} from "../src/lib/account-gate";
import {
  rememberWritingOffline,
  rememberWritingSession,
  writingSignedIn,
} from "../src/lib/account-session";
import { MODEL_UNREACHABLE_LINE } from "../src/features/redline-spike/margin-copy";
import { backspaceDigit, digitsFrom, pasteDigits, typeDigit } from "../src/lib/sign-in-code";
import { openAccountSignIn, subscribeAccountSignIn } from "../src/lib/account-sign-in";
import { signInMarkup } from "../src/lib/sign-in-markup";
import { askAgentOnNote, requestRewrite } from "../src/features/redline-spike";
import { addRedlineNote, redlineNotesField } from "../src/features/redline-spike/notes";
import {
  isSignInPrompt,
  noteShowsCompose,
  redlineNoteLabel,
} from "../src/features/redline-spike/gutter";
import type { RedlineNote } from "../src/features/redline-spike/model";
import {
  NO_CLIENT_IP_LINE,
  SIGNUP_CAP_LINE,
  SIGNUP_IP_LINE,
} from "../src/features/redline-spike/margin-copy";

const mockedInvoke = vi.mocked(invoke);
const ORIGINAL = "This is really very important.";

const CODE_ERRORS = [
  CODE_ENTRY_ERROR,
  CODE_ENTRY_EXPIRED,
  CODE_ENTRY_LOCKED,
  rateLimitedMessage(60),
  rateLimitedMessage(120),
  CODE_ENTRY_RATE_LIMITED_FALLBACK,
  NO_CLIENT_IP_LINE,
  SIGNUP_CAP_LINE,
  SIGNUP_IP_LINE,
  CODE_ENTRY_UNREACHABLE,
  CODE_ENTRY_MISSING_SUPABASE,
  CODE_ENTRY_MAIL_FAILED,
];

function readSrc(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/** Static markup escapes apostrophes. Compare the sentence a person reads. */
function shown(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

function dispatchView(doc: string) {
  let state = EditorState.create({ doc, extensions: [redlineNotesField] });
  const view = {
    get state() {
      return state;
    },
    dom: { isConnected: true },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  };
  return view as unknown as EditorView;
}

function openNote(): RedlineNote {
  return {
    id: "redline-1",
    from: 0,
    to: ORIGINAL.length,
    original: ORIGINAL,
    proposed: null,
    intent: null,
    instruction: null,
    status: "open",
    error: null,
    git: null,
    publish: null,
  };
}

afterEach(() => {
  rememberWritingSession(true);
  rememberWritingOffline(false);
  vi.clearAllMocks();
});

describe("full-screen sign-in", () => {
  test("a fresh launch shows the welcome screen before the desk", () => {
    expect(deskEntry(false)).toBe("welcome");
    const app = readSrc("../src/App.tsx");
    expect(app).toContain("<SignInGate>");
    // The first-run question mounts with the desk. Beside the gate it opened
    // under the sign-in screen and its key handler took Tab and Escape.
    const gated = app.slice(app.indexOf("<SignInGate>"), app.indexOf("</SignInGate>"));
    expect(gated).toContain("<AppLayout />");
    expect(gated).toContain("<TelemetryConsentDialog />");
    expect(app.split("<TelemetryConsentDialog />")).toHaveLength(2);
    const welcome = shown(signInMarkup("welcome"));
    expect(welcome).toContain('alt="Alkuin"');
    expect(welcome).toContain("/brand/alkuin-wordmark.svg");
    expect(welcome).toContain(EMAIL_PROMPT);
    expect(welcome).toContain(WELCOME_BUTTON);
    expect(welcome).not.toMatch(/just write|write only/i);
    expect(welcome).not.toContain("COPY:");
  });

  test("nothing but a signed-in session opens the desk, and a save does not move the file", () => {
    expect(reduceSignIn("welcome", { type: "signed-in" })).toBe("desk");
    expect(reduceSignIn("code", { type: "different-email" })).toBe("welcome");
    expect(reduceSignIn("code", { type: "signed-out" })).toBe("welcome");
    expect(editorUnlocked(false, "desk")).toBe(false);
    expect(editorUnlocked(false, "welcome")).toBe(false);
    expect(editorUnlocked(true, "welcome")).toBe(false);
    expect(editorUnlocked(true, "code")).toBe(false);
    expect(editorUnlocked(true, "desk")).toBe(true);
    const gate = readSrc("../src/components/use-sign-in-gate.ts");
    const screen = readSrc("../src/components/sign-in-screen.tsx");
    const shell = readSrc("../src/components/sign-in-gate.tsx");
    expect(gate).not.toContain("just-write");
    expect(gate).not.toContain("justWrite");
    expect(screen).not.toMatch(/just write|write only/i);
    expect(shell).toContain("editorUnlocked");
    // Two doors: Create account sends the date with the email, before any code.
    // Sign in asks nothing but the email. A held sign-in still has its date step.
    expect(shell).not.toMatch(/continueWithAge|accountSignInKnown|AgeGate/);
    expect(shell).toContain("void gate.register(birthDate).then(keepRefusal)");
    expect(shell).toContain("void gate.submitAge(birthDate).then(keepRefusal)");
    expect(shell).toContain('if (result !== "age_blocked") return;');
    expect(reduceSignIn("code", { type: "age-check" })).toBe("age");
    expect(reduceSignIn("age", { type: "different-email" })).toBe("welcome");
    expect(editorUnlocked(true, "age")).toBe(false);
    expect(shell).not.toContain("onJustWrite");
    const submit = gate.slice(
      gate.indexOf("async function submitCode"),
      gate.indexOf("function differentEmail"),
    );
    const opened = submit.indexOf('type: "signed-in"');
    const refused = submit.indexOf("if (!status.signed_in) return");
    expect(refused).toBeGreaterThan(-1);
    expect(opened).toBeGreaterThan(refused);
    expect(readSrc("../src/hooks/use-keyboard-shortcuts.ts")).toContain(
      "if (!writingSignedIn()) return",
    );
    expect(readSrc("../src/hooks/use-menu-events.ts")).toContain("if (!writingSignedIn()) return");
    rememberWritingSession(false);
    expect(writingSignedIn()).toBe(false);
    const session = readSrc("../src/lib/account-session.ts");
    expect(session).not.toContain("localStorage");
    expect(session).not.toContain("preferences");
    const save = readSrc("../src/lib/save.ts");
    expect(save).toContain("await tauri.writeFile(path, full, expected)");
    expect(save).not.toContain("accountSignIn");
    expect(save).not.toContain("redline_propose");
    const fs = readSrc("../src-tauri/src/commands/fs.rs");
    const impl = fs.slice(
      fs.indexOf("pub fn write_file_impl"),
      fs.indexOf("pub async fn write_file"),
    );
    expect(impl).toContain("fs::write");
    expect(impl).not.toContain("session");
  });

  test("an offline relaunch with a stored session opens the desk", async () => {
    let release: (value: { signed_in: boolean }) => void = () => {};
    const pending = new Promise<{ signed_in: boolean }>((resolve) => {
      release = resolve;
    });
    let confirms = 0;
    const seen: string[] = [];
    const done = enterFromStoredSession(
      async () => ({ signed_in: true, email: "ada@example.com" }),
      () => {
        confirms += 1;
        return pending;
      },
      (entry) => seen.push(entry.step),
    );
    await Promise.resolve();
    expect(seen).toEqual(["desk"]);
    expect(confirms).toBe(1);
    release({ signed_in: true });
    await done;
    expect(seen).toEqual(["desk", "desk"]);
  });

  test("a status check that is still signed in keeps the desk", async () => {
    const seen: string[] = [];
    await enterFromStoredSession(
      async () => ({ signed_in: true, email: "ada@example.com" }),
      async () => ({ signed_in: true, email: "ada@example.com" }),
      (entry) => seen.push(entry.step),
    );
    expect(seen).toEqual(["desk", "desk"]);
  });

  test("an invalid session answer returns to the welcome screen", async () => {
    const seen: string[] = [];
    await enterFromStoredSession(
      async () => ({ signed_in: true, email: "ada@example.com" }),
      async () => ({ signed_in: false, email: null }),
      (entry) => seen.push(entry.step),
    );
    expect(seen).toEqual(["desk", "welcome"]);
  });

  test("a timeout keeps the desk", async () => {
    const seen: { step: string; offline: boolean }[] = [];
    await enterFromStoredSession(
      async () => ({ signed_in: true, email: "ada@example.com" }),
      () => Promise.reject(new Error("timeout")),
      (entry) => seen.push({ step: entry.step, offline: entry.offline }),
    );
    expect(seen).toEqual([
      { step: "desk", offline: false },
      { step: "desk", offline: true },
    ]);
  });

  test("asking for help while signed out sends no request", async () => {
    rememberWritingSession(false);
    await expect(requestRewrite(ORIGINAL, "improve")).rejects.toThrow(SIGN_IN_LABEL);
    expect(mockedInvoke).not.toHaveBeenCalled();
    const view = dispatchView(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(openNote()) });
    await expect(askAgentOnNote(view, "redline-1", "improve")).resolves.toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.error).toBe(SIGN_IN_LABEL);
    expect(isSignInPrompt(item)).toBe(true);
    expect(noteShowsCompose(item)).toBe(false);
    expect(redlineNoteLabel(item)).toBe("");
    const gutter = readSrc("../src/features/redline-spike/gutter.ts");
    const signInBranch = gutter.indexOf("if (isSignInPrompt(note)) {");
    const branch = gutter.slice(
      signInBranch,
      gutter.indexOf("if (note.error && isCalmStatusNote", signInBranch),
    );
    expect(branch).toContain("cm-redline-btn");
    expect(branch).toContain('action: "sign-in"');
    expect(branch).toContain("openAccountSignIn");
    expect(branch).not.toContain("cm-redline-error");
  });

  test("an offline Ask shows the network line and sends no request", async () => {
    rememberWritingSession(true);
    rememberWritingOffline(true);
    await expect(requestRewrite(ORIGINAL, "improve")).rejects.toThrow(MODEL_UNREACHABLE_LINE);
    expect(mockedInvoke).not.toHaveBeenCalled();
    const view = dispatchView(ORIGINAL);
    view.dispatch({ effects: addRedlineNote.of(openNote()) });
    await expect(askAgentOnNote(view, "redline-1", "improve")).resolves.toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalled();
    const item = view.state.field(redlineNotesField)[0]!;
    expect(item.error).toBe(MODEL_UNREACHABLE_LINE);
    expect(item.error).not.toBe(SIGN_IN_LABEL);
  });

  test("every refusal renders in ink on the code screen", () => {
    const css = readSrc("../src/components/sign-in-screen.css");
    expect(css).toMatch(/\.error\s*\{[^}]*color:\s*var\(--color-ink\)/);
    expect(css).not.toContain("#8a3a35");
    expect(css).not.toContain("--color-error");
    for (const line of CODE_ERRORS) {
      const html = signInMarkup("code", { error: line });
      expect(shown(html)).toContain(line);
      expect(html).toContain('class="error"');
    }
    const send = readSrc("../src/components/use-sign-in-gate.ts");
    const sendCode = send.slice(
      send.indexOf("async function requestCode"),
      send.indexOf("async function submitCode"),
    );
    const caught = sendCode.slice(sendCode.indexOf("} catch"));
    expect(caught).toContain("setError");
    expect(caught).toContain("codeRequestNotice");
    expect(caught).not.toContain("setStep");
    const failed = shown(signInMarkup("welcome", { error: CODE_SEND_FAILED }));
    expect(failed).toContain("We couldn't send your code. Try again later, or write to ");
    expect(failed).toContain('href="mailto:support@alkuin.app"');
    expect(failed).toContain(">support@alkuin.app<");
    expect(failed).toContain(`>${WELCOME_BUTTON}<`);
    expect(failed).toContain('class="prompt"');
    expect(failed).not.toContain(EMAIL_PROMPT);
    expect(failed).not.toContain('class="error"');
    expect(failed).not.toContain("Enter the code we sent");
    const normal = shown(signInMarkup("welcome"));
    expect(normal).toContain(EMAIL_PROMPT);
    expect(normal).not.toContain("couldn't send your code");
    // The two doors: Sign in asks only the email; Create account asks the date too.
    expect(normal).toContain(TO_CREATE_ACCOUNT);
    expect(normal).not.toContain('type="date"');
    const create = shown(signInMarkup("welcome", { door: "create" }));
    expect(create).toContain(CREATE_ACCOUNT_PROMPT);
    expect(create).toContain('type="date"');
    expect(create).toContain(`>${CREATE_ACCOUNT_LABEL}<`);
    expect(create).toContain(TO_SIGN_IN);
    const blocked = shown(signInMarkup("welcome", { door: "create", age: "blocked" }));
    expect(blocked).toContain(AGE_BLOCKED);
    expect(blocked).not.toContain('type="date"');
    // A device that answered under age still signs in to an existing account.
    expect(shown(signInMarkup("welcome", { age: "blocked" }))).toContain(EMAIL_PROMPT);
  });

  test("Sign in while already signed in does not open the welcome screen", () => {
    rememberWritingSession(true);
    const events: string[] = [];
    const stop = subscribeAccountSignIn((event) => events.push(event));
    openAccountSignIn();
    stop();
    expect(events).toEqual([]);
    expect(editorUnlocked(true, "desk")).toBe(true);
    const palette = readSrc("../src/components/command-palette/index.tsx");
    const at = palette.indexOf('id: "account-sign-in"');
    expect(palette.slice(at - 80, at)).toContain("!writingSignedIn()");
  });

  test("Sign in while signed out still opens the welcome screen", () => {
    rememberWritingSession(false);
    const events: string[] = [];
    const stop = subscribeAccountSignIn((event) => events.push(event));
    openAccountSignIn();
    stop();
    expect(events).toEqual(["open"]);
    expect(reduceSignIn("desk", { type: "open" })).toBe("welcome");
  });

  test("sign-out returns to the welcome screen and a signed-in launch skips it", () => {
    expect(reduceSignIn("desk", { type: "signed-out" })).toBe("welcome");
    expect(deskEntry(true)).toBe("desk");
    expect(reduceSignIn("desk", { type: "open" })).toBe("welcome");
    expect(readSrc("../src/components/preferences-panel/index.tsx")).toContain("returnToWelcome()");
    expect(readSrc("../src/lib/account-delete.ts")).toContain("returnToWelcome()");
    expect(readSrc("../src/components/command-palette/index.tsx")).toContain("runDeleteAccount(");
  });

  test("the delete confirm is one line, and the 30-day note stays off it", () => {
    const confirm = deleteAccountConfirmText();
    expect(confirm).toBe(DELETE_ACCOUNT_BODY);
    expect(confirm).toBe("This can’t be undone.");
  });

  test("paste fills every box, the 8th typed digit submits, and backspace moves back", () => {
    const pasted = pasteDigits("48-219037 extra");
    expect(pasted.digits.join("")).toBe("48219037");
    expect(pasted.submit).toBe(false);
    const filled = signInMarkup("code", { initialCode: "48219037" });
    for (const digit of "48219037") expect(filled).toContain(`value="${digit}"`);
    const seventh = digitsFrom("4821903");
    expect(typeDigit(seventh, 6, "x").submit).toBe(false);
    expect(typeDigit(seventh, 6, "x").digits[6]).toBe("3");
    const submitted = typeDigit(seventh, 7, "7");
    expect(submitted.submit).toBe(true);
    expect(submitted.digits.join("")).toBe("48219037");
    const cleared = backspaceDigit(digitsFrom("48219037"), 3);
    expect(cleared.digits[3]).toBe("");
    expect(cleared.focus).toBe(3);
    const moved = backspaceDigit(cleared.digits, 3);
    expect(moved.focus).toBe(2);
    expect(moved.digits[2]).toBe("");
    expect(moved.digits[1]).toBe("8");
  });

  test("one second is singular and zero brings the resend button back", () => {
    expect(resendCooldownLine(1)).toBe("You can send a new code in 1 second.");
    expect(resendCooldownLine(1)).not.toContain("seconds");
    expect(resendCooldownLine(2)).toBe("You can send a new code in 2 seconds.");
    expect(resendCooldownLine(0)).toBeNull();
    expect(resendCooldownLine(-1)).toBeNull();
    const waiting = signInMarkup("code", { resendIn: 1 });
    expect(waiting).toContain("You can send a new code in 1 second.");
    expect(waiting).not.toContain(`>${CODE_ENTRY_RESEND}<`);
    const ready = signInMarkup("code", { resendIn: 0 });
    expect(ready).toContain(`>${CODE_ENTRY_RESEND}<`);
    expect(ready).not.toContain("You can send a new code in");
    expect(ready).toContain(CODE_DIFFERENT_EMAIL);
  });

  test("the account menu opens billing and the unfinished label stays hidden", () => {
    expect(ACCOUNT_MENU_ENABLED).toBe(false);
    expect(BILLING_PORTAL_ENABLED).toBe(false);
    expect(manageAccountLabel()).toBeNull();
    expect(MANAGE_ACCOUNT_LABEL).toBe("Manage Account Online");
    expect(MANAGE_ACCOUNT_LABEL).not.toContain("…");
    expect(MANAGE_ACCOUNT_LABEL).not.toContain("...");
    expect(ACCOUNT_MENU_LABEL).toBe("Account…");
    expect(ACCOUNT_MENU_LABEL).not.toContain("...");
    expect(WELCOME_BUTTON).toBe("Email me a code");
    expect(CODE_DIFFERENT_EMAIL).toBe("Use a different email");
    expect(readSrc("../src/lib/account-copy.ts")).not.toMatch(/just write|write only/i);
    const lib = readSrc("../src-tauri/src/lib.rs");
    expect(lib).not.toContain("Manage Account Online");
    expect(lib).toContain("Account…");
    expect(lib).toContain("menu:open-account");
    expect(lib).not.toContain("Install 'writer' Command Line Tool…");
    expect(lib).not.toContain("cli.toggle");
    const copy = readSrc("../src/lib/account-copy.ts");
    expect(copy).not.toContain("COPY:");
    expect(copy).not.toContain("placeholder");
  });

  test("the welcome hint is prompt grey and a typed email stays ink", () => {
    const empty = signInMarkup("welcome", { email: "" });
    expect(empty).toContain('placeholder="you@example.com"');
    expect(empty).toContain('value=""');
    const typed = signInMarkup("welcome", { email: "ada@example.com" });
    expect(typed).toContain('value="ada@example.com"');
    const css = readSrc("../src/components/sign-in-screen.css");
    expect(css).toMatch(/z-index:\s*110/);
    expect(css).toContain("--color-quiet: #6e675f");
    expect(css).toContain("--color-ink: #2c2824");
    expect(css).toMatch(/\.sheet-a \.field\s*\{[^}]*color:\s*var\(--color-ink\)/);
    expect(css).toMatch(/\.field::placeholder\s*\{[^}]*color:\s*var\(--color-quiet\)/);
  });

  test("the focused code box is a thicker ink underline", () => {
    const css = readSrc("../src/components/sign-in-screen.css");
    const start = css.indexOf(".sheet-a .code input:focus-visible");
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toContain("border-bottom: 2px solid var(--color-ink)");
    expect(block).toContain("caret-color: var(--color-ink)");
    expect(block).not.toMatch(/outline\s*:/);
    expect(contrast("#2c2824", "#f4efe6")).toBeGreaterThanOrEqual(3);
  });
});

function contrast(foreground: string, background: string): number {
  const channel = (hex: string, shift: number) => {
    const s = ((Number.parseInt(hex.slice(1), 16) >> shift) & 255) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) =>
    0.2126 * channel(hex, 16) + 0.7152 * channel(hex, 8) + 0.0722 * channel(hex, 0);
  const [lighter, darker] = [lum(foreground), lum(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}
