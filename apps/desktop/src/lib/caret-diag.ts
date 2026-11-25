// Opt-in caret timing. Off unless ALKUIN_CARET_DIAG or the hidden toggle is on.
// A line is event timing and caret offsets. The typed characters are not fields.

const CARET_DIAG_TYPES = ["keydown", "keyup", "beforeinput", "input", "mark"] as const;

type CaretDiagType = (typeof CARET_DIAG_TYPES)[number];

export type CaretOffsets = [number, number];

export type CaretDiagRecord = {
  t: CaretDiagType;
  us: number;
  inputType: string;
  code: string;
  keyCode: number;
  composing: boolean;
  before: CaretOffsets;
  after: CaretOffsets;
  doc: number;
  block: number;
};

type DomDiagEvent = {
  type: string;
  code?: string;
  keyCode?: number;
  inputType?: string;
  isComposing?: boolean;
};

const TOKEN = /^[A-Za-z0-9]{0,40}$/;

function token(value: string, max: number): boolean {
  return value.length <= max && TOKEN.test(value);
}

export function caretDiagRequested(value: string | null | undefined): boolean {
  return value === "1" || (typeof value === "string" && value.toLowerCase() === "true");
}

const MARK_FLASH_MS = 1200;

export function caretMarkLabel(
  at: number,
  logged: boolean,
  now: number,
): "marked" | "diag off" | null {
  if (at === 0 || now - at >= MARK_FLASH_MS || now < at) return null;
  return logged ? "marked" : "diag off";
}

/** File text plus anything still only in memory. An empty file must not hide
 *  lines that have not been flushed, or that the file gate dropped. */
export function joinCaretDiagCopy(file: string, buffered: readonly string[]): string {
  const stored = file.trim();
  const extra = buffered.filter((line) => line.length > 0 && !stored.includes(line));
  if (extra.length === 0) return stored;
  if (!stored) return extra.join("\n");
  return `${stored}\n${extra.join("\n")}`;
}

function count(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

// KeyA and Digit1 rebuild the typed text. Space, Enter, Backspace, arrows,
// and modifiers stay so the trace can still show those keys.
function redactKey(code: string, keyCode: number): { code: string; keyCode: number } {
  if (/^Key[A-Z]$/.test(code) || code === "Letter") return { code: "Letter", keyCode: 0 };
  if (/^Digit[0-9]$/.test(code) || code === "Digit") return { code: "Digit", keyCode: 0 };
  return { code, keyCode };
}

function offsets(value: CaretOffsets): boolean {
  return (
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    value[0] >= 0 &&
    value[1] >= 0
  );
}

export function caretDiagFields(
  event: DomDiagEvent,
): Omit<CaretDiagRecord, "us" | "before" | "after" | "doc" | "block"> | null {
  if (!CARET_DIAG_TYPES.includes(event.type as CaretDiagType)) return null;
  const inputType = typeof event.inputType === "string" ? event.inputType : "";
  const code = typeof event.code === "string" ? event.code : "";
  const keyCode =
    typeof event.keyCode === "number" && Number.isInteger(event.keyCode) ? event.keyCode : 0;
  if (!token(inputType, 40) || !token(code, 32) || keyCode < 0 || keyCode > 65535) return null;
  const safe = redactKey(code, keyCode);
  return {
    t: event.type as CaretDiagType,
    inputType,
    code: safe.code,
    keyCode: safe.keyCode,
    composing: event.isComposing === true,
  };
}

export function formatCaretDiagLine(record: CaretDiagRecord): string | null {
  if (
    !Number.isInteger(record.us) ||
    record.us < 0 ||
    !token(record.inputType, 40) ||
    !token(record.code, 32) ||
    !Number.isInteger(record.keyCode) ||
    record.keyCode < 0 ||
    record.keyCode > 65535 ||
    !offsets(record.before) ||
    !offsets(record.after) ||
    !count(record.doc) ||
    !count(record.block)
  ) {
    return null;
  }
  const safe = redactKey(record.code, record.keyCode);
  return JSON.stringify({
    t: record.t,
    us: record.us,
    inputType: record.inputType,
    code: safe.code,
    keyCode: safe.keyCode,
    composing: record.composing,
    before: record.before,
    after: record.after,
    doc: record.doc,
    block: record.block,
  });
}
