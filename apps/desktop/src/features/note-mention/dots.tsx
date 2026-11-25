import { useEffect, useState } from "react";
import { subscribeAccountSignIn } from "@/lib/account-sign-in";
import {
  forgetMentionDots,
  refreshMentionDots,
  subscribeMentionDots,
  waitingOnPath,
} from "./dot-state";
import { OPEN_TAG_LABEL } from "./strings";
import "./mention.css";

export { waitingOnPath };

/** Sidebar dots for documents that have an open mention for this account.
 *  Sign-out and sign-in clear them at once, then read them for the new account. */
export function useMentionDots(paths: readonly string[]): void {
  const key = paths.join("\0");
  useEffect(() => {
    const list = key.length === 0 ? [] : key.split("\0");
    let dead = false;
    const tick = () => {
      void refreshMentionDots(list, () => !dead).catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 60_000);
    const unsubscribe = subscribeAccountSignIn((event) => {
      if (event === "open") return;
      forgetMentionDots();
      tick();
    });
    return () => {
      dead = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [key]);
}

export function useOpenTag(path: string): boolean {
  const [on, setOn] = useState(() => waitingOnPath(path));
  useEffect(() => {
    const read = () => setOn(waitingOnPath(path));
    read();
    return subscribeMentionDots(read);
  }, [path]);
  return on;
}

export function OpenTagDot() {
  return (
    <span className="mention-dot" title={OPEN_TAG_LABEL} aria-label={OPEN_TAG_LABEL} role="img" />
  );
}
