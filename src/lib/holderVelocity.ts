import type { DisplaySelection, HolderSnapshotBase } from "@/hooks/useHolderSnapshot";

export type WalletVelocity = {
  currentCount: number;
  previousCount: number;
  added: number;
  removed: number;
  net: number;
  days: number;
  addedPerDay: number;
  removedPerDay: number;
  netPerDay: number;
};

const normalizeAddress = (address?: string | null) => {
  if (typeof address !== "string") return "";
  return address.trim().toLowerCase();
};

export const buildHolderKeySet = (
  snapshot: HolderSnapshotBase | null | undefined,
  selection: DisplaySelection,
  options?: { dedupeCombined?: boolean },
) => {
  const keys = new Set<string>();
  if (!snapshot) return keys;

  if (selection === "combined") {
    const dedupeCombined = options?.dedupeCombined ?? true;
    for (const [chainKey, chain] of Object.entries(snapshot.chains ?? {})) {
      for (const holder of chain?.holders ?? []) {
        const normalized = normalizeAddress(holder?.address);
        if (!normalized) continue;
        keys.add(dedupeCombined ? normalized : `${chainKey}:${normalized}`);
      }
    }
    return keys;
  }

  const chain = snapshot.chains?.[selection];
  for (const holder of chain?.holders ?? []) {
    const normalized = normalizeAddress(holder?.address);
    if (!normalized) continue;
    keys.add(normalized);
  }

  return keys;
};

export const getHolderCount = (
  snapshot: HolderSnapshotBase | null | undefined,
  selection: DisplaySelection,
) => buildHolderKeySet(snapshot, selection).size;

const parseSnapshotDate = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const resolveSnapshotDays = (current: HolderSnapshotBase, previous: HolderSnapshotBase) => {
  const currentDate = parseSnapshotDate(current.generatedAt);
  const previousDate = parseSnapshotDate(previous.generatedAt);

  if (!currentDate || !previousDate) {
    return 1;
  }

  const diffMs = currentDate.getTime() - previousDate.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return 1;
  }

  return diffMs / (1000 * 60 * 60 * 24);
};

export const computeWalletVelocity = (
  current: HolderSnapshotBase | null | undefined,
  previous: HolderSnapshotBase | null | undefined,
  selection: DisplaySelection,
): WalletVelocity | null => {
  if (!current || !previous) {
    return null;
  }

  const currentKeys = buildHolderKeySet(current, selection, { dedupeCombined: true });
  const previousKeys = buildHolderKeySet(previous, selection, { dedupeCombined: true });

  let added = 0;
  for (const key of currentKeys) {
    if (!previousKeys.has(key)) {
      added += 1;
    }
  }

  let removed = 0;
  for (const key of previousKeys) {
    if (!currentKeys.has(key)) {
      removed += 1;
    }
  }

  const net = added - removed;
  const days = Math.max(resolveSnapshotDays(current, previous), 1);

  return {
    currentCount: currentKeys.size,
    previousCount: previousKeys.size,
    added,
    removed,
    net,
    days,
    addedPerDay: added / days,
    removedPerDay: removed / days,
    netPerDay: net / days,
  };
};
