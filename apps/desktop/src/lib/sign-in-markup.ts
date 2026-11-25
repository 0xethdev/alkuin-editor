import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignInScreen } from "@/components/sign-in-screen";

const noop = () => {};

/** Static markup for the sign-in steps. Tests read this without a DOM. */
export function signInMarkup(
  step: "welcome" | "code",
  options?: { error?: string | null; resendIn?: number; email?: string; initialCode?: string },
): string {
  return renderToStaticMarkup(
    createElement(SignInScreen, {
      step,
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
