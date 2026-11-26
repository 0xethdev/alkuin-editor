/** `age`: the code matched an address with no account, and the date of birth is asked. */
export type SignInStep = "welcome" | "code" | "age" | "desk";

/** The welcome screen's two doors: Sign in (email, then code) and Create account (email and date of birth, then code). */
export type SignInDoor = "sign-in" | "create";

export type SignInEvent =
  | { type: "code-sent" }
  | { type: "different-email" }
  /** The code matched an address with no account: the sign-in is held for the date of birth. */
  | { type: "age-check" }
  | { type: "signed-in" }
  | { type: "signed-out" }
  | { type: "open" };

/** Auth waits 60 seconds before another code to the same address. */
export const RESEND_WAIT_SECONDS = 60;

export function reduceSignIn(step: SignInStep, event: SignInEvent): SignInStep {
  switch (event.type) {
    case "signed-in":
      return "desk";
    case "code-sent":
      return "code";
    case "age-check":
      return "age";
    case "different-email":
    case "signed-out":
      return "welcome";
    case "open":
      return step === "desk" ? "welcome" : step;
    default:
      return step;
  }
}

/** No session shows the welcome screen. A session skips it. */
export function deskEntry(signedIn: boolean): SignInStep {
  return signedIn ? "desk" : "welcome";
}

/** The desk mounts only for a session that has finished sign-in. */
export function editorUnlocked(signedIn: boolean, step: SignInStep): boolean {
  return signedIn && step === "desk";
}

export type DeskArrival = {
  step: SignInStep;
  signedIn: boolean;
  offline: boolean;
  email: string | null;
};

type SessionSnapshot = { signed_in: boolean; email?: string | null };

/** A stored session opens the desk before Auth answers. No session stays on welcome.
 *  A keychain that cannot be read is no session: the gate never stays blank. */
export async function enterFromStoredSession(
  readStored: () => Promise<SessionSnapshot>,
  confirm: () => Promise<SessionSnapshot>,
  apply: (entry: DeskArrival) => void,
): Promise<void> {
  let stored: SessionSnapshot;
  try {
    stored = await readStored();
  } catch (error) {
    console.error("[account] Failed to read the stored session", error);
    apply({ step: "welcome", signedIn: false, offline: false, email: null });
    return;
  }
  const email = stored.email?.trim() ? stored.email : null;
  apply({
    step: deskEntry(stored.signed_in),
    signedIn: stored.signed_in,
    offline: false,
    email,
  });
  if (!stored.signed_in) return;
  await confirmStoredSession(confirm, email, apply);
}

/** Ask Auth about the stored session. An answer opens the desk online or returns to
 *  welcome. No answer keeps the desk, offline. The offline desk asks again later. */
export async function confirmStoredSession(
  confirm: () => Promise<SessionSnapshot>,
  email: string | null,
  apply: (entry: DeskArrival) => void,
): Promise<void> {
  try {
    const status = await confirm();
    const nextEmail = status.email?.trim() ? status.email : email;
    apply({
      step: status.signed_in ? "desk" : "welcome",
      signedIn: status.signed_in,
      offline: false,
      email: nextEmail,
    });
  } catch {
    apply({ step: "desk", signedIn: true, offline: true, email });
  }
}

/** One status check at a time for an offline desk. Online or signed-out desks skip it.
 *  `apply` is per call so the caller can drop an answer that a sign-out outran. */
export function offlineRecheck(
  confirm: () => Promise<SessionSnapshot>,
  isOffline: () => boolean,
): (apply: (entry: DeskArrival) => void) => Promise<void> {
  let checking: Promise<void> | null = null;
  return (apply) => {
    if (checking) return checking;
    if (!isOffline()) return Promise.resolve();
    checking = confirmStoredSession(confirm, null, apply).finally(() => {
      checking = null;
    });
    return checking;
  };
}
