import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { ForensicsUnlockGate, useForensicsUnlock } from "@/components/ForensicsGate";
import { useProject } from "@/hooks/useProject";
import { loadAssociationFlowReport } from "@/lib/loadForensics";

/**
 * Password-gated forensic reconciliation of stablecoin outflows linked to the
 * Association Safes. Loaded from the Netlify forensics gate after unlock, for
 * the active project (null = that project has no such report yet).
 */
type FlowReport = {
  key: string;
  title: string;
  tracedAt: string;
  coverage: string;
  headline: string;
  sections: Array<{
    heading: string;
    body: string;
    rows: Array<{ label: string; value: string }>;
  }>;
};

const useFlowReport = (password: string | null, slug: string) =>
  useQuery({
    queryKey: ["flow-report", "association-stablecoin-flows", slug, password],
    queryFn: async (): Promise<FlowReport | null> => (await loadAssociationFlowReport(password, slug)) as FlowReport | null,
    enabled: password !== null,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

export const AssociationFlowAnalysis = () => {
  const { password, status, unlock } = useForensicsUnlock();
  const { slug } = useProject();
  const { data: report, isLoading } = useFlowReport(password, slug);

  return (
    <section className="mt-4 rounded-xl border border-border/60 bg-muted/10 p-3 sm:p-4">
      <header className="flex items-start gap-2">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            Stablecoin outflow analysis
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Where USDC leaving the Association-linked wallets actually goes. Password required.
          </p>
        </div>
      </header>

      {password === null ? (
        <div className="mt-3">
          <ForensicsUnlockGate status={status} onUnlock={unlock} />
        </div>
      ) : isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading analysis…</p>
      ) : !report ? (
        <p className="mt-3 text-xs text-muted-foreground">Analysis unavailable for this project.</p>
      ) : (
        <div className="mt-3 space-y-4">
          <div className="rounded-lg border border-border/50 bg-background/60 p-3">
            <p className="text-sm font-medium text-foreground">{report.headline}</p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Traced {report.tracedAt} · {report.coverage}
            </p>
          </div>

          {report.sections.map((s) => (
            <article key={s.heading} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">
                {s.heading}
              </h4>
              <p className="text-xs leading-relaxed text-muted-foreground">{s.body}</p>
              {s.rows.length > 0 && (
                <dl className="divide-y divide-border/40 rounded-lg border border-border/40 bg-background/40">
                  {s.rows.map((r) => (
                    <div key={r.label} className="flex justify-between gap-3 px-2.5 py-1.5">
                      <dt className="text-[11px] text-muted-foreground">{r.label}</dt>
                      <dd className="shrink-0 text-[11px] font-semibold tabular-nums text-foreground">
                        {r.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
};
