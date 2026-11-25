import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const chrome = [
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/local/bin/google-chrome",
].find((path) => existsSync(path));

type Anchor = { id: string; dy: number | null };
type Measure = {
  pane: number;
  text: number;
  textCh: number | null;
  sidebar: number | null;
  gap: number | null;
  insetRight: number | null;
  glyphGap: number | null;
  overflowX: number;
  anchors: Anchor[];
};

let server: ViteDevServer;
let base = "";

beforeAll(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  server = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 4178, strictPort: true },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : 4178;
  base = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  await server?.close();
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function load(
  query: string,
  width: number,
): Promise<{ measure: Measure; before: Anchor[] | null }> {
  await fetch(`${base}/screenshot.html?${query}`);
  const dir = mkdtempSync(join(tmpdir(), "margin-anchor-"));
  const port = 9300 + (width % 50);
  const child: ChildProcess = spawn(
    chrome!,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--disable-extensions",
      "--no-proxy-server",
      "--proxy-bypass-list=<-loopback>",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      "about:blank",
    ],
    {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        NO_PROXY: "*",
      },
    },
  );
  const stop = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  try {
    let version: { webSocketDebuggerUrl: string } | null = null;
    for (let i = 0; i < 50 && !version; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) version = (await res.json()) as { webSocketDebuggerUrl: string };
      } catch {
        await sleep(100);
      }
    }
    if (!version) throw new Error("chrome did not open a debugging port");
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("chrome socket failed")), {
        once: true,
      });
    });
    let next = 1;
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (!msg.id || !pending.has(msg.id)) return;
      const waiter = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
    const send = (method: string, params: object = {}, sessionId?: string) => {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    };
    const created = (await send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const attached = (await send("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };
    const session = attached.sessionId;
    await send("Page.enable", {}, session);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: 1100, deviceScaleFactor: 1, mobile: false },
      session,
    );
    await send("Page.navigate", { url: `${base}/screenshot.html?${query}` }, session);
    let raw = "";
    let prior = "";
    let detail = "";
    for (let i = 0; i < 80 && !raw; i++) {
      const result = (await send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const body = document.body;
            if (!body) return "";
            if (body.dataset.shotError) return "ERR " + body.dataset.shotError;
            if (body.dataset.shotReady === "1") return "OK " + body.dataset.measure + "\\n" + (body.dataset.measureBefore || "");
            return "";
          })()`,
          returnByValue: true,
        },
        session,
      )) as { result?: { value?: string } };
      const value = result.result?.value ?? "";
      if (value.startsWith("ERR ")) throw new Error(value.slice(4));
      if (value.startsWith("OK ")) {
        const [measure, before] = value.slice(3).split("\n");
        raw = measure;
        prior = before;
      } else {
        await sleep(250);
      }
    }
    if (!raw) {
      const probe = (await send(
        "Runtime.evaluate",
        {
          expression:
            "document.body ? (document.body.dataset.shotBoot || 'no-boot') + ' ' + location.href : 'no-body'",
          returnByValue: true,
        },
        session,
      )) as { result?: { value?: string } };
      detail = probe.result?.value ?? "";
    }
    socket.close();
    if (!raw) throw new Error(`shot not ready (${detail})`);
    return {
      measure: JSON.parse(raw) as Measure,
      before: prior ? (JSON.parse(prior) as Anchor[]) : null,
    };
  } finally {
    stop();
  }
}

function anchored(anchors: Anchor[]) {
  expect(anchors.length).toBe(4);
  for (const anchor of anchors) {
    expect(anchor.dy, anchor.id).not.toBeNull();
    expect(Math.abs(anchor.dy!), anchor.id).toBeLessThan(2);
  }
}

test.skipIf(!chrome)(
  "at 1100px the unit cannot center and the rail does not overlap the draft",
  async () => {
    const { measure } = await load("shot=margin", 1100);
    expect(measure.sidebar).toBe(268);
    expect(measure.textCh).toBeLessThan(75);
    expect(measure.text).toBeGreaterThan(80);
    expect(measure.insetRight).toBeLessThan(1);
    expect(measure.gap).toBeGreaterThan(80);
    expect(measure.glyphGap).toBeGreaterThan(8);
    expect(measure.overflowX).toBeLessThan(2);
    anchored(measure.anchors);
  },
  100_000,
);

test.skipIf(!chrome)(
  "notes stay on their passages after the window grows",
  async () => {
    const { measure, before } = await load("shot=margin&resize=1", 1920);
    expect(before).toBeTruthy();
    anchored(before!);
    anchored(measure.anchors);
    expect(measure.sidebar).toBe(268);
    expect(measure.textCh).toBeGreaterThan(74);
    expect(measure.textCh).toBeLessThan(76);
    expect(measure.insetRight).toBeGreaterThan(100);
    expect(measure.gap).toBeGreaterThan(80);
    expect(measure.gap).toBeLessThan(110);
    expect(measure.glyphGap).toBeGreaterThan(8);
    expect(measure.overflowX).toBeLessThan(2);
  },
  100_000,
);
