// The merged table sequences run unchanged on packItemStore over the release backend,
// talking to the in-memory fake server (one server per harness).
import { setItemStoreFactory } from "./storeTestKit.js";
import { createPackItemStore } from "./packItemStore.js";
import { releaseBackend } from "./blobStoreRelease.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { packName } from "./packNames.js";

setItemStoreFactory(() => {
  const server = createFakeReleaseServer();
  const blobs = releaseBackend({
    owner: "o", repo: "r", token: "secret-token", http: server.http, now: () => server.clock.t,
    sleep: async (ms) => { server.clock.t += ms; },
  });
  const nameFor = (flush) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: 1, attempt: 1, lane: 0, flush });
  return createPackItemStore({ blobs, nameFor, targetBytes: 64 * 1024, headerCache: 4096 });
});

await import("./storeHistory.test.js");
await import("./storeFixes.test.js");
// Time only: the property test passes at its 20 seeds on packs too (about 86 s on the
// folder backend), so it runs 8 by default here to keep the folder under 90 s; STORE_SEEDS overrides.
process.env.STORE_SEEDS ??= "8";
await import("./storeProperty.test.js");
