/**
 * writeRegistry (scripts/init-forensics-registry.js): derives the forensics
 * registry from a gated project's config and writes it under data/<slug>/forensics/.
 * Each test runs in its own temp root so nothing touches the repo's data/.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeRegistry } from "./init-forensics-registry.js";
import { WALLET_FLOWS_REGISTRY_FILE } from "./lib/walletFlowsProject.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TREASURY = "So11111111111111111111111111111111111111112";
const HOLDINGS = "SysvarRent111111111111111111111111111111111";
const CEX = "11111111111111111111111111111111";

const baseConfig = (contracts) => ({
  slug: "demo",
  name: "Demo",
  ticker: "DMO",
  gated: { forensics: true },
  chains: [
    {
      key: "solana",
      name: "Solana",
      vm: "solana",
      tokens: [{ address: MINT, decimals: 6 }],
      contracts,
    },
  ],
});

const fullConfig = () =>
  baseConfig({
    treasury: { address: TREASURY, role: "treasury", $comment: "Treasury multisig, high confidence" },
    holdings: { address: HOLDINGS, role: "holdings", $comment: "Holdings, medium confidence" },
    cexHot: { address: CEX, role: "cex", $comment: "CEX hot wallet, high confidence" },
  });

const projectOf = (config) => ({ slug: "demo", config, dataDir: "public/data/demo" });

let root;
let target;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-init-forensics-"));
  target = path.join(root, "data", "demo", WALLET_FLOWS_REGISTRY_FILE);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("writeRegistry", () => {
  it("creates the registry file with valid JSON listing the non-retail wallets", async () => {
    const result = await writeRegistry(projectOf(fullConfig()), { root });

    expect(result.written).toBe(true);
    expect(result.path).toBe(target);
    expect(result.wallets).toBe(2);
    expect(result.byConfidence).toEqual({ high: 1, medium: 1, low: 0 });

    const doc = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(doc.knownWallets.map((w) => w.address)).toEqual([TREASURY, HOLDINGS]);
    expect(doc.knownWallets[0]).toMatchObject({ group: "treasury", confidence: "high", chains: ["solana"] });
  });

  it("refuses to overwrite an existing registry without force", async () => {
    await writeRegistry(projectOf(fullConfig()), { root });

    await expect(writeRegistry(projectOf(fullConfig()), { root })).rejects.toThrow(/exists; pass --force to overwrite/);
  });

  it("overwrites an existing registry when force is set", async () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ stale: true }));

    const result = await writeRegistry(projectOf(fullConfig()), { root, force: true });

    expect(result.written).toBe(true);
    const doc = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(doc.stale).toBeUndefined();
    expect(doc.knownWallets).toHaveLength(2);
  });

  it("dry run reports the summary but writes nothing", async () => {
    const result = await writeRegistry(projectOf(fullConfig()), { root, dryRun: true });

    expect(result.written).toBe(false);
    expect(result.wallets).toBe(2);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(root, "data", "demo"))).toBe(false);
  });

  it("throws when gated.forensics is not true", async () => {
    const config = { ...fullConfig(), gated: { forensics: false } };

    await expect(writeRegistry(projectOf(config), { root })).rejects.toThrow("demo: gated.forensics is not true");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("throws when the config has no treasury or holdings wallets", async () => {
    const config = baseConfig({ cexHot: { address: CEX, role: "cex", $comment: "CEX hot wallet" } });

    await expect(writeRegistry(projectOf(config), { root })).rejects.toThrow("demo: no treasury/holdings wallets in config contracts");
    expect(fs.existsSync(target)).toBe(false);
  });
});
