export const CODE_LENGTH = 8;

export type CodeDigits = string[];

export type CodeChange = {
  digits: CodeDigits;
  focus: number;
  submit: boolean;
};

export function blankDigits(): CodeDigits {
  return Array.from({ length: CODE_LENGTH }, () => "");
}

export function digitsFrom(code: string): CodeDigits {
  const digits = blankDigits();
  const found = code.replace(/\D/g, "").slice(0, CODE_LENGTH);
  for (let i = 0; i < found.length; i++) digits[i] = found[i] ?? "";
  return digits;
}

export function joinCode(digits: CodeDigits): string {
  return digits.join("");
}

function unchanged(digits: CodeDigits, focus: number): CodeChange {
  return { digits, focus, submit: false };
}

/** One digit. The 8th box submits. Anything else is ignored. */
export function typeDigit(digits: CodeDigits, index: number, key: string): CodeChange {
  if (!/^\d$/.test(key) || index < 0 || index >= CODE_LENGTH) return unchanged(digits, index);
  const next = digits.slice();
  next[index] = key;
  const submit = index === CODE_LENGTH - 1;
  return { digits: next, focus: submit ? index : index + 1, submit };
}

/** Backspace clears this box. On an empty box it clears the previous one. */
export function backspaceDigit(digits: CodeDigits, index: number): CodeChange {
  if (index < 0 || index >= CODE_LENGTH) return unchanged(digits, 0);
  const next = digits.slice();
  if (next[index]) {
    next[index] = "";
    return { digits: next, focus: index, submit: false };
  }
  if (index === 0) return unchanged(digits, 0);
  next[index - 1] = "";
  return { digits: next, focus: index - 1, submit: false };
}

/** A full 8-digit paste fills every box. Shorter pastes fill from the first box. */
export function pasteDigits(text: string): CodeChange {
  const digits = digitsFrom(text);
  const filled = joinCode(digits).length;
  if (filled === 0) return { digits, focus: 0, submit: false };
  return { digits, focus: Math.min(filled, CODE_LENGTH) - 1, submit: false };
}
