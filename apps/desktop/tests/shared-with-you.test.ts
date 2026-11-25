import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import {
  SHARED_EMPTY,
  SHARED_EMPTY_NEXT,
  SHARED_WITH_YOU,
  WAITING,
  waitingCount,
} from "../src/features/shared-with-you/copy";
// @ts-expect-error the desk module is JSX and this test file sits outside that project
import { SharedWithYou } from "../src/features/shared-with-you/desk";
import { collectMarkdownPaths, showsDot } from "../src/features/shared-with-you/marks";

describe("shared with you", () => {
  test("uses Copy's header, empty lines, and waiting labels", () => {
    expect(SHARED_WITH_YOU).toBe("Shared with you");
    expect(SHARED_EMPTY).toBe("Nothing shared with you yet.");
    expect(SHARED_EMPTY_NEXT).toBe("When someone invites you to a document, it shows up here.");
    expect(WAITING).toBe("Waiting for your answer");
    expect(waitingCount(1)).toBe("1 waiting for your answer");
    expect(waitingCount(3)).toBe("3 waiting for your answer");
  });

  test("a dot is an open mention and zero is none", () => {
    expect(showsDot(0)).toBe(false);
    expect(showsDot(1)).toBe(true);
    expect(showsDot(4)).toBe(true);
  });

  test("collects markdown paths the sidebar already loaded", () => {
    const cache = new Map([
      [
        "/notes",
        [
          {
            name: "Harbor.md",
            path: "/notes/Harbor.md",
            is_dir: false,
            is_markdown: true,
            modified_at: 0,
            created_at: 0,
            title: "Harbor",
          },
          {
            name: "pics",
            path: "/notes/pics",
            is_dir: true,
            is_markdown: false,
            modified_at: 0,
            created_at: 0,
            title: null,
          },
        ],
      ],
    ]);
    expect(collectMarkdownPaths(cache, ["/notes/Harbor.md", "/pinned/Tide.md"])).toEqual([
      "/notes/Harbor.md",
      "/pinned/Tide.md",
    ]);
  });

  test("a removed row and an open share both offer Remove", () => {
    const html = renderToStaticMarkup(
      createElement(SharedWithYou, {
        rows: [
          { id: "live", title: "Still shared", owner: "Ada", open: 0 },
          { id: "dead", title: "this is a test", owner: "Ada", open: 0, removed: true },
          { id: "wait", title: "Invite", owner: "Ada", open: 0, pending: true },
        ],
        restore: [],
        count: 0,
        onOpen: () => {},
        onAnswer: () => {},
        onLeave: () => {},
        onRestore: () => {},
      }),
    );
    const labels = [
      ...html.matchAll(/<button[^>]*class="shared-action"[^>]*>([\s\S]*?)<\/button>/g),
    ].map((hit) => hit[1].trim());
    expect(html).toContain("Removed by the owner.");
    expect(labels.filter((label) => label === "Remove")).toHaveLength(2);
    expect(labels).toEqual(expect.arrayContaining(["Accept", "Decline"]));
    const tombstoneAt = html.indexOf("this is a test");
    const buttonAfter = html.indexOf("<button", tombstoneAt);
    expect(html.slice(tombstoneAt, buttonAfter)).not.toContain("<button");
    expect(html.slice(buttonAfter, html.indexOf("</button>", buttonAfter))).toContain("Remove");
  });
});
