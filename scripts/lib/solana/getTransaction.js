/**
 * getTransaction that survives newer transaction versions. A node rejects a
 * transaction whose version is above `maxSupportedTransactionVersion` with
 * "Transaction version (N) is not supported by the requesting client". Asking
 * for too low a version made every such call fail on every endpoint in turn
 * (pushing load onto the rate-limited public node) before the scan crashed.
 *
 * The request therefore starts at the highest version seen so far (1 today:
 * it also returns legacy and v0 transactions) and, when a node names a higher
 * one, raises that ceiling for the rest of the process and retries once.
 */
const INITIAL_VERSION = 1;
const MAX_VERSION = 255;
const UNSUPPORTED_VERSION = /Transaction version \((\d+)\) is not supported/;

let supportedVersion = INITIAL_VERSION;

export function unsupportedVersionFrom(err) {
  const match = UNSUPPORTED_VERSION.exec(String(err?.message ?? err));
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isInteger(version) && version > supportedVersion && version <= MAX_VERSION ? version : null;
}

/** @param {(method: string, params: unknown[]) => Promise<unknown>} call */
export async function getTransactionAnyVersion(call, signature, { encoding = "jsonParsed", commitment = "finalized" } = {}) {
  const request = (maxSupportedTransactionVersion) =>
    call("getTransaction", [signature, { encoding, maxSupportedTransactionVersion, commitment }]);
  try {
    return await request(supportedVersion);
  } catch (err) {
    const version = unsupportedVersionFrom(err);
    if (version === null) throw err;
    supportedVersion = version;
    return request(version);
  }
}

/** Test hook. */
export function __resetSupportedVersionForTests() {
  supportedVersion = INITIAL_VERSION;
}
