/**
 * Bundles the modular TypeScript source into a single deployable file.
 * Output: dist/opentalk.js — a standalone JS file ready for OpenCode.
 */
import * as esbuild from "esbuild"
import { mkdirSync } from "node:fs"

mkdirSync("dist", { recursive: true })

await esbuild.build({
  entryPoints: ["src/opentalk.ts"],
  outfile: "dist/opentalk.js",
  bundle: true,
  format: "esm",
  target: "esnext",
  // Bundle everything but mark @opencode-ai/plugin as external
  // (it's provided by the OpenCode runtime)
  external: [
    "node:path",
    "node:os",
    "node:fs",
  ],
  // Keep the banner as a comment so it's clear this is built
  banner: {
    js: "// OpenTalk — bundled plugin (auto-generated, do not edit directly)",
  },
}).then(() => {
  console.log("✓ dist/opentalk.js built")
}).catch((err) => {
  console.error("Build failed:", err)
  process.exit(1)
})
