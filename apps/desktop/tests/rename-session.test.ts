import { describe, expect, test } from "vite-plus/test";
import { endRename, startRenameSession } from "../src/components/sidebar/rename-session";

describe("inline rename session", () => {
  test("Enter submits once; the blur fired when the input unmounts is ignored", () => {
    const session = startRenameSession();
    expect(endRename(session, { kind: "submit", value: "next" })).toEqual({
      kind: "submit",
      value: "next",
    });
    expect(endRename(session, { kind: "submit", value: "next" })).toBeNull();
  });

  test("Escape cancels, and a later blur can't commit the edited name", () => {
    const session = startRenameSession();
    expect(endRename(session, { kind: "cancel" })).toEqual({ kind: "cancel" });
    expect(endRename(session, { kind: "submit", value: "typed" })).toBeNull();
  });

  test("a new session starts fresh", () => {
    const first = startRenameSession();
    endRename(first, { kind: "cancel" });
    const second = startRenameSession();
    expect(endRename(second, { kind: "submit", value: "x" })).toEqual({
      kind: "submit",
      value: "x",
    });
  });
});
