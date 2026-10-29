import fs from "node:fs/promises";

/** Parse a JSON file, returning `fallback` when it does not exist. Registry-driven
 *  inputs (e.g. funding-wallets.json) are TEL-only; other projects have none.
 *  Any other failure (bad JSON, permissions) still throws. */
export const readJsonOptional = async (p, fallback) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return fallback;
    throw e;
  }
};
