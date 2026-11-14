import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goLiveProblems } from "../goLive.js";

const NOW = Date.parse("2026-11-12T12:00:00Z");
let root;
const write = (rel, value) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const project = {
  slug: "hbar",
  dataDir: "public/data/hbar",
  config: {
    slug: "hbar",
    ticker: "HBAR",
    data: { legacyRoot: false },
    chains: [{ key: "hedera", vm: "hedera", asset: { kind: "native", decimals: 8 } }],
    classification: { cexWallets: "config/projects/hbar/cex-wallets.json" },
  },
};
const held = () => goLiveProblems(project, { root, now: NOW, section: "feeds" }).filter((p) => /flow (cursor held|scan has not run)/.test(p));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hedera-golive-"));
  write("config/projects.json", { projects: [{ slug: "tel", default: true }, { slug: "hbar" }] });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("go-live: Hedera flow scan", () => {
  it("fails while the scan has not run", () => {
    expect(held().join("\n")).toMatch(/hedera flow scan has not run/);
  });

  it("fails while a cursor is held, naming the day it targets and the failing account", () => {
    write("public/data/hbar/exchange-flow-checkpoint.json", {
      chains: { hedera: { complete: false, throughDate: "2026-11-11", failed: [{ account: "0.0.615421", message: "mirror GET failed after 6 attempts" }] } },
    });
    const out = held().join("\n");
    expect(out).toMatch(/hedera flow cursor held/);
    expect(out).toContain("2026-11-11");
    expect(out).toContain("0.0.615421");
  });

  it("passes once every account reached the settled end", () => {
    write("public/data/hbar/exchange-flow-checkpoint.json", { chains: { hedera: { complete: true, throughDate: "2026-11-11", throughBlock: 1 } } });
    expect(held()).toEqual([]);
  });

  it("does not apply to a project without a Hedera chain", () => {
    const evm = { ...project, config: { ...project.config, chains: [{ key: "ethereum", vm: "evm" }] } };
    expect(goLiveProblems(evm, { root, now: NOW, section: "feeds" }).filter((p) => /flow (cursor held|scan has not run)/.test(p))).toEqual([]);
  });
});
