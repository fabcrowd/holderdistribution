/**
 * Solana mint metadata: decimals + supply from the mint account (jsonParsed),
 * name/symbol from the Token-2022 `tokenMetadata` extension, else from the
 * Metaplex Token Metadata PDA. Decimals are never guessed: a mint we cannot
 * read is an error.
 */
import { metaplexMetadataPda, METAPLEX_METADATA_PROGRAM } from "./pda.js";

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const PROGRAM_BY_NAME = Object.freeze({ "spl-token": SPL_TOKEN_PROGRAM, "token-2022": TOKEN_2022_PROGRAM });
export const NAME_BY_PROGRAM = Object.freeze({ [SPL_TOKEN_PROGRAM]: "spl-token", [TOKEN_2022_PROGRAM]: "token-2022" });

/**
 * Parses a getAccountInfo(jsonParsed) value for a mint.
 * @returns {{ program: "spl-token"|"token-2022", programId: string, decimals: number, supplyRaw: bigint, supply: number, name: string|null, symbol: string|null }}
 */
export function parseMintAccount(value, mint = "mint") {
  if (!value) throw new Error(`solana: mint ${mint} not found`);
  const program = NAME_BY_PROGRAM[value.owner];
  if (!program) throw new Error(`solana: ${mint} is owned by ${value.owner}, not the SPL Token or Token-2022 program`);
  const parsed = value.data?.parsed;
  if (parsed?.type !== "mint") throw new Error(`solana: ${mint} is not a mint account (type ${parsed?.type ?? "unknown"})`);
  const info = parsed.info ?? {};
  const decimals = Number(info.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`solana: ${mint} has no readable decimals`);
  const supplyRaw = BigInt(info.supply ?? "0");
  const ext = (info.extensions ?? []).find((e) => e?.extension === "tokenMetadata")?.state ?? null;
  return {
    program,
    programId: value.owner,
    decimals,
    supplyRaw,
    supply: rawToNumber(supplyRaw, decimals),
    name: cleanStr(ext?.name),
    symbol: cleanStr(ext?.symbol),
  };
}

export const rawToNumber = (raw, decimals) => {
  const big = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  return Number(big / base) + Number(big % base) / Number(base);
};

const cleanStr = (s) => {
  if (typeof s !== "string") return null;
  const t = s.replace(/\u0000+/g, "").trim();
  return t || null;
};

/**
 * Parses a Metaplex Token Metadata account (base64 data):
 * key u8 | update_authority [32] | mint [32] | name (u32 len + bytes) | symbol (u32 len + bytes) | uri ...
 */
export function parseMetaplexMetadata(base64) {
  const buf = Buffer.from(base64, "base64");
  let o = 1 + 32 + 32;
  const readStr = () => {
    if (o + 4 > buf.length) return null;
    const len = buf.readUInt32LE(o);
    o += 4;
    if (len > 200 || o + len > buf.length) return null;
    const s = buf.subarray(o, o + len).toString("utf8");
    o += len;
    return cleanStr(s);
  };
  const name = readStr();
  const symbol = readStr();
  return { name, symbol };
}

/**
 * Mint metadata via an RPC caller `call(method, params)` (already bound to a
 * URL pool with failover). Name/symbol fall back to `fallback` (the config's
 * tokens[].symbol / project ticker) when neither metadata source has them.
 */
export async function fetchMintMetadata(call, mint, { fallbackSymbol = null, fallbackName = null } = {}) {
  const res = await call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "finalized" }]);
  const meta = parseMintAccount(res?.value ?? null, mint);
  let { name, symbol } = meta;
  let metadataSource = name || symbol ? "token-2022-extension" : null;
  if (!symbol) {
    try {
      const pda = metaplexMetadataPda(mint);
      const md = await call("getAccountInfo", [pda, { encoding: "base64", commitment: "finalized" }]);
      const v = md?.value;
      if (v?.owner === METAPLEX_METADATA_PROGRAM && Array.isArray(v.data)) {
        const p = parseMetaplexMetadata(v.data[0]);
        name = name ?? p.name;
        symbol = symbol ?? p.symbol;
        if (p.symbol || p.name) metadataSource = "metaplex";
      }
    } catch {
      // Metadata is cosmetic; decimals/supply above are what the pipeline needs.
    }
  }
  if (!symbol && fallbackSymbol) metadataSource = metadataSource ?? "config";
  return {
    ...meta,
    name: name ?? fallbackName,
    symbol: symbol ?? fallbackSymbol,
    metadataSource,
  };
}
