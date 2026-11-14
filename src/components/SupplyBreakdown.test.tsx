import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectConfig } from "@/lib/projects";

const state = vi.hoisted(() => ({ project: {} as unknown }));

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ slug: "stub", project: state.project }),
}));
vi.mock("@/hooks/useProjectCopy", async () => {
  const pc = await import("@/lib/projectCopy");
  return {
    useProjectCopy: () => {
      const p = state.project as ProjectConfig;
      const ctx = pc.copyContext(p);
      return {
        ...ctx,
        t: (tpl: string) => pc.fillCopy(tpl, ctx),
        text: (id: string, tpl: string) => pc.copyText(p, id, tpl),
        hasText: (id: string) => pc.hasCopyText(p, id),
        entities: pc.projectEntities(p),
      };
    },
  };
});

const { ResidualPanel, itemExplorerHref } = await import("./SupplyBreakdown");

const evm = (key: string, name: string, explorer: string, origin = false) => ({ key, name, origin, explorer, tokens: [] });
const stub = (over: Partial<ProjectConfig>): ProjectConfig =>
  ({ slug: "stub", name: "Stub", ticker: "STB", supply: { target: 1e9, targetLabel: "1B" }, ...over }) as unknown as ProjectConfig;

const ETH = evm("ethereum", "Ethereum", "https://etherscan.io", true);
const POLYGON = evm("polygon", "Polygon", "https://polygonscan.com");
const BASE = evm("base", "Base", "https://basescan.org");
const ADDR = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

const residual = (over: Record<string, unknown> = {}) =>
  ({
    totalSupply: 1e9,
    residual: 5e6,
    bridgeLocked: 0,
    mirrored: 0,
    residualParts: { bridgeInFlight: 0, originDrift: 0 },
    ...over,
  }) as never;

const panelText = (project: ProjectConfig, data: unknown) => {
  state.project = project;
  const html = renderToStaticMarkup(<ResidualPanel data={data as never} bridges={[]} />);
  return (new JSDOM(html).window.document.body.textContent ?? "").replace(/\s+/g, " ");
};

describe("ResidualPanel", () => {
  it("a single-chain token with no bridge figures sees no bridge wording", () => {
    const text = panelText(stub({ chains: [ETH] as never }), residual());
    expect(text).toContain("Deeper look at the ~5.00M gap");
    expect(text).toContain("on Ethereum");
    expect(text).not.toMatch(/bridge|Polygon|Base|crossing|locked on/i);
  });

  it("TEL-shaped data (origin + mirrors, bridge figures present) shows the bridge rows", () => {
    const text = panelText(
      stub({ chains: [ETH, POLYGON, BASE] as never }),
      residual({ bridgeLocked: 3e6, mirrored: 2e6, residualParts: { bridgeInFlight: 1e6, originDrift: 0 } }),
    );
    expect(text).toContain("locked on Ethereum while it moves to Polygon or Base");
    expect(text).toContain("Locked on Ethereum (bridges)");
    expect(text).toContain("Already showing on Polygon + Base");
    expect(text).toContain("Still crossing bridges");
    expect(text).toContain("Still crossing ≈ locked on Ethereum − already showing on Polygon/Base.");
  });

  it("a multi-chain token whose feed has no bridge figures hides the bridge rows", () => {
    const text = panelText(stub({ chains: [ETH, POLYGON] as never }), residual());
    expect(text).not.toMatch(/bridge|crossing|locked on/i);
  });

  it("without a reconciliation feed, the total comes from the project target, never a hardcoded 100B", () => {
    const withTarget = panelText(stub({ chains: [ETH] as never }), null);
    expect(withTarget).toContain("the 1.00B total supply");
    const noTarget = panelText(stub({ chains: [ETH], supply: {} } as never), null);
    expect(noTarget).toContain("the — total supply");
    expect(noTarget).not.toContain("100.00B");
  });
});

describe("itemExplorerHref", () => {
  it("links an EVM address on the origin chain and leaves its case alone", () => {
    const project = stub({ chains: [POLYGON, ETH, BASE] as never });
    expect(itemExplorerHref(project, { address: ADDR, category: "treasury" })).toBe(`https://etherscan.io/address/${ADDR}`);
  });

  it("a single-chain non-Ethereum token links to its own explorer", () => {
    const project = stub({ chains: [evm("base", "Base", "https://basescan.org", true)] as never });
    expect(itemExplorerHref(project, { address: ADDR, category: "cex" })).toBe(`https://basescan.org/address/${ADDR}`);
  });

  it("a staking contract uses its configured chain", () => {
    const project = stub({
      chains: [ETH, POLYGON] as never,
      staking: [{ chain: "polygon", address: ADDR.toLowerCase(), name: "Staking" }],
    });
    expect(itemExplorerHref(project, { address: ADDR, category: "staking-contract" })).toBe(`https://polygonscan.com/address/${ADDR}`);
  });

  it("Solana base58 stays as-is on Solscan", () => {
    const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const project = stub({ chains: [{ key: "solana", name: "Solana", vm: "solana", tokens: [] }] as never });
    expect(itemExplorerHref(project, { address: SOL, category: "treasury" })).toBe(`https://solscan.io/account/${SOL}`);
  });

  it("a Hedera id is not lowercased or treated as EVM, and opens HashScan", () => {
    const project = stub({ chains: [ETH, { key: "hedera", name: "Hedera", vm: "hedera", tokens: [] }] as never });
    expect(itemExplorerHref(project, { address: "0.0.1234567", category: "treasury" })).toBe(
      "https://hashscan.io/mainnet/account/0.0.1234567",
    );
  });
});
