import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  ACCEPT,
  REJECT,
  SEND_CHANGES,
  VISIBLE_COPY,
  fixtureHolds,
} from "../src/features/invite-preview/copy";
import { ACCEPT_LABEL, REJECT_LABEL } from "../src/lib/history/steps";

const root = new URL("../src/features/invite-preview/", import.meta.url);
const entry = readFileSync(new URL("entry.tsx", root), "utf8");
const preview = readFileSync(new URL("preview.tsx", root), "utf8");
const css = readFileSync(new URL("preview.css", root), "utf8");
const html = readFileSync(new URL("../invite-preview.html", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const tauri = readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8");

const GIT_WORDING =
  /\bgit\b|github|dirty|diff --git|\bcommit\b|\bbranch\b|\bmerge\b|\bpull\b|\bpush\b|\bconflict\b|\bremote\b|\brepository\b/i;

describe("invite preview", () => {
  test("the fixture holds together", () => {
    expect(fixtureHolds()).toBe(true);
    expect(SEND_CHANGES).toBe("Send changes");
    expect(ACCEPT).toBe(ACCEPT_LABEL);
    expect(REJECT).toBe(REJECT_LABEL);
  });

  test("the preview stays off unless this is a development build", () => {
    expect(entry).toContain("import.meta.env.DEV");
    expect(entry).toContain('dataset.invitePreview = "off"');
    expect(html).toContain("/src/features/invite-preview/entry.tsx");
    expect(indexHtml).not.toContain("invite-preview");
    expect(tauri).not.toContain("invite-preview");
  });

  test("the preview copy has no git words", () => {
    for (const line of VISIBLE_COPY) expect(line).not.toMatch(GIT_WORDING);
    for (const file of [preview, css, html, entry]) expect(file).not.toMatch(GIT_WORDING);
  });
});
