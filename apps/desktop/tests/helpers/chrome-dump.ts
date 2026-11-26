import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";

// /usr/bin/google-chrome is a shell wrapper that pipes stdio through cat, so a
// leftover child holds the dump pipe open. /usr/local is last: some images
// wrap it with a shared profile and a debugging port.
export const chrome = [
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/local/bin/google-chrome",
].find((path) => existsSync(path));

interface Dumped {
  stdout: string;
  stderr: string;
}

/** The serializer escapes these in an attribute value. `&amp;` goes last. */
function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Chrome prints --dump-dom and then keeps running if a bus or a child is
// still up. spawnSync waits for that exit, hits its timeout, and the shell
// wrapper has not forwarded the dump yet, so status is 0 and the attribute is
// missing. This returns as soon as the attribute arrives and kills the group.
function dumpDom(
  page: string,
  profile: string,
  found: RegExp,
  extraArgs: readonly string[],
): Promise<Dumped> {
  return new Promise((resolve, reject) => {
    // Chrome block-buffers stdout, so the dump stays in the buffer until the
    // browser exits. A bus that never replies keeps it alive, and the timeout
    // then sees an empty pipe. stdbuf flushes each write. Without --no-zygote
    // the zygote can sit forever and --dump-dom never prints (empty stderr).
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
      ...extraArgs,
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
      if (found.test(stdout)) finish();
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const events = child as unknown as EventEmitter;
    events.on("error", (error: Error) => finish(error));
    events.on("close", () => finish());
  });
}

/**
 * Loads `page` in headless Chrome and returns the JSON its script wrote to
 * `attribute` on the body. Call only when `chrome` is set.
 *
 * A killed Chrome leaves its profile lock, so each attempt gets a new profile
 * under `dir`. Only a dump that never carries the attribute is retried; the
 * caller's checks run once, on the first value that arrives.
 */
export async function readChromeDump<T>(
  page: string,
  dir: string,
  attribute: string,
  extraArgs: readonly string[] = [],
): Promise<T> {
  const found = new RegExp(`${attribute}="([^"]+)"`);
  const attempts = 3;
  let failure = `chrome dump missing ${attribute}`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const dumped = await dumpDom(page, join(dir, `chrome-${attempt}`), found, extraArgs);
      const match = found.exec(dumped.stdout);
      if (match) return JSON.parse(unescapeAttribute(match[1])) as T;
      failure = `chrome dump missing ${attribute}\n${dumped.stderr.slice(-1500)}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${failure}\n(after ${attempts} chrome dumps)`);
}
