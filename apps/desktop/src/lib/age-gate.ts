// Neutral age screen for a new account, after its sign-in code. The email and
// the code come first for everyone; an address that already has an account
// signs in with nothing more. When /verify finds no account it holds the
// sign-in and asks for the date of birth, so the server says whether an
// address has an account only to the person who typed its code. The question
// never shows the cutoff. An under-age answer is refused by the server, which
// erases the bare sign-in, and blocks sign-up on this device for a day, so
// changing the answer straight away doesn't get round it. The date is sent
// once, only so the server can run this check, and is not stored.
//
// The website asks the same question with the same MINIMUM_AGE, and the two
// modules are the same from AGE_BLOCK_KEY on.

export const MINIMUM_AGE = 16;
export const AGE_BLOCK_KEY = "alkuin_age_block";
export const AGE_BLOCK_MS = 24 * 60 * 60 * 1000;

export const AGE_LABEL = "Date of birth";
export const AGE_INVALID = "Enter your date of birth.";
export const AGE_BLOCKED = "Sorry, you can't create an Alkuin account.";
/** Above the date, after the code, for an address with no account. Not yet through Copy. */
export const AGE_STEP_PROMPT = "New to Alkuin? Enter your date of birth to create your account.";

/** "blocked" for a day after an under-age answer on this device. */
export type AgeState = "ok" | "blocked";
export type AgeAnswer = "ok" | "under" | "invalid";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whole years on `today` for a `YYYY-MM-DD` value, or null when it isn't a real past date. */
export function ageOn(value: string, today: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  let age = today.getFullYear() - year;
  const beforeBirthday =
    today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

export function ageAnswer(value: string, today: Date, minimum = MINIMUM_AGE): AgeAnswer {
  const age = ageOn(value, today);
  if (age === null) return "invalid";
  return age >= minimum ? "ok" : "under";
}

/** "blocked" for a day after an under-age answer on this device, so the date step refuses at once. */
export function ageState(store: Store | null = browserStore(), now = Date.now()): AgeState {
  try {
    const blockedAt = Number(store?.getItem(AGE_BLOCK_KEY) ?? "");
    if (Number.isFinite(blockedAt) && blockedAt > 0 && now - blockedAt < AGE_BLOCK_MS)
      return "blocked";
  } catch {
    // Storage blocked: nothing was kept.
  }
  return "ok";
}

/** Keeps an under-age answer. It holds even when storage fails: the caller shows it for this session. */
export function rememberUnderAge(store: Store | null = browserStore(), now = Date.now()) {
  try {
    store?.setItem(AGE_BLOCK_KEY, String(now));
  } catch {
    // Storage blocked: the answer applies to this session only.
  }
}
