/**
 * `npm run check:data`: the checks that assert the real generated data (public/data/, data/). They are
 * kept out of `npm test` (vite.config.ts include) so the unit suite passes in a checkout without those
 * folders. Files: scripts/datachecks/*.datacheck.js, src/datachecks/*.datacheck.ts.
 *
 * Project choice works like the pipeline scripts: `--project <slug>` or HD_PROJECT, default every
 * project. The run is one vitest project named after that slug ("all" by default), so vitest's own
 * `--project` filter matches it; HD_PROJECT reaches the checks, which skip other projects' cases.
 */
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";
import { parseProjectArg, resolveProject } from "./scripts/lib/projects.js";

const DATACHECKS = ["scripts/datachecks/**/*.datacheck.js", "src/datachecks/**/*.datacheck.ts"];

const asked = process.argv.some((a) => a === "--project" || a.startsWith("--project=")) || Boolean(process.env.HD_PROJECT?.trim());
// resolveProject throws on a slug that is not in config/projects.json, so a typo fails loudly.
const slug: string = asked ? resolveProject(parseProjectArg(process.argv.slice(2))).slug : "";

export default defineConfig((env) => {
  const { resolve } = viteConfig(env);
  return {
    resolve,
    test: {
      include: DATACHECKS,
      projects: [
        {
          resolve,
          test: { name: slug || "all", environment: "node", globals: true, include: DATACHECKS, env: { HD_PROJECT: slug } },
        },
      ],
    },
  };
});
