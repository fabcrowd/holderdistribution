// Data check (npm run check:data): TEL's legacy data root holds its feed. The one data assertion of
// "data dirs: TEL keeps the legacy root, others get public/data/<slug>" in scripts/lib/projects.test.js.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { projectDataDir } from "../lib/projects.js";

// check:data scope: HD_PROJECT is set by vitest.datacheck.config.ts ("" = every project).
const inScope = (...slugs) => !process.env.HD_PROJECT || slugs.includes(process.env.HD_PROJECT);

const root = path.resolve(".");

describe.runIf(inScope("tel"))("project registry (node side)", () => {
  it("data dirs: TEL's legacy root holds holders-lite.json", () => {
    expect(fs.existsSync(path.join(root, projectDataDir("tel", root), "holders-lite.json"))).toBe(true);
  });
});
