/**
 * getTransaction that survives newer transaction versions. An RPC node rejects a
 * transaction whose version is above `maxSupportedTransactionVersion` with
 * "Transaction version (N) is not supported by the requesting client", which used
 * to crash the whole flow scan. On that error the call is retried once with the
 * version the node named; any other error is rethrown unchanged.
 */
const BASE_VERSION = 0;
const MAX_VERSION = 255;
const UNSUPPORTED_VERSION = /Transaction version \((\d+)\) is not supported/;

export function unsupportedVersionFrom(err) {
  const match = UNSUPPORTED_VERSION.exec(String(err?.message ?? err));
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isInteger(version) && version > BASE_VERSION && version <= MAX_VERSION ? version : null;
}

/** @param {(method: string, params: unknown[]) => Promise<unknown>} call */
export async function getTransactionAnyVersion(call, signature, { encoding = "jsonParsed", commitment = "finalized" } = {}) {
  const request = (maxSupportedTransactionVersion) =>
    call("getTransaction", [signature, { encoding, maxSupportedTransactionVersion, commitment }]);
  try {
    return await request(BASE_VERSION);
  } catch (err) {
    const version = unsupportedVersionFrom(err);
    if (version === null) throw err;
    return request(version);
  }
}
