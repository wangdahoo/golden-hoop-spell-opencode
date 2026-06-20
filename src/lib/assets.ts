// Read plugin-bundled text assets (templates, default config, fixtures) from
// `<pluginRoot>/shared/<relativePath>`.
//
// Assets are shipped with the npm package (see `package.json` `files:
// ["src","shared"]`). They are read at runtime — not inlined — so a plugin
// upgrade picks up new asset content without a rebuild.
//
// `loadAsset` is the single entry point for reading these files; callers
// should not reach for `Bun.file`/`fs.readFile` against the shared tree
// directly, so that the root-resolution strategy stays in one place.

import { resolve } from "node:path";
import { pluginRoot } from "./paths";

/**
 * Read a text asset relative to `<pluginRoot>/shared/`.
 *
 * @param name - asset path relative to `shared/`, e.g. `"assets/features.json"`
 *               or `"ghs.default.json"`.
 * @returns the file's UTF-8 contents.
 * @throws {Error} if the file does not exist or cannot be read.
 */
export async function loadAsset(name: string): Promise<string> {
  const filePath = resolve(pluginRoot(), "shared", name);
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`Asset not found: ${filePath}`);
  }
  return file.text();
}
