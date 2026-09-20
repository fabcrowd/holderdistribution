#!/usr/bin/env node
/**
 * Bundle the forensics gate for Netlify. Raw .ts with ESM imports 502s at
 * runtime ("Cannot use import statement outside a module"); esbuild → CJS fixes it.
 */
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "netlify/functions-src/forensics-gate.ts");
const outfile = path.join(root, "netlify/functions/forensics-gate.cjs");

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile,
  logLevel: "info",
});

console.log(`Bundled forensics gate → ${path.relative(root, outfile)}`);
