import type { ReactNode } from "react";
import { X } from "lucide-react";
import { TerminalPanel, PanelMessage, PanelError, PanelSkeleton } from "./TerminalPanel";
import { useForensicsAccess } from "@/hooks/useForensicsAccess";

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
 * the analysis on the right. "Category detail" (largest category by default)
 * is the big panel; clicking a category switches it;
 * the password-gated panels sit behind one unlock (the parent provides the
 * ForensicsUnlockProvider in singleGate mode): the treasury tile holds the
 * only password form, and every other gate points to it.
 */
export const SupplyTerminal = (p: Props) => {
  if (p.state !== "ready") {
    return (
      <div className="grid h-full min-h-0 grid-cols-12 gap-2">
        <TerminalPanel className="col-span-12" title="Supply">
          {p.state === "loading" ? (
            <PanelSkeleton />
          ) : p.state === "error" ? (
            <PanelError>Couldn&apos;t load the supply breakdown.</PanelError>
          ) : (
            <PanelMessage>No supply data available.</PanelMessage>
          )}
        </TerminalPanel>
      </div>
    );
  }
  return <ReadySupply {...p} />;
};

const ReadySupply = (p: Props) => {
  const { unlocked } = useForensicsAccess();
  // History is always on screen here (its own panel), so a #supply/history
  // deep link simply lands on the default tab beside it.
  const tabBase = TABS.some((t) => t.id === p.panel) ? p.panel : "breakdown";
  return (
    <div
      className={`grid h-full min-h-0 grid-cols-12 gap-2 ${
        // Locked, the history panel is a one-row tile; the category detail
        // gets everything else. Unlocked, the chart earns real height.
        unlocked ? "grid-rows-[minmax(0,3fr)_minmax(0,2fr)]" : "grid-rows-[minmax(0,1fr)_auto]"
      }`}
      data-testid="supply-terminal"
      data-forensics={unlocked ? "unlocked" : "locked"}
    >
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

      <section aria-label="Supply analysis" className="relative col-span-8 flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/70 px-2">
          {/* The ✕ sits beside the tablist, not in it: a tablist may only
              own tabs (axe aria-required-children). */}
          <div role="tablist" aria-label="Supply analysis" className="flex items-center gap-1">
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
          </div>
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
      <TerminalPanel
        className="col-span-8"
        title="Treasury & escrow history"
        info="Association Safes, Telcoin Holdings and escrow balances over the selected period. Password protected."
        testId="panel-treasury-history"
      >
        <div className={unlocked ? "text-xs" : "h-full text-xs"}>{p.history}</div>
      </TerminalPanel>
    </div>
  );
};
