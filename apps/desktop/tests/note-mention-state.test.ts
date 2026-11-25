import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { mentionPeopleLoader } from "../src/features/note-mention/client";
import {
  forgetMentionDots,
  refreshMentionDots,
  waitingOnPath,
} from "../src/features/note-mention/dot-state";
import type { AccessPerson } from "../src/features/note-mention/logic";
import { mentionEmailControl } from "../src/features/note-mention/preference-state";

const mockedInvoke = vi.mocked(invoke);

const PAUL: AccessPerson = {
  id: "paul",
  email: "paul@example.com",
  name: "Paul",
  role: "accepted",
};

describe("mention picker load", () => {
  test("loading is not 'nobody accepted', and a failed load is asked again", async () => {
    const answers = [
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve({ macOnly: false, people: [PAUL] }),
    ];
    const load = vi.fn((_path: string) => answers.shift()!());
    const loader = mentionPeopleLoader("/docs/a.md", load);
    const ready = vi.fn();
    expect(loader.current().kind).toBe("idle");

    loader.ensure(ready);
    expect(loader.current().kind).toBe("loading");
    loader.ensure(ready);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(loader.current().kind).toBe("failed"));
    expect(ready).not.toHaveBeenCalled();

    loader.ensure(ready);
    await vi.waitFor(() => expect(loader.current().kind).toBe("ready"));
    expect(load).toHaveBeenCalledTimes(2);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(loader.current()).toEqual({ kind: "ready", macOnly: false, people: [PAUL] });

    loader.ensure(ready);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("sidebar mention dots", () => {
  const PATH = "/docs/harbor.md";

  function dotsServer() {
    let release: (rows: unknown) => void = () => {};
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "mention_document_ids") return [{ path: PATH, document_id: "doc-1" }];
      if (command === "mention_open") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return undefined;
    });
    return { answer: (rows: unknown) => release(rows) };
  }

  test("sign-out clears the dots at once", async () => {
    const server = dotsServer();
    const read = refreshMentionDots([PATH]);
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("mention_open"));
    server.answer([{ id: "row", document_id: "doc-1" }]);
    await read;
    expect(waitingOnPath(PATH)).toBe(true);
    forgetMentionDots();
    expect(waitingOnPath(PATH)).toBe(false);
  });

  test("a read for the last account that lands after sign-out is dropped", async () => {
    mockedInvoke.mockClear();
    const server = dotsServer();
    const read = refreshMentionDots([PATH]);
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("mention_open"));
    forgetMentionDots();
    server.answer([{ id: "row", document_id: "doc-1" }]);
    await read;
    expect(waitingOnPath(PATH)).toBe(false);
  });
});

describe("mention email switch", () => {
  function saves() {
    const pending: { resolve: () => void; reject: () => void }[] = [];
    const save = vi.fn(
      (_on: boolean) =>
        new Promise<void>((resolve, reject) => pending.push({ resolve, reject: () => reject() })),
    );
    return { save, next: () => pending.shift()! };
  }

  test("the first read does not undo a flip made before it landed", () => {
    const shown: boolean[] = [];
    const { save } = saves();
    const control = mentionEmailControl((on) => shown.push(on), save);
    control.toggle(false);
    control.loaded(true);
    expect(shown).toEqual([false]);
    expect(save).toHaveBeenCalledWith(false);
  });

  test("an untouched switch shows the read", () => {
    const shown: boolean[] = [];
    const control = mentionEmailControl((on) => shown.push(on), saves().save);
    control.loaded(false);
    expect(shown).toEqual([false]);
  });

  test("only the latest failed save rolls back, to what the server last confirmed", async () => {
    const shown: boolean[] = [];
    const server = saves();
    const control = mentionEmailControl((on) => shown.push(on), server.save);
    control.loaded(true);
    control.toggle(false);
    control.toggle(true);
    const first = server.next();
    const second = server.next();
    first.reject();
    await Promise.resolve();
    await Promise.resolve();
    expect(shown).toEqual([true, false, true]);
    second.reject();
    await vi.waitFor(() => expect(shown).toEqual([true, false, true, true]));
  });

  test("nothing shows after the session closes", async () => {
    const shown: boolean[] = [];
    const server = saves();
    const control = mentionEmailControl((on) => shown.push(on), server.save);
    control.toggle(false);
    control.close();
    server.next().reject();
    control.loaded(true);
    await Promise.resolve();
    expect(shown).toEqual([false]);
  });
});
