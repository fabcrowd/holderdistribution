// @vitest-environment jsdom
/**
 * Renders every top-level section for every project shape (the three registered
 * configs plus synthetic tiny / huge / hedera / solana-staking ones) with stub
 * feeds built from that project's own config (shapeFixtures.ts), and asserts
 * that no section carries another token's assumptions: foreign wording, chains
 * that are not configured, wrong explorers, NaN / undefined, or labels missing.
 *
 * The page under test is the real Holders page in desktop-terminal mode, opened
 * on each hash (#holders, #holders/<panel>, #distribution, #supply/<panel>);
 * Landing is rendered as the real Landing page. Charts get a fixed size by
 * mocking Recharts' ResponsiveContainer (jsdom has no layout).
 */
import { cloneElement, createElement, isValidElement, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "@/lib/projects";
import { holderTiersFor } from "@/lib/holderTiers";
import { addressFor, buildFeeds, EXCHANGES, hasNetworkStake, holderCountOf, NETWORK_STAKE_SHARE, SYNTHETIC_SHAPES, treasuryCategoriesOf, type Feeds } from "./shapeFixtures";

const state = vi.hoisted(() => ({ project: null as unknown as { slug: string }, listed: [] as unknown[] }));

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ slug: state.project.slug, project: state.project, projects: [] }),
}));

vi.mock("@/lib/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects")>();
  return {
    ...actual,
    getProject: (slug: string) => (slug === state.project?.slug ? state.project : actual.getProject(slug)),
    LISTED_PROJECTS: state.listed,
  };
});

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const ResponsiveContainer = ({ children }: { children: ReactElement }) =>
    isValidElement(children) ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, { width: 800, height: 400 }) : null;
  return { ...actual, ResponsiveContainer };
});

const { getProject } = await import("@/lib/projects");
const { __resetActiveSlug } = await import("@/lib/projectStore");
const { default: Holders } = await import("@/pages/Holders");
const { default: Landing } = await import("@/pages/Landing");
const { TooltipProvider } = await import("@/components/ui/tooltip");

type Shape = { id: string; project: ProjectConfig; tel: boolean };
const SHAPES: Shape[] = [
  { id: "tel", project: getProject("tel"), tel: true },
  { id: "zebec-network", project: getProject("zebec-network"), tel: false },
  { id: "ondo", project: getProject("ondo"), tel: false },
  ...SYNTHETIC_SHAPES.map((p) => ({ id: p.slug, project: p, tel: false })),
];

/** `component` sections render one exported component directly (the page hides it behind a password gate or a selection). */
type Section = {
  id: string;
  hash: string;
  landing?: boolean;
  component?: (feeds: Feeds | null) => ReactElement;
  /** Clicks made after the first settle (expand a row, open a tab) so the content behind them is checked too. */
  interact?: (container: HTMLElement) => void;
};
const clickButtons = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLElement>("button, [role='button']")].filter((b) => (b.textContent ?? "").includes(label)).forEach((b) => b.click());
const { ResidualPanel } = await import("@/components/SupplyBreakdown");
const { TreasuryHistoryChart } = await import("@/components/TreasuryHistoryChart");
const { ForensicsUnlockProvider } = await import("@/components/ForensicsGate");
const SECTIONS: Section[] = [
  { id: "landing", hash: "", landing: true },
  {
    id: "component:residual-panel",
    hash: "",
    component: (feeds) => {
      const recon = feeds?.["supply-reconciliation.json"] as { items: Array<{ category: string }> } | undefined;
      const bridges = (recon?.items ?? []).filter((i) => i.category === "bridge-lock");
      return createElement(ForensicsUnlockProvider, { singleGate: true, children: createElement(ResidualPanel, { data: recon as never, bridges: bridges as never }) });
    },
  },
  { id: "component:treasury-chart", hash: "", component: () => createElement(TreasuryHistoryChart, { rangeDays: 90 }) },
  { id: "holders", hash: "#holders" },
  ...["concentration", "balances", "staking", "growth", "trends", "flows", "exchanges"].map((p): Section => ({
    id: `holders/${p}`,
    hash: `#holders/${p}`,
    interact: p === "exchanges" ? (c) => clickButtons(c, EXCHANGES[0]) : undefined,
  })),
  { id: "distribution", hash: "#distribution" },
  ...["breakdown", "reconciliation", "history", "wallet-flows", "project-wallets"].map((p) => ({ id: `supply/${p}`, hash: `#supply/${p}` })),
];

// --- environment ------------------------------------------------------------

const installObservers = () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
};

beforeEach(installObservers);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*1280px/.test(query) || /prefers-reduced-motion:\s*reduce/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

const serveFeeds = (feeds: Feeds | null) => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const file = url.split("?")[0].split("/").pop() ?? "";
    requested.push(file);
    const body = feeds?.[file];
    const ok = body !== undefined;
    return { ok, status: ok ? 200 : 404, statusText: ok ? "OK" : "Not Found", url, json: async () => JSON.parse(JSON.stringify(body ?? {})) };
  });
  return requested;
};

const tick = (ms = 15) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const settle = async (qc: QueryClient) => {
  for (let i = 0; i < 6; i++) await tick();
  for (let i = 0; i < 40 && qc.isFetching() > 0; i++) await tick();
  for (let i = 0; i < 4; i++) await tick();
};

type Rendered = { text: string; hrefs: string[]; html: string; errors: string[]; root: Root; container: HTMLElement };
let mounted: Root | null = null;

const textOf = (el: HTMLElement): string => {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? "");
  el.querySelectorAll("[aria-label],[title]").forEach((e) => parts.push(e.getAttribute("aria-label") ?? "", e.getAttribute("title") ?? ""));
  return parts.join(" ").replace(/\s+/g, " ");
};

const renderSection = async (shape: Shape, section: Section, feeds: Feeds | null): Promise<Rendered> => {
  state.project = shape.project as unknown as { slug: string };
  state.listed.splice(0, state.listed.length, { slug: shape.project.slug, name: shape.project.name, ticker: shape.project.ticker });
  __resetActiveSlug(shape.project.slug);
  window.history.replaceState(null, "", `/${shape.project.slug}${section.hash}`);
  serveFeeds(feeds);
  const errors: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 400));
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = root;
  const page = section.component ? section.component(feeds) : section.landing ? createElement(Landing) : createElement(Holders);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(TooltipProvider, null, createElement(MemoryRouter, { initialEntries: [`/${shape.project.slug}`] }, page))),
    );
  });
  await settle(qc);
  if (feeds && section.interact) {
    await act(async () => section.interact!(container));
    await settle(qc);
  }
  const text = textOf(container);
  const hrefs = [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
  const html = container.innerHTML;
  spy.mockRestore();
  return { text, hrefs, html, errors, root, container };
};

afterEach(async () => {
  if (mounted) {
    const r = mounted;
    mounted = null;
    await act(async () => r.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

// --- assertions ---------------------------------------------------------------

const BAD_TEXT = /NaN|undefined|Infinity|\[object Object\]/;
const TEL_WORDING = /\bTEL\b|Telcoin|v3 StakingModule|Legacy contract|BitGo/;
const TEL_ONLY_WORDING = /council|escrow/i;
const KNOWN_CHAIN_NAMES = ["Ethereum", "Polygon", "Arbitrum", "Optimism", "BNB Chain", "Solana", "Hedera"];
const EXPLORER_HOST = /(scan\.|scan$|explorer|blockscout|hashscan|solscan|etherscan)/i;

const explorerHostsOf = (p: ProjectConfig): Set<string> => {
  const hosts = new Set<string>();
  for (const c of p.chains) {
    if (c.vm === "hedera") hosts.add("hashscan.io");
    else if (c.explorer) hosts.add(new URL(c.explorer).hostname);
    else if (c.vm === "solana" || c.key === "solana") hosts.add("solscan.io");
  }
  return hosts;
};

const hasChain = (p: ProjectConfig, name: string) => p.chains.some((c) => c.name === name || (name === "Solana" && c.vm === "solana") || (name === "Hedera" && c.vm === "hedera"));

/** Names / tickers of every OTHER shape, which must not leak into this one. */
const foreignIdentity = (shape: Shape): RegExp | null => {
  const words = SHAPES.filter((s) => s.id !== shape.id)
    .flatMap((s) => [s.project.name, s.project.ticker])
    .filter((w) => !!w && w.length > 2 && !shape.project.name.includes(w) && shape.project.ticker !== w);
  const unique = [...new Set(words)].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return unique.length ? new RegExp(`\\b(?:${unique.join("|")})\\b`) : null;
};

const baselineChecks = (shape: Shape, section: Section, r: Rendered) => {
  const p = shape.project;
  expect(r.errors, "console.error output").toEqual([]);
  expect(r.text.match(BAD_TEXT)?.[0] ?? null, "NaN/undefined/Infinity/[object Object] in text").toBeNull();
  const hrefBad = r.hrefs.filter((h) => BAD_TEXT.test(h));
  expect(hrefBad, "bad href").toEqual([]);

  // Chains that are not configured must not be named anywhere.
  const phantom = KNOWN_CHAIN_NAMES.filter((n) => !hasChain(p, n) && new RegExp(`\\b${n}\\b`).test(r.text));
  // TEL legitimately names Ethereum/Polygon/Base; synthetic and other shapes must not name chains they lack.
  expect(phantom, "chain named but not configured").toEqual([]);

  // Explorer links only to the configured chains' explorers.
  const allowed = explorerHostsOf(p);
  const wrongHost = r.hrefs
    .filter((h) => /^https?:\/\//.test(h))
    .map((h) => new URL(h).hostname)
    .filter((h) => EXPLORER_HOST.test(h) && !allowed.has(h));
  expect([...new Set(wrongHost)], "explorer host not in project's chains").toEqual([]);

  // Case handling: Solana ids keep case (a base58 id with capitals is never all-lowercase).
  for (const c of p.chains.filter((x) => x.vm === "solana")) {
    const host = "solscan.io";
    const ids = r.hrefs.filter((h) => h.includes(host)).map((h) => h.split("?")[0].split("/").pop() ?? "");
    expect(ids.filter((id) => id.length > 30 && id === id.toLowerCase()), `solana id lower-cased (${c.key})`).toEqual([]);
  }
  for (const h of r.hrefs.filter((x) => x.includes("hashscan.io"))) {
    expect(h, "hedera ids are 0.0.N").toMatch(/hashscan\.io\/mainnet\/(?:token|account|transaction)\/(?:0\.0\.\d+|0x[0-9a-fA-F]+)/);
  }

  if (!shape.tel) {
    expect(r.text.match(TEL_WORDING)?.[0] ?? null, "TEL wording in a non-TEL project").toBeNull();
    const id = foreignIdentity(shape);
    if (id) expect(r.text.match(id)?.[0] ?? null, "another token's name/ticker").toBeNull();
    const hasCategoryWords = (p.supply?.developerHoldings?.subcategories ?? []).some((s) => /council|escrow/i.test(`${s.category} ${s.label}`));
    if (!hasCategoryWords) expect(r.text.match(TEL_ONLY_WORDING)?.[0] ?? null, "council/escrow wording").toBeNull();
  }
  void section;
};

// --- the matrix ------------------------------------------------------------------

const EMPTY_STATE = /couldn't load|unavailable|no (?:history|flow|data)|not (?:yet )?(?:available|published)|appears once|nothing/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (text: string, w: string) => new RegExp(`(?:^|[^\\w])${esc(w)}(?![\\w])`).test(text);
const topRows = (r: Rendered): number[] =>
  [...r.container.querySelectorAll("caption")]
    .filter((c) => /held by the top wallets/.test(c.textContent ?? ""))
    .flatMap((c) => [...(c.closest("table")?.querySelectorAll("tbody th") ?? [])].map((th) => Number((th.textContent ?? "").replace(/,/g, ""))));

/** The informational network-stake tile: only a feed that carries `networkStake`, and only in the Staking section. */
const networkStakeChecks = (shape: Shape, section: Section, r: Rendered, feeds: Feeds) => {
  const tile = r.container.querySelector('[data-testid="network-stake"]');
  const expected = hasNetworkStake(shape.project) && section.id === "holders/staking";
  expect(tile !== null, `network stake tile in ${section.id} for ${shape.id}`).toBe(expected);
  if (!hasNetworkStake(shape.project)) expect(r.text, "tile wording without the feed block").not.toMatch(/Staked on the network|not subtracted from anything/);
  if (!expected) return;
  const stake = (feeds["holders-lite.json"] as { networkStake: { stakingPeriod: { start: string } } }).networkStake;
  const text = tile!.textContent ?? "";
  expect(text).toContain("Staked on the network");
  expect(text).toContain(`${(NETWORK_STAKE_SHARE * 100).toFixed(2)}% of total supply`);
  expect(text).toContain(`Staking period of ${stake.stakingPeriod.start.slice(0, 10)} (UTC)`);
  expect(text).toContain("already counted in holder balances");
  // 27% of 50B, compact with the Staking tiles' preset: no raw tinybars, no exponent, no long decimals.
  expect(tile!.querySelector('[data-testid="network-stake-amount"]')?.textContent).toBe("13.50B");
  expect(text).not.toMatch(/e\+|\d\.\d{3,}|\d{1,3}(?:,\d{3}){3,}/);
  expect(text.match(/\bTEL\b|Ethereum|Etherscan/)?.[0] ?? null, "foreign wording in the tile").toBeNull();
  // The note replaces the no-staking note; nothing implies stakers or a Staked Total exist.
  expect(r.container.querySelector('[data-testid="staking-none"]')).toBeNull();
  expect(r.text).not.toMatch(/has no staking contract|Staked Total|Stakers/);
};

/** Section-specific mapping checks, run only when the feeds are present. */
const sectionChecks = (shape: Shape, section: Section, r: Rendered) => {
  const p = shape.project;
  const tiers = holderTiersFor(p);
  const holders = holderCountOf(p);
  const hasStaking = (p.staking?.length ?? 0) > 0;
  const chainNames = p.chains.map((c) => c.name);
  const sub = p.supply?.developerHoldings?.subcategories ?? [];
  const isPage = !section.landing && !section.component;

  if (isPage) for (const n of chainNames) expect(hasWord(r.text, n), `chain "${n}" named in chain picker/footer`).toBe(true);

  if (!shape.tel && hasStaking === false) expect(r.text, "staked wording without a staking mechanism").not.toMatch(/Staked [A-Z]{2,6} [\d.]+[KMBT]?\b/);
  if (!shape.tel) expect(r.text.match(/\bLegacy\b|\bv3\b/)?.[0] ?? null, "legacy/v3 wording in a non-TEL project").toBeNull();

  // A very large or very small supply must be abbreviated, never printed as a thousand of the previous unit.
  const supplyTarget = p.supply?.target ?? 0;
  if (supplyTarget >= 1e12) expect(r.text.match(/\b1,?000(?:\.\d+)?B\b/)?.[0] ?? null, "1000B instead of 1T").toBeNull();

  switch (section.id) {
    case "landing":
      expect(r.text).toContain(p.name);
      expect(r.text).toContain(p.ticker);
      break;
    case "holders": {
      // A sub-1 positive balance (shape A's 0.4 CEX balance) must not round to a bare "0".
      if (supplyTarget <= 1e6) {
        // Target the CEX Balance answer cell's own value (dd[data-role="value"]'s number span),
        // not the flattened page text, so a sub line or change indicator cannot satisfy it.
        const cexCell = Array.from(r.container.querySelectorAll<HTMLElement>('[data-testid^="answer-"]:not([data-testid="answer-cards"])')).find(
          (el) => el.querySelector("dt")?.textContent?.includes("CEX Balance"),
        );
        expect(cexCell, "CEX Balance answer cell rendered").toBeDefined();
        const cexValue = cexCell?.querySelector('dd[data-role="value"] .ha-num')?.textContent?.trim() ?? "";
        expect(cexValue, "CEX Balance value shows the 0.4 balance").toContain("0.4");
        expect(cexValue, "CEX Balance value is not a bare 0").not.toBe("0");
      }
      const rows = topRows(r);
      expect(rows.length, "Top-N table rendered").toBeGreaterThan(0);
      expect(rows.filter((n) => n >= holders), "Top-N bucket >= holder count").toEqual([]);
      expect(rows, "every configured bucket below the holder count is shown").toEqual(tiers.concentrationBuckets.filter((n) => n < holders));
      break;
    }
    case "holders/concentration":
      for (const n of tiers.concentrationBuckets) {
        const shown = new RegExp(`Top ${n}\\b|Top ${n.toLocaleString("en-US")}\\b`).test(r.text);
        expect(shown, `Top ${n} ${n >= holders ? "hidden (>= holders)" : "shown"}`).toBe(n < holders);
      }
      break;
    case "holders/balances":
      for (const range of tiers.balanceRanges) expect(r.text, `balance range ${range.label}`).toContain(range.label);
      break;
    case "holders/staking":
      if (hasStaking) {
        expect(r.text).toMatch(/Staked Total/);
        expect(r.container.querySelector('[data-testid="staking-none"]')).toBeNull();
      } else if (hasNetworkStake(p)) {
        expect(r.text, "tile replaces the no-staking note").not.toMatch(/has no staking contract or staking mechanism/);
      } else {
        expect(r.text).toMatch(/has no staking contract or staking mechanism/);
        expect(r.text).not.toMatch(/Staked Total|Stakers/);
      }
      if (shape.tel) expect(r.text).toMatch(/Legacy [\d,.]+ \/ v3 [\d,.]+/);
      break;
    case "holders/trends":
    case "holders/growth": {
      const tabs = [...r.container.querySelectorAll('[role="tab"], button')].map((b) => (b.textContent ?? "").trim());
      if (section.id === "holders/trends") expect(tabs.includes("Staked"), "Staked tab iff the project has staking").toBe(hasStaking);
      break;
    }
    case "holders/exchanges": {
      for (const x of EXCHANGES) expect(r.text).toContain(x);
      const wallet = addressFor(p, 50);
      const linked = r.hrefs.filter((h) => h.includes(wallet));
      expect(linked.length, `exchange wallet ${wallet} links to an explorer`).toBeGreaterThan(0);
      break;
    }
    case "distribution":
      for (const t of tiers.distributionTiers) expect(r.text, `tier ${t.label}`).toContain(t.label);
      break;
    case "supply/breakdown":
      for (const s of sub) expect(r.text, `developer category "${s.label}"`).toContain(s.label);
      if (supplyTarget >= 1e12) expect(r.text).toMatch(/\b1\.00T\b/);
      break;
    case "supply/reconciliation":
      expect(r.text).toMatch(/Circulating/);
      expect(/Association treasury ledger|Stablecoin outflow/.test(r.text), "association panel iff TEL").toBe(shape.tel);
      break;
    case "component:residual-panel": {
      const bridged = p.chains.length > 1;
      expect(/Locked on .* \(bridges\)/.test(r.text), "bridge rows only for multi-chain shapes").toBe(bridged);
      if (!bridged) expect(r.text).not.toMatch(/Locked on|Still crossing|Already showing|while it moves/);
      if (bridged) for (const c of p.chains.filter((x) => !x.origin)) expect(r.text).toContain(c.name);
      expect(/v3 upgrade \(legacy/.test(r.text), "v3 upgrade block iff TEL").toBe(shape.tel);
      break;
    }
    case "component:treasury-chart": {
      const chips = [...r.container.querySelectorAll("button[aria-pressed]")].map((b) => (b.textContent ?? "").trim());
      const cats = treasuryCategoriesOf(p);
      expect(chips.length, `chips ${JSON.stringify(chips)} vs categories ${JSON.stringify(cats)}`).toBe(cats.length);
      // TEL renames council/holdings through its own copy overrides; every other shape uses its developer-holdings label.
      if (!shape.tel) {
        for (const c of cats) {
          const label = sub.find((s) => s.category === c)?.label;
          const matched = chips.some((chip) => (c === "treasury" ? /Treasury/.test(chip) : label ? chip.includes(label) : new RegExp(c, "i").test(chip)));
          expect(matched, `chip for category ${c}`).toBe(true);
        }
        expect(chips.join(" ")).not.toMatch(/council|escrow/i);
      } else {
        expect(chips.length).toBe(4);
        expect(chips.join(" ")).toMatch(/Escrow/);
      }
      break;
    }
    default:
      break;
  }

  if (section.id.startsWith("supply/") && isPage) {
    expect(/Developer wallets/.test(r.text), "Developer wallets tab iff capability").toBe(p.capabilities?.projectWallets === true);
  }
};

describe.each(SHAPES)("project shape: $id", (shape) => {
  const feeds = buildFeeds(shape.project, { cexBalance: shape.id === "shape-tiny" ? 0.4 : undefined });

  describe.each(SECTIONS)("with feeds: $id", (section) => {
    it("renders cleanly, maps this project's own shape, carries no other token's assumptions", async () => {
      const r = await renderSection(shape, section, feeds);
      baselineChecks(shape, section, r);
      expect(r.text.length, "section rendered something").toBeGreaterThan(section.component ? 20 : 50);
      sectionChecks(shape, section, r);
      networkStakeChecks(shape, section, r, feeds);
    }, 90_000);
  });

  describe.each(SECTIONS)("with every feed missing: $id", (section) => {
    it("degrades to honest empty states without crashing", async () => {
      const r = await renderSection(shape, section, null);
      baselineChecks(shape, section, r);
      expect(r.text.length).toBeGreaterThan(section.component ? 10 : 50);
      if (!section.component) expect(r.text, "an honest empty/error state").toMatch(EMPTY_STATE);
    }, 90_000);
  });
});
