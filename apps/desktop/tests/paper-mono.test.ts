import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
const css = readFileSync(new URL("../src/fonts/paper-mono.css", import.meta.url), "utf8");
const ofl = readFileSync(new URL("../public/fonts/paper-mono/OFL.txt", import.meta.url), "utf8");
const scribble = readFileSync(
  new URL("../src/features/redline-spike/redline-spike.css", import.meta.url),
  "utf8",
);

describe("Paper Mono", () => {
  test("loads the local face and keeps the OFL beside it", () => {
    expect(css).toContain('font-family: "Paper Mono"');
    expect(css).toContain('url("/fonts/paper-mono/PaperMono-wght.woff2")');
    expect(css).not.toMatch(/https?:/);
    expect(
      existsSync(
        fileURLToPath(new URL("../public/fonts/paper-mono/PaperMono-wght.woff2", import.meta.url)),
      ),
    ).toBe(true);
    expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(scribble).toContain('--redline-scribble: "Nothing You Could Do"');
    const handLicence = readFileSync(
      new URL("../src/features/redline-spike/fonts/OFL.txt", import.meta.url),
      "utf8",
    );
    expect(handLicence).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(handLicence).toContain("Kimberly Geswein");
  });

  test("draft text does not enable stylistic sets or metric overrides", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/ss0[123]/);
    expect(rules).not.toMatch(/font-feature-settings/);
    expect(rules).not.toMatch(
      /font-kerning|text-rendering|font-variant-ligatures|optimizeLegibility/,
    );
  });
});

// /usr/bin/google-chrome is a shell wrapper that pipes stdio through cat, so a
// leftover child holds the dump pipe open. /usr/local is last: some images
// wrap it with a shared profile and a debugging port.
const chrome = [
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/local/bin/google-chrome",
].find((path) => existsSync(path));

// Chrome prints --dump-dom and then keeps running if a bus or a child is
// still up. spawnSync waits for that exit, hits 15s, and the shell wrapper
// has not forwarded the dump yet, so status is 0 and the attribute is missing.
function dumpDom(page: string, profile: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // dump-dom is about 2.6KB. Chrome block-buffers stdout, so the dump stays
    // in the buffer until the browser exits. A bus that never replies keeps
    // it alive, and the 15s timeout then sees an empty pipe. stdbuf flushes
    // each write. /usr/bin/google-chrome's cat wrapper has the same hole.
    const chromeArgs = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-sync",
      "--disable-breakpad",
      "--no-zygote",
      "--password-store=basic",
      "--use-mock-keychain",
      `--user-data-dir=${profile}`,
      "--dump-dom",
      page,
    ];
    const stdbuf = "/usr/bin/stdbuf";
    const child: ChildProcess = spawn(
      existsSync(stdbuf) ? stdbuf : chrome!,
      existsSync(stdbuf) ? ["-o0", "-e0", chrome!, ...chromeArgs] : chromeArgs,
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: "disabled:",
          DBUS_SYSTEM_BUS_ADDRESS: "disabled:",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    // A cold runner was still inside chrome_main at 8s and had not printed
    // the dump by 15s. The fast path returns when the attribute arrives.
    const timer = setTimeout(() => {
      finish(new Error(`chrome dump timed out\n${stderr.slice(-1500)}`));
    }, 30_000);
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      finish(new Error("chrome stdio missing"));
      return;
    }
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
      if (/data-features="([^"]+)"/.test(stdout)) finish();
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const events = child as unknown as EventEmitter;
    events.on("error", (error: Error) => finish(error));
    events.on("close", () => finish());
  });
}

test.skipIf(!chrome)(
  "computed font-feature-settings stay off the chrome",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "paper-mono-"));
    try {
      const page = join(dir, "features.html");
      const profile = join(dir, "chrome");
      writeFileSync(
        page,
        `<!doctype html><meta charset="utf-8"><style>
      :root { font-family: "Paper Mono", ui-monospace, monospace; }
      ${css}
    </style>
    <div class="cm-editor">
      <div class="cm-content" id="draft">Draft line</div>
      <div class="cm-redline-gutter" id="gutter"><span id="note-label" class="cm-redline-note-label">note</span></div>
    </div>
    <aside id="sidebar">Files</aside>
    <div id="tab" role="tab">room</div>
    <label id="label">Font</label>
    <script>
      const read = (id) => getComputedStyle(document.getElementById(id));
      const pack = (id) => ({ features: read(id).fontFeatureSettings, family: read(id).fontFamily });
      document.body.dataset.features = JSON.stringify({
        draft: pack("draft"),
        gutter: pack("gutter"),
        label: pack("note-label"),
        sidebar: pack("sidebar"),
        tab: pack("tab"),
        field: pack("label"),
      });
    </script>`,
      );
      const dumped = await dumpDom(page, profile);
      const match = dumped.stdout.match(/data-features="([^"]+)"/);
      expect(match, dumped.stderr.slice(-1500)).toBeTruthy();
      const features = JSON.parse(
        match![1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
      ) as Record<string, { features: string; family: string }>;
      expect(features.draft.features).toBe("normal");
      expect(features.draft.family).toContain("Paper Mono");
      for (const id of ["gutter", "label", "sidebar", "tab", "field"] as const) {
        expect(features[id].features).toBe("normal");
        expect(features[id].family).toContain("Paper Mono");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  40_000,
);
