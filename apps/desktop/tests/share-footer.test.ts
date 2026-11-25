import { readFileSync } from "node:fs";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
// @ts-expect-error the popover is JSX and this test file sits outside that project
import { InvitePopover } from "../src/features/document-share/invite-popover";

const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

test("Send waits while an invite is on its way", () => {
  const props = { title: "Harbor", email: "ada@example.com", onSend: () => {} };
  const idle = renderToStaticMarkup(createElement(InvitePopover, props));
  const busy = renderToStaticMarkup(createElement(InvitePopover, { ...props, sending: true }));
  const button = (html: string) => html.slice(html.indexOf('<button type="button"'));
  expect(button(idle)).not.toContain("disabled");
  expect(button(busy)).toContain('disabled=""');
  expect(button(busy)).toContain('aria-busy="true"');
  expect(busy).toContain("readOnly");
});

test("the footer and the invite sheet are one instance per document", async () => {
  // @ts-expect-error the view registry is JSX and this test file sits outside that project
  const { pageKindView } = await import("../src/components/editor-area/page-kinds/views");
  const location = { kind: "file", path: "/notes/harbor.md" } as const;
  const footer = pageKindView(location).renderFooter?.(location);
  expect(isValidElement(footer)).toBe(true);
  expect((footer as { key: string | null }).key).toBe("/notes/harbor.md");
  const source = read("components/editor-area/document-footer.tsx");
  expect(source).toContain("<InviteControl key={filePath} path={filePath} />");
  // A keep-switch result for another path is dropped, and the switch waits for this path's value.
  expect(source).toContain("state.path === filePath ? state");
  expect(source.match(/if \(shown\.current !== path\) return;/g)).toHaveLength(2);
  expect(source).toContain('if (current.phase !== "ready") return;');
  const desk = read("features/document-share/desk.tsx");
  expect(desk).toContain("if (inFlight.current) return;");
  expect(desk).toContain("sending={sending}");
});
