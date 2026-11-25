import { describe, expect, test } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { marginNoteVisible } from "../src/features/redline-spike/gutter";
import { emptyGitStatus } from "../src/features/redline-spike/model";
import {
  EMPTY_DESK_LINE,
  OTHER_EDITS_LINE,
  SAVED_LINE,
  SHARE_CHANGES_LABEL,
  otherEditsLine,
  shareChangesOffered,
  shareFailureLine,
} from "../src/features/redline-spike/margin-copy";

const GUTTER = readFileSync(
  new URL("../src/features/redline-spike/gutter.ts", import.meta.url),
  "utf8",
);

const GIT_WORDING = /\bgit\b|dirty|github|diff --git|publish to github/i;

describe("accepted margin card", () => {
  test("saved and share copy does not use git wording", () => {
    expect(SAVED_LINE).toBe("Saved");
    expect(EMPTY_DESK_LINE).toBe(
      "Add a folder with your drafts, essays and notes. Alkuin works with Markdown (.md) files.",
    );
    expect(SHARE_CHANGES_LABEL).toBe("Share changes");
    expect(GIT_WORDING.test(SAVED_LINE)).toBe(false);
    expect(GIT_WORDING.test(SHARE_CHANGES_LABEL)).toBe(false);
    expect(GIT_WORDING.test(OTHER_EDITS_LINE)).toBe(false);
    expect(OTHER_EDITS_LINE).toBe("Someone else's edits didn't fit. Your words are still here.");
    expect(OTHER_EDITS_LINE).not.toMatch(/merge|fetch|pull|conflict|branch|commit|remote|github/i);
  });

  test("ask status lines stay free of git words", async () => {
    const copy = await import("../src/features/redline-spike/margin-copy");
    expect(copy.PAUSED_LINE).toBe(
      "Writing help is paused for now. Your document is unchanged, and you can keep writing. Try again later.",
    );
    expect(copy.ASK_REFUSED_LINE).toBe(
      "Alkuin ran this ask but couldn't finish a suggestion. Your text is unchanged.",
    );
    expect(copy.CITATIONS_LINE).toBe("Help finding sources comes with Alkuin.");
    expect(copy.PLAN_FREE).toBe("Free");
    expect(copy.PLAN_REDLINE).toBe("Alkuin");
    expect(copy.HARD_CAP_LINE).toBe("You've used this month's writing help.");
    expect(copy.GROUP_HOUSE).toBe("House style");
    expect(copy.GROUP_POLISH).toBe("Editing");
    expect(copy.GROUP_CITE).toBe("Sources");
    for (const line of [
      copy.PAUSED_LINE,
      copy.ASK_REFUSED_LINE,
      copy.CITATIONS_LINE,
      copy.HARD_CAP_LINE,
      copy.FREE_SLICE_LINE,
      copy.FREE_MONTH_LINE,
      copy.PAID_CAP_LINE,
      copy.SEE_PLANS_LABEL,
    ]) {
      expect(line).not.toMatch(/\bgit\b|github|commit|branch/i);
    }
  });

  test("the gutter source does not print git, dirty, a diff, or Publish to GitHub", () => {
    expect(GUTTER).not.toContain("Publish to GitHub");
    expect(GUTTER).not.toContain("git: dirty");
    expect(GUTTER).not.toContain("git: clean");
    expect(GUTTER).not.toContain("diff --git");
    expect(GUTTER).not.toContain("cm-redline-git");
    expect(GUTTER).not.toContain("OTHER_EDITS_LINE");
    expect(GUTTER).not.toContain("SAVED_LINE");
    expect(GUTTER).toContain("marginNoteVisible");
    expect(GUTTER).toContain("SHARE_CHANGES_LABEL");
    expect(GUTTER).toContain("note.git?.sharing");
  });

  test("an accepted note stays out of the margin unless share is offered", () => {
    expect(marginNoteVisible({ status: "accepted", git: null })).toBe(false);
    expect(
      marginNoteVisible({ status: "accepted", git: { ...emptyGitStatus(), sharing: true } }),
    ).toBe(false);
    expect(marginNoteVisible({ status: "pending", git: null })).toBe(true);
  });

  test("reply stays shut until Reply, and Done removes the note", () => {
    const desk = readFileSync(
      new URL("../src/features/note-mention/desk.ts", import.meta.url),
      "utf8",
    );
    expect(desk).toContain("replyField.hidden = true");
    expect(desk).toContain("removeRedlineNote.of(note.id)");
    expect(desk).toContain('className = "mention-reply"');
    expect(desk).not.toContain("dataset.mentionDone");
  });

  test("share stays hidden until invites exist", () => {
    expect(shareChangesOffered(true)).toBe(false);
    expect(shareChangesOffered(false)).toBe(false);
    expect(shareFailureLine()).toBeNull();
    expect(otherEditsLine()).toBeNull();
    expect(GUTTER).toContain("shareChangesOffered(note.git?.sharing)");
  });
});
