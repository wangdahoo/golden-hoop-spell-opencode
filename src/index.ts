// Plugin entry — default-exported re-export of the `ghsPlugin` Plugin function
// defined in `src/plugin.ts`.
//
// `package.json` points `main` at this file (`src/index.ts`); OpenCode's
// plugin loader resolves the module, takes the default export, and invokes
// it as the plugin's `server` function. The actual Plugin implementation
// lives in `plugin.ts` to keep this entry focused on module resolution.

export { ghsPlugin as default } from "./plugin.ts";
