/**
 * Shared env loader: when ENV_PASSPHRASE is set and .env.enc exists, decrypt and apply to process.env.
 * Pull scripts import and await this before reading process.env.
 */
import { loadDecryptedEnv } from "./decrypt-env.js";

export { loadDecryptedEnv as loadEnv };
