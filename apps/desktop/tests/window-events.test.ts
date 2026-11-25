import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vite-plus/test";

const windowListen = vi.hoisted(() => vi.fn(() => Promise.resolve(() => {})));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: windowListen }),
}));

import { listenInThisWindow } from "../src/lib/window-events";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("events Rust sends to one window", () => {
  test("are heard on this window, not on the app-wide listener", async () => {
    const handler = () => {};
    await listenInThisWindow("menu:export-pdf", handler);
    expect(windowListen).toHaveBeenCalledWith("menu:export-pdf", handler);
  });

  // With two windows open, the app-wide `listen` ran Export PDF in both.
  test("the menu, an opened file, and a refused invite link use it", () => {
    for (const file of [
      "hooks/use-menu-events.ts",
      "hooks/use-open-drop.ts",
      "features/document-share/invite-arrival.ts",
    ]) {
      const source = readFileSync(join(SRC, file), "utf8");
      expect(source, file).toMatch(/listenInThisWindow\(/);
      expect(source, file).not.toMatch(
        /import \{[^}]*\blisten\b[^}]*\} from "@tauri-apps\/api\/event"/,
      );
    }
  });

  // `listen` hears every window's events. Only an event sent with `emit` to the
  // whole app belongs on it. Add a file here with the event it listens for.
  test("the app-wide listener is used only where the event is app-wide", () => {
    const appWide = sourceFiles(SRC)
      .filter((path) =>
        /import \{[^}]*\blisten\b[^}]*\} from "@tauri-apps\/api\/event"/.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) =>
        path
          .slice(SRC.length + 1)
          .split("\\")
          .join("/"),
      )
      .sort();
    expect(appWide).toEqual([
      // Watcher events carry their workspace, and every handler checks it
      // against this window's before acting.
      "hooks/use-file-watcher.ts",
      // account:checkout-return, sent with `app.emit`.
      "lib/account-plan-refresh.ts",
    ]);
  });
});
