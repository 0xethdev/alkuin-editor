import { describe, expect, test } from "vite-plus/test";
import {
  editYamlFrontmatter,
  readYamlFrontmatter,
  type YamlEdit,
  type YamlEntry,
} from "../src/lib/yaml-entries";

// `id` is a non-deterministic React-key field (a module-level counter) that is
// never written. Compare parsed output by value only.
const byValue = (entries: YamlEntry[]) =>
  entries.map((e) => ({ key: e.key, value: e.value, isComplex: e.isComplex }));

// The rows of a block that reads as entries. Fails the test otherwise.
function parseYamlEntries(yaml: string): YamlEntry[] {
  const read = readYamlFrontmatter(yaml);
  if (read.kind !== "entries") throw new Error(`expected entries, got ${read.reason}`);
  return read.entries;
}

/** Apply edits in order the way the panel does, each on the last result. */
function edit(yaml: string, ...edits: YamlEdit[]): string {
  const read = readYamlFrontmatter(yaml);
  if (read.kind !== "entries") throw new Error(`expected entries, got ${read.reason}`);
  let text = yaml;
  for (const next of edits) {
    const result = editYamlFrontmatter(text, read.style, next);
    if (!result.ok) throw new Error(`edit refused: ${result.reason}`);
    text = result.yaml;
  }
  return text;
}

// The reviewer's sample: comments, quoted strings that look like numbers or
// booleans, a float with a trailing zero, and a commented list item.
const SAMPLE =
  '# reviewed\nid: "007"\nzip: "02134"\nversion: 1.10\npublished: "false"\ntags:\n  - a  # keep';

describe("readYamlFrontmatter", () => {
  test("parses simple key-value pairs", () => {
    const entries = parseYamlEntries("title: Hello\nauthor: Jane");
    expect(byValue(entries)).toEqual([
      { key: "title", value: "Hello", isComplex: false },
      { key: "author", value: "Jane", isComplex: false },
    ]);
  });

  test("shows numbers, booleans and nulls as written", () => {
    const entries = parseYamlEntries("draft: false\nweight: 42\nversion: 1.10\nempty:\nnone: ~");
    expect(byValue(entries)).toEqual([
      { key: "draft", value: "false", isComplex: false },
      { key: "weight", value: "42", isComplex: false },
      { key: "version", value: "1.10", isComplex: false },
      { key: "empty", value: "", isComplex: false },
      { key: "none", value: "~", isComplex: false },
    ]);
  });

  test("shows a collection on one line in flow style", () => {
    expect(byValue(parseYamlEntries("tags:\n  - markdown\n  - test"))).toEqual([
      { key: "tags", value: "[markdown, test]", isComplex: true },
    ]);
    expect(byValue(parseYamlEntries("tags: [a, b, c]"))).toEqual([
      { key: "tags", value: "[a, b, c]", isComplex: true },
    ]);
    expect(parseYamlEntries("nested:\n  key: value\n  other: 123")[0]).toMatchObject({
      key: "nested",
      isComplex: true,
    });
  });

  test("reads zero-indented lists too", () => {
    expect(parseYamlEntries("tags:\n- a\n- b\ntitle: T")).toHaveLength(2);
  });

  test("a blank block is an empty mapping", () => {
    expect(parseYamlEntries("")).toEqual([]);
    expect(parseYamlEntries("\n  \n")).toEqual([]);
  });

  test("YAML that is not a mapping is unparsed, not an empty list of rows", () => {
    for (const yaml of ["just a string", "# only a comment", "- a\n- b", "~", "42"]) {
      expect(readYamlFrontmatter(yaml)).toEqual({ kind: "unparsed", reason: "not-mapping" });
    }
  });

  test("invalid YAML, including a duplicate key, is unparsed", () => {
    for (const yaml of ["title: [unclosed", "a: 1\na: 2", "key: : :\n  - bad"]) {
      expect(readYamlFrontmatter(yaml)).toEqual({ kind: "unparsed", reason: "invalid" });
    }
  });

  test("a mapping the rows can't reproduce exactly is unparsed, so it stays verbatim", () => {
    for (const yaml of [
      // Two spaces before an inline comment; the writer would emit one.
      "tags:\n  - a  # keep",
      SAMPLE,
      // A multi-line string can't be edited in a single-line input.
      "summary: |\n  line one\n  line two",
      // Aliases.
      "base: &b 1\ncopy: *b",
      // Extra spaces after the colon.
      "title:   Spaced",
    ]) {
      expect(readYamlFrontmatter(yaml)).toEqual({ kind: "unparsed", reason: "not-editable" });
    }
  });
});

describe("editYamlFrontmatter", () => {
  // The sample with the comment spacing the writer reproduces, so it reads as rows.
  const ROWS_SAMPLE =
    '# reviewed\nid: "007"\nzip: "02134"\nversion: 1.10\npublished: "false"\nempty:\ntags:\n  - a # keep';

  test("editing one row leaves every other row's bytes, types and comments alone", () => {
    expect(edit(ROWS_SAMPLE, { kind: "set-value", key: "id", text: "008", isComplex: false })).toBe(
      '# reviewed\nid: "008"\nzip: "02134"\nversion: 1.10\npublished: "false"\nempty:\ntags:\n  - a # keep',
    );
  });

  test("a string stays a string; other values read the typed text the way YAML would", () => {
    expect(
      edit("title: Hello\ncount: 3\nratio: 1.10\nflag: true", {
        kind: "set-value",
        key: "title",
        text: "123",
        isComplex: false,
      }),
    ).toBe('title: "123"\ncount: 3\nratio: 1.10\nflag: true');
    expect(
      edit(
        "count: 3\nratio: 1.10",
        { kind: "set-value", key: "count", text: "four", isComplex: false },
        { kind: "set-value", key: "ratio", text: "2.50", isComplex: false },
      ),
    ).toBe("count: four\nratio: 2.50");
  });

  test("an emptied value is written as an empty value, not an empty string", () => {
    expect(edit("a: 1\nb: x", { kind: "set-value", key: "a", text: "", isComplex: false })).toBe(
      "a:\nb: x",
    );
    expect(edit("a: 1", { kind: "add", key: "draft", text: "", isComplex: false, at: 1 })).toBe(
      "a: 1\ndraft:",
    );
  });

  test("a list edited in its one-line form keeps its block style, and invalid text is refused", () => {
    expect(
      edit("tags:\n  - a\n  - b\ntitle: T", {
        kind: "set-value",
        key: "tags",
        text: "[a, b, c]",
        isComplex: true,
      }),
    ).toBe("tags:\n  - a\n  - b\n  - c\ntitle: T");
    const read = readYamlFrontmatter("tags: [a]");
    if (read.kind !== "entries") throw new Error("expected entries");
    expect(
      editYamlFrontmatter("tags: [a]", read.style, {
        kind: "set-value",
        key: "tags",
        text: "[a, b",
        isComplex: true,
      }),
    ).toEqual({ ok: false, reason: "invalid-value" });
  });

  test("a key another property already has is refused, never overwritten", () => {
    const read = readYamlFrontmatter("title: A\nauthor: B");
    if (read.kind !== "entries") throw new Error("expected entries");
    for (const next of [
      { kind: "add", key: "title", text: "C", isComplex: false, at: 2 },
      { kind: "rename", from: "author", to: "title" },
    ] as const) {
      expect(editYamlFrontmatter("title: A\nauthor: B", read.style, next)).toEqual({
        ok: false,
        reason: "duplicate-key",
      });
    }
  });

  test("rename keeps the position; add goes where the row sits", () => {
    expect(edit("a: 1\nb: 2", { kind: "rename", from: "a", to: "z" })).toBe("z: 1\nb: 2");
    expect(edit("a: 1\nb: 2", { kind: "add", key: "m", text: "x", isComplex: false, at: 1 })).toBe(
      "a: 1\nm: x\nb: 2",
    );
  });

  test("deleting a property keeps the comment above it", () => {
    expect(edit("# reviewed\na: 1\nb: 2", { kind: "delete", key: "a" })).toBe("# reviewed\nb: 2");
    expect(edit("# reviewed\na: 1", { kind: "delete", key: "a" })).toBe("# reviewed");
    expect(edit("a: 1", { kind: "delete", key: "a" })).toBe("");
  });

  test("the first property of a blank block", () => {
    expect(edit("", { kind: "add", key: "title", text: "Hello", isComplex: false, at: 0 })).toBe(
      "title: Hello",
    );
  });

  test("zero-indented lists keep their indentation through an edit", () => {
    expect(
      edit("tags:\n- a\n- b\ntitle: T", {
        kind: "set-value",
        key: "title",
        text: "U",
        isComplex: false,
      }),
    ).toBe("tags:\n- a\n- b\ntitle: U");
  });
});
