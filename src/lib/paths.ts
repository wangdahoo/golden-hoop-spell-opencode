// Plugin root resolution.
//
// `import.meta.dir` is Bun's canonical primitive for "the directory of the
// current source file". This file lives at `src/lib/paths.ts`, so two levels
// up is the plugin package root (the directory containing `src/index.ts` and
// `shared/`). We use this instead of `process.cwd()` or `__dirname` because:
//
//   - `process.cwd()` is the *host project's* working directory, not the
//     plugin's install location — using it would resolve assets relative to
//     the wrong tree entirely.
//   - `__dirname` is a CommonJS construct; this package is `"type": "module"`.
//
// Spike 001 confirmed `import.meta.dir` works under Bun + opencode runtime.

import { resolve } from "node:path";

/**
 * Returns the absolute path to the directory containing `src/index.ts` —
 * i.e. the plugin package root. Under that root live `src/`, `shared/`,
 * `package.json`, etc.
 */
export function pluginRoot(): string {
  // `import.meta.dir` = absolute path to `src/lib/` (this file's directory).
  // Two `..` segments climb to the plugin package root.
  return resolve(import.meta.dir, "..", "..");
}
