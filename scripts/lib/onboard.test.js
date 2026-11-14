import { describe, expect, it } from "vitest";
import { chainFromProbe, findDeployBlock, imageExt, inferVm, planOnboarding, probeEvmChain, slugify, wholeTokens } from "./onboard.js";
import { validateInventory } from "./chainInventory.js";
import { scaffold, validateScaffold } from "../add-project.js";
import { main as onboardMain, parseArgs as parseOnboardArgs } from "../onboard.js";

const TOKEN = "0xFAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3";
const facts = (over = {}) => ({ name: "Ondo", symbol: "ONDO", decimals: 18, totalSupplyRaw: (10n ** 28n).toString(), deployBlock: 16_000_000, deployDate: "2022-11-20", ...over });
const discovery = {
  methods: ["same-address-rpc", "coingecko-platforms"],
  checkedAt: "2026-11-11T00:00:00Z",
  chains: [
    { chain: "ethereum", status: "configured" },
    { chain: "polygon", status: "candidate", address: "0x" + "ab".repeat(20), decimals: 18 },
    { chain: "base", status: "not-found" },
    { chain: "bsc", status: "rpc-error", error: "timeout" },
  ],
};
const registry = { projects: [{ slug: "tel", name: "Telcoin", ticker: "TEL", default: true }] };

const parseArgv = (argv) => {
  const out = { chains: [], wallets: [], stables: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === "--chain") out.chains.push(v);
    else if (k === "--wallet") out.wallets.push(v);
    else if (k === "--supply-target") out.supplyTarget = Number(v);
    else out[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
};

describe("inferVm", () => {
  it("reads the VM from the address shape", () => {
    expect(inferVm(TOKEN)).toBe("evm");
    expect(inferVm("ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU")).toBe("solana");
    expect(inferVm("0.0.1456985")).toBe("hedera");
    expect(inferVm("not an address")).toBeNull();
  });
});

describe("helpers", () => {
  it("slugify keeps registry-safe slugs only", () => {
    expect(slugify("zebec-network")).toBe("zebec-network");
    expect(slugify("Ondo Finance!")).toBe("ondo-finance");
    expect(slugify("")).toBeNull();
  });
  it("wholeTokens floors raw supply to whole tokens", () => {
    expect(wholeTokens("1234567", 3)).toBe(1234);
    expect(wholeTokens((10n ** 28n).toString(), 18)).toBe(10_000_000_000);
  });
  it("imageExt reads the extension, dropping the query", () => {
    expect(imageExt("https://coin-images.coingecko.com/coins/images/1/large/ondo.png?1696525000")).toBe("png");
    expect(imageExt("https://x/y.JPEG")).toBe("jpg");
    expect(imageExt("https://x/y")).toBe("png");
  });
  it("findDeployBlock finds the first block with code", async () => {
    const calls = [];
    const block = await findDeployBlock({ latest: 1_000_000, hasCode: async (b) => (calls.push(b), b >= 123_456) });
    expect(block).toBe(123_456);
    expect(calls.length).toBeLessThan(25);
  });
  it("findDeployBlock returns null when the node refuses historical state", async () => {
    expect(await findDeployBlock({ latest: 100, hasCode: async (b) => { if (b < 100) throw new Error("missing trie node"); return true; } })).toBeNull();
    expect(await findDeployBlock({ latest: 100, hasCode: async () => false })).toBeNull();
  });
});

describe("planOnboarding", () => {
  const plan = (over = {}) => planOnboarding({
    address: TOKEN,
    chain: "ethereum",
    facts: facts(),
    coingecko: { id: "ondo-finance", name: "Ondo", symbol: "ondo", image: "https://img/ondo.png?1" },
    discovery,
    now: new Date("2026-11-11T00:00:00Z"),
    ...over,
  });

  it("derives slug, ticker, supply, deploy block, history start and image", () => {
    const p = plan();
    expect(p).toMatchObject({ slug: "ondo", ticker: "ONDO", name: "Ondo", supplyTarget: 10_000_000_000, historyStart: "2022-11-20", image: { path: "/tokens/ondo.png" } });
    expect(p.argv).toEqual(expect.arrayContaining(["--chain", `ethereum:${TOKEN.toLowerCase()}:18:1:16000000`, "--supply-target", "10000000000", "--coingecko", "ondo-finance"]));
  });

  it("excludes undecided copies on other chains with a reason, so the inventory validates", () => {
    const p = plan();
    const byChain = Object.fromEntries(p.inventory.chains.map((r) => [r.chain, r]));
    expect(byChain.ethereum.status).toBe("configured");
    expect(byChain.polygon.status).toBe("excluded");
    expect(byChain.polygon.reason).toMatch(/--include polygon/);
    expect(byChain.base.status).toBe("not-found");
    expect(byChain.bsc.status).toBe("excluded");
    expect(byChain.bsc.reason).toMatch(/Public RPC failed/);
    expect(p.inventory.chains.some((r) => r.status === "candidate")).toBe(false);
    const project = scaffold(parseArgv(p.argv), registry).files[`config/projects/${p.slug}.json`];
    expect(validateInventory(project, p.inventory)).toEqual([]);
  });

  it("configures an included chain and the scaffold validates", () => {
    const p = plan({ included: { polygon: { address: "0x" + "ab".repeat(20), decimals: 18 } } });
    expect(p.inventory.chains.find((r) => r.chain === "polygon").status).toBe("configured");
    const result = scaffold(parseArgv(p.argv), registry);
    expect(validateScaffold(result).errors).toEqual([]);
    expect(validateInventory(result.files[`config/projects/${p.slug}.json`], p.inventory)).toEqual([]);
    expect(p.notes.join("\n")).toMatch(/polygon: configured as bridge "lock-mint"/);
  });

  it("keeps a Solana mint's case and needs no deploy block", () => {
    const mint = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
    const p = planOnboarding({ address: mint, chain: "solana", facts: facts({ symbol: "ZBCN", decimals: 6, totalSupplyRaw: "100000000000000000", deployBlock: null, deployDate: null }), coingecko: { id: "zebec-network", name: "Zebec Network" }, discovery: { chains: [{ chain: "solana", status: "configured" }] } });
    expect(p.argv).toEqual(expect.arrayContaining(["--chain", `solana:${mint}:6`]));
    expect(p.supplyTarget).toBe(100_000_000_000);
    expect(p.notes.join("\n")).not.toMatch(/deploy block/);
    expect(p.notes.join("\n")).toMatch(/no CoinGecko image/);
  });

  it("plans a native coin (HBAR) with no contract, and the scaffold validates", () => {
    const p = planOnboarding({ address: "native", chain: "hedera", facts: facts({ name: "HBAR", symbol: "HBAR", decimals: 8, totalSupplyRaw: "5000000000000000000", deployBlock: null, deployDate: null }), coingecko: { id: "hedera-hashgraph", name: "Hedera", image: "https://img/hbar.png" }, discovery: { chains: [] } });
    expect(p).toMatchObject({ slug: "hedera", ticker: "HBAR", vm: "hedera", supplyTarget: 50_000_000_000 });
    expect(p.argv).toEqual(expect.arrayContaining(["--chain", "hedera:native:8"]));
    expect(p.inventory.chains).toEqual([expect.objectContaining({ chain: "hedera", status: "configured" })]);
    const result = scaffold(parseArgv(p.argv), registry);
    expect(validateScaffold(result).errors).toEqual([]);
    expect(validateInventory(result.files["config/projects/hedera.json"], p.inventory)).toEqual([]);
  });

  it("owner overrides win", () => {
    const p = plan({ overrides: { slug: "ondo-x", ticker: "ondo", name: "Ondo Finance", historyStart: "2024-01-18" } });
    expect(p).toMatchObject({ slug: "ondo-x", ticker: "ONDO", name: "Ondo Finance", historyStart: "2024-01-18" });
  });

  it("stops when decimals or supply cannot be verified on-chain", () => {
    expect(() => plan({ facts: facts({ decimals: null }) })).toThrow(/decimals/);
    expect(() => plan({ facts: facts({ totalSupplyRaw: null }) })).toThrow(/total supply/);
  });
});

describe("planOnboarding history and Solana program", () => {
  const mint = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
  const solFacts = (over = {}) => facts({ symbol: "ZBCN", decimals: 6, totalSupplyRaw: "100000000000000000", deployBlock: null, deployDate: null, ...over });
  const solPlan = (over = {}, overrides = {}) => planOnboarding({ address: mint, chain: "solana", facts: solFacts(over), coingecko: { id: "zebec-network", name: "Zebec Network" }, discovery: { chains: [{ chain: "solana", status: "configured" }] }, overrides });

  it("an explicit null historyStart means forward-only: no deploy-date fallback and no --history-start", () => {
    const p = planOnboarding({ address: TOKEN, chain: "ethereum", facts: facts(), coingecko: { id: "ondo-finance", name: "Ondo" }, discovery, overrides: { historyStart: null } });
    expect(p.historyStart).toBeNull();
    expect(p.argv).not.toContain("--history-start");
    expect(p.notes.join("\n")).not.toMatch(/history start unknown/);
  });

  it("passes the mint's own token program (Token-2022) to the scaffold and validates", () => {
    const p = solPlan({ program: "token-2022" });
    expect(p.argv).toEqual(expect.arrayContaining(["--chain", `solana:${mint}:6:token-2022`]));
    const result = scaffold(parseArgv(p.argv), registry);
    expect(result.files[`config/projects/${p.slug}.json`].chains[0].tokens[0].program).toBe("token-2022");
    expect(validateScaffold(result).errors).toEqual([]);
    expect(solPlan({ program: "spl-token" }).argv).toEqual(expect.arrayContaining(["--chain", `solana:${mint}:6`]));
  });
});

describe("EVM chain probe", () => {
  it("checks chains sequentially and reports what has code", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const hasCode = async (chain) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (chain === "bsc") throw new Error("HTTP 429");
      return chain === "base";
    };
    const probe = await probeEvmChain({ chains: ["ethereum", "base", "bsc"], hasCode });
    expect(maxInFlight).toBe(1);
    expect(probe).toEqual({ found: ["base"], failed: [{ chain: "bsc", message: "HTTP 429" }] });
    expect(chainFromProbe(probe, "0xabc")).toBe("base");
  });

  it("asks for --chain when several chains have code, and hints at the RPC override when none could be checked", () => {
    expect(chainFromProbe({ found: ["ethereum", "base"], failed: [] }, "0xabc").message).toMatch(/exists at 0xabc on ethereum, base: pass --chain .* --include/);
    const failed = chainFromProbe({ found: [], failed: [{ chain: "ethereum", message: "HTTP 403" }] }, "0xabc");
    expect(failed.message).toMatch(/PUBLIC_RPC_URLS_ETHEREUM=<rpc url>/);
    expect(chainFromProbe({ found: [], failed: [] }, "0xabc").message).toMatch(/no contract at 0xabc on any scanned EVM chain/);
  });
});

describe("--write without --answers is only possible for the Hedera native coin", () => {
  const quiet = { log() {}, warn() {} };
  const evm = "0x" + "ab".repeat(20);
  const solana = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
  const refusal = /--write needs the owner's answers file/;

  it("refuses every non-Hedera flag combination before any network call or write", async () => {
    const attempts = [
      ["--address", evm, "--write"],
      ["--address", evm, "--chain", "ethereum", "--write"],
      ["--address", solana, "--write"],
      ["--address", solana, "--chain", "solana", "--write"],
      ["--address", "native", "--chain", "ethereum", "--write"],
      ["--address", "native", "--chain", "solana", "--write"],
      ["--address", "native", "--write"],
      ["--address", "native", "--chain", "constructor", "--write"],
      ["--address", "native", "--chain", "__proto__", "--write"],
      ["--address", "0.0.1456985", "--write"],
    ];
    for (const argv of attempts) await expect(onboardMain(argv, { logger: quiet }), argv.join(" ")).rejects.toThrow(refusal);
  });

  it("recognises hedera only as an own key of the native-chain table", () => {
    expect(parseOnboardArgs(["--chain", "hedera", "--write"])).toMatchObject({ address: "native", chain: "hedera", write: true });
    expect(parseOnboardArgs(["--chain", "constructor", "--address", "0xabc"]).address).toBe("0xabc");
    expect(() => parseOnboardArgs(["--chain", "constructor"])).toThrow(/--address/);
  });
});
