import { useEffect, useRef, useState } from "react";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { subscribeAccountSignIn } from "@/lib/account-sign-in";
import { InvitePopover } from "./invite-popover";
import "./share.css";
import { INVITE_FOOTER, inviteFailureNotice, SHARE_INVITE_DONE } from "./copy";
import * as tauri from "@/lib/tauri";
import { hostedCopy, parseShareAccess, type ShareAccess } from "./access";

function titleOf(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? path;
  return name.replace(/\.md$/i, "") || "Document";
}

/**
 * The invite sheet for one document. The footer keys it by path, so the
 * sheet, the typed email, and an invite on its way belong to that document
 * only. One invite is in flight at a time, and Send waits for it.
 */
export function InviteControl({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const send = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    const to = email;
    void tauri
      .shareInvite(path, to)
      .then(
        () => {
          showEditorNotice(SHARE_INVITE_DONE);
          setOpen(false);
        },
        (error: unknown) => {
          const raw = error instanceof Error ? error.message : String(error);
          showEditorNotice(inviteFailureNotice(raw), { sticky: true });
        },
      )
      .finally(() => {
        inFlight.current = false;
        setSending(false);
      });
  };
  return (
    <span className="relative text-[var(--fg-base)]">
      <button
        type="button"
        data-invite
        className="invite-footer"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {INVITE_FOOTER}
      </button>
      {open ? (
        <InvitePopover
          title={titleOf(path)}
          email={email}
          onEmail={setEmail}
          onSend={send}
          sending={sending}
        />
      ) : null}
    </span>
  );
}

/**
 * The role the footer shows for `path`. `access` is this path's lookup, or
 * null while it is loading or when it failed. A collaborator's copy
 * (`shares/<id>.md`) is the invitee's until the lookup says otherwise, so
 * the owner's controls never flash on it.
 */
export function shownShareRole(
  path: string,
  access: ShareAccess | null,
): { role: ShareAccess["role"]; shareId: string | null } {
  if (!access) {
    const copy = hostedCopy(path);
    return copy ? { role: "invitee", shareId: copy.shareId } : { role: "none", shareId: null };
  }
  if (access.role === "none") return { role: "none", shareId: null };
  return { role: access.role, shareId: access.shareId };
}

/**
 * The share access for `path`. A result for another path is never returned,
 * so a tab switch shows the fallback until this path's lookup lands.
 */
export function useShareRole(path: string): { role: ShareAccess["role"]; shareId: string | null } {
  const [loaded, setLoaded] = useState<{ path: string; access: ShareAccess | null } | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => {
      void tauri.shareRole(path).then(
        (raw) => {
          if (!dead) setLoaded({ path, access: parseShareAccess(raw) });
        },
        () => {
          if (!dead) setLoaded({ path, access: null });
        },
      );
    };
    load();
    const unsubscribe = subscribeAccountSignIn((event) => {
      if (event === "open" || dead) return;
      load();
    });
    return () => {
      dead = true;
      unsubscribe();
    };
  }, [path]);
  return shownShareRole(path, loaded?.path === path ? loaded.access : null);
}
