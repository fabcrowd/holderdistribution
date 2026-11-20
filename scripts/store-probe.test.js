import { describe, it, expect } from "vitest";
import { PROBE_PREFIX, assertProbeTag, githubClient, runProbes } from "./store-probe.js";

// An in-memory GitHub: releases with assets, tags that outlive their release, an upload that stays "in flight"
// for `uploadTicks` calls of sleep.
function fakeGh({ uploadTicks = 3, failList = false } = {}) {
  const state = { releases: new Map(), tags: new Set(), calls: [], next: 1, ticks: 0, inflight: null };
  const gh = {
    createRelease: async ({ tag, body, prerelease }) => {
      state.calls.push(["create", tag]);
      const rel = { id: state.next++, tag, body, prerelease, draft: false, created_at: "2026-11-20T00:00:00Z", published_at: null, assets: [] };
      state.releases.set(rel.id, rel);
      state.tags.add(tag);
      return { ...rel };
    },
    getRelease: async (id) => ({ ...state.releases.get(id) }),
    listAssets: async (id) => {
      if (failList) throw new Error("listing refused");
      const rel = state.releases.get(id);
      const inflight = state.inflight?.id === id && state.ticks < uploadTicks ? [{ name: "pending", state: "starter", size: 0 }] : [];
      return [...rel.assets, ...inflight];
    },
    uploadAsset: async (id, name, bytes) => {
      state.calls.push(["upload", id, name]);
      const rel = state.releases.get(id);
      if (!rel) return { status: 404, message: "Not Found" };
      if (name === "probe-large.bin") {
        state.inflight = { id };
        while (state.ticks < uploadTicks && !failList) await Promise.resolve();
        state.inflight = null;
      }
      rel.assets.push({ name, state: "uploaded", size: bytes.length });
      return { status: 201, message: null };
    },
    deleteRelease: async (id) => {
      state.calls.push(["delete", id]);
      return state.releases.delete(id) ? 204 : 404;
    },
    getTagRef: async (tag) => (state.tags.has(tag) ? 200 : 404),
    deleteTagRef: async (tag) => (state.tags.delete(tag) ? 204 : 404),
  };
  const sleep = async () => { state.ticks++; };
  return { gh, state, sleep };
}

describe("assertProbeTag", () => {
  it("only accepts probe- tags", () => {
    expect(assertProbeTag(`${PROBE_PREFIX}abc-1`)).toBe("probe-abc-1");
    for (const bad of ["data-live-1", "live-1", "probe", "", null, "probe-x/../data-live-1", "refs/tags/probe-1"]) expect(() => assertProbeTag(bad)).toThrow(/refusing/);
  });
});

describe("runProbes", () => {
  it("measures the four behaviors and leaves nothing behind", async () => {
    const { gh, state, sleep } = fakeGh();
    const r = await runProbes({ gh, sleep, uploadBytes: Buffer.alloc(10), id: "t1", now: () => "2026-11-20T00:00:00Z" });
    expect(r.errors).toEqual([]);
    expect(r.probes.assetCountDuringUpload).toMatchObject({ uploadStatus: 201, countSeenBeforeUploadFinished: true, maxCountDuring: 1, after: { count: 1, states: ["uploaded"] } });
    expect(r.probes.assetCountDuringUpload.statesSeen).toContain("starter");
    expect(r.probes.uploadToDeletedRelease).toEqual({ deleteStatus: 204, uploadStatus: 404, uploadMessage: "Not Found" });
    expect(r.probes.prerelease).toMatchObject({ prerelease: true, publishedAtIsNull: true, bodyPersisted: true, bodyPersistedAfterUpload: true });
    expect(r.probes.tagRefAfterDelete).toMatchObject({ tagRefBeforeDelete: 200, deleteStatus: 204, tagRefAfterDelete: 200, tagSurvivesDelete: true });
    expect(state.releases.size).toBe(0);
    expect(state.tags.size).toBe(0);
    expect(r.cleanup.errors).toEqual([]);
    expect(r.cleanup.tags).toHaveLength(4);
  });

  it("only ever creates probe- tags, never a data- one", async () => {
    const { gh, state, sleep } = fakeGh();
    await runProbes({ gh, sleep, uploadBytes: Buffer.alloc(1), id: "t2" });
    const tags = state.calls.filter((c) => c[0] === "create").map((c) => c[1]);
    expect(tags).toHaveLength(4);
    for (const t of tags) expect(t).toMatch(/^probe-t2-\d$/);
  });

  it("records a failing probe and runs the others and the cleanup", async () => {
    const { gh, state, sleep } = fakeGh({ failList: true });
    const r = await runProbes({ gh, sleep, uploadBytes: Buffer.alloc(1), id: "t3" });
    expect(r.errors.map((e) => e.probe)).toEqual(["assetCountDuringUpload"]);
    expect(Object.keys(r.probes).sort()).toEqual(["prerelease", "tagRefAfterDelete", "uploadToDeletedRelease"]);
    expect(state.releases.size).toBe(0);
    expect(state.tags.size).toBe(0);
  });
});

describe("githubClient", () => {
  it("refuses to read or delete a tag outside the probe series", async () => {
    const calls = [];
    const gh = githubClient({ owner: "o", repo: "r", token: "t", http: async (url) => { calls.push(url); return { status: 200 }; } });
    await expect(gh.getTagRef("data-live-1")).rejects.toThrow(/refusing/);
    await expect(gh.deleteTagRef("data-live-1")).rejects.toThrow(/refusing/);
    expect(calls).toEqual([]);
    expect(await gh.getTagRef("probe-x-1")).toBe(200);
    expect(calls).toEqual(["https://api.github.com/repos/o/r/git/ref/tags/probe-x-1"]);
  });
});
