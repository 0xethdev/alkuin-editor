/**
 * One read of the server budget. The preferences status line and the margin's
 * hard-cap state both come from `readBudget`. Callers pass the numbers the
 * server already stored. They do not derive a second percentage.
 *
 * The bands follow the server's answer:
 * - a paid plan runs low near its soft cap
 * - Free stays plenty until the hard cap
 * - used once spent reaches the hard cap
 */
import {
  FREE_MONTH_LINE,
  FROZEN_LINE,
  HARD_CAP_LINE,
  PAID_CAP_LINE,
  PLENTY_MONTH_LINE,
  PLAN_FOUNDING,
  PLAN_FREE,
  PLAN_REDLINE,
  RESET_ON_LINE,
  RUNNING_LOW_MONTH_LINE,
} from "./margin-copy.ts";

export type PlanKind = "paid" | "founding" | "free";

export type BudgetBand = "plenty" | "running_low" | "used";

/** The budget as the server sends it. */
export type ServerBudget = {
  spent: number;
  softCap: number;
  hardCap: number;
  effective: PlanKind;
  windowEnd: string | null;
  /** The account is frozen. Preferences shows this instead of the budget line. */
  frozen?: boolean;
};

export type MarginBudgetState = {
  band: BudgetBand;
  /** Spent has reached the soft cap. */
  softReached: boolean;
  /** Spent has reached the hard cap. */
  hardCap: boolean;
  /** Calm line the margin shows. Null while the ask can still run. */
  line: string | null;
};

export type BudgetRead = {
  band: BudgetBand;
  statusLine: string;
  margin: MarginBudgetState;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function resetDateText(value: string | null): string {
  return englishDate(value);
}

function englishDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function fill(template: string, date: string): string {
  return template.replace("{date}", date).replace("{reset date}", date);
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Local date for a cap line, like `1 Nov 2026`. Empty when the instant cannot be read. */
export function capDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** Local `HH:MM` for a cap line. Empty when the instant cannot be read. */
export function capTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Fills `{date}` and `{time}`. A missing instant drops the clause and never leaves the token. */
export function fillHelpLine(template: string, resetsAt: string | null | undefined): string {
  const date = capDate(resetsAt);
  const time = capTime(resetsAt);
  let line = template;
  line = date ? line.replace("{date}", date) : line.replace(" on {date}", "").replace("{date}", "");
  line = time ? line.replace("{time}", time) : line.replace(" at {time}", "").replace("{time}", "");
  return line;
}

/**
 * The margin's hard-cap sentence. Preferences uses the shorter used line.
 * An unknown plan stays on that short line.
 */
export function usedMarginLine(windowEnd: string | null, plan?: string | null): string {
  if (plan === "free") return fillHelpLine(FREE_MONTH_LINE, windowEnd);
  if (plan === "paid" || plan === "founding") return fillHelpLine(PAID_CAP_LINE, windowEnd);
  return HARD_CAP_LINE;
}

function atLeast80(spent: number, cap: number): boolean {
  if (!Number.isSafeInteger(spent) || !Number.isSafeInteger(cap) || cap <= 0) return false;
  return spent * 100 >= cap * 80;
}

function bandOf(budget: ServerBudget): BudgetBand {
  if (budget.spent >= budget.hardCap) return "used";
  // Free hard-stops. A note before the cap would be a soft warn.
  if (budget.effective === "free") return "plenty";
  if (atLeast80(budget.spent, budget.softCap)) return "running_low";
  return "plenty";
}

function statusLine(band: BudgetBand): string {
  if (band === "used") return HARD_CAP_LINE;
  if (band === "running_low") return RUNNING_LOW_MONTH_LINE;
  return PLENTY_MONTH_LINE;
}

export function readBudget(budget: ServerBudget): BudgetRead {
  const band = bandOf(budget);
  const line = statusLine(band);
  const margin: MarginBudgetState = {
    band,
    softReached: budget.spent >= budget.softCap,
    hardCap: band === "used",
    line: band === "used" ? usedMarginLine(budget.windowEnd, budget.effective) : null,
  };
  return { band, statusLine: line, margin };
}

/** Preferences status line. Same read as `marginBudgetState`. */
export function preferencesStatusLine(budget: ServerBudget): string {
  if (budget.frozen) return FROZEN_LINE;
  return readBudget(budget).statusLine;
}

/** Margin soft-cap and hard-cap state. Same read as `preferencesStatusLine`. */
export function marginBudgetState(budget: ServerBudget): MarginBudgetState {
  return readBudget(budget).margin;
}

export function planLabel(effective: PlanKind): string {
  if (effective === "free") return PLAN_FREE;
  if (effective === "founding") return PLAN_FOUNDING;
  return PLAN_REDLINE;
}

export function dateLine(budget: Pick<ServerBudget, "windowEnd">): string {
  const date = englishDate(budget.windowEnd);
  return date ? fill(RESET_ON_LINE, date) : "";
}
