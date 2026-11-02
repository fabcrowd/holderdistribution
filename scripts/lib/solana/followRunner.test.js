import { describe, expect, it } from "vitest";
import { CallBudgetError } from "./callBudget.js";
import { runFollow, seedDeeperTasks, seedTasks } from "./followRunner.js";

// Synthetic base58-looking keys; case is significant and must never be folded.
const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const BOB_LOWER = BOB.toLowerCase();
const DEST = "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ";
const SELLER = "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const NOW = Date.parse("2026-11-01T12:00:00Z") / 1000;
const DAY = 86400;
const ROLES = { wallets: new Set([ALICE]), cex: new Map(), dex: new Set(), staking: new Set() };

const unlabelled = (over = {}) => ({
  wallet: ALICE,
  kind: "unlabelled",
  venue: null,
  dest: DEST,
  raw: "1000",
  t: NOW - 2 * DAY,
  sig: "SIG_A",
  ...over,
});

const tokenLeg = (over = {}) => ({
  mint: MINT,
  raw: "500",
  decimals: 6,
  holder: "wallet",
  owner: SELLER,
  account: "SellerAta1",
  source: "token",
  ...over,
});

const sale = (over = {}) => ({
  sig: "SALE_1",
  t: NOW - 3 * DAY,
  wallet: ALICE,
  dex: "raydium",
  soldRaw: "500",
  legs: [tokenLeg()],
  ...over,
});

const baseState = (over = {}) => ({ events: [], sales: [], ...over });

const SEED = { nowSec: NOW, mint: MINT, decimals: 6 };

const openTask = (id, kind, remaining, over = {}) => ({
  id,
  kind,
  ref: `ref-${id}`,
  rootWallet: ALICE,
  owner: DEST,
  account: kind === "trace" ? null : "AcctX",
  mint: MINT,
  decimals: 6,
  sinceSec: NOW - DAY,
  remaining,
  depth: 1,
  until: null,
  status: "open",
  ...over,
});

/** Follower that marks each task done and records its arguments. */
function recordingFollower() {
  const seen = [];
  const follower = async (args) => {
    seen.push(args);
    return { task: { ...args.task, status: "done" }, hops: [], nextTasks: [] };
  };
  return { follower, seen };
}

const idsOf = (seen) => seen.map((a) => a.task.id);

describe("seedTasks", () => {
  it("is idempotent: seeding a seeded state keeps the same task set", () => {
    const state = baseState({ events: [unlabelled()], sales: [sale()] });
    const once = seedTasks(state, SEED);
    const twice = seedTasks({ ...state, follow: once }, SEED);

    expect(Object.keys(twice.tasks).sort()).toEqual(Object.keys(once.tasks).sort());
    expect(Object.keys(once.tasks)).toHaveLength(2);
  });

  it("skips unlabelled events below minRaw", () => {
    const state = baseState({
      events: [unlabelled({ raw: "5", sig: "SMALL" }), unlabelled({ raw: "500", sig: "BIG" })],
    });
    const { tasks } = seedTasks(state, { ...SEED, minRaw: 100n });

    const ids = Object.keys(tasks);
    expect(ids).toHaveLength(1);
    expect(tasks[ids[0]].remaining).toBe("500");
    expect(ids[0]).toContain("|BIG|");
  });

  it("skips events and sales older than 90 days", () => {
    const state = baseState({
      events: [unlabelled({ t: NOW - 91 * DAY, sig: "OLD" }), unlabelled({ t: NOW - 89 * DAY, sig: "RECENT" })],
      sales: [sale({ t: NOW - 91 * DAY, sig: "OLD_SALE" })],
    });
    const { tasks } = seedTasks(state, SEED);

    expect(Object.keys(tasks)).toHaveLength(1);
    expect(Object.keys(tasks)[0]).toContain("|RECENT|");
  });

  it("seeds a native leg as an untracked task with no account", () => {
    const nativeLeg = tokenLeg({ mint: SOL_MINT, source: "native", account: null, raw: "42", decimals: 9 });
    const { tasks } = seedTasks(baseState({ sales: [sale({ legs: [nativeLeg] })] }), SEED);

    const task = tasks[`sale|SALE_1|${ALICE}|${SOL_MINT}`];
    expect(task).toMatchObject({ kind: "sale", account: null, status: "untracked", remaining: "42" });
  });

  it("keeps wallets that differ only in case as separate task ids", () => {
    const state = baseState({
      events: [unlabelled({ wallet: BOB, sig: "S" }), unlabelled({ wallet: BOB_LOWER, sig: "S" })],
    });
    const { tasks } = seedTasks(state, SEED);

    expect(Object.keys(tasks)).toHaveLength(2);
    expect(tasks[`trace|S|${BOB}|${DEST}|${MINT}`]).toBeDefined();
    expect(tasks[`trace|S|${BOB_LOWER}|${DEST}|${MINT}`]).toBeDefined();
  });

  it("does not mutate the input state", () => {
    const state = baseState({ events: [unlabelled()], sales: [sale()] });
    const snapshot = structuredClone(state);
    seedTasks(state, SEED);

    expect(state).toEqual(snapshot);
  });
});

describe("seedDeeperTasks", () => {
  const TRACE_REF = `SIG_A|${ALICE}|${DEST}`;
  const TRACE_ID = `trace|${TRACE_REF}|${MINT}`;
  const doneTrace = {
    id: TRACE_ID,
    kind: "trace",
    ref: TRACE_REF,
    rootWallet: ALICE,
    owner: DEST,
    account: null,
    mint: MINT,
    decimals: 6,
    sinceSec: NOW - 3 * DAY,
    remaining: "1000",
    depth: 1,
    until: null,
    status: "done",
  };
  const hopTo = (to, over = {}) => ({
    taskId: TRACE_ID,
    depth: 1,
    from: DEST,
    to,
    kind: "unlabelled",
    venue: null,
    mint: MINT,
    raw: "700",
    t: NOW - 2 * DAY,
    sig: "SIG_B",
    ...over,
  });
  const follow = { tasks: { [TRACE_ID]: doneTrace }, hops: [hopTo(BOB)] };
  const OPTS = { nowSec: NOW, maxTraceDepth: 2, maxSaleDepth: 2 };
  const CHILD_ID = `trace|${TRACE_REF}|${BOB}|${MINT}`;

  it("adds one open depth-2 trace task when maxTraceDepth is 2", () => {
    const { tasks } = seedDeeperTasks(follow, OPTS);

    expect(Object.keys(tasks)).toHaveLength(2);
    expect(tasks[CHILD_ID]).toMatchObject({
      kind: "trace",
      ref: TRACE_REF,
      owner: BOB,
      account: null,
      depth: 2,
      remaining: "700",
      sinceSec: NOW - 2 * DAY,
      status: "open",
    });
  });

  it("adds no task when maxTraceDepth is 1", () => {
    const { tasks } = seedDeeperTasks(follow, { ...OPTS, maxTraceDepth: 1 });

    expect(Object.keys(tasks)).toEqual([TRACE_ID]);
  });

  it("is idempotent: a second call keeps the same tasks", () => {
    const once = seedDeeperTasks(follow, OPTS);
    const twice = seedDeeperTasks(once, OPTS);

    expect(twice.tasks).toEqual(once.tasks);
    expect(twice.hops).toEqual(once.hops);
  });

  it("keeps base58 owners exactly as given, never case-folded", () => {
    const mixed = { tasks: { [TRACE_ID]: doneTrace }, hops: [hopTo(BOB), hopTo(BOB_LOWER)] };
    const { tasks } = seedDeeperTasks(mixed, OPTS);

    expect(tasks[`trace|${TRACE_REF}|${BOB}|${MINT}`].owner).toBe(BOB);
    expect(tasks[`trace|${TRACE_REF}|${BOB_LOWER}|${MINT}`].owner).toBe(BOB_LOWER);
  });

  it("uses maxSaleDepth for sale tasks and ignores maxTraceDepth", () => {
    const saleRef = `SALE_1|${ALICE}`;
    const saleTask = { ...doneTrace, id: `sale|${saleRef}|${MINT}`, kind: "sale", ref: saleRef, owner: SELLER };
    const saleFollow = {
      tasks: { [saleTask.id]: saleTask },
      hops: [hopTo(BOB, { taskId: saleTask.id })],
    };
    const childId = `sale|${saleRef}|${BOB}|${MINT}`;

    expect(seedDeeperTasks(saleFollow, { nowSec: NOW, maxTraceDepth: 1, maxSaleDepth: 2 }).tasks[childId]).toMatchObject({
      kind: "sale",
      depth: 2,
      status: "open",
    });
    expect(seedDeeperTasks(saleFollow, { nowSec: NOW, maxTraceDepth: 2, maxSaleDepth: 1 }).tasks[childId]).toBeUndefined();
  });

  it("creates nothing when the parent is already at the depth cap of 2", () => {
    const capped = { tasks: { [TRACE_ID]: { ...doneTrace, depth: 2 } }, hops: [hopTo(BOB)] };
    const { tasks } = seedDeeperTasks(capped, OPTS);

    expect(Object.keys(tasks)).toEqual([TRACE_ID]);
  });
});

describe("runFollow", () => {
  it("never passes an untracked native task to the follower", async () => {
    const nativeLeg = tokenLeg({ mint: SOL_MINT, source: "native", account: null, raw: "42", decimals: 9 });
    const state = baseState({ sales: [sale({ legs: [nativeLeg] })] });
    const follow = seedTasks(state, SEED);
    const { follower, seen } = recordingFollower();

    const { follow: out } = await runFollow({
      call: async () => ({}),
      state: { ...state, follow },
      roles: ROLES,
      nowSec: NOW,
      follower,
    });

    expect(seen).toHaveLength(0);
    expect(out.tasks[`sale|SALE_1|${ALICE}|${SOL_MINT}`].status).toBe("untracked");
  });

  it("runs sale tasks before trace tasks, each by descending remaining", async () => {
    const follow = {
      tasks: {
        "trace|a": openTask("trace|a", "trace", "100"),
        "trace|b": openTask("trace|b", "trace", "900"),
        "sale|c": openTask("sale|c", "sale", "50"),
        "sale|d": openTask("sale|d", "sale", "700"),
      },
      hops: [],
    };
    const { follower, seen } = recordingFollower();

    await runFollow({ call: async () => ({}), state: { follow }, roles: ROLES, nowSec: NOW, follower });

    expect(idsOf(seen)).toEqual(["sale|d", "sale|c", "trace|b", "trace|a"]);
  });

  it("limits follower calls to maxTasks", async () => {
    const tasks = {};
    for (let i = 0; i < 5; i += 1) tasks[`trace|${i}`] = openTask(`trace|${i}`, "trace", String(100 + i));
    const { follower, seen } = recordingFollower();

    await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      limits: { maxTasks: 2 },
      follower,
    });

    expect(seen).toHaveLength(2);
  });

  it("never exceeds maxCalls and reports usedCalls exactly", async () => {
    const tasks = {
      "trace|1": openTask("trace|1", "trace", "300"),
      "trace|2": openTask("trace|2", "trace", "200"),
      "trace|3": openTask("trace|3", "trace", "100"),
    };
    let underlying = 0;
    const call = async () => {
      underlying += 1;
      return {};
    };
    const spender = async ({ call: budgetedCall, task }) => {
      for (let i = 0; i < 4; i += 1) await budgetedCall("getSignaturesForAddress", []);
      return { task: { ...task, status: "done" }, hops: [], nextTasks: [] };
    };

    const { follow, usedCalls } = await runFollow({
      call,
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      limits: { maxCalls: 10 },
      follower: spender,
    });

    expect(underlying).toBe(10);
    expect(usedCalls).toBe(10);
    expect(follow.tasks["trace|1"].status).toBe("done");
    expect(follow.tasks["trace|3"].status).toBe("budget");
  });

  it("marks a task budget when the follower hits the call budget", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "10") };
    const throwing = async ({ call: budgetedCall }) => {
      await budgetedCall("getX", []);
      throw new CallBudgetError("RPC call budget of 0 exhausted");
    };

    const { follow } = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      limits: { maxCalls: 5 },
      follower: throwing,
    });

    expect(follow.tasks["trace|1"].status).toBe("budget");
  });

  it("reports a follower error without retrying it in the same run", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "10") };
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("boom");
    };

    const { follow } = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      follower: failing,
    });

    expect(calls).toBe(1);
    expect(follow.tasks["trace|1"].status).toBe("error");
  });

  it("does not re-run a done task", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "10", { status: "done" }) };
    const { follower, seen } = recordingFollower();

    await runFollow({ call: async () => ({}), state: { follow: { tasks, hops: [] } }, roles: ROLES, nowSec: NOW, follower });

    expect(seen).toHaveLength(0);
  });

  it("de-duplicates hops across two runs", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "1000") };
    const hop = {
      taskId: "trace|1",
      depth: 1,
      from: ALICE,
      to: DEST,
      kind: "unlabelled",
      venue: null,
      mint: MINT,
      raw: "10",
      t: NOW - DAY,
      sig: "HOP_SIG",
    };
    const stillOpen = async ({ task }) => ({ task: { ...task, status: "open" }, hops: [hop], nextTasks: [] });

    const first = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      follower: stillOpen,
    });
    const second = await runFollow({
      call: async () => ({}),
      state: { follow: first.follow },
      roles: ROLES,
      nowSec: NOW,
      follower: stillOpen,
    });

    expect(second.follow.hops).toHaveLength(1);
  });

  it("adds a nextTask returned by two parents only once", async () => {
    const tasks = {
      "trace|p1": openTask("trace|p1", "trace", "100"),
      "trace|p2": openTask("trace|p2", "trace", "90"),
    };
    const child = openTask("trace|child", "trace", "10", { depth: 2 });
    const seen = [];
    const follower = async ({ task }) => {
      seen.push(task.id);
      const nextTasks = task.id === "trace|child" ? [] : [child];
      return { task: { ...task, status: "done" }, hops: [], nextTasks };
    };

    const { follow } = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      follower,
    });

    expect(seen.filter((id) => id === "trace|child")).toHaveLength(1);
    expect(follow.tasks["trace|child"].status).toBe("done");
  });

  it("passes the saleDepth default of 2 and clamps traceDepth to 2", async () => {
    const tasks = {
      "sale|s": openTask("sale|s", "sale", "10"),
      "trace|t": openTask("trace|t", "trace", "10"),
    };
    const { follower, seen } = recordingFollower();

    await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      limits: { traceDepth: 9 },
      follower,
    });

    expect(seen.find((a) => a.task.kind === "sale").maxDepth).toBe(2);
    expect(seen.find((a) => a.task.kind === "trace").maxDepth).toBe(2);
  });

  it("runs the seeded depth-2 trace task at traceDepth 2 and nothing new at 1", async () => {
    const ref = `SIG_A|${ALICE}|${DEST}`;
    const parentId = `trace|${ref}|${MINT}`;
    const parent = openTask(parentId, "trace", "1000", {
      ref,
      owner: DEST,
      account: null,
      sinceSec: NOW - 3 * DAY,
      status: "done",
    });
    const hop = {
      taskId: parentId,
      depth: 1,
      from: DEST,
      to: BOB,
      kind: "unlabelled",
      venue: null,
      mint: MINT,
      raw: "700",
      t: NOW - 2 * DAY,
      sig: "SIG_B",
    };
    const state = baseState({ follow: { tasks: { [parentId]: parent }, hops: [hop] } });
    const deep = recordingFollower();
    await runFollow({ call: async () => null, state, roles: ROLES, nowSec: NOW, limits: { traceDepth: 2 }, follower: deep.follower });

    expect(idsOf(deep.seen)).toEqual([`trace|${ref}|${BOB}|${MINT}`]);
    expect(deep.seen[0].task.depth).toBe(2);

    const shallow = recordingFollower();
    await runFollow({ call: async () => null, state, roles: ROLES, nowSec: NOW, limits: { traceDepth: 1 }, follower: shallow.follower });

    expect(idsOf(shallow.seen)).toEqual([]);
  });

  it("runs nothing when the deadline has already passed", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "10") };
    const { follower, seen } = recordingFollower();

    const { usedCalls } = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      deadlineMs: Date.now() - 1,
      follower,
    });

    expect(seen).toHaveLength(0);
    expect(usedCalls).toBe(0);
  });

  it("does not mutate the input state", async () => {
    const state = baseState({ events: [unlabelled()], sales: [sale()] });
    const follow = seedTasks(state, SEED);
    const withFollow = { ...state, follow };
    const snapshot = structuredClone(withFollow);
    const { follower } = recordingFollower();

    await runFollow({ call: async () => ({}), state: withFollow, roles: ROLES, nowSec: NOW, follower });

    expect(withFollow).toEqual(snapshot);
  });

  it("re-runs an errored task with no attempts field and marks it done on success", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "10", { status: "error" }) };
    const { follower, seen } = recordingFollower();

    const { follow } = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      follower,
    });

    expect(idsOf(seen)).toEqual(["trace|1"]);
    expect(follow.tasks["trace|1"].status).toBe("done");
  });

  it("does not re-run an errored task that has already used 3 attempts", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "10", { status: "error", attempts: 3 }) };
    const { follower, seen } = recordingFollower();

    const { follow } = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      follower,
    });

    expect(seen).toHaveLength(0);
    expect(follow.tasks["trace|1"]).toMatchObject({ status: "error", attempts: 3 });
  });

  it("never re-runs a busy task", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "10", { status: "busy" }) };
    const { follower, seen } = recordingFollower();

    const { follow } = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      follower,
    });

    expect(seen).toHaveLength(0);
    expect(follow.tasks["trace|1"].status).toBe("busy");
  });

  it("does not retry an error that happens again within the same run", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "10", { status: "error", attempts: 1 }) };
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("boom");
    };

    const { follow } = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      follower: failing,
    });

    expect(calls).toBe(1);
    expect(follow.tasks["trace|1"]).toMatchObject({ status: "error", attempts: 2 });
  });

  it("counts an error status returned by the follower as an attempt", async () => {
    const tasks = { "trace|1": openTask("trace|1", "trace", "10") };
    const returnsError = async ({ task }) => ({ task: { ...task, status: "error" }, hops: [], nextTasks: [] });

    const { follow } = await runFollow({
      call: async () => ({}),
      state: { follow: { tasks, hops: [] } },
      roles: ROLES,
      nowSec: NOW,
      follower: returnsError,
    });

    expect(follow.tasks["trace|1"]).toMatchObject({ status: "error", attempts: 1 });
  });
});
