import { useState } from "react";
import { Heart, Copy } from "lucide-react";
import { toast } from "sonner";
import { InfoTooltip } from "@/components/InfoTooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** EVM tip address. Same wallet on every route that renders this footer. */
export const TIP_ADDRESS = "0x82C2Bca9d6a3ad4611eA5b8FAEAd789ad59a0542";

/** Shared legal disclaimer. Landing, the phone layout, and the desktop terminal all use this wording. */
export const SITE_DISCLAIMER =
  "Holder Analytics is an independent on-chain analytics platform and is not endorsed by, paid by, or affiliated with any cryptocurrency token or project. Content is informational and educational only: it is not financial, investment, legal, or tax advice, and it is not an offer or solicitation to buy or sell any security or token. Data may be incomplete or delayed and is provided without warranty of accuracy or completeness; users should verify it on-chain.";

/** Donation copy, shown in the (i) beside the copy control. */
const SUPPORT_NOTE =
  "This site is community-run. If you find it useful, consider donating to help cover hosting + development costs\n\nDonations can be sent to the EVM address shown — All EVM networks supported";

/** The popover body: the full legal text, verbatim. Exported for tests. */
export const DisclaimerPanel = () => (
  <div className="space-y-2">
    <h3 className="text-sm font-semibold text-foreground">Disclaimer</h3>
    <p className="text-[13px] leading-relaxed text-muted-foreground text-pretty" data-testid="site-disclaimer">
      {SITE_DISCLAIMER}
    </p>
  </div>
);

/** "Disclaimer" link that opens the full text. Escape closes it and returns focus to the link. */
export const DisclaimerLink = ({ className = "" }: { className?: string }) => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        type="button"
        className={`inline-flex min-h-11 items-center px-1 underline underline-offset-2 hover:text-foreground rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-6 ${className}`}
      >
        Disclaimer
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="center" collisionPadding={12} className="w-[min(calc(100vw-1.5rem),36rem)]">
      <DisclaimerPanel />
    </PopoverContent>
  </Popover>
);

export const Footer = () => {
  const [copied, setCopied] = useState(false);
  const donationAddress = TIP_ADDRESS;

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(donationAddress);
      setCopied(true);
      toast.success("Address copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("Failed to copy address");
    }
  };

  return (
    <footer className="border-t border-border/50 bg-card/30 backdrop-blur-md mt-8">
      <div className="mx-auto w-full max-w-7xl flex flex-col items-center gap-x-6 gap-y-1 px-4 py-3 text-[13px] text-muted-foreground lg:flex-row lg:justify-between">
        {/* Support: label + copy control + (i) with the explanatory sentences. */}
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <Heart aria-hidden="true" className="h-4 w-4 text-primary" />
          <span className="font-semibold text-foreground">Support Holder Analytics</span>
          <button
            onClick={copyAddress}
            className="inline-flex min-h-11 xl:min-h-9 items-center gap-2 px-3 rounded-md bg-card border border-border hover:bg-muted transition-colors group"
            title="Click to copy address"
            type="button"
          >
            {/* No aria-label: the accessible name is this prefix plus the
                visible address, so it always contains what is on screen. */}
            <span className="sr-only">Copy donation address: </span>
            <code className="text-xs font-mono text-foreground">
              <span className="hidden sm:inline">{donationAddress}</span>
              <span className="sm:hidden">{donationAddress.slice(0, 10)}...{donationAddress.slice(-8)}</span>
            </code>
            <Copy aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
          </button>
          <InfoTooltip text={SUPPORT_NOTE} label="About supporting Holder Analytics" className="max-xl:before:-inset-2.5" />
          {copied && <span role="status" className="text-xs text-primary animate-fade-in">Copied!</span>}
        </div>

        <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-center">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span>© {new Date().getFullYear()} Holder Analytics</span>
            <span aria-hidden="true">·</span>
            <span>Price data by CoinGecko</span>
          </span>
          <span aria-hidden="true" className="hidden sm:inline">·</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span>Not financial advice</span>
            <span aria-hidden="true">·</span>
            <DisclaimerLink />
          </span>
        </p>
      </div>
    </footer>
  );
};
