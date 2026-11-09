import { describe, expect, it } from "vitest";
import { assertChainVm, CHAIN_VMS } from "./chainVms.js";
import { canonicalAddressForVm, isAddressForVm, normalizeAddressForVm } from "./address.js";
import { loadChainAdapter } from "./chainAdapters.js";
import { cexVmForProject, extractCexRow } from "./duneCex.js";
import { planPins } from "./asOf.js";
import { cutoffScanWindow, findFirstBlockAtOrAfter, findFirstSlotAtOrAfter } from "./dayBlocks.js";
import { walletsForChain } from "./ledger/config.js";
import { deriveChainsFromProject, loadProjectConfig, projectChainEntries, projectRoleAddresses, validateProjectConfig } from "./projects.js";
import { walletEntry } from "../add-project.js";

const EVM = "0xabcdef0123456789abcdef0123456789abcdef01";
const SOL = "So11111111111111111111111111111111111111112";
const UNKNOWN = /unknown chain vm "fakevm"/;

describe("unknown chain vm fails loudly, never passes as EVM or Solana", () => {
  it("assertChainVm accepts known vms and rejects others", () => {
    for (const vm of CHAIN_VMS) expect(assertChainVm(vm)).toBe(vm);
    expect(() => assertChainVm("fakevm")).toThrow(UNKNOWN);
  });

  it("address helpers dispatch on the vm table", () => {
    expect(isAddressForVm("evm", EVM)).toBe(true);
    expect(isAddressForVm("solana", EVM)).toBe(false);
    expect(isAddressForVm("solana", SOL)).toBe(true);
    expect(canonicalAddressForVm("evm", ` ${EVM.toUpperCase().replace("0X", "0x")} `)).toBe(EVM);
    expect(canonicalAddressForVm("solana", ` ${SOL} `)).toBe(SOL);
    expect(() => isAddressForVm("fakevm", "1")).toThrow(UNKNOWN);
    expect(() => normalizeAddressForVm("fakevm", "1")).toThrow(UNKNOWN);
    expect(() => canonicalAddressForVm("fakevm", "1")).toThrow(UNKNOWN);
  });

  it("adapters expose a clock with a first-at-or-after resolver", async () => {
    for (const vm of CHAIN_VMS) expect(typeof (await loadChainAdapter(vm)).clock({}).firstAtOrAfter).toBe("function");
    await expect(loadChainAdapter("fakevm")).rejects.toThrow(/unknown chain vm/);
  });

  it("each vm's clock is bound to its own search, not the other's", async () => {
    expect(findFirstBlockAtOrAfter).not.toBe(findFirstSlotAtOrAfter);
    expect((await loadChainAdapter("evm")).clock({}).firstAtOrAfter).toBe(findFirstBlockAtOrAfter);
    expect((await loadChainAdapter("solana")).clock({}).firstAtOrAfter).toBe(findFirstSlotAtOrAfter);
  });

  it("dispatch sites reject an unknown vm", async () => {
    expect(() => planPins({ chains: [{ key: "h", vm: "fakevm" }], settledDate: "2026-11-01", cutoffMap: {} })).toThrow(UNKNOWN);
    expect(() => cexVmForProject({ config: { chains: [{ key: "h", vm: "fakevm" }] } })).toThrow(UNKNOWN);
    expect(() => extractCexRow({ address: "1" }, "fakevm")).toThrow(UNKNOWN);
    expect(() => walletsForChain({ developerWallets: [{ address: EVM }] }, "h", "fakevm")).toThrow(UNKNOWN);
    await expect(cutoffScanWindow({ project: { slug: "x" }, chain: "h", from: 1, latest: 2, vm: "fakevm", getBlockTimestamp: async () => 0 })).rejects.toThrow(UNKNOWN);
  });

  it("registry readers reject an unknown vm", () => {
    const cfg = structuredClone(loadProjectConfig("ondo", process.cwd()));
    cfg.chains[0].vm = "fakevm";
    expect(validateProjectConfig(cfg).errors.join("\n")).toMatch(/unknown vm "fakevm"/);
    expect(() => deriveChainsFromProject(cfg)).toThrow(UNKNOWN);
    expect(() => projectChainEntries(cfg)).not.toThrow();
    cfg.chains[0].contracts = { x: { address: EVM, role: "treasury" } };
    expect(() => projectRoleAddresses(cfg)).toThrow(UNKNOWN);
  });

  it("add-project --wallet rejects an address that is neither EVM nor Solana", () => {
    expect(() => walletEntry("0.0.1234:Council", [])).toThrow(/bad address/);
    expect(walletEntry(`${SOL}:Treasury`, []).address).toBe(SOL);
    expect(walletEntry(`${EVM.toUpperCase().replace("0X", "0x")}:Treasury`, []).address).toBe(EVM);
  });
});
