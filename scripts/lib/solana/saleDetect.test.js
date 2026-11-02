import { describe, expect, it } from "vitest";
import { detectSale, SALE_DUST_LAMPORTS } from "./saleDetect.js";
import { STABLE_MINTS, WSOL_MINT } from "./knownMints.js";

// Synthetic addresses; jsonParsed shapes as in walletFlowScan.test.js.
const ZBCN = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const USDC = STABLE_MINTS.USDC.mint;
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CARRIER = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const POOL = "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w";
const WALLET_USDC = "WalletUsdcAta";
const CARRIER_USDC = "CarrierUsdcAta";
const POOL_USDC = "PoolUsdcAta";
const WALLET_WSOL = "WalletWsolAta";
const WALLET_ZBCN = "WalletZbcnAta";
const BLOCK_TIME = 1_800_000_000;
const FEE = 5000;
const SOL = 1_000_000_000;

/** Token balance row for one token account at `accountIndex`. */
const balance = (accountIndex, mint, owner, amount, decimals = 6) => ({
  accountIndex,
  mint,
  owner,
  uiTokenAmount: { amount: String(amount), decimals },
});

/** jsonParsed-like tx: `keys` are account addresses in index order. */
const txFixture = ({ keys, fee = 0, pre = [], post = [], preLamports = [], postLamports = [] }) => ({
  transaction: { message: { accountKeys: keys } },
  meta: {
    err: null,
    fee,
    preBalances: preLamports,
    postBalances: postLamports,
    preTokenBalances: pre,
    postTokenBalances: post,
  },
});

const detect = (tx, overrides = {}) =>
  detectSale({
    tx,
    signature: "sig1",
    blockTime: BLOCK_TIME,
    wallet: WALLET,
    zbcnMint: ZBCN,
    soldRaw: 0n,
    dexOwners: new Set([POOL]),
    ...overrides,
  });

/** Case-flipped copy of an address: differs from it only in letter case. */
const flipCase = (s) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");

describe("detectSale", () => {
  it("records a stablecoin gain to the wallet as one wallet token leg", () => {
    const tx = txFixture({
      keys: [WALLET, WALLET_USDC],
      fee: FEE,
      preLamports: [SOL, 0],
      postLamports: [SOL - FEE, 0],
      pre: [balance(1, USDC, WALLET, 0)],
      post: [balance(1, USDC, WALLET, 2_500_000)],
    });
    expect(detect(tx)).toEqual({
      sig: "sig1",
      t: BLOCK_TIME,
      wallet: WALLET,
      dex: [],
      soldRaw: "0",
      legs: [{ mint: USDC, raw: "2500000", decimals: 6, holder: "wallet", owner: WALLET, account: WALLET_USDC, source: "token" }],
    });
  });

  it("turns a wSOL-closing swap's native SOL gain into exactly one native leg", () => {
    // Fee added back for the payer: post - pre = 1_999_995_000, + fee = 2_000_000_000.
    const tx = txFixture({
      keys: [WALLET, POOL],
      fee: FEE,
      preLamports: [SOL, 0],
      postLamports: [3 * SOL - FEE, 0],
    });
    const record = detect(tx, { soldRaw: 2_000_000_000n });
    expect(record.legs).toEqual([
      { mint: WSOL_MINT, raw: "2000000000", decimals: 9, holder: "wallet", owner: WALLET, account: null, source: "native" },
    ]);
    expect(record.soldRaw).toBe("2000000000");
  });

  it("emits an other-holder leg when a DEX owner pays a third owner and the wallet gains nothing", () => {
    const tx = txFixture({
      keys: [WALLET, POOL_USDC, CARRIER_USDC],
      fee: FEE,
      preLamports: [SOL, 0, 0],
      postLamports: [SOL - FEE, 0, 0],
      pre: [balance(1, USDC, POOL, 5_000_000), balance(2, USDC, CARRIER, 0)],
      post: [balance(1, USDC, POOL, 0), balance(2, USDC, CARRIER, 5_000_000)],
    });
    expect(detect(tx)).toEqual({
      sig: "sig1",
      t: BLOCK_TIME,
      wallet: WALLET,
      dex: [POOL],
      soldRaw: "0",
      legs: [{ mint: USDC, raw: "5000000", decimals: 6, holder: "other", owner: CARRIER, account: CARRIER_USDC, source: "token" }],
    });
  });

  it("returns null when nothing was gained", () => {
    const tx = txFixture({ keys: [WALLET], fee: FEE, preLamports: [SOL], postLamports: [SOL - FEE] });
    expect(detect(tx)).toBeNull();
  });

  it("drops a SOL gain under the dust floor and keeps one at the floor", () => {
    const noise = txFixture({ keys: [WALLET], preLamports: [SOL], postLamports: [SOL + Number(SALE_DUST_LAMPORTS) - 1] });
    expect(detect(noise)).toBeNull();
    const atFloor = txFixture({ keys: [WALLET], preLamports: [SOL], postLamports: [SOL + Number(SALE_DUST_LAMPORTS)] });
    expect(detect(atFloor).legs).toEqual([
      { mint: WSOL_MINT, raw: "5000000", decimals: 9, holder: "wallet", owner: WALLET, account: null, source: "native" },
    ]);
  });

  it("never records the native token as a leg", () => {
    const zbcnOnly = txFixture({
      keys: [WALLET, WALLET_ZBCN],
      preLamports: [SOL, 0],
      postLamports: [SOL, 0],
      pre: [balance(1, ZBCN, WALLET, 0, 6)],
      post: [balance(1, ZBCN, WALLET, 1_000_000_000, 6)],
    });
    expect(detect(zbcnOnly)).toBeNull();

    const mixed = txFixture({
      keys: [WALLET, WALLET_ZBCN, WALLET_USDC],
      preLamports: [SOL, 0, 0],
      postLamports: [SOL, 0, 0],
      pre: [balance(1, ZBCN, WALLET, 0, 6), balance(2, USDC, WALLET, 0)],
      post: [balance(1, ZBCN, WALLET, 1_000_000_000, 6), balance(2, USDC, WALLET, 2_000_000)],
    });
    expect(detect(mixed).legs.map((leg) => leg.mint)).toEqual([USDC]);
  });

  it("counts wSOL gained as a token once, as one native SOL leg", () => {
    const tx = txFixture({
      keys: [WALLET, WALLET_WSOL],
      fee: FEE,
      preLamports: [SOL, 0],
      postLamports: [SOL - FEE, 0],
      pre: [balance(1, WSOL_MINT, WALLET, 0, 9)],
      post: [balance(1, WSOL_MINT, WALLET, SOL, 9)],
    });
    const record = detect(tx);
    expect(record.legs).toEqual([
      { mint: WSOL_MINT, raw: "1000000000", decimals: 9, holder: "wallet", owner: WALLET, account: null, source: "native" },
    ]);
  });

  it("treats owner addresses differing only in case as different owners", () => {
    const twin = flipCase(WALLET);
    expect(twin).not.toBe(WALLET);
    const tx = txFixture({
      keys: [twin, WALLET_USDC],
      preLamports: [SOL, 0],
      postLamports: [SOL, 0],
      pre: [balance(1, USDC, twin, 0)],
      post: [balance(1, USDC, twin, 2_000_000)],
    });
    expect(detect(tx, { wallet: WALLET })).toBeNull();
    expect(detect(tx, { wallet: twin }).legs).toEqual([
      { mint: USDC, raw: "2000000", decimals: 6, holder: "wallet", owner: twin, account: WALLET_USDC, source: "token" },
    ]);
  });

  it("does not mutate the input transaction", () => {
    const tx = txFixture({
      keys: [WALLET, POOL_USDC, CARRIER_USDC],
      fee: FEE,
      preLamports: [SOL, 0, 0],
      postLamports: [SOL - FEE, 0, 0],
      pre: [balance(1, USDC, POOL, 5_000_000), balance(2, USDC, CARRIER, 0)],
      post: [balance(1, USDC, POOL, 0), balance(2, USDC, CARRIER, 5_000_000)],
    });
    const snapshot = structuredClone(tx);
    detect(tx);
    expect(tx).toEqual(snapshot);
  });
});
