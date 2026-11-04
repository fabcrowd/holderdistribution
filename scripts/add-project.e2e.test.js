// One-prompt onboarding: add-project.js alone wires a new token into the
// dashboard tab, the forensics gate and the refresh-ledger matrix (which runs
// build-ledger.js and trace-bot-proceeds.js per project). No per-token code.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "./add-project.js";
import { workflowMatrix } from "./workflow-paths.js";
import { ledgerOutRelDir, loadLedgerConfig } from "./lib/ledger/config.js";
import { gatedSlugsFrom, resolveGatedProject } from "../netlify/functions-src/gatedProjects.ts";
import { LEDGER_KEYS } from "../netlify/functions-src/ledgerSource.ts";
import { showsProjectWallets } from "../src/lib/projectWallets.ts";
import { parseViewHash } from "../src/lib/viewRoute.ts";

const repo = path.resolve(import.meta.dirname, "..");
const quiet = { log() {}, warn() {} };
const workflow = fs.readFileSync(path.join(repo, ".github/workflows/refresh-ledger.yml"), "utf8");

function sandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addproj-e2e-"));
  fs.cpSync(path.join(repo, "config"), path.join(tmp, "config"), { recursive: true });
  return tmp;
}

const TOKENS = [
  { slug: "fake-evm", ticker: "FEVM", chain: "base:0x" + "1f".repeat(20) + ":18", wallet: "0x" + "2e".repeat(20) + ":Team wallet", vm: "evm" },
  { slug: "fake-sol", ticker: "FSOL", chain: "solana:75hbt6uvDqjPZ9WgFtMhBnTeyHw7cinoHiz4FD2vEz2d:6", wallet: "8EKdKDq6GunEvgmJfxuK8fad7zWY4oTjnfKDEfo6weWe:Team wallet", vm: "solana" },
];

// Onboarding step 1: a chains inventory covering the --chain (scripts/lib/chainInventory.js).
function inventoryFor(root, t) {
  const [chain, address] = t.chain.split(":");
  const file = path.join(root, `${t.slug}-inventory.json`);
  fs.writeFileSync(file, JSON.stringify({ chains: [{ chain, vm: t.vm, status: "configured", tokens: [{ address }], source: "test fixture" }] }));
  return file;
}

describe("add-project wires a new token end to end", () => {
  for (const t of TOKENS) {
    it(`${t.vm}: tab, gate keys and workflow matrix pick up ${t.slug}`, () => {
      const root = sandbox();
      main(["--slug", t.slug, "--name", `Fake ${t.vm}`, "--ticker", t.ticker, "--chain", t.chain, "--wallet", t.wallet, "--root", root, "--inventory", inventoryFor(root, t)], { logger: quiet });
      const reg = JSON.parse(fs.readFileSync(path.join(root, "config/projects.json"), "utf8"));
      const cfg = JSON.parse(fs.readFileSync(path.join(root, `config/projects/${t.slug}.json`), "utf8"));

      // Dashboard: the Developer wallets tab + deep link.
      expect(showsProjectWallets(cfg)).toBe(true);
      expect(parseViewHash("#supply/project-wallets")).toEqual({ view: "supply", panel: "project-wallets" });
      expect(cfg.chains[0].explorer).toBe(t.vm === "solana" ? "https://solscan.io" : "https://basescan.org");

      // Gate: allowlisted, and both ledger keys resolve to data/<slug>/ledger/*.
      const gated = gatedSlugsFrom(reg.projects);
      expect(gated.has(t.slug)).toBe(true);
      expect(Object.keys(LEDGER_KEYS)).toEqual(["project-ledger", "bot-proceeds"]);
      expect(ledgerOutRelDir(t.slug)).toBe(`data/${t.slug}/ledger`);
      expect(resolveGatedProject("tel")).toBe("tel");

      // Ledger config + wallet registry.
      const ledger = loadLedgerConfig(t.slug, root);
      expect(ledger.chains).toEqual([cfg.chains[0].key]);
      expect(ledger.developerWallets).toHaveLength(1);
      expect(fs.existsSync(path.join(root, `data/${t.slug}/forensics/wallet-flows.registry.json`))).toBe(true);

      // Workflow: the refresh-ledger matrix (build-ledger + trace-bot-proceeds) includes it.
      const { include } = workflowMatrix("all", root);
      expect(include.map((e) => e.slug)).toContain(t.slug);
      expect(workflow).toMatch(/build-ledger\.js/);
      expect(workflow).toMatch(/trace-bot-proceeds\.js/);
      expect(workflow).toMatch(/workflow-paths\.js matrix/);
    });
  }
});
