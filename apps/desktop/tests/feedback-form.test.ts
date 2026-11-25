import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { SUPPORT_EMAIL } from "../src/lib/account-copy";
import {
  FEEDBACK_KINDS,
  FEEDBACK_NOTE_MAX,
  feedbackMailto,
  feedbackNotice,
  submitFeedback,
} from "../src/components/preferences-panel/feedback";

function mailtoParts(url: string): { subject: string; body: string; keys: string[] } {
  const parsed = new URL(url);
  expect(parsed.protocol).toBe("mailto:");
  expect(parsed.pathname).toBe(SUPPORT_EMAIL);
  return {
    subject: parsed.searchParams.get("subject") ?? "",
    body: parsed.searchParams.get("body") ?? "",
    keys: [...parsed.searchParams.keys()],
  };
}

describe("feedback form", () => {
  test("an empty note is blocked and does not open mail", async () => {
    const opened: string[] = [];
    for (const note of ["", "   ", "\n\t", " ".repeat(FEEDBACK_NOTE_MAX + 10)]) {
      const result = await submitFeedback({ kind: "bug", note }, async (url) => {
        opened.push(url);
      });
      expect(result).toEqual({ state: "empty" });
      expect(feedbackNotice(result)).toBe("Write a note first.");
      expect(feedbackMailto({ kind: "bug", note })).toBeNull();
    }
    expect(opened).toEqual([]);
  });

  test("a note past the limit is blocked", async () => {
    const note = "a".repeat(FEEDBACK_NOTE_MAX + 1);
    let opened = false;
    const result = await submitFeedback({ kind: "feature", note }, async () => {
      opened = true;
    });
    expect(result).toEqual({ state: "too_long" });
    expect(feedbackNotice(result)).toBe("Keep the note under 1,500 characters.");
    expect(opened).toBe(false);
    const exact = await submitFeedback(
      { kind: "feature", note: "b".repeat(FEEDBACK_NOTE_MAX) },
      async () => undefined,
    );
    expect(exact).toEqual({ state: "opened" });
  });

  test("a feature note is a support draft, and a bug uses the other subject", async () => {
    let url = "";
    const result = await submitFeedback(
      {
        kind: "feature",
        note: "  Darker paper &\nsecond? #line  ",
        email: "ada@example.com\nBcc: evil@example.com",
        build: "Version 0.7.2 (c371ac0) · 2026-10-24",
      },
      async (next) => {
        url = next;
      },
    );
    expect(result).toEqual({ state: "opened" });
    expect(feedbackNotice(result)).toBe("Opened in your mail app. Send it from there.");
    const feature = mailtoParts(url);
    expect(feature.keys).toEqual(["subject", "body"]);
    expect(feature.subject).toBe("Request a feature");
    expect(feature.body).toBe(
      "Darker paper &\nsecond? #line\n\nFrom: ada@example.com Bcc: evil@example.com\nVersion 0.7.2 (c371ac0) · 2026-10-24",
    );

    let bug = "";
    await submitFeedback({ kind: "bug", note: "The tab stayed." }, async (next) => {
      bug = next;
    });
    expect(mailtoParts(bug).subject).toBe("Report a bug");
    expect(mailtoParts(bug).body).toBe("The tab stayed.");
  });

  test("a mail app that does not open is shown as a failure", async () => {
    const result = await submitFeedback({ kind: "bug", note: "Prefs crashed." }, async () => {
      throw new Error("no handler");
    });
    expect(result.state).toBe("failed");
    if (result.state !== "failed") return;
    expect(result.url.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    expect(feedbackNotice(result)).toBe(`Couldn't open your mail app. Write to ${SUPPORT_EMAIL}.`);
    expect(mailtoParts(result.url).body).toBe("Prefs crashed.");
  });

  test("a bare Version stamp and a blank email stay out of the draft", () => {
    const url = feedbackMailto({
      kind: "bug",
      note: "Hello",
      email: "  ",
      build: "Version",
    });
    expect(url).not.toBeNull();
    if (!url) return;
    expect(mailtoParts(url).body).toBe("Hello");
  });

  test("Preferences shows both kinds for any account", () => {
    expect(FEEDBACK_KINDS.map((item) => item.label)).toEqual(["Request a feature", "Report a bug"]);
    const panel = readFileSync(
      new URL("../src/components/preferences-panel/index.tsx", import.meta.url),
      "utf8",
    );
    const form = readFileSync(
      new URL("../src/components/preferences-panel/feedback-form.tsx", import.meta.url),
      "utf8",
    );
    expect(panel).toContain("<FeedbackForm email={snapshot.email} />");
    expect(form).toContain("FEEDBACK_KINDS");
    expect(form).toContain("submitFeedback");
    const feedbackAt = panel.indexOf("<FeedbackForm");
    expect(panel).not.toContain(">Dark<");
    expect(feedbackAt).toBeGreaterThan(panel.indexOf(">Account<"));
    expect(feedbackAt).toBeGreaterThan(panel.indexOf("{STYLE_HEADING}"));
    expect(panel.indexOf("<MentionEmailSwitch")).toBeGreaterThan(feedbackAt);
  });
});
