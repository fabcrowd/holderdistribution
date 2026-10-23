import { afterAll, describe, expect, it } from "vitest";
import { rangeStartMs } from "./chartRange";
import { ytdDays, ytdStartMs } from "./timeRange";

const DAY = 86_400_000;
const ORIGINAL_TZ = process.env.TZ;

// Node re-reads process.env.TZ on assignment, so each case runs the same
// instant in a different local zone. Range starts must not move.
const ZONES = ["UTC", "America/Los_Angeles", "America/New_York", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata"];

describe("range starts are UTC in every timezone", () => {
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  // 2026-01-01T03:00Z is still Dec 31 in the Americas and already Jan 1 in Asia.
  const cases = [new Date("2026-01-01T03:00:00Z"), new Date("2026-03-15T23:30:00Z"), new Date("2026-12-31T22:00:00Z")];

  for (const zone of ZONES) {
    it(`YTD starts at Jan 1 00:00 UTC in ${zone}`, () => {
      process.env.TZ = zone;
      for (const now of cases) {
        const jan1 = Date.UTC(now.getUTCFullYear(), 0, 1);
        expect(ytdStartMs(now)).toBe(jan1);
        expect(rangeStartMs(ytdDays(now), now.getTime(), now)).toBe(jan1);
        expect(ytdDays(now)).toBe(Math.max(1, Math.ceil((now.getTime() - jan1) / DAY)));
      }
    });
    it(`rolling ranges ignore the local offset in ${zone}`, () => {
      process.env.TZ = zone;
      const last = Date.UTC(2026, 9, 22);
      expect(rangeStartMs(30, last)).toBe(Date.UTC(2026, 8, 22));
    });
  }
});
