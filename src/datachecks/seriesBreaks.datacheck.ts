// Data check (npm run check:data): moved unchanged from src/lib/seriesBreaks.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClassificationChangelog } from "@/lib/classificationChangelog";
import { getSeriesBreaks } from "@/lib/seriesBreaks";

// check:data scope: HD_PROJECT is set by vitest.datacheck.config.ts ("" = every project).
const inScope = (...slugs: string[]) => !process.env.HD_PROJECT || slugs.includes(process.env.HD_PROJECT);

const day = (iso: string) => Date.parse(iso);

describe("committed feeds", () => {
  const load = (p: string) => JSON.parse(readFileSync(resolve(process.cwd(), p), "utf8")) as ClassificationChangelog;

  it.runIf(inScope("tel", "zebec-network"))("declare the known breaks and keep undeclared events untouched", () => {
    const tel = load("public/data/classification-changelog.json");
    const telBreaks = getSeriesBreaks(tel, ["retail.balance", "holderCount"], day("2026-09-01"));
    expect(telBreaks.map((b) => b.t)).toEqual([day("2026-09-29"), day("2026-10-03")]);
    const zbcn = load("public/data/zebec-network/classification-changelog.json");
    expect(getSeriesBreaks(zbcn, ["retail.balance"], day("2026-10-01")).map((b) => b.t)).toEqual([day("2026-10-26"), day("2026-10-28")]);
    expect(getSeriesBreaks(zbcn, ["retail.count"], day("2026-10-01")).map((b) => b.t)).toEqual([day("2026-10-28")]);
    expect(getSeriesBreaks(zbcn, ["cexBalance"], day("2026-10-01")).map((b) => b.t)).toEqual([day("2026-10-28")]);
    expect(tel.events.filter((e) => !e.breaksSeries).length).toBeGreaterThan(10);
  });
});
