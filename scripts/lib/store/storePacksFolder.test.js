// The merged table sequences (storeHistory, storeFixes, the property test's model check)
// run unchanged on packItemStore over the folder backend. A small pack target makes
// most items flush mid-test, so reads exercise both the pending pack and stored packs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { setItemStoreFactory } from "./storeTestKit.js";
import { createPackItemStore } from "./packItemStore.js";
import { folderBackend } from "./blobStoreFolder.js";
import { packName } from "./packNames.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-folder-"));
let n = 0;
setItemStoreFactory(() => {
  const lane = n++;
  const blobs = folderBackend(path.join(root, String(lane)), { assetLimit: 900 });
  const nameFor = (flush) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: 1, attempt: 1, lane, flush });
  return createPackItemStore({ blobs, nameFor, targetBytes: 64 * 1024, headerCache: 4096 });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

await import("./storeHistory.test.js");
await import("./storeFixes.test.js");
// Time only: the property test passes at its 20 seeds on packs too (about 86 s on the
// folder backend), so it runs 8 by default here to keep the folder under 90 s; STORE_SEEDS overrides.
process.env.STORE_SEEDS ??= "8";
await import("./storeProperty.test.js");
