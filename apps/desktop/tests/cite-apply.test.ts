import { describe, expect, test } from "vite-plus/test";
import { Text } from "@codemirror/state";
import {
  applyCitation,
  citationChanges,
  citePreviewChanges,
  formatCiteOutput,
  instructionIsCiteShaped,
  linkCiteMarkers,
  referenceAnchorPos,
  referenceBearingChanges,
  tidyPunctuation,
} from "../src/features/redline-spike/cite-apply";
import { buildRedlineDecorations } from "../src/features/redline-spike/decorations";
import type { RedlineNote } from "../src/features/redline-spike/model";

const DUMP =
  "Kreider RB et al., International Society of Sports Nutrition position stand: safety and efficacy of creatine supplementation in exercise, sport, and medicine. J Int Soc Sports Nutr. 2017. https://doi.org/10.1186/s12970-017-0173-z; Kreider R.B., Stout J.R., Creatine in Health and Disease. Nutrients. 2021. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7910963/";

const PAGE_MASH =
  "Page MJ, Moher D, Bossuyt PM, Boutron I, Hoffmann TC, Mulrow CD, Shamseer L, Tetzlaff JM, Akl EA, Brennan SE, Chou R, Glanville J, Grimshaw JM, Hróbjartsson A, Lalu MM, Li T, Loder EW, Mayo-Wilson E, McDonald S, McKenzie JE. PRISMA 2020 explanation and elaboration: updated guidance and exemplars for reporting systematic reviews. BMJ. 2021;372:n160. doi:10.1136/bmj.n160. indicates that, when administered at recommended dosages, creatine supplementation is generally well tolerated and considered safe in healthy adolescent populations; however, long-term safety data are limited.";

const PROSE = `Creatine monohydrate is a well-researched supplement that consistently helps increase muscle strength and lean mass. People usually follow one of two common dosing approaches:

- Loading method: 20 g/day (split into four 5 g doses) for 5–7 days, then 3–5 g/day for maintenance.
`;

describe("cite output", () => {
  test("keeps a short marker and does not invent a references list", () => {
    expect(formatCiteOutput(" (Smith, 2020) ")).toEqual({
      markers: "(Smith, 2020)",
      references: [],
    });
    expect(formatCiteOutput("[1]")).toEqual({ markers: "[1]", references: [] });
  });

  test("splits a marker from a References heading", () => {
    const raw = `(Kreider et al., 2017)

## References

Kreider RB, et al. (2017). Position stand. https://doi.org/10.1186/s12970-017-0173-z
`;
    const cite = formatCiteOutput(raw);
    expect(cite.markers).toBe("(Kreider et al., 2017)");
    expect(cite.references).toEqual([
      "Kreider RB, et al. (2017). Position stand. https://doi.org/10.1186/s12970-017-0173-z",
    ]);
  });

  test("turns a jammed bibliography into short markers and one reference each", () => {
    const cite = formatCiteOutput(DUMP);
    expect(cite.markers).toBe("(Kreider et al., 2017; Kreider & Stout, 2021)");
    expect(cite.references).toHaveLength(2);
    expect(cite.references[0]).toContain("https://doi.org/10.1186/s12970-017-0173-z");
    expect(cite.references[1]).toContain("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7910963/");
    expect(cite.markers).not.toContain("http");
  });

  test("splits a bibliography glued to body prose into one reference, not one line", () => {
    const cite = formatCiteOutput(PAGE_MASH);
    expect(cite.markers).toBe("(Page et al., 2021)");
    expect(cite.references).toHaveLength(1);
    expect(cite.references[0]).toContain("doi:10.1136/bmj.n160");
    expect(cite.references[0]).not.toContain("indicates that");
    expect(cite.markers).not.toContain("Page MJ");

    const glued = formatCiteOutput(
      `${DUMP} indicates that creatine is generally well tolerated at the recommended dose.`,
    );
    expect(glued.markers).toBe("(Kreider et al., 2017; Kreider & Stout, 2021)");
    expect(glued.references).toHaveLength(2);
    expect(glued.references.join("\n")).not.toContain("indicates that");
  });
});

describe("cite apply", () => {
  test("places the marker at the sentence boundary with a space, and lists references once", () => {
    const start = PROSE.indexOf("well-researched");
    const end = start + "well-researched".length;
    const out = applyCitation(PROSE, start, end, DUMP);

    expect(out).toContain("is a well-researched supplement");
    expect(out).not.toContain("researchedKreider");
    expect(out).not.toMatch(/researched\S/);
    expect(out).toContain("lean mass (Kreider et al., 2017; Kreider & Stout, 2021).");
    expect(out).toContain("## References");
    expect(out.match(/10\.1186\/s12970-017-0173-z/g)).toHaveLength(1);
    expect(out.match(/PMC7910963/g)).toHaveLength(1);
    expect(out).toContain("Loading method: 20 g/day");
  });

  test("does not leave a doubled colon at approaches", () => {
    expect(tidyPunctuation("one of two common dosing approaches::")).toBe(
      "one of two common dosing approaches:",
    );

    const start = PROSE.indexOf("well-researched");
    const jammed = `${DUMP} one of two common dosing approaches::`;
    const out = applyCitation(PROSE, start, start + "well-researched".length, jammed);

    expect(out).toContain("one of two common dosing approaches:");
    expect(out).not.toContain("::");
    expect(out).not.toContain("approaches::");
    expect(out).toContain("supplement that consistently helps");
  });

  test("drops a stray colon glued to an otherwise good marker", () => {
    const doc = "People usually follow one of two common dosing approaches:";
    const out = applyCitation(doc, doc.length, doc.length, "(Kreider et al., 2017)::");
    expect(out).toBe(
      "People usually follow one of two common dosing approaches: (Kreider et al., 2017)",
    );
    expect(out).not.toContain("::");
  });

  test("a short citation after a finished sentence keeps the sentence and the space", () => {
    const doc = "The economy grew last year.";
    expect(applyCitation(doc, 0, doc.length, " (Smith, 2020)")).toBe(
      "The economy grew last year. (Smith, 2020)",
    );
  });

  test("does not duplicate a reference already listed", () => {
    const start = PROSE.indexOf("well-researched");
    const once = applyCitation(PROSE, start, start + "well-researched".length, DUMP);
    const twice = applyCitation(once, start, start + "well-researched".length, DUMP);
    expect(twice.match(/## References/g)).toHaveLength(1);
    expect(twice.match(/10\.1186\/s12970-017-0173-z/g)).toHaveLength(1);
  });

  test("mashed bib plus prose keeps the claim, a spaced marker, and a separate reference", () => {
    const claim = "creatine supplementation is generally well tolerated";
    const doc = `${claim} and considered safe.\n\n## References\n`;
    const out = applyCitation(doc, 0, claim.length, PAGE_MASH);

    expect(out.startsWith(claim)).toBe(true);
    expect(out).toContain("safe (Page et al., 2021).");
    expect(out).not.toContain("::");
    expect(out).not.toContain("indicates that");
    expect(out).not.toMatch(/n160\.\s*indicates/);
    expect(out).toMatch(/## References\n+Page MJ,/);
    expect(out.match(/doi:10\.1136\/bmj\.n160/g)).toHaveLength(1);
    const reference = out.split(/## References\n+/)[1] ?? "";
    expect(reference.startsWith("Page MJ,")).toBe(true);
    expect(reference).not.toContain("considered safe");
  });

  test("creatine claim keeps its wording, a space before the marker, and no doubled colon", () => {
    const doc =
      "Creatine monohydrate is one of the most-studied dietary supplements and reliably increases muscle strength and lean mass when used with resistance training.";
    const claim = "reliably increases muscle strength and lean mass";
    const start = doc.indexOf(claim);
    const out = applyCitation(doc, start, start + claim.length, `${DUMP} approaches::`);

    expect(out).toContain(claim);
    expect(out).toContain("training (Kreider et al., 2017; Kreider & Stout, 2021).");
    expect(out).not.toContain("::");
    expect(out).not.toMatch(/training\(/);
  });
});

function insertWidgets(doc: string, note: RedlineNote): { from: number; text: string }[] {
  const found: { from: number; text: string }[] = [];
  buildRedlineDecorations(Text.of(doc.split("\n")), [note]).between(
    0,
    doc.length + 1,
    (from, _to, value) => {
      const widget = value.spec.widget as { kind?: string; text?: string } | undefined;
      if (widget?.kind === "insert") found.push({ from, text: widget.text ?? "" });
    },
  );
  return found;
}

function spanClasses(doc: string, note: RedlineNote): string[] {
  const classes: string[] = [];
  buildRedlineDecorations(Text.of(doc.split("\n")), [note]).between(
    note.from,
    note.to,
    (_a, _b, value) => {
      const cls = value.spec.class as string | undefined;
      if (cls) classes.push(cls);
    },
  );
  return classes;
}

describe("fact check this", () => {
  const doc = "The river was cold. People swam.";
  const claim = "The river was cold.";
  const proposed = `The river was 4 C [1].

## References

River log. n.d. https://example.com/river`;

  test("is not cite-shaped, so the correction stays and references move to the end", () => {
    expect(instructionIsCiteShaped("Fact check this")).toBe(false);
    const from = doc.indexOf(claim);
    const to = from + claim.length;
    const changes = referenceBearingChanges(doc, from, to, proposed, "replace");
    expect(changes).toEqual([
      { from, to, insert: "The river was 4 C [1]." },
      {
        from: doc.length,
        to: doc.length,
        insert: "\n\n## References\n\nRiver log. n.d. https://example.com/river\n",
      },
    ]);
    const applied = [...(changes ?? [])]
      .sort((a, b) => b.from - a.from)
      .reduce(
        (next, change) => next.slice(0, change.from) + change.insert + next.slice(change.to),
        doc,
      );
    expect(applied).toBe(
      "The river was 4 C [1]. People swam.\n\n## References\n\nRiver log. n.d. https://example.com/river\n",
    );
    expect(applied.indexOf("## References")).toBeGreaterThan(applied.indexOf("People swam"));
  });

  test("replacing a selection that already holds the reference does not drop it", () => {
    const whole = `${claim}\n\n## References\n\nRiver log. n.d. https://example.com/river\n`;
    const changes = referenceBearingChanges(whole, 0, whole.length, proposed, "replace");
    const applied = [...(changes ?? [])]
      .sort((a, b) => b.from - a.from)
      .reduce(
        (next, change) => next.slice(0, change.from) + change.insert + next.slice(change.to),
        whole,
      );
    expect(applied).toContain("The river was 4 C [1].");
    expect(applied).toContain("https://example.com/river");
    expect(applied.match(/## References/g)).toHaveLength(1);
  });

  test("a lowercase title stays with its URL", () => {
    const line =
      "Ada Lovelace (2020-01-02). river log. https://example.com/river-temperature-record";
    const cite = formatCiteOutput(`[1]\n\n## References\n\n${line}`);
    expect(cite.references[0]).toContain("river log");
    expect(cite.references[0]).toContain("https://example.com/river-temperature-record");
  });

  test("preview strikes the claim, shows the correction, and lists references at the end", () => {
    const from = doc.indexOf(claim);
    const note = {
      id: "fact-1",
      from,
      to: from + claim.length,
      original: claim,
      proposed,
      intent: "replace" as const,
      instruction: "Fact check this",
      status: "pending" as const,
      error: null,
      git: null,
      publish: null,
    };
    const widgets = insertWidgets(doc, note);
    expect(spanClasses(doc, note)).toContain("cm-redline-del");
    expect(widgets.map((widget) => widget.text).join("\n")).not.toMatch(
      /4 C \[1\]\.\n\n## References/,
    );
    const correction = widgets.find((widget) => widget.text.includes("4 C"));
    const references = widgets.find((widget) => widget.text.includes("## References"));
    expect(correction?.text).toBe("The river was 4 C [1].");
    expect(correction?.from).toBe(note.to);
    expect(references?.text).toBe(
      "\n\n## References\n\nRiver log. n.d. https://example.com/river\n",
    );
    expect(references?.from).toBe(doc.length);
  });

  test("an inserted marker gains a space when the previous character is not whitespace", () => {
    const note = "The river was cold.";
    const proposed = `[1]\n\n## References\n\n[1] A. River. 2016. River log. https://example.com/river`;
    const changes = referenceBearingChanges(note, note.length, note.length, proposed, "insert");
    expect(changes?.[0]?.insert.startsWith(" [\\[1\\]](#ref-1)")).toBe(true);
    expect(changes?.[0]?.insert).toContain(
      "[1] A. River. 2016. River log. https://example.com/river",
    );

    const spaced = `${note} `;
    const again = referenceBearingChanges(spaced, spaced.length, spaced.length, proposed, "insert");
    expect(again?.[0]?.insert.startsWith("[\\[1\\]](#ref-1)")).toBe(true);
    expect(again?.[0]?.insert.startsWith(" ")).toBe(false);
  });

  test("a numbered marker links to its reference line", () => {
    const from = doc.indexOf(claim);
    const numbered = `The river was 4 C [1].

## References

[1] A. River. 2016. River log. https://example.com/river`;
    const changes = referenceBearingChanges(doc, from, from + claim.length, numbered, "replace");
    const applied = [...(changes ?? [])]
      .sort((a, b) => b.from - a.from)
      .reduce(
        (next, change) => next.slice(0, change.from) + change.insert + next.slice(change.to),
        doc,
      );
    expect(applied).toContain("The river was 4 C [\\[1\\]](#ref-1). People swam.");
    expect(referenceAnchorPos(applied, "ref-1")).toBe(applied.indexOf("[1] A. River"));
    expect(referenceAnchorPos(applied, "ref-2")).toBeNull();
    expect(referenceAnchorPos(applied, "references")).toBeNull();

    const linked = linkCiteMarkers("[1] [2]", [
      "[1] A. https://example.com/a",
      "Ada. https://example.com/b",
    ]);
    expect(linked).toBe("[\\[1\\]](#ref-1) [2]");
  });
});

describe("cite marker links", () => {
  test("a cite insert keeps a space before a numbered marker", () => {
    const note = "The economy grew last year.";
    const raw = `[1]\n\n## References\n\n[1] Smith. 2020. Growth. https://example.com/growth`;
    const out = applyCitation(note, 0, note.length, raw);
    expect(out.startsWith("The economy grew last year. [\\[1\\]](#ref-1)")).toBe(true);
    expect(out).toContain(
      "\n\n## References\n\n[1] Smith. 2020. Growth. https://example.com/growth",
    );
    expect(referenceAnchorPos(out, "ref-1")).toBe(out.indexOf("[1] Smith"));
  });
});

describe("cite preview", () => {
  test("a pending cite note previews the merge, not a bibliography insert", () => {
    const claim = "creatine supplementation is generally well tolerated";
    const doc = `${claim} and considered safe.\n\n## References\n`;
    const note = {
      id: "cite-1",
      from: 0,
      to: claim.length,
      original: claim,
      proposed: PAGE_MASH,
      intent: "insert" as const,
      instruction: "@agent add citations for this claim",
      status: "pending" as const,
      error: null,
      git: null,
      publish: null,
    };
    const widgets = insertWidgets(doc, note);
    const painted = widgets.map((widget) => widget.text).join("\n");
    const merge = citationChanges(doc, note.from, note.to, PAGE_MASH);

    expect(spanClasses(doc, note)).not.toContain("cm-redline-del");
    expect(spanClasses(doc, note)).not.toContain("cm-redline-open");
    expect(widgets.map((widget) => widget.text)).toEqual(merge.map((change) => change.insert));
    expect(painted).not.toBe(PAGE_MASH);
    expect(painted).not.toContain("indicates that");
    expect(painted).toContain("(Page et al., 2021)");
    expect(painted).toContain("doi:10.1136/bmj.n160");
    const marker = widgets.find((widget) => widget.text.includes("(Page et al., 2021)"));
    const reference = widgets.find((widget) => widget.text.includes("Page MJ"));
    expect(marker?.text).toBe(" (Page et al., 2021)");
    expect(marker?.from).not.toBe(note.to);
    expect(marker?.text).not.toContain("doi:");
    expect(reference?.from).toBe(doc.length);
    expect(reference?.text).not.toContain("indicates that");

    const replaced = { ...note, intent: "replace" as const };
    expect(spanClasses(doc, replaced)).not.toContain("cm-redline-del");
    expect(insertWidgets(doc, replaced).some((widget) => widget.text === PAGE_MASH)).toBe(false);
  });

  test("a cite proposal that is not a reference is not painted as a raw insert", () => {
    const doc = "creatine supplementation is generally well tolerated.";
    const proposed =
      "indicates that creatine is generally well tolerated when taken as directed by a clinician.";
    const note = {
      id: "cite-prose",
      from: 0,
      to: 12,
      original: doc.slice(0, 12),
      proposed,
      intent: "insert" as const,
      instruction: "@agent add a citation",
      status: "pending" as const,
      error: null,
      git: null,
      publish: null,
    };
    expect(citationChanges(doc, note.from, note.to, proposed)).toEqual([]);
    expect(insertWidgets(doc, note)).toEqual([]);
  });
});

describe("cite-shaped instruction", () => {
  test("whole words only, the same list as Rust", () => {
    for (const ask of [
      "cite this",
      "Add a citation.",
      "add citations for this claim",
      "find a source",
      "Sources?",
      "add a footnote",
      "@agent footnotes, please",
    ]) {
      expect(instructionIsCiteShaped(ask), ask).toBe(true);
    }
    for (const ask of [
      "make it sound really excited",
      "mention our resources",
      "we should outsource this",
      "recite it plainly",
      "cite-worthy",
      "Make this shorter",
    ]) {
      expect(instructionIsCiteShaped(ask), ask).toBe(false);
    }
  });

  test("a rewrite whose ask only contains a cite word inside another word is still painted", () => {
    const claim = "This is a real document and, just as any text, it is front and center.";
    const doc = `${claim}\n`;
    const note = {
      id: "excited-1",
      from: 0,
      to: claim.length,
      original: claim,
      proposed: "This is a real document and, as any text, it is front and center.",
      intent: "replace" as const,
      instruction: "make it sound really excited",
      status: "pending" as const,
      error: null,
      git: null,
      publish: null,
    };
    // Not the citation merge: null hands the note to the ordinary strike and insert.
    expect(citePreviewChanges(doc, note)).toBeNull();
  });
});
