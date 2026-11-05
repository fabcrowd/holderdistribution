import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildInventory, inventoryRelPath, validateInventory } from "./chainInventory.js";
import { loadRegistry, resolveProject } from "./projects.js";

describe("chains inventory (onboarding step 1)", () => {
  for (const { slug } of loadRegistry()) {
    it(`${slug}: committed inventory covers every configured chain and decides every other chain`, () => {
      const file = inventoryRelPath(slug);
      expect(fs.existsSync(file), file).toBe(true);
      const inv = JSON.parse(fs.readFileSync(file, "utf8"));
      const p = resolveProject(slug);
      expect(validateInventory({ slug, ...p.config }, inv)).toEqual([]);
    });
  }

  it("multi-chain build: EVM + Solana rows, supply shares over canonical tokens, candidates must be decided", () => {
    const project = {
      slug: "multi",
      config: {
        ticker: "MLT",
        chains: [
          { key: "ethereum", vm: "evm", tokens: [{ address: "0xAA", decimals: 18, status: "canonical" }] },
          { key: "solana", vm: "solana", tokens: [{ address: "MintCaseKept111", decimals: 6, status: "canonical" }] },
        ],
      },
    };
    const inv = buildInventory({ project, discovery: { methods: ["same-address-rpc"], chains: [{ chain: "base", status: "candidate", address: "0xbb" }, { chain: "bsc", status: "not-found" }] }, supplies: { ethereum: { "0xAA": 750 }, solana: { MintCaseKept111: 250 } } });
    expect(inv.chains.find((c) => c.chain === "ethereum").tokens[0].supplyShare).toBe(0.75);
    expect(inv.chains.find((c) => c.chain === "solana").tokens[0].address).toBe("MintCaseKept111");
    const errs = validateInventory({ slug: "multi", ...project.config }, inv);
    expect(errs).toEqual([expect.stringMatching(/base: undecided candidate/)]);
    inv.chains.find((c) => c.chain === "base").status = "excluded";
    inv.chains.find((c) => c.chain === "base").reason = "bridged copy not supported by the issuer";
    expect(validateInventory({ slug: "multi", ...project.config }, inv)).toEqual([]);
    // Solana addresses keep their case: a lowercased mint is a different token.
    inv.chains.find((c) => c.chain === "solana").tokens[0].address = "mintcasekept111";
    expect(validateInventory({ slug: "multi", ...project.config }, inv)).toEqual([expect.stringMatching(/solana: token MintCaseKept111 not in the inventory/)]);
  });
});
