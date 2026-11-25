import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      ".wrangler/**",
      // Byte-exact files: tests or include! read them verbatim.
      "apps/desktop/src-tauri/src/pdf_widths.inc",
      "apps/desktop/src-tauri/src/tutorial*.md",
    ],
  },
  lint: {
    ignorePatterns: [".wrangler/**"],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: ["apps/desktop", "packages/*"],
  },
});
