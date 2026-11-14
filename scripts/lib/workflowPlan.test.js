import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadRegistry, resolveProject } from "./projects.js";
import {
  workflowMatrix,
  workflowPlan,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_HOLDERS_SCAN_TIMEOUT_MINUTES,
  DEFAULT_HOLDERS_RETRY_TIMEOUT_MINUTES,
} from "../workflow-paths.js";

/**
 * The registry-driven refresh (.github/workflows/refresh-holders.yml) takes
 * its project list and every per-project stage difference from these helpers,
 * so onboarding a token is config only (docs/MULTI-TOKEN.md "Onboarding").
 */
const repo = path.resolve(".");
/** Registered slugs in registry order (registering a token must not break this file). */
const registered = loadRegistry(repo).map((p) => p.slug);

describe("workflowMatrix", () => {
  it("all: every registered project, default (TEL) first, with its configured timeout", () => {
    const { include, skipped } = workflowMatrix("all", repo);
    expect(skipped).toEqual([]);
    expect(include.map((p) => p.slug)).toEqual(registered);
    expect(registered[0]).toBe("tel");
    const configured = include.map((p) => resolveProject(p.slug, repo).config?.pipeline?.workflowTimeoutMinutes);
    expect(include.map((p) => p.timeout)).toEqual(configured);
    expect(include[0].ticker).toBe("TEL");
  });

  it("job holders: default first, then holdersTimeout ascending (stable), every project present", () => {
    const { include, skipped } = workflowMatrix("all", repo, { job: "holders" });
    expect(skipped).toEqual([]);
    const slugs = include.map((p) => p.slug);
    expect(slugs[0]).toBe("tel");
    const rest = include.slice(1);
    expect(rest.map((p) => p.holdersTimeout)).toEqual(rest.map((p) => p.holdersTimeout).sort((a, b) => a - b));
    expect([...slugs].sort()).toEqual([...registered].sort());
  });

  it("empty or missing selection means all (scheduled runs have no inputs)", () => {
    expect(workflowMatrix("", repo).include).toHaveLength(registered.length);
    expect(workflowMatrix(undefined, repo).include).toHaveLength(registered.length);
  });

  it("a slug selects exactly that project; an unknown slug throws", () => {
    expect(workflowMatrix("zebec-network", repo).include.map((p) => p.slug)).toEqual(["zebec-network"]);
    expect(() => workflowMatrix("nope", repo)).toThrow(/unknown project "nope"/);
  });

  it("a broken project config is skipped under all (never blocks the others) but fails when named", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-matrix-"));
    try {
      fs.mkdirSync(path.join(tmp, "config/projects"), { recursive: true });
      fs.copyFileSync(path.join(repo, "config/projects.json"), path.join(tmp, "config/projects.json"));
      fs.copyFileSync(path.join(repo, "config/projects/tel.json"), path.join(tmp, "config/projects/tel.json"));
      // Every registered project but tel is registered while its config file is missing here.
      const out = workflowMatrix("all", tmp);
      expect(out.include.map((p) => p.slug)).toEqual(["tel"]);
      expect(out.skipped.map((p) => p.slug)).toEqual(registered.filter((s) => s !== "tel"));
      expect(() => workflowMatrix("zebec-network", tmp)).toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to a default timeout when the project sets none", () => {
    expect(DEFAULT_TIMEOUT_MINUTES).toBe(60);
  });
});

/** Temp registry root: `defs` = [{slug, default?, pipeline?}] in registry order. */
function withRegistry(defs, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-matrix-synth-"));
  try {
    fs.mkdirSync(path.join(tmp, "config/projects"), { recursive: true });
    fs.copyFileSync(path.join(repo, "config/nightly-jobs.json"), path.join(tmp, "config/nightly-jobs.json"));
    const projects = defs.map((d) => ({ slug: d.slug, name: d.slug, ticker: d.slug.toUpperCase(), ...(d.default ? { default: true } : {}), legacyRoot: d.default === true }));
    fs.writeFileSync(path.join(tmp, "config/projects.json"), JSON.stringify({ projects }));
    for (const d of defs) {
      const config = { slug: d.slug, name: d.slug, ticker: d.slug.toUpperCase(), data: { legacyRoot: d.default === true, dir: d.default ? "public/data" : `public/data/${d.slug}` }, pipeline: d.pipeline ?? {} };
      fs.writeFileSync(path.join(tmp, "config/projects", `${d.slug}.json`), JSON.stringify(config));
    }
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("holders scan step timeouts", () => {
  it("defaults are 20 and 35", () => {
    expect(DEFAULT_HOLDERS_SCAN_TIMEOUT_MINUTES).toBe(20);
    expect(DEFAULT_HOLDERS_RETRY_TIMEOUT_MINUTES).toBe(35);
  });

  it("every registered project without holdersScanTimeoutMinutes emits the defaults", () => {
    for (const p of workflowMatrix("all", repo, { job: "holders" }).include) {
      const configured = resolveProject(p.slug, repo).config?.pipeline?.holdersScanTimeoutMinutes;
      expect(p.holdersTimeout).toBe(configured ?? DEFAULT_HOLDERS_SCAN_TIMEOUT_MINUTES);
      expect(p.holdersRetryTimeout).toBe(DEFAULT_HOLDERS_RETRY_TIMEOUT_MINUTES);
    }
  });

  it("emits a configured holdersScanTimeoutMinutes", () => {
    withRegistry([{ slug: "a", default: true }, { slug: "b", pipeline: { workflowTimeoutMinutes: 180, holdersScanTimeoutMinutes: 100 } }], (root) => {
      const b = workflowMatrix("b", root, { job: "holders" }).include[0];
      expect(b).toMatchObject({ timeout: 180, holdersTimeout: 100, holdersRetryTimeout: 35 });
    });
  });

  it("orders default first, then by holdersTimeout ascending, ties in registry order", () => {
    withRegistry(
      [
        { slug: "slow", pipeline: { workflowTimeoutMinutes: 180, holdersScanTimeoutMinutes: 100 } },
        { slug: "tel", default: true, pipeline: { workflowTimeoutMinutes: 90 } },
        { slug: "t1" },
        { slug: "mid", pipeline: { workflowTimeoutMinutes: 120, holdersScanTimeoutMinutes: 40 } },
        { slug: "t2", pipeline: { workflowTimeoutMinutes: 75 } },
      ],
      (root) => {
        expect(workflowMatrix("all", root, { job: "holders" }).include.map((p) => p.slug)).toEqual(["tel", "t1", "t2", "mid", "slow"]);
      },
    );
  });

  it("a default project with a long scan still runs first", () => {
    withRegistry([{ slug: "x" }, { slug: "d", default: true, pipeline: { workflowTimeoutMinutes: 180, holdersScanTimeoutMinutes: 100 } }], (root) => {
      expect(workflowMatrix("all", root, { job: "holders" }).include.map((p) => p.slug)).toEqual(["d", "x"]);
    });
  });

  it("guard: steps that do not fit the job timeout skip the project under all and throw when named, naming both keys", () => {
    withRegistry([{ slug: "tel", default: true }, { slug: "bad", pipeline: { workflowTimeoutMinutes: 90, holdersScanTimeoutMinutes: 60 } }], (root) => {
      const out = workflowMatrix("all", root, { job: "holders" });
      expect(out.include.map((p) => p.slug)).toEqual(["tel"]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0].slug).toBe("bad");
      expect(out.skipped[0].error).toMatch(/pipeline\.workflowTimeoutMinutes.*pipeline\.holdersScanTimeoutMinutes/);
      expect(() => workflowMatrix("bad", root, { job: "holders" })).toThrow(/60 \+ 35 = 95 min but the job timeout is 90/);
    });
  });

  it("guard: the default job timeout (60) also bounds the default steps (20 + 35 fits), and 26 + 35 does not", () => {
    withRegistry([{ slug: "tel", default: true, pipeline: { holdersScanTimeoutMinutes: 25 } }], (root) => {
      expect(workflowMatrix("tel", root, { job: "holders" }).include[0].holdersTimeout).toBe(25);
    });
    withRegistry([{ slug: "tel", default: true, pipeline: { holdersScanTimeoutMinutes: 26 } }], (root) => {
      expect(() => workflowMatrix("tel", root, { job: "holders" })).toThrow(/holdersScanTimeoutMinutes/);
    });
  });

  it("rejects a non-positive or non-integer holdersScanTimeoutMinutes", () => {
    for (const bad of [0, -5, 12.5, "20", null]) {
      withRegistry([{ slug: "tel", default: true, pipeline: { holdersScanTimeoutMinutes: bad } }], (root) => {
        expect(() => workflowMatrix("tel", root, { job: "holders" }), JSON.stringify(bad)).toThrow(/holdersScanTimeoutMinutes must be a positive integer/);
      });
    }
  });
});

describe("holders-only guard and ordering", () => {
  const projects = [
    { slug: "tel", default: true },
    { slug: "long", pipeline: { holdersScanTimeoutMinutes: 50 } },
    { slug: "short" },
  ];
  it("other jobs and no job keep the original entries and registry order (no holders keys, no guard)", () => {
    withRegistry(projects, (root) => {
      for (const opts of [{}, ...["cex-sync", "exchange-flows", "tier-outflows"].map((job) => ({ job }))]) {
        const out = workflowMatrix("all", root, opts);
        expect(out.skipped, JSON.stringify(opts)).toEqual([]);
        expect(out.include.map((p) => p.slug), JSON.stringify(opts)).toEqual(["tel", "long", "short"]);
        for (const e of out.include) expect(Object.keys(e), JSON.stringify(opts)).toEqual(["slug", "ticker", "timeout"]);
      }
      for (const job of ["ledger", "wallet-flows", "cex-sync", "cex-candidates"]) expect(workflowMatrix("long", root, { job }).include).toEqual([{ slug: "long", ticker: "LONG", timeout: 60 }]);
    });
  });
  it("non-holders jobs keep registry order and never apply the holders guard, even to an invalid holders timeout", () => {
    const defs = [
      { slug: "tel", default: true },
      { slug: "zero", pipeline: { holdersScanTimeoutMinutes: 0 } },
      { slug: "huge", pipeline: { holdersScanTimeoutMinutes: 500 } },
      { slug: "fast", pipeline: { holdersScanTimeoutMinutes: 5 } },
    ];
    withRegistry(defs, (root) => {
      for (const opts of [{}, ...["cex-sync", "exchange-flows", "tier-outflows"].map((job) => ({ job }))]) {
        const out = workflowMatrix("all", root, opts);
        expect(out.skipped, JSON.stringify(opts)).toEqual([]);
        expect(out.include.map((p) => p.slug), JSON.stringify(opts)).toEqual(["tel", "zero", "huge", "fast"]);
        for (const e of out.include) expect(Object.keys(e), JSON.stringify(opts)).toEqual(["slug", "ticker", "timeout"]);
      }
    });
  });
  it("job holders skips it under all and throws when named", () => {
    withRegistry(projects, (root) => {
      const out = workflowMatrix("all", root, { job: "holders" });
      expect(out.include.map((p) => p.slug)).toEqual(["tel", "short"]);
      expect(out.skipped.map((s) => s.slug)).toEqual(["long"]);
      expect(() => workflowMatrix("long", root, { job: "holders" })).toThrow(/holdersScanTimeoutMinutes/);
    });
  });
});

describe("workflow-paths.js skipped (CLI)", () => {
  const script = path.join(repo, "scripts/workflow-paths.js");
  const run = (cwd) => execFileSync(process.execPath, [script, "skipped", "all", "--job", "holders"], { cwd, encoding: "utf8" });

  it("prints a single JSON line; the real registry has nothing skipped", () => {
    const out = run(repo);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.slice(0, -1)).not.toContain("\n");
    expect(Array.isArray(JSON.parse(out))).toBe(true);
    expect(out.trim()).toBe("[]");
  });

  it("a skipped project is still one line: [{slug, error}]", () => {
    withRegistry([{ slug: "tel", default: true }, { slug: "bad", pipeline: { workflowTimeoutMinutes: 90, holdersScanTimeoutMinutes: 60 } }], (root) => {
      const out = run(root);
      expect(out.endsWith("\n")).toBe(true);
      expect(out.slice(0, -1)).not.toContain("\n");
      const parsed = JSON.parse(out);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].slug).toBe("bad");
      expect(typeof parsed[0].error).toBe("string");
      expect(parsed[0].error.length).toBeGreaterThan(0);
    });
  });
});

describe("per-project timeouts", () => {
  it("are bounded so a stuck job cannot burn the Actions minute budget", () => {
    for (const p of workflowMatrix("all", repo, { job: "holders" }).include) {
      expect(p.holdersTimeout + p.holdersRetryTimeout).toBeLessThanOrEqual(p.timeout);
      expect(p.timeout).toBeGreaterThan(0);
      // 270 is the native-coin cap: HBAR's scan (67-93 min measured) + retry + Hedera/exchange/tier stages sum to 263; GitHub's job limit is 360.
      expect(p.timeout).toBeLessThanOrEqual(270);
    }
  });
});

describe("workflowPlan", () => {
  it("TEL: publishes (no skip tag), has EVM chains, verifies exactly the files the YAML used to list", () => {
    const plan = workflowPlan(resolveProject("tel", repo), repo);
    expect(plan.HD_TICKER).toBe("TEL");
    expect(plan.HD_COMMIT_TAG).toBe("");
    expect(plan.HD_HAS_EVM).toBe("true");
    expect(plan.HD_REQUIRED_FILES.split(" ").sort()).toEqual(
      [
        "funding-wallets.json", "tel-holders.json", "holders-summary.json", "holders-history.json", "cex-wallets.json",
        "cex-flows.json", "cex-balance-history.json", "holders-lite.json", "holders-checkpoint.json",
        "holder-transitions.json", "holders-ever-checkpoint.json", "supply-reconciliation.json", "treasury-history.json",
        "classification-changelog.json",
      ].sort(),
    );
  });

  it("zebec-network: [skip netlify], no EVM chains (no gap fill), Solana staking overlay, no funding-wallets", () => {
    const plan = workflowPlan(resolveProject("zebec-network", repo), repo);
    expect(plan.HD_COMMIT_TAG).toBe(" [skip netlify]");
    expect(plan.HD_HAS_EVM).toBe("false");
    const files = plan.HD_REQUIRED_FILES.split(" ");
    expect(files).toContain("solana-staking.json");
    expect(files).not.toContain("funding-wallets.json");
    expect(files).toEqual(expect.arrayContaining(["cex-wallets.json", "cex-flows.json", "cex-balance-history.json"]));
  });
});
