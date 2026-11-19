// The arithmetic behind the synthetic ledger. Nothing here holds a list of accounts: an account is an index
// i in [0, H), the accounts that change on a day are an arithmetic progression mod H (so "who changed" costs
// O(C) and "did i change" costs O(1) by inverting the progression), and a balance is rebuilt from the seed.

const UNIT = 1_000_000n;
// Fibonacci-like weights with a zero, so some accounts start empty and a few are large.
const WEIGHTS = [0n, 1n, 1n, 2n, 3n, 5n, 8n, 13n, 21n, 34n, 55n, 89n, 144n, 233n, 377n, 610n];
const WEIGHT_CYCLE = WEIGHTS.length;
const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b, 0n);
const MAX_ACCOUNTS = 2 ** 32 - 1;
const NAME_PREFIX = "acct-";
const NAME_DIGITS = 12;
const DRAIN_ONE_IN = 5;
const MAX_STAKE_UNITS = 100;
const STAKE_RESOLUTION = 1_000_000;

const mix = (value) => {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

/** Deterministic 32-bit hash of a seed and up to three integers. */
export const hash = (seed, a, b = 0, c = 0) => mix(mix(mix(mix(seed ^ 0x9e3779b9) ^ a) + b) ^ (c + 0x7f4a7c15));

// Products of two numbers below H stay exact in a double up to H of about 94 million; beyond that go through
// BigInt, so the same code serves a hundred million accounts.
export const mulmod = (a, b, m) => {
  const product = a * b;
  return product <= Number.MAX_SAFE_INTEGER ? product % m : Number((BigInt(a) * BigInt(b)) % BigInt(m));
};

const gcd = (a, b) => {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
};

export function modInverse(a, m) {
  if (m === 1) return 0;
  let [r0, r1, t0, t1] = [m, a % m, 0, 1];
  while (r1 !== 0) {
    const q = Math.floor(r0 / r1);
    [r0, r1] = [r1, r0 - q * r1];
    [t0, t1] = [t1, t0 - q * t1];
  }
  return ((t0 % m) + m) % m;
}

/** The progression for one day: index(k) = (a*k + b) mod H, with a coprime to H so no index repeats. */
function dayProgression(seed, H, day, salt) {
  let a = 1 + (H > 1 ? hash(seed, day, salt, 1) % (H - 1) : 0);
  while (gcd(a, H) !== 1) a = a >= H - 1 ? 1 : a + 1;
  return { a, b: hash(seed, day, salt, 2) % H, inv: modInverse(a, H) };
}

const SALT_BALANCE = 1;
const SALT_STAKE = 2;

/**
 * @param {{ seed: number, accounts: number, changesPerDay: number, days: number, stakeShare: number }} p
 */
export function createModel({ seed, accounts: H, changesPerDay, days, stakeShare }) {
  if (!Number.isInteger(H) || H < 1 || H > MAX_ACCOUNTS) throw new RangeError(`accounts must be an integer in [1, ${MAX_ACCOUNTS}], got ${H}`);
  const C = Math.min(changesPerDay, H);
  const progressions = (salt) => Array.from({ length: days + 1 }, (_, d) => (d === 0 ? null : dayProgression(seed, H, d, salt)));
  const balanceDays = progressions(SALT_BALANCE);
  const stakeDays = progressions(SALT_STAKE);
  const weightOffset = hash(seed, 7) % WEIGHT_CYCLE;

  const slotIn = (progression, i) => {
    const k = mulmod((i - progression.b + H) % H, progression.inv, H);
    return k < C ? k : -1;
  };
  const indexIn = (progression, k) => (mulmod(progression.a, k, H) + progression.b) % H;

  const initialBalance = (i) => UNIT * WEIGHTS[(i + weightOffset) % WEIGHT_CYCLE];
  // Whole cycles of the weight table plus the partial cycle at the end: no pass over the accounts.
  const supply = (() => {
    let total = BigInt(Math.floor(H / WEIGHT_CYCLE)) * WEIGHT_SUM;
    for (let j = 0; j < H % WEIGHT_CYCLE; j++) total += WEIGHTS[(j + weightOffset) % WEIGHT_CYCLE];
    return total * UNIT;
  })();

  // Both accounts of a pair are read at the end of the previous day, so a balance depends on its own history
  // and on its partners' histories. Partners rarely have changed on the same earlier days (C is small next to
  // H); only when nearly every account changes every day does the walk grow, to at most 2^days.
  const pairOutcome = (day, pair) => {
    const x = indexIn(balanceDays[day], 2 * pair);
    const y = indexIn(balanceDays[day], 2 * pair + 1);
    const bx = balanceAt(x, day - 1);
    const by = balanceAt(y, day - 1);
    let [from, to, fromBalance] = hash(seed, day, pair, 14) & 1 ? [x, y, bx] : [y, x, by];
    if (fromBalance === 0n) [from, to, fromBalance] = from === x ? [y, x, by] : [x, y, bx];
    const drain = hash(seed, day, pair, 13) % DRAIN_ONE_IN === 0;
    const wide = (BigInt(hash(seed, day, pair, 11)) << 32n) | BigInt(hash(seed, day, pair, 12));
    const amount = drain ? fromBalance : wide % (fromBalance + 1n);
    const delta = (i) => (i === from ? -amount : amount);
    return { from, to, amount, newX: bx + delta(x), newY: by + delta(y), x, y };
  };

  function balanceAt(i, day) {
    for (let d = day; d >= 1; d--) {
      const k = slotIn(balanceDays[d], i);
      if (k < 0 || 2 * Math.floor(k / 2) + 1 >= C) continue; // not changed, or the odd slot out of an odd C
      const outcome = pairOutcome(d, Math.floor(k / 2));
      return i === outcome.x ? outcome.newX : outcome.newY;
    }
    return initialBalance(i);
  }

  const stakeShareCut = Math.floor(stakeShare * STAKE_RESOLUTION);
  const isStaker = (i) => stakeShare >= 1 || hash(seed, i, 21) % STAKE_RESOLUTION < stakeShareCut;
  const stakeFrom = (h) => UNIT * BigInt(1 + (h % MAX_STAKE_UNITS));
  function stakeAt(i, day) {
    if (!isStaker(i)) return 0n;
    for (let d = day; d >= 1; d--) {
      if (slotIn(stakeDays[d], i) < 0) continue;
      const h = hash(seed, i, d, 22);
      return h % 4 === 0 ? 0n : stakeFrom(h >>> 2); // one change in four is an unstake
    }
    return stakeFrom(hash(seed, i, 23));
  }

  const dayId = (d) => `blk-${hash(seed, d, 31).toString(16).padStart(8, "0")}${hash(seed, d, 32).toString(16).padStart(8, "0")}`;
  const accountName = (i) => NAME_PREFIX + i.toString(16).padStart(NAME_DIGITS, "0");

  return {
    accounts: H,
    changesPerDay: C,
    days,
    supply,
    decimals: 6,
    accountName,
    dayId,
    balanceAt,
    stakeAt,
    pairOutcome,
    hasPartner: (k) => 2 * Math.floor(k / 2) + 1 < C,
    balanceSlot: (day, i) => slotIn(balanceDays[day], i),
    balanceIndex: (day, k) => indexIn(balanceDays[day], k),
    stakeSlot: (day, i) => slotIn(stakeDays[day], i),
    stakeIndex: (day, k) => indexIn(stakeDays[day], k),
    isStaker,
    hasStakers: stakeShareCut > 0,
  };
}

export const ACCOUNT_PATTERN = new RegExp(`^${NAME_PREFIX}[0-9a-f]{${NAME_DIGITS}}$`);
export const parseAccount = (name) => parseInt(name.slice(NAME_PREFIX.length), 16);
