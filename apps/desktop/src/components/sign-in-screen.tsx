import { useState } from "react";
import {
  CODE_DIFFERENT_EMAIL,
  CODE_ENTRY_RESEND,
  CODE_SEND_FAILED,
  CREATE_ACCOUNT_LABEL,
  CREATE_ACCOUNT_PROMPT,
  EMAIL_PROMPT,
  SIGN_IN_LABEL,
  TO_CREATE_ACCOUNT,
  TO_SIGN_IN,
  WELCOME_BUTTON,
  codeEntryPrompt,
  codeSendFailedParts,
  resendCooldownLine,
} from "@/lib/account-copy";
import {
  CODE_LENGTH,
  backspaceDigit,
  digitsFrom,
  joinCode,
  pasteDigits,
  typeDigit,
  type CodeChange,
  type CodeDigits,
} from "@/lib/sign-in-code";
import { AGE_BLOCKED, AGE_LABEL, AGE_STEP_PROMPT, type AgeState } from "@/lib/age-gate";
import type { SignInDoor } from "@/lib/account-gate";
import { AgreeLine } from "@/lib/legal-links";
import "./sign-in-screen.css";

export function SignInScreen({
  step,
  door = "sign-in",
  onDoor = () => {},
  onRegister = () => {},
  age = "ok",
  birthDate = "",
  onBirthDate = () => {},
  email,
  error,
  busy,
  resendIn,
  initialCode = "",
  onEmail,
  onContinue,
  onResend,
  onDifferentEmail,
  onSubmitCode,
  onSubmitAge = () => {},
}: {
  /** `age`: the code matched an address with no account, so the date of birth is asked. */
  step: "welcome" | "code" | "age";
  /** Which form the welcome step shows: Sign in, or Create account with the date of birth. */
  door?: SignInDoor;
  onDoor?: (door: SignInDoor) => void;
  /** Create account's submit: the email and the date of birth. */
  onRegister?: () => void;
  /** "blocked": this device answered under age within the day, so Create account and the date step refuse at once. */
  age?: AgeState;
  birthDate?: string;
  onBirthDate?: (value: string) => void;
  email: string;
  error: string | null;
  busy: boolean;
  resendIn: number;
  initialCode?: string;
  onEmail: (value: string) => void;
  onContinue: () => void;
  onResend: () => void;
  onDifferentEmail: () => void;
  onSubmitCode: (code: string) => void;
  onSubmitAge?: () => void;
}) {
  const [digits, setDigits] = useState<CodeDigits>(() => digitsFrom(initialCode));
  const [focus, setFocus] = useState(0);
  const cooldown = resendCooldownLine(resendIn);

  function apply(change: CodeChange) {
    setDigits(change.digits);
    setFocus(change.focus);
    if (change.submit) onSubmitCode(joinCode(change.digits));
  }

  return (
    <div className="sheet-a">
      <main className="island">
        <h1 className="name">
          <img src="/brand/alkuin-wordmark.svg" alt="Alkuin" width={280} height={91} />
        </h1>
        {step === "age" && age === "blocked" ? (
          <>
            <p className="prompt" role="alert">
              {AGE_BLOCKED}
            </p>
            <button className="quiet" type="button" onClick={onDifferentEmail} disabled={busy}>
              {CODE_DIFFERENT_EMAIL}
            </button>
          </>
        ) : step === "age" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitAge();
            }}
          >
            <label className="prompt" htmlFor="sign-in-birth">
              {AGE_STEP_PROMPT}
            </label>
            <input
              id="sign-in-birth"
              className="field"
              type="date"
              autoComplete="bday"
              aria-label={AGE_LABEL}
              autoFocus
              value={birthDate}
              disabled={busy}
              onChange={(event) => onBirthDate(event.target.value)}
            />
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="action" type="submit" disabled={busy}>
              {SIGN_IN_LABEL}
            </button>
            <button className="quiet" type="button" onClick={onDifferentEmail} disabled={busy}>
              {CODE_DIFFERENT_EMAIL}
            </button>
          </form>
        ) : step === "welcome" && door === "create" && age === "blocked" ? (
          <>
            <p className="prompt" role="alert">
              {AGE_BLOCKED}
            </p>
            <button
              className="quiet"
              type="button"
              onClick={() => onDoor("sign-in")}
              disabled={busy}
            >
              {TO_SIGN_IN}
            </button>
          </>
        ) : step === "welcome" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (door === "create") onRegister();
              else onContinue();
            }}
          >
            {error === CODE_SEND_FAILED ? (
              <p className="prompt" role="alert">
                <CodeSendFailedLine />
              </p>
            ) : (
              <label className="prompt" htmlFor="sign-in-email">
                {door === "create" ? CREATE_ACCOUNT_PROMPT : EMAIL_PROMPT}
              </label>
            )}
            <input
              id="sign-in-email"
              className="field"
              type="email"
              autoComplete="email"
              inputMode="email"
              aria-label="Email"
              placeholder="you@example.com"
              value={email}
              disabled={busy}
              onChange={(event) => onEmail(event.target.value)}
            />
            {door === "create" ? (
              <>
                <label className="prompt follow" htmlFor="sign-in-birth">
                  {AGE_LABEL}
                </label>
                <input
                  id="sign-in-birth"
                  className="field"
                  type="date"
                  autoComplete="bday"
                  value={birthDate}
                  disabled={busy}
                  onChange={(event) => onBirthDate(event.target.value)}
                />
              </>
            ) : null}
            {error && error !== CODE_SEND_FAILED ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="action" type="submit" disabled={busy}>
              {door === "create" ? CREATE_ACCOUNT_LABEL : WELCOME_BUTTON}
            </button>
            <button
              className="quiet"
              type="button"
              onClick={() => onDoor(door === "create" ? "sign-in" : "create")}
              disabled={busy}
            >
              {door === "create" ? TO_SIGN_IN : TO_CREATE_ACCOUNT}
            </button>
            <p className="legal">
              <AgreeLine
                action={door === "create" ? CREATE_ACCOUNT_LABEL : WELCOME_BUTTON}
                linkClassName="legal-link"
              />
            </p>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitCode(joinCode(digits));
            }}
          >
            <p className="prompt">{codeEntryPrompt(email)}</p>
            <div className="code" role="group" aria-label="Code">
              {digits.map((digit, index) => (
                <input
                  key={index}
                  aria-label={`Digit ${index + 1} of ${CODE_LENGTH}`}
                  inputMode="numeric"
                  autoComplete={index === 0 ? "one-time-code" : "off"}
                  maxLength={1}
                  value={digit}
                  disabled={busy}
                  autoFocus={index === 0}
                  ref={(el) => {
                    if (el && index === focus) el.focus();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Backspace") return;
                    event.preventDefault();
                    apply(backspaceDigit(digits, index));
                  }}
                  onPaste={(event) => {
                    event.preventDefault();
                    apply(pasteDigits(event.clipboardData.getData("text")));
                  }}
                  onChange={(event) => {
                    const value = event.target.value.replace(/\D/g, "");
                    if (value.length > 1) {
                      apply(pasteDigits(value));
                      return;
                    }
                    if (value.length === 1) apply(typeDigit(digits, index, value));
                  }}
                />
              ))}
            </div>
            {error === CODE_SEND_FAILED ? (
              <p className="error" role="alert">
                <CodeSendFailedLine />
              </p>
            ) : error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="action" type="submit" disabled={busy}>
              {SIGN_IN_LABEL}
            </button>
            {cooldown ? (
              <p className="cooldown">{cooldown}</p>
            ) : (
              <button className="quiet" type="button" onClick={onResend} disabled={busy}>
                {CODE_ENTRY_RESEND}
              </button>
            )}
            <button className="quiet" type="button" onClick={onDifferentEmail} disabled={busy}>
              {CODE_DIFFERENT_EMAIL}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}

function CodeSendFailedLine() {
  const line = codeSendFailedParts();
  return (
    <>
      {line.before}
      <a href={line.href}>{line.email}</a>
      {line.after}
    </>
  );
}
