import type { ReactNode } from "react";
import { X } from "lucide-react";
import { TerminalPanel, PanelMessage, PanelSkeleton } from "./TerminalPanel";

const TABS = [
  { id: "breakdown", label: "Category detail" },
  { id: "reconciliation", label: "Reconciliation" },
  { id: "wallet-flows", label: "Wallet flows" },
] as const;

type Props = {
  state: "loading" | "error" | "empty" | "ready";
  panel: string;
  onPanelChange: (panel: string) => void;
  totalSupplyLabel: string;
  donut: ReactNode;
  list: ReactNode;
  footnote: ReactNode;
  openBucketLabel: string | null;
  detail: ReactNode;
  onCloseDetail: () => void;
  reconciliation: ReactNode;
  history: ReactNode;
  walletFlows: ReactNode;
};

/**
 * Supply on one screen: the 100B split (donut + list) stays on the left,
 * the analysis on the right. Clicking a category fills "Category detail";
 * the password-gated panels sit behind one unlock (the parent provides the
 * ForensicsUnlockProvider), so a reader unlocks once for all of them.
 */
export const SupplyTerminal = (p: Props) => {
  if (p.state !== "ready") {
    return (
      <div className="grid h-full min-h-0 grid-cols-12 gap-2">
        <TerminalPanel className="col-span-12" title="Supply">
          {p.state === "loading" ? (
            <PanelSkeleton />
          ) : (
            <PanelMessage>{p.state === "error" ? "Could not load supply reconciliation." : "No supply data available."}</PanelMessage>
          )}
        </TerminalPanel>
      </div>
    );
  }
  // History is always on screen here (its own panel), so a #supply/history
  // deep link simply lands on the default tab beside it.
  const tabBase = TABS.some((t) => t.id === p.panel) ? p.panel : "breakdown";
  return (
    <div className="grid h-full min-h-0 grid-cols-12 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-2" data-testid="supply-terminal">
      <TerminalPanel
        className="col-span-4 row-span-2"
        title="Where all TEL sits"
        info="Every TEL in the 100B total supply, by holder type. Select a category to see its wallets and notes."
        stat={<span className="font-semibold text-foreground">{p.totalSupplyLabel}</span>}
      >
        <div className="flex h-full min-h-0 flex-col gap-2">
          {p.donut}
          <div className="min-w-0">{p.list}</div>
          <div className="mt-auto [&_p]:mt-0 [&_p]:text-left">{p.footnote}</div>
        </div>
      </TerminalPanel>

      <TerminalPanel
        className="col-span-8"
        title="Treasury & escrow history"
        info="Association Safes, Telcoin Holdings and escrow balances over the selected period. Password protected."
      >
        <div className="text-xs">{p.history}</div>
      </TerminalPanel>

      <section aria-label="Supply analysis" className="relative col-span-8 flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div role="tablist" aria-label="Supply analysis" className="flex h-9 shrink-0 items-center gap-1 border-b border-border/70 px-2">
          {TABS.map((t) => {
            const selected = tabBase === t.id;
            return (
              <button
                key={t.id}
                id={`supply-tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="supply-tabpanel"
                tabIndex={selected ? 0 : -1}
                onClick={() => p.onPanelChange(t.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  const i = TABS.findIndex((x) => x.id === t.id);
                  const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
                  p.onPanelChange(next.id);
                  document.getElementById(`supply-tab-${next.id}`)?.focus();
                }}
                className={`h-7 rounded px-2.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {t.id === "breakdown" && p.openBucketLabel ? p.openBucketLabel : t.label}
              </button>
            );
          })}
          {tabBase === "breakdown" && p.openBucketLabel && (
            <button
              type="button"
              onClick={p.onCloseDetail}
              aria-label="Clear selected category"
              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <div
          id="supply-tabpanel"
          role="tabpanel"
          aria-labelledby={`supply-tab-${tabBase}`}
          tabIndex={0}
          className="relative min-h-0 flex-1 overflow-auto p-3 text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {tabBase === "breakdown" &&
            (p.detail ?? <PanelMessage>Select a category on the left to see its wallets and notes.</PanelMessage>)}
          {tabBase === "reconciliation" && <div className="space-y-4">{p.reconciliation}</div>}
          {tabBase === "wallet-flows" && p.walletFlows}
        </div>
      </section>
    </div>
  );
};
