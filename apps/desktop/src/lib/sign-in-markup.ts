import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignInScreen } from "@/components/sign-in-screen";
import type { SignInDoor } from "@/lib/account-gate";
import type { AgeState } from "@/lib/age-gate";

const noop = () => {};

/** Static markup for the sign-in steps. Tests read this without a DOM. */
export function signInMarkup(
  step: "welcome" | "code",
  options?: {
    error?: string | null;
    resendIn?: number;
    email?: string;
    initialCode?: string;
    door?: SignInDoor;
    age?: AgeState;
  },
): string {
  return renderToStaticMarkup(
    createElement(SignInScreen, {
      step,
      door: options?.door,
      age: options?.age,
      email: options?.email ?? "you@example.com",
      error: options?.error ?? null,
      busy: false,
      resendIn: options?.resendIn ?? 0,
      initialCode: options?.initialCode,
      onEmail: noop,
      onContinue: noop,
      onResend: noop,
      onDifferentEmail: noop,
      onSubmitCode: noop,
    }),
  );
}
