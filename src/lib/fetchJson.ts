/**
 * Fetch a JSON feed and THROW on a non-2xx response, so React Query marks the
 * query as errored (panel shows "Couldn't load" + Retry) instead of caching an
 * empty result that renders as real-looking zeros.
 */
export class FeedError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`Couldn't load ${url.split("/").pop() ?? url} (HTTP ${status})`);
    this.name = "FeedError";
  }
}

export const fetchJson = async <T>(url: string, init?: RequestInit, fetchImpl: typeof fetch = fetch): Promise<T> => {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new FeedError(url, res.status);
  return (await res.json()) as T;
};
