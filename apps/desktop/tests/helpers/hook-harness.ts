/** Just enough of React to run a hook or a component body as a plain function in
 *  the node test runner: state slots by call order, refs, and effects that run after
 *  a render when their deps changed. Mock `react` with `reactHooks`, then call
 *  `renderOnce` each time the test wants the current output. */
type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined };

let slots: unknown[] = [];
let effectSlots = new Set<EffectSlot>();
let cursor = 0;
let due: (() => void)[] = [];

function depsChanged(
  before: readonly unknown[] | undefined,
  after: readonly unknown[] | undefined,
) {
  if (!before || !after || before.length !== after.length) return true;
  return after.some((value, index) => !Object.is(value, before[index]));
}

export const reactHooks = {
  useState: <T>(initial: T | (() => T)) => {
    const at = cursor++;
    if (!(at in slots))
      slots[at] = typeof initial === "function" ? (initial as () => T)() : initial;
    const set = (value: T | ((previous: T) => T)) => {
      slots[at] =
        typeof value === "function" ? (value as (previous: T) => T)(slots[at] as T) : value;
    };
    return [slots[at] as T, set] as const;
  },
  useRef: <T>(initial: T) => {
    const at = cursor++;
    if (!(at in slots)) slots[at] = { current: initial };
    return slots[at] as { current: T };
  },
  useCallback: <T>(callback: T, deps: readonly unknown[]) => {
    const at = cursor++;
    const memo = slots[at] as { callback: T; deps: readonly unknown[] } | undefined;
    if (memo && !depsChanged(memo.deps, deps)) return memo.callback;
    slots[at] = { callback, deps };
    return callback;
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const at = cursor++;
    const first = !(at in slots);
    if (first) {
      const created: EffectSlot = { deps: undefined, cleanup: undefined };
      slots[at] = created;
      effectSlots.add(created);
    }
    const slot = slots[at] as EffectSlot;
    if (!first && !depsChanged(slot.deps, deps)) return;
    due.push(() => {
      slot.cleanup?.();
      slot.cleanup = effect() ?? undefined;
      slot.deps = deps;
    });
  },
};

/** Call the hook or component with the state it has now, then run the effects whose
 *  deps changed. */
export function renderOnce<T>(render: () => T): T {
  cursor = 0;
  due = [];
  const out = render();
  const run = due;
  due = [];
  for (const effect of run) effect();
  return out;
}

/** Unmount: run each effect's cleanup, then forget every slot. */
export function unmountAll() {
  for (const slot of effectSlots) slot.cleanup?.();
  effectSlots = new Set();
  slots = [];
  cursor = 0;
  due = [];
}
