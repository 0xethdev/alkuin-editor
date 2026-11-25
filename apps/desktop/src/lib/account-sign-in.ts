import { writingSignedIn } from "@/lib/account-session";

type AccountEvent = "open" | "signed-out" | "signed-in";
type Listener = (event: AccountEvent) => void;

const listeners = new Set<Listener>();

function emit(event: AccountEvent) {
  for (const listener of listeners) listener(event);
}

/** Signed-out Sign in opens the welcome screen. A live session stays on the desk. */
export function openAccountSignIn() {
  if (writingSignedIn()) return;
  emit("open");
}

/** Sign-out and a finished delete return to the welcome screen. */
export function returnToWelcome() {
  emit("signed-out");
}

/** A finished sign-in. Open tabs reload share roles and margin notes. */
export function noteAccountSignedIn() {
  emit("signed-in");
}

export function subscribeAccountSignIn(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
