import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonOptional } from "./readJsonOptional.js";
import { stakedAmountsByAddress } from "./phantomStakers.js";

describe("readJsonOptional", () => {
  it("returns the fallback when the file is missing", async () => {
    const missing = path.join(os.tmpdir(), "hd-no-such-dir", "funding-wallets.json");
    const doc = await readJsonOptional(missing, { wallets: [] });
    expect(doc).toEqual({ wallets: [] });
    expect(stakedAmountsByAddress(doc).size).toBe(0);
  });

  it("parses an existing file and rethrows invalid JSON", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-rjo-"));
    const ok = path.join(dir, "ok.json");
    const bad = path.join(dir, "bad.json");
    await fs.writeFile(ok, '{"a":1}');
    await fs.writeFile(bad, "{nope");
    expect(await readJsonOptional(ok, null)).toEqual({ a: 1 });
    await expect(readJsonOptional(bad, null)).rejects.toThrow();
    await fs.rm(dir, { recursive: true });
  });
});
