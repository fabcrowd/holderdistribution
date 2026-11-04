/**
 * Developer-wallet ledger transaction types, shared with the generator
 * (scripts/build-ledger.js) through config/ledger-tx-types.json, so a label
 * or meaning changes in one place. Reports also embed `txTypes`; the UI prefers
 * the report's copy (what the data was classified with) and falls back to this.
 */
import catalog from "../../config/ledger-tx-types.json";

export type TxTypeInfo = {
  label: string;
  group: string;
  headline?: boolean;
  internal?: boolean;
  meaning: string;
  identifiedBy: string;
};

export const TX_TYPES: Readonly<Record<string, TxTypeInfo>> = (catalog as { types: Record<string, TxTypeInfo> }).types;

export const txTypeInfo = (type: string, fromReport?: Record<string, TxTypeInfo> | null): TxTypeInfo =>
  fromReport?.[type] ?? TX_TYPES[type] ?? { label: type.replace(/_/g, " "), group: "other", meaning: "Unclassified transfer.", identifiedBy: "Not in the type catalog." };

/** Tone for a badge: selling is negative, internal neutral, inflows positive. */
export const txTypeTone = (type: string, info: TxTypeInfo = txTypeInfo(type)): "negative" | "neutral" | "positive" | "muted" =>
  info.headline ? "negative" : info.internal ? "neutral" : type === "receive" || type === "stable_in" ? "positive" : "muted";
