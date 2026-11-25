import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// Preferences reads these. The release script sets them; `vp dev` fills
// the gaps from git and tauri.conf.json so a local run shows the same line.
function bakeBuildStamp(): void {
  if (!process.env.ALKUIN_APP_VERSION) {
    try {
      const conf = JSON.parse(
        readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"),
      ) as { version?: string };
      if (typeof conf.version === "string" && conf.version) {
        process.env.ALKUIN_APP_VERSION = conf.version;
      }
    } catch {
      // The footer still says Version.
    }
  }
  const given = process.env.ALKUIN_GIT_COMMIT?.trim() ?? "";
  if (/^[0-9a-f]{7,40}$/i.test(given)) {
    process.env.ALKUIN_GIT_COMMIT = given.slice(0, 7).toLowerCase();
  } else {
    try {
      const sha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
        encoding: "utf8",
      }).trim();
      if (/^[0-9a-f]{7,40}$/i.test(sha)) {
        process.env.ALKUIN_GIT_COMMIT = sha.slice(0, 7).toLowerCase();
      }
    } catch {
      // A tree without git omits the commit.
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(process.env.ALKUIN_BUILD_DATE ?? "")) {
    process.env.ALKUIN_BUILD_DATE = new Date().toISOString().slice(0, 10);
  }
}

bakeBuildStamp();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react({
      jsxImportSource: "@welldone-software/why-did-you-render",
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "@shared": new URL("./shared", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  // Only VITE_ names reach the bundle by prefix. Each ALKUIN_ name the webview
  // reads is defined below by name, so another ALKUIN_ variable in the build
  // shell (a token, say) is never copied into the shipped JavaScript.
  // `vp run dev` forwards ALKUIN_CARET_DIAG, so the webview is lit before Rust answers.
  define: {
    "import.meta.env.ALKUIN_APP_VERSION": JSON.stringify(process.env.ALKUIN_APP_VERSION ?? ""),
    "import.meta.env.ALKUIN_GIT_COMMIT": JSON.stringify(process.env.ALKUIN_GIT_COMMIT ?? ""),
    "import.meta.env.ALKUIN_BUILD_DATE": JSON.stringify(process.env.ALKUIN_BUILD_DATE ?? ""),
    "import.meta.env.ALKUIN_CARET_DIAG": JSON.stringify(process.env.ALKUIN_CARET_DIAG ?? ""),
  },
  build: {
    // Fonts ship as files. The CSP has no font-src, so a data: font would be blocked.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
