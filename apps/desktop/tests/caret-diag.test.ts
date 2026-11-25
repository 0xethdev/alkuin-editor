import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  caretDiagFields,
  caretDiagRequested,
  caretMarkLabel,
  formatCaretDiagLine,
  joinCaretDiagCopy,
  type CaretDiagRecord,
} from "../src/lib/caret-diag";

const record: CaretDiagRecord = {
  t: "keydown",
  us: 1500,
  inputType: "",
  code: "KeyA",
  keyCode: 65,
  composing: false,
  before: [2, 2],
  after: [3, 3],
  doc: 3,
  block: 2,
};

describe("caret diagnostics", () => {
  test("records timing and caret offsets", () => {
    expect(formatCaretDiagLine(record)).toBe(
      '{"t":"keydown","us":1500,"inputType":"","code":"Letter","keyCode":0,"composing":false,"before":[2,2],"after":[3,3],"doc":3,"block":2}',
    );
    expect(formatCaretDiagLine(record)).not.toContain("KeyA");
    expect(formatCaretDiagLine(record)).not.toContain("65");
  });

  test("copy includes lines that never reached the file", () => {
    const line = formatCaretDiagLine(record);
    expect(joinCaretDiagCopy("", [line!])).toBe(line);
    expect(joinCaretDiagCopy("already", [line!])).toBe(`already\n${line}`);
    expect(joinCaretDiagCopy(line!, [line!])).toBe(line);
  });

  test("env 1 or true pins the logger on before Rust answers", () => {
    expect(caretDiagRequested("1")).toBe(true);
    expect(caretDiagRequested("true")).toBe(true);
    expect(caretDiagRequested("TRUE")).toBe(true);
    expect(caretDiagRequested("0")).toBe(false);
    expect(caretDiagRequested(undefined)).toBe(false);
    const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    // Defined by name, not by an ALKUIN_ prefix (see env-exposure.test.ts).
    expect(vite).toContain(
      '"import.meta.env.ALKUIN_CARET_DIAG": JSON.stringify(process.env.ALKUIN_CARET_DIAG ?? "")',
    );
  });

  test("the mark flash is brief and says when logging was off", () => {
    expect(caretMarkLabel(1_000, true, 1_000)).toBe("marked");
    expect(caretMarkLabel(1_000, false, 1_100)).toBe("diag off");
    expect(caretMarkLabel(1_000, true, 2_200)).toBeNull();
    expect(caretMarkLabel(0, true, 1_000)).toBeNull();
  });

  test("a mark line is numbers only", () => {
    const line = formatCaretDiagLine({
      ...record,
      t: "mark",
      us: 2400,
      code: "",
      keyCode: 0,
      before: [5, 5],
      after: [5, 5],
    });
    expect(line).toContain('"t":"mark"');
    expect(line).toContain('"doc":3');
    expect(line).toContain('"block":2');
    expect(line).not.toContain("secret");
  });

  test("letter and digit codes never reach the line", () => {
    const kept = [
      ["Space", 32, 1910],
      ["Enter", 13, 2000],
      ["Backspace", 8, 2100],
      ["ArrowLeft", 37, 2200],
      ["ArrowRight", 39, 2210],
      ["ArrowUp", 38, 2220],
      ["ArrowDown", 40, 2230],
      ["ShiftLeft", 16, 2300],
      ["ControlLeft", 17, 2310],
      ["AltLeft", 18, 2320],
      ["MetaLeft", 91, 2330],
    ] as const;
    const lines = [
      formatCaretDiagLine(record),
      formatCaretDiagLine({ ...record, t: "keyup", us: 1600, code: "KeyZ", keyCode: 90 }),
      formatCaretDiagLine({ ...record, us: 1700, code: "Digit1", keyCode: 49 }),
      formatCaretDiagLine({ ...record, us: 1800, code: "Digit0", keyCode: 48 }),
      formatCaretDiagLine({ ...record, us: 1510, code: "Letter", keyCode: 65 }),
      formatCaretDiagLine({ ...record, us: 1710, code: "Digit", keyCode: 49 }),
      ...kept.map(([code, keyCode, us]) => formatCaretDiagLine({ ...record, us, code, keyCode })),
    ].join("\n");
    expect(lines).not.toContain("KeyA");
    expect(lines).not.toContain("KeyZ");
    expect(lines).not.toContain("Digit1");
    expect(lines).not.toContain("Digit0");
    expect(lines).not.toContain("65");
    expect(lines).not.toContain("90");
    expect(lines).not.toContain("49");
    expect(lines).not.toContain("48");
    expect(lines).toContain('"code":"Letter"');
    expect(lines).toContain('"code":"Digit"');
    expect(lines).toContain('"keyCode":0');
    for (const [code, keyCode] of kept) {
      expect(lines).toContain(`"code":"${code}"`);
      expect(lines).toContain(`"keyCode":${keyCode}`);
    }
    expect(caretDiagFields({ type: "keydown", code: "KeyA", keyCode: 65 })).toMatchObject({
      code: "Letter",
      keyCode: 0,
    });
    expect(caretDiagFields({ type: "keydown", code: "Digit1", keyCode: 49 })).toMatchObject({
      code: "Digit",
      keyCode: 0,
    });
    expect(caretDiagFields({ type: "keydown", code: "Space", keyCode: 32 })).toMatchObject({
      code: "Space",
      keyCode: 32,
    });
  });

  test("never writes the typed text", () => {
    const event = {
      type: "beforeinput",
      code: "",
      keyCode: 0,
      key: "secret phrase",
      data: "secret phrase",
      inputType: "insertText",
      isComposing: false,
    };
    const fields = caretDiagFields(event);
    const line = formatCaretDiagLine({
      ...fields!,
      us: 10,
      before: [4, 4],
      after: [5, 5],
      doc: 5,
      block: 5,
    });
    expect(line).toContain("insertText");
    expect(line).not.toContain("secret");
  });

  test("rejects a field that contains characters", () => {
    expect(
      caretDiagFields({
        type: "input",
        inputType: "secret phrase",
        code: "",
        keyCode: 0,
      }),
    ).toBeNull();
    expect(formatCaretDiagLine({ ...record, code: "a b" })).toBeNull();
    expect(caretDiagFields({ type: "paste", code: "KeyV", keyCode: 86 })).toBeNull();
  });

  test("records composition and the caret after the event", () => {
    const fields = caretDiagFields({
      type: "input",
      inputType: "insertCompositionText",
      code: "",
      keyCode: 0,
      isComposing: true,
    });
    const line = formatCaretDiagLine({
      ...fields!,
      us: 80,
      before: [3, 3],
      after: [3, 1],
      doc: 4,
      block: 4,
    });
    expect(line).toContain('"composing":true');
    expect(line).toContain('"before":[3,3]');
    expect(line).toContain('"after":[3,1]');
  });
});
