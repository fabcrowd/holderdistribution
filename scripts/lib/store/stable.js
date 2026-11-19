// Equal content gives equal bytes: keys sorted at every depth, arrays kept in order.
import { createHash } from "node:crypto";

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  }
  return value;
}

export const canonical = (value) => sorted(value);
export const stableStringify = (value, indent = 0) => JSON.stringify(sorted(value), null, indent);
export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
