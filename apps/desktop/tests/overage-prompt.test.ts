import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react", async () => (await import("./helpers/hook-harness")).reactHooks);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { invoke } from "@tauri-apps/api/core";
import { renderOnce, unmountAll } from "./helpers/hook-harness";
// @ts-expect-error the prompt module is JSX and this test file sits outside that project
import { OveragePrompt } from "../src/components/overage-prompt";
import { noteWriterAsk } from "../src/lib/account-billing";
import type { AccountPreferences } from "../src/lib/tauri";

const mockedInvoke = vi.mocked(invoke);

type Node = ReactElement<{ children?: unknown; onClick?: () => void; disabled?: boolean }>;

function buttons(node: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, found);
    return found;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return found;
  const element = node as Node;
  if (element.type === "button") found.push(element);
  buttons(element.props.children, found);
  return found;
}

function render(): Node | null {
  return renderOnce(() => OveragePrompt()) as Node | null;
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const AT_ALLOWANCE = {
  signed_in: true,
  offline: false,
  effective: "paid",
  overage_prompt: true,
  overage_default_dollars: 20,
} as AccountPreferences;

beforeEach(() => {
  unmountAll();
  mockedInvoke.mockReset();
});

describe("overage prompt", () => {
  test("a look issued before the answer does not open the prompt again", async () => {
    const lateLook = deferred<AccountPreferences>();
    const saving = deferred<void>();
    const looks = [Promise.resolve(AT_ALLOWANCE), lateLook.promise];
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_preferences") return looks.shift() ?? Promise.resolve(AT_ALLOWANCE);
      if (command === "account_usage") return saving.promise;
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    const lighter = buttons(render())[0]!;
    noteWriterAsk();
    lighter.props.onClick?.();
    expect(buttons(render()).every((button) => button.props.disabled)).toBe(true);
    buttons(render())[1]!.props.onClick?.();
    saving.resolve();
    await settle();
    expect(render()).toBeNull();
    lateLook.resolve(AT_ALLOWANCE);
    await settle();
    expect(render()).toBeNull();
    const saves = mockedInvoke.mock.calls.filter(([command]) => command === "account_usage");
    expect(saves).toHaveLength(1);
  });

  test("a look after the answer still opens next month's prompt", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "account_preferences") return Promise.resolve(AT_ALLOWANCE);
      return Promise.resolve(undefined);
    });
    render();
    await settle();
    buttons(render())[0]!.props.onClick?.();
    await settle();
    expect(render()).toBeNull();
    noteWriterAsk();
    await settle();
    expect(render()).not.toBeNull();
  });
});
