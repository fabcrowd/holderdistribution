// Data check (npm run check:data): every project runs (or waives with a reason) each data set whose
// nightly job needs a capability read from data/ (forensicsRegistry: data/<slug>/forensics/wallet-flows.registry.json).
// Same test as the parity loop in scripts/lib/nightlyPlan.test.js, which keeps every other data set.
import { describe, expect, it } from "vitest";
import { nightlyPlan } from "../lib/nightlyPlan.js";

// check:data scope: HD_PROJECT is set by vitest.datacheck.config.ts ("" = every project).
const inScope = (...slugs) => !process.env.HD_PROJECT || slugs.includes(process.env.HD_PROJECT);

describe("parity: every project produces every data set", () => {
  const plan = nightlyPlan();
  const DATA_CAPABILITIES = ["forensicsRegistry"];
  const needsData = (ds) => plan.jobs.some((j) => j.dataset === ds && (j.requires ?? []).some((c) => DATA_CAPABILITIES.includes(c)));
  const datasets = [...new Set(plan.jobs.map((j) => j.dataset))].filter(needsData);

  for (const p of plan.projects) {
    for (const ds of datasets) {
      it.runIf(inScope(p.slug))(`${p.slug}: data set "${ds}" runs or is waived with a reason`, () => {
        const covering = plan.jobs.filter((j) => j.dataset === ds).map((j) => p.jobs.find((x) => x.id === j.id));
        const ok = covering.some((s) => s.status === "run" || (s.status === "waived" && s.reason.trim().length > 10));
        expect(ok, `${p.slug} ${ds}: ${JSON.stringify(covering)}`).toBe(true);
      });
    }
  }
});
