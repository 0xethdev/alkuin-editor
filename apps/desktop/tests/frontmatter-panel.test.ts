import { describe, expect, test, vi } from "vite-plus/test";

// The panel reads its block through this hook. Static rendering can't see a
// zustand store's live state, so the test stands in for the hook.
let storedFrontmatter: string | null = null;
vi.mock("@/hooks/use-frontmatter", () => ({
  useFrontmatter: () => ({
    frontmatter: storedFrontmatter ?? "",
    hasFrontmatter: storedFrontmatter !== null,
    updateFrontmatter: vi.fn(),
    removeFrontmatter: vi.fn(),
  }),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addFrontmatterRow,
  blurFrontmatterRow,
  blurFrontmatterText,
  deleteFrontmatterRow,
  editFrontmatterRow,
  editFrontmatterText,
  frontmatterPanelFromStore,
  isPendingKey,
  type FrontmatterPanelState,
} from "../src/components/editor-area/frontmatter-panel-state";
// @ts-expect-error the panel module is JSX and this test file sits outside that project
import { FrontmatterPanel } from "../src/components/editor-area/frontmatter-panel";

function rowsOf(panel: FrontmatterPanelState) {
  if (panel.mode !== "entries") throw new Error(`expected entries, got ${panel.mode}`);
  return panel.rows;
}

const MALFORMED = "title: [unclosed\nauthor: Jane";
const COMMENT_ONLY = "# draft notes, keep\n# tags: later";

describe("frontmatter panel modes", () => {
  test("no block is absent", () => {
    expect(frontmatterPanelFromStore(null)).toEqual({ mode: "absent" });
  });

  test("malformed YAML is unparsed and keeps its text, with no empty-key row", () => {
    expect(frontmatterPanelFromStore(MALFORMED)).toEqual({ mode: "unparsed", text: MALFORMED });
  });

  test("comment-only, list and scalar blocks are unparsed, not a seeded placeholder", () => {
    for (const yaml of [COMMENT_ONLY, "- a\n- b", "just words"]) {
      expect(frontmatterPanelFromStore(yaml)).toEqual({ mode: "unparsed", text: yaml });
    }
  });

  test("a blank block seeds one placeholder that does not focus itself", () => {
    const rows = rowsOf(frontmatterPanelFromStore(""));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "", value: "", autoFocus: false });
  });

  test("rows parsed from the store never focus themselves", () => {
    const rows = rowsOf(frontmatterPanelFromStore("title: Hello\ndraft: true"));
    expect(rows).toMatchObject([
      { key: "title", autoFocus: false },
      { key: "draft", autoFocus: false },
    ]);
  });
});

describe("unparsed block round-trips verbatim", () => {
  test("blur keeps the raw text and writes nothing", () => {
    const panel = frontmatterPanelFromStore(MALFORMED);
    expect(blurFrontmatterText(panel)).toBe(panel);
  });

  test("raw edits are written exactly as typed", () => {
    const panel = frontmatterPanelFromStore(COMMENT_ONLY);
    const text = `${COMMENT_ONLY}\n# one more`;
    const step = editFrontmatterText(panel, text);
    expect(step.write).toEqual({ kind: "set", yaml: text });
    expect(step.panel).toEqual({ mode: "unparsed", text });
  });

  test("an unchanged raw edit writes nothing", () => {
    const panel = frontmatterPanelFromStore(MALFORMED);
    expect(editFrontmatterText(panel, MALFORMED).write).toEqual({ kind: "none" });
  });

  test("fixing the YAML shows rows on blur", () => {
    const fixed = editFrontmatterText(
      frontmatterPanelFromStore(MALFORMED),
      "title: closed\nauthor: Jane",
    );
    const rows = rowsOf(blurFrontmatterText(fixed.panel));
    expect(rows).toMatchObject([
      { key: "title", value: "closed" },
      { key: "author", value: "Jane" },
    ]);
  });

  test("row transitions leave an unparsed block alone", () => {
    const panel = frontmatterPanelFromStore(MALFORMED);
    expect(blurFrontmatterRow(panel, 0)).toBe(panel);
    expect(deleteFrontmatterRow(panel, 0)).toEqual({ panel, write: { kind: "none" } });
    expect(editFrontmatterRow(panel, 0, "value", "")).toEqual({ panel, write: { kind: "none" } });
  });
});

describe("blur never removes the block", () => {
  test("blurring the only placeholder of a blank block changes nothing", () => {
    const panel = frontmatterPanelFromStore("");
    expect(blurFrontmatterRow(panel, 0)).toBe(panel);
  });

  test("blurring a keyed row changes nothing", () => {
    const panel = frontmatterPanelFromStore("title: Hello");
    expect(blurFrontmatterRow(panel, 0)).toBe(panel);
  });

  test("a keyless row is dropped on blur when other rows remain", () => {
    const panel = addFrontmatterRow(frontmatterPanelFromStore("title: Hello"));
    const rows = rowsOf(blurFrontmatterRow(panel, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "title" });
  });

  test("clearing the last key then blurring leaves one placeholder, not an absent block", () => {
    const cleared = editFrontmatterRow(frontmatterPanelFromStore("title: Hello"), 0, "key", "");
    expect(cleared.write).toEqual({ kind: "set", yaml: "" });
    const rows = rowsOf(blurFrontmatterRow(cleared.panel, 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "", value: "", autoFocus: false });
  });
});

describe("explicit delete", () => {
  test("deleting the last row removes the block", () => {
    const step = deleteFrontmatterRow(frontmatterPanelFromStore("title: Hello"), 0);
    expect(step).toEqual({ panel: { mode: "absent" }, write: { kind: "remove" } });
  });

  test("deleting one of several rows rewrites the rest", () => {
    const step = deleteFrontmatterRow(frontmatterPanelFromStore("title: Hello\ndraft: true"), 0);
    expect(step.write).toEqual({ kind: "set", yaml: "draft: true" });
  });

  test("deleting a placeholder next to keyed rows writes nothing", () => {
    const panel = addFrontmatterRow(frontmatterPanelFromStore("title: Hello"));
    expect(deleteFrontmatterRow(panel, 1).write).toEqual({ kind: "none" });
  });
});

describe("row edits", () => {
  test("a value typed into a keyless row writes nothing, so the stored text stays verbatim", () => {
    const panel = addFrontmatterRow(frontmatterPanelFromStore("title: Hello # keep this"));
    expect(editFrontmatterRow(panel, 1, "value", "x").write).toEqual({ kind: "none" });
  });

  test("typing a key writes the block", () => {
    const panel = addFrontmatterRow(frontmatterPanelFromStore("title: Hello"));
    const step = editFrontmatterRow(panel, 1, "key", "draft");
    expect(step.write).toEqual({ kind: "set", yaml: "title: Hello\ndraft:" });
  });

  test("editing one row writes only that row; quoting, numbers, nulls and comments survive", () => {
    const yaml = '# reviewed\nid: "007"\nversion: 1.10\nempty:\ntags:\n  - a # keep\ntitle: Old';
    const panel = frontmatterPanelFromStore(yaml);
    const step = editFrontmatterRow(panel, 4, "value", "New");
    expect(step.write).toEqual({
      kind: "set",
      yaml: '# reviewed\nid: "007"\nversion: 1.10\nempty:\ntags:\n  - a # keep\ntitle: New',
    });
  });

  test("the reviewer's sample is kept verbatim as raw text", () => {
    const sample =
      '# reviewed\nid: "007"\nzip: "02134"\nversion: 1.10\npublished: "false"\ntags:\n  - a  # keep';
    expect(frontmatterPanelFromStore(sample)).toEqual({ mode: "unparsed", text: sample });
  });

  test("a new row with a key that already exists is refused until the name is unique", () => {
    let panel = addFrontmatterRow(frontmatterPanelFromStore("title: Hello"));
    let step = editFrontmatterRow(panel, 1, "key", "title");
    expect(step.write).toEqual({ kind: "none" });
    expect(isPendingKey(rowsOf(step.panel)[1]!)).toBe(true);

    panel = step.panel;
    step = editFrontmatterRow(panel, 1, "key", "title2");
    expect(step.write).toEqual({ kind: "set", yaml: "title: Hello\ntitle2:" });
    expect(isPendingKey(rowsOf(step.panel)[1]!)).toBe(false);
  });

  test("renaming onto an existing key is refused, and blur shows the stored name again", () => {
    const panel = frontmatterPanelFromStore("title: A\nauthor: B");
    const step = editFrontmatterRow(panel, 1, "key", "title");
    expect(step.write).toEqual({ kind: "none" });
    const blurred = blurFrontmatterRow(step.panel, 1);
    expect(rowsOf(blurred)[1]).toMatchObject({ key: "author", value: "B", writtenKey: "author" });
  });

  test("clearing a key and typing it again puts the property back where it was", () => {
    let panel = frontmatterPanelFromStore("a: 1\nb: 2\nc: 3");
    let step = editFrontmatterRow(panel, 1, "key", "");
    expect(step.write).toEqual({ kind: "set", yaml: "a: 1\nc: 3" });
    panel = step.panel;
    step = editFrontmatterRow(panel, 1, "key", "b");
    expect(step.write).toEqual({ kind: "set", yaml: "a: 1\nb: 2\nc: 3" });
  });

  test("focus intent is fixed at creation and never flips as a row empties or fills", () => {
    let panel = addFrontmatterRow(frontmatterPanelFromStore("title: Hello"));
    expect(rowsOf(panel)[1]!.autoFocus).toBe(true);
    panel = editFrontmatterRow(panel, 1, "key", "draft").panel;
    expect(rowsOf(panel)[1]!.autoFocus).toBe(true);

    panel = editFrontmatterRow(panel, 0, "key", "").panel;
    panel = editFrontmatterRow(panel, 0, "value", "").panel;
    expect(rowsOf(panel)[0]).toMatchObject({ key: "", value: "", autoFocus: false });
  });
});

function renderPanel(frontmatter: string | null): string {
  storedFrontmatter = frontmatter;
  return renderToStaticMarkup(createElement(FrontmatterPanel, { filePath: "/notes/panel.md" }));
}

describe("FrontmatterPanel", () => {
  test("renders nothing without a block", () => {
    expect(renderPanel(null)).toBe("");
  });

  test("shows malformed YAML as its raw text, not as rows", () => {
    const html = renderPanel(MALFORMED);
    expect(html).toContain('data-frontmatter-mode="unparsed"');
    expect(html).toContain("<textarea");
    expect(html).toContain("title: [unclosed\nauthor: Jane</textarea>");
    expect(html).not.toContain('data-field="key"');
  });

  test("shows a comment-only block as its raw text", () => {
    const html = renderPanel(COMMENT_ONLY);
    expect(html).toContain('data-frontmatter-mode="unparsed"');
    expect(html).toContain("# draft notes, keep");
  });

  test("shows a mapping as rows", () => {
    const html = renderPanel("title: Hello\ndraft: true");
    expect(html).toContain('data-frontmatter-mode="entries"');
    expect(html.match(/data-field="key"/g)).toHaveLength(2);
    expect(html).toContain('value="Hello"');
  });
});
