import { expect, test } from "vite-plus/test";
import { hostedCopy, liveSyncs, parseShareAccess } from "../src/features/document-share/access";
import { shouldLiveSync } from "../src/features/document-share/live";
import { hostedShareId } from "../src/features/document-removal/copy";
// @ts-expect-error the desk module is JSX and this test file sits outside that project
import { shownShareRole } from "../src/features/document-share/desk";

const SHARE = "33333333-3333-4333-8333-333333333333";

test("share_role is parsed once into an access value", () => {
  expect(
    parseShareAccess({ role: "owner", share_id: SHARE, document_id: "doc", status: "accepted" }),
  ).toEqual({ role: "owner", shareId: SHARE, documentId: "doc", status: "accepted" });
  expect(
    parseShareAccess({ role: "none", share_id: null, document_id: "doc", status: null }),
  ).toEqual({ role: "none", documentId: "doc" });
  // A role or status this build does not know is no access, not a guess.
  expect(
    parseShareAccess({ role: "editor", share_id: SHARE, document_id: "doc", status: "accepted" })
      .role,
  ).toBe("none");
  expect(
    parseShareAccess({ role: "invitee", share_id: SHARE, document_id: "doc", status: "paused" })
      .role,
  ).toBe("none");
  expect(
    parseShareAccess({ role: "invitee", share_id: null, document_id: "doc", status: "accepted" })
      .role,
  ).toBe("none");
  expect(parseShareAccess({ role: "owner", share_id: SHARE, document_id: "doc" }).role).toBe(
    "none",
  );
});

test("live sync covers every status, and a declined or removed invitee stops", () => {
  const access = (role: "owner" | "invitee", status: string) =>
    parseShareAccess({ role, share_id: SHARE, document_id: "doc", status });
  expect(liveSyncs(access("owner", "accepted"))).toBe(true);
  expect(liveSyncs(access("owner", "pending"))).toBe(false);
  expect(liveSyncs(access("invitee", "accepted"))).toBe(true);
  expect(liveSyncs(access("invitee", "pending"))).toBe(true);
  for (const status of ["declined", "removed"]) {
    expect(liveSyncs(access("owner", status))).toBe(false);
    expect(liveSyncs(access("invitee", status))).toBe(false);
    expect(shouldLiveSync({ role: "invitee", share_id: SHARE, status })).toBe(false);
  }
  // The old gate let an owner with no status through.
  expect(shouldLiveSync({ role: "owner", share_id: SHARE, status: null })).toBe(false);
  expect(shouldLiveSync({ role: "none", share_id: null, status: null })).toBe(false);
});

test("one hosted-copy rule, the same as copy_share_id in shares.rs", () => {
  const mac = `/Users/ada/Library/Application Support/app.alkuin/shares/${SHARE}.md`;
  expect(hostedCopy(mac)).toEqual({
    shareId: SHARE,
    dir: "/Users/ada/Library/Application Support/app.alkuin/shares",
    name: `${SHARE}.md`,
  });
  expect(hostedCopy(`/x/shares/${SHARE.toUpperCase()}.md`)?.shareId).toBe(SHARE);
  expect(hostedCopy(`C:\\Users\\ada\\shares\\${SHARE}.md`)?.shareId).toBe(SHARE);
  // live.ts used to take any <uuid>.md. Removal took any 36 hex-or-dash characters.
  expect(hostedCopy(`/notes/${SHARE}.md`)).toBeNull();
  expect(hostedCopy(`/x/shares/${"-".repeat(36)}.md`)).toBeNull();
  expect(hostedCopy(`/x/shares/${SHARE.replace(/-/g, "a")}a.md`)).toBeNull();
  expect(hostedCopy(`/x/Shares/${SHARE}.md`)).toBeNull();
  expect(hostedCopy(`/x/myshares/${SHARE}.md`)).toBeNull();
  expect(hostedCopy(`/x/shares/${SHARE}.txt`)).toBeNull();
  expect(hostedCopy(`${SHARE}.md`)).toBeNull();
  for (const path of [mac, `/notes/${SHARE}.md`, `/x/shares/${"-".repeat(36)}.md`]) {
    expect(hostedShareId(path)).toBe(hostedCopy(path)?.shareId ?? null);
  }
});

test("a collaborator's copy shows the invitee footer until its role is known", () => {
  const copy = `/Users/ada/Library/Application Support/app.alkuin/shares/${SHARE}.md`;
  expect(shownShareRole(copy, null)).toEqual({ role: "invitee", shareId: SHARE });
  expect(shownShareRole("/notes/own.md", null)).toEqual({ role: "none", shareId: null });
  const owner = parseShareAccess({
    role: "owner",
    share_id: SHARE,
    document_id: "doc",
    status: "accepted",
  });
  expect(shownShareRole("/notes/own.md", owner)).toEqual({ role: "owner", shareId: SHARE });
  // Once the server says the copy has no share, the lookup wins.
  expect(shownShareRole(copy, { role: "none", documentId: "doc" })).toEqual({
    role: "none",
    shareId: null,
  });
});
