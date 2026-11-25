import { useEffect, useRef, useState } from "react";
import * as tauri from "@/lib/tauri";
import { mentionEmailControl, type MentionEmailControl } from "./preference-state";
import { PREFERENCE_MENTION_EMAIL } from "./strings";

/** On by default. One switch covers mention, reply, and suggested-wording mail.
 *  A flip made before the first read lands is not overwritten by it. */
export function MentionEmailSwitch({ signedIn }: { signedIn: boolean }) {
  const [on, setOn] = useState(true);
  const control = useRef<MentionEmailControl | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    const mine = mentionEmailControl(setOn, (next) => tauri.mentionEmailPref(next));
    control.current = mine;
    void tauri
      .mentionEmailPref()
      .then((value) => mine.loaded(value))
      .catch(() => undefined);
    return () => {
      mine.close();
      if (control.current === mine) control.current = null;
    };
  }, [signedIn]);
  if (!signedIn) return null;
  return (
    <div className="mt-4">
      <label
        className="text-[13px] text-[var(--text-primary)]"
        style={{ display: "inline-flex", alignItems: "center", margin: 0, gap: 8 }}
      >
        <input
          type="checkbox"
          checked={on}
          style={{ margin: 0 }}
          onChange={(event) => {
            control.current?.toggle(event.target.checked);
          }}
        />
        <span>{PREFERENCE_MENTION_EMAIL}</span>
      </label>
    </div>
  );
}
