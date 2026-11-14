// Guards the owner decisions recorded in config/projects/<slug>/onboarding.answers.json: the
// project config must keep reflecting them (wallet labels/roles, staking, DEX, CEX, history).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main as addProject } from "../add-project.js";
import { answersRelPath, appliedMismatches, assertAnswers, readProjectFiles } from "./onboardAnswers.js";
import { loadRegistry } from "./projects.js";

const repo = path.resolve(import.meta.dirname, "../..");
const quiet = { log() {}, warn() {} };

/** Mismatches for every registered project in `root` that has an answers file. */
const projectsMismatches = (root) =>
  loadRegistry(root).flatMap(({ slug }) => {
    const file = path.join(root, answersRelPath(slug));
    if (!fs.existsSync(file)) return [];
    const answers = assertAnswers(JSON.parse(fs.readFileSync(file, "utf8")), `${slug} onboarding.answers.json`);
    return appliedMismatches(answers, readProjectFiles(root, slug), slug).map((m) => `${slug}: ${m}`);
  });

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "answers-applied-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config/projects.json"), JSON.stringify({ projects: [{ slug: "tel", name: "Telcoin", ticker: "TEL", default: true, legacyRoot: true }] }));
  const inv = path.join(root, "inv.json");
  fs.writeFileSync(inv, JSON.stringify({ chains: [{ chain: "ethereum", vm: "evm", status: "configured", tokens: [{ address: "0x00000000000000000000000000000000000f00d1" }], source: "test fixture" }] }));
  addProject(["--slug", "example-token", "--name", "Example Token", "--ticker", "EXMP", "--chain", "ethereum:0x00000000000000000000000000000000000f00d1:18", "--root", root, "--inventory", inv, "--answers", path.join(repo, "config/onboarding.answers.example.json")], { logger: quiet });
  return root;
}

describe("recorded onboarding answers are still reflected in the config", () => {
  it("holds for every registered project that has an answers file (none yet is fine)", () => {
    expect(projectsMismatches(repo)).toEqual([]);
  });

  it("holds on a freshly onboarded fixture", () => {
    expect(projectsMismatches(fixtureRoot())).toEqual([]);
  });

  it("fails when a wallet loses its label/role, staking drifts, or history changes", () => {
    const root = fixtureRoot();
    const cfgFile = path.join(root, "config/projects/example-token.json");
    const exFile = path.join(root, "config/projects/example-token/exclusions.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    const ex = JSON.parse(fs.readFileSync(exFile, "utf8"));

    cfg.chains[0].contracts = Object.fromEntries(Object.entries(cfg.chains[0].contracts).filter(([, v]) => v.role !== "treasury" && v.role !== "dex"));
    ex.labels = {};
    cfg.staking = [];
    cfg.pipeline.historyStart = "2020-01-01";
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    fs.writeFileSync(exFile, JSON.stringify(ex));

    const problems = projectsMismatches(root).join("\n");
    expect(problems).toMatch(/wallet ethereum:0x0+ca5e \(treasury, .*\): no contracts\{\} entry with role "treasury"/);
    expect(problems).toMatch(/not labelled in exclusions\.json \(it would count as retail\)/);
    expect(problems).toMatch(/dex pool ethereum:0x0+9001: no contracts\{\} entry with role "dex"/);
    expect(problems).toMatch(/staking ethereum:0x0+57a1: missing from staking\[\] with kind stakeChanged/);
    expect(problems).toMatch(/historyStart: answers say 2023-04-12 but pipeline\.historyStart is 2020-01-01/);
  });
});
