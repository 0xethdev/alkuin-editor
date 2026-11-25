import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(desktopRoot, "dist");

// Attribution and the license texts may name the upstream project. Everything
// else a person can see in the built UI or the bundle config says Alkuin.
const ALLOWED_LINE = /built on Writer|GNU GENERAL PUBLIC LICENSE|Copyright \(C\)/;

const NATIVE_CHROME = [
  "src-tauri/src/lib.rs",
  "src-tauri/src/updater.rs",
  "src-tauri/src/writer_cli.rs",
  "src-tauri/src/commands/shell_install.rs",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function writerLines(text: string): string[] {
  return text.split("\n").filter((line) => /\bWriter\b/.test(line) && !ALLOWED_LINE.test(line));
}

describe("product name", () => {
  test("bundle config is Alkuin and does not publish the upstream updater", () => {
    const conf = JSON.parse(readFileSync(join(desktopRoot, "src-tauri/tauri.conf.json"), "utf8"));
    // The .app name, dock name, and macOS menu app name come from productName.
    // The identifier is the app-data folder. The first launch copies the
    // previous folder. The keychain item is not copied.
    expect(conf.productName).toBe("Alkuin");
    const appName = readFileSync(join(desktopRoot, "src/lib/app-name.ts"), "utf8");
    expect(appName).toContain(`export const APP_NAME = "${conf.productName}"`);
    expect(conf.identifier).toBe("app.alkuin.desktop");
    expect(conf.identifier.toLowerCase()).not.toContain("redline");
    expect(conf.app.windows[0].title).toBe("Alkuin");
    const plist = readFileSync(join(desktopRoot, "src-tauri/Info.plist"), "utf8");
    expect(plist).toContain("<key>CFBundleDisplayName</key>\n  <string>Alkuin</string>");
    expect(plist).toContain("<key>CFBundleName</key>\n  <string>Alkuin</string>");
    expect(plist).not.toMatch(/\bWriter\b/);
    expect(conf.bundle.createUpdaterArtifacts).toBe(false);
    expect(conf.plugins.updater.endpoints).toEqual(["https://updates.alkuin.app/latest.json"]);
    const host = new URL(conf.plugins.updater.endpoints[0]).host;
    expect(host.toLowerCase()).not.toContain("redline");
    const decoded = Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf8");
    expect(decoded).toContain("minisign public key: 2640ADD87A870767");
    const raw = readFileSync(join(desktopRoot, "src-tauri/tauri.conf.json"), "utf8");
    expect(raw).not.toMatch(/\bWriter\b/);
    expect(raw).not.toContain("joelbqz/writer-computer");
    expect(raw).not.toContain("REPLACE_WITH_UPDATER_PUBKEY");
    expect(raw).not.toContain("example.invalid");
  });

  test("native menu and dialog strings do not say Writer", () => {
    const offenders: string[] = [];
    for (const rel of NATIVE_CHROME) {
      for (const line of writerLines(readFileSync(join(desktopRoot, rel), "utf8"))) {
        // The help-text test names the forbidden word in order to reject it.
        if (line.includes('contains("Writer")')) continue;
        offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("built UI does not say Writer", () => {
    expect(existsSync(distRoot), "build the desktop UI with `vp build` in apps/desktop first").toBe(
      true,
    );
    const files = walk(distRoot).filter((path) => /\.(html|js|css|json|svg|txt)$/.test(path));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const path of files) {
      if (/\/(OFL|LICENSE|COPYING)/.test(path)) continue;
      for (const line of writerLines(readFileSync(path, "utf8"))) {
        offenders.push(`${path}: ${line.trim().slice(0, 180)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
