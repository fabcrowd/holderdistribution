import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCommittedJson, replayChainRawBalances, resolveAnchorDate } from "./holdersAsOfReplay.js";

describe("resolveAnchorDate", () => {
  it("uses the target date so each project anchors on its own newest checkpoint", () => {
    expect(resolveAnchorDate(undefined, "2026-10-22")).toBe("2026-10-22");
    expect(resolveAnchorDate(null, "2026-10-22")).toBe("2026-10-22");
  });

  it("lets an explicit --anchor-date win", () => {
    expect(resolveAnchorDate("2026-08-21", "2026-10-22")).toBe("2026-08-21");
  });
});

describe("replayChainRawBalances", () => {
  it("refuses an anchor that is after the target block", async () => {
    await expect(
      replayChainRawBalances({
        anchorChain: { rawBalances: {}, lastBlock: 200 },
        transfersPath: "unused",
        toBlock: 100,
      }),
    ).rejects.toThrow(/after the target block/);
  });
});

describe("readCommittedJson with a young project", () => {
  let dir;
  afterEach(() => {
    process.chdir(os.tmpdir());
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds a checkpoint committed only recently when anchored on the target date, and fails on an older fixed date", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_AUTHOR_DATE: "2026-11-05T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-05T10:00:00Z",
    };
    const git = (...args) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
    git("init", "-q");
    fs.writeFileSync(path.join(dir, "cp.json"), JSON.stringify({ chains: { ethereum: { lastBlock: 1 } } }));
    git("add", "cp.json");
    git("commit", "-q", "-m", "first checkpoint");
    process.chdir(dir);

    expect(() => readCommittedJson("cp.json", "2026-08-21")).toThrow(/No commit of cp.json/);
    expect(readCommittedJson("cp.json", "2026-11-06").chains.ethereum.lastBlock).toBe(1);
  });
});
