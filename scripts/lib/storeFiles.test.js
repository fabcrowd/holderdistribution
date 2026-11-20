import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXCLUDED_BASENAMES, EXCLUDED_WORK_FILES, StoreFilesError, UnclassifiedFileError, coinLayout, kindRoots, listCoinFiles } from "./storeFiles.js";

// Fixture trees only: nothing here runs a generator or reads the repository's own data directories.
let root;
const put = (rel, text = "x") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "storefiles-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const own = coinLayout({ slug: "alpha", dataDir: "public/data/alpha", workDir: "data/alpha", slugs: ["alpha", "beta", "gamma"] });
const legacy = coinLayout({ slug: "alpha", dataDir: "public/data", workDir: "data", sharedRoots: true, slugs: ["alpha", "beta", "gamma"], ledgerDir: "data/alpha/ledger" });

function growOwnTree() {
  put("public/data/alpha/holders.json");
  put("public/data/alpha/sub/summary.json");
  put("public/data/alpha/.gitkeep", "");
  put("public/data/alpha/holders-previous.json");
  put("public/data/alpha/holders-previous.d/0001.json");
  put("data/alpha/rpc-usage.json");
  put("data/alpha/days/2026-11-01.json");
  put("data/alpha/cex-candidates.json");
  put("data/alpha/cex-dune-candidates.json");
  put("data/alpha/forensics/wallet-flows.json");
  put("data/alpha/forensics/wallet-flows.registry.json");
  put("data/alpha/ledger/ledger.json");
  put("data/alpha/ledger/.gitkeep", "");
}

describe("directories per kind", () => {
  it("holders stores P and W except the ledger and forensics directories; the other kinds store their own", async () => {
    growOwnTree();
    expect((await listCoinFiles({ root, layout: own, kind: "holders" })).files).toEqual([
      "data/alpha/days/2026-11-01.json", "data/alpha/rpc-usage.json", "public/data/alpha/holders.json", "public/data/alpha/sub/summary.json",
    ]);
    expect((await listCoinFiles({ root, layout: own, kind: "ledger" })).files).toEqual(["data/alpha/ledger/ledger.json"]);
    expect((await listCoinFiles({ root, layout: own, kind: "walletFlows" })).files).toEqual(["data/alpha/forensics/wallet-flows.json"]);
  });

  it("every file of the tree is stored by exactly one kind or excluded", async () => {
    growOwnTree();
    const seen = new Map();
    for (const kind of ["holders", "ledger", "walletFlows"]) {
      const { files, excluded } = await listCoinFiles({ root, layout: own, kind });
      for (const f of [...files, ...excluded]) seen.set(f, [...(seen.get(f) ?? []), kind]);
      for (const f of files) expect(excluded).not.toContain(f);
    }
    const onDisk = [];
    const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : onDisk.push(`${d}/${e.name}`)));
    walk("public");
    walk("data");
    const sharedByDirectory = onDisk.filter((f) => !f.includes("-previous.d/"));
    for (const f of sharedByDirectory) expect(seen.has(f), f).toBe(true);
    expect([...seen.entries()].filter(([f, kinds]) => kinds.length > 1 && !/\.gitkeep|candidates|registry|-previous/.test(f))).toEqual([]);
  });

  it("a layout on shared roots skips the sibling coins' directories and the coin's own ledger directory", async () => {
    put("public/data/holders.json");
    put("public/data/beta/holders.json");
    put("data/rpc-usage.json");
    put("data/beta/rpc-usage.json");
    put("data/alpha/ledger/ledger.json");
    put("data/forensics/wallet-flows.json");
    put("data/unallocated-classification.json");
    put("data/forensics/wallet-flows.registry.json");
    expect((await listCoinFiles({ root, layout: legacy, kind: "holders" })).files).toEqual(["data/rpc-usage.json", "public/data/holders.json"]);
    expect((await listCoinFiles({ root, layout: legacy, kind: "ledger" })).files).toEqual(["data/alpha/ledger/ledger.json"]);
    expect((await listCoinFiles({ root, layout: legacy, kind: "walletFlows" })).files).toEqual(["data/forensics/wallet-flows.json"]);
  });

  it("an absent directory is empty, not an error", async () => {
    expect(await listCoinFiles({ root, layout: own, kind: "ledger" })).toEqual({ files: [], excluded: [] });
  });

  it("refuses an unknown kind and a layout path that leaves the repository", () => {
    expect(() => kindRoots(own, "nightly")).toThrow(StoreFilesError);
    expect(() => coinLayout({ slug: "a", dataDir: "../x", workDir: "data" })).toThrow(StoreFilesError);
    expect(() => coinLayout({ slug: "a", dataDir: "/abs", workDir: "data" })).toThrow(StoreFilesError);
  });
});

describe("the exclusion list is exact", () => {
  it("names only scratch copies, .gitkeep, hand-kept files and review queues", () => {
    expect(EXCLUDED_BASENAMES).toEqual([".gitkeep"]);
    expect([...EXCLUDED_WORK_FILES].sort()).toEqual([
      "cex-candidates.json", "cex-dune-candidates.json", "forensics/wallet-flows.registry.json", "unallocated-classification.json",
    ]);
  });

  it("a coin's own hand-kept files come from its layout (excludedFiles, relative to W), and only for that coin", async () => {
    const mine = coinLayout({ slug: "alpha", dataDir: "public/data/alpha", workDir: "data/alpha", slugs: ["alpha", "beta"], excludedFiles: ["hand-kept/notes.json"] });
    put("data/alpha/hand-kept/notes.json");
    put("data/alpha/hand-kept/other.json");
    put("data/alpha/cex-candidates.json");
    const r = await listCoinFiles({ root, layout: mine, kind: "holders" });
    expect(r.excluded).toEqual(["data/alpha/cex-candidates.json", "data/alpha/hand-kept/notes.json"]);
    expect(r.files).toEqual(["data/alpha/hand-kept/other.json"]);
    expect((await listCoinFiles({ root, layout: own, kind: "holders" })).files).toContain("data/alpha/hand-kept/notes.json");
  });

  it("refuses an excludedFiles entry that is not a repo-relative path", () => {
    const make = (excludedFiles) => () => coinLayout({ slug: "a", dataDir: "public/data/a", workDir: "data/a", excludedFiles });
    expect(make("x.json")).toThrow(StoreFilesError);
    expect(make([""])).toThrow(StoreFilesError);
    expect(make(["/abs.json"])).toThrow(StoreFilesError);
    expect(make(["../x.json"])).toThrow(StoreFilesError);
    expect(make([7])).toThrow(StoreFilesError);
  });

  it("excludes exactly those files and a *-previous.json copy, and nothing near them", async () => {
    put("public/data/alpha/a.json");
    put("public/data/alpha/a-previous.json");
    put("public/data/alpha/a-previous.json.tmp");
    put("public/data/alpha/previous.json");
    put("public/data/alpha/.gitkeep", "");
    put("public/data/alpha/.gitkeeper");
    put("data/alpha/cex-candidates.json");
    put("data/alpha/cex-candidates-old.json");
    put("data/alpha/nested/cex-candidates.json");
    put("data/alpha/unallocated-classification.json");
    const r = await listCoinFiles({ root, layout: own, kind: "holders" });
    expect(r.excluded).toEqual(["data/alpha/cex-candidates.json", "data/alpha/unallocated-classification.json", "public/data/alpha/.gitkeep", "public/data/alpha/a-previous.json"]);
    expect(r.files).toEqual([
      "data/alpha/cex-candidates-old.json", "data/alpha/nested/cex-candidates.json", "public/data/alpha/.gitkeeper", "public/data/alpha/a-previous.json.tmp", "public/data/alpha/a.json", "public/data/alpha/previous.json",
    ]);
  });
});

describe("a file that is neither stored nor excluded fails the coin", () => {
  it("refuses a name that holds the slice marker", async () => {
    put("public/data/alpha/ok.json");
    put("public/data/alpha/big.json#slice.0");
    const err = await listCoinFiles({ root, layout: own, kind: "holders" }).catch((e) => e);
    expect(err).toBeInstanceOf(UnclassifiedFileError);
    expect(err.files).toEqual([{ path: "public/data/alpha/big.json#slice.0", why: "name cannot be stored" }]);
  });

  it("refuses a name with a leading space and a directory named like another coin", async () => {
    put("public/data/alpha/ ws.json");
    put("data/alpha/beta/x.json");
    const err = await listCoinFiles({ root, layout: own, kind: "holders" }).catch((e) => e);
    expect(err).toBeInstanceOf(UnclassifiedFileError);
    expect(err.files.map((f) => f.path).sort()).toEqual(["data/alpha/beta", "public/data/alpha/ ws.json"]);
    expect(err.message).toContain("2 file(s)");
  });

  it("refuses a symbolic link when the platform lets the test make one", async () => {
    put("public/data/alpha/target.json");
    try {
      fs.symlinkSync(path.join(root, "public/data/alpha/target.json"), path.join(root, "public/data/alpha/link.json"));
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") return;
      throw err;
    }
    const err = await listCoinFiles({ root, layout: own, kind: "holders" }).catch((e) => e);
    expect(err).toBeInstanceOf(UnclassifiedFileError);
    expect(err.files[0].why).toBe("not a regular file");
  });
});
