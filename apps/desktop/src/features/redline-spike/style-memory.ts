import type { StyleItem } from "./style-items.ts";

/** Learned rules kept on this Mac. The preferences list reads this store. */
const KEY = "alkuin-style-memory";

export type LearnedStyleRule = {
  id: string;
  rule: string;
  why: string;
  scope: string;
  seen: number;
};

function ruleId(item: Pick<StyleItem, "id" | "scope" | "rule">): string {
  return item.id && item.id.length > 0 ? item.id : `${item.scope}:${item.rule}`;
}

function clean(value: unknown): LearnedStyleRule[] {
  if (!Array.isArray(value)) return [];
  const rules: LearnedStyleRule[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const item = row as Partial<LearnedStyleRule>;
    if (typeof item.id !== "string" || typeof item.rule !== "string") continue;
    if (typeof item.why !== "string" || typeof item.scope !== "string") continue;
    const seen = Number(item.seen);
    rules.push({
      id: item.id,
      rule: item.rule,
      why: item.why,
      scope: item.scope,
      seen: Number.isFinite(seen) ? seen : 0,
    });
  }
  return rules;
}

export function readStyleMemory(): LearnedStyleRule[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? clean(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeStyleMemory(rules: LearnedStyleRule[]): LearnedStyleRule[] {
  const next = clean(rules);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // The list still updates in memory for this open.
  }
  return next;
}

export function rememberStyleItems(items: StyleItem[]): LearnedStyleRule[] {
  return writeStyleMemory(
    items.map((item) => ({
      id: ruleId(item),
      rule: item.rule,
      why: item.why,
      scope: item.scope,
      seen: item.seen,
    })),
  );
}

export function forgetStyleRule(id: string): LearnedStyleRule[] {
  return writeStyleMemory(readStyleMemory().filter((rule) => rule.id !== id));
}

/** Drop one rule from the store, or from the list on screen when the store is empty. */
export function dropVisibleStyleRule(visible: StyleItem[], id: string): LearnedStyleRule[] {
  const stored = readStyleMemory();
  const base = stored.length > 0 ? stored : visible;
  return rememberStyleItems(base.filter((rule) => styleRuleKey(rule) !== id));
}

export function forgetAllStyle(): LearnedStyleRule[] {
  return writeStyleMemory([]);
}

export function styleRuleKey(item: Pick<StyleItem, "id" | "scope" | "rule">): string {
  return ruleId(item);
}
