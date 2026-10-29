import { useState } from "react";
import { Heart, Copy } from "lucide-react";
import { toast } from "sonner";

/** EVM tip address. Same wallet on every route that renders this footer. */
export const TIP_ADDRESS = "0x82C2Bca9d6a3ad4611eA5b8FAEAd789ad59a0542";

/** Shared legal disclaimer. Landing, the phone layout, and the desktop terminal all use this wording. */
export const SITE_DISCLAIMER =
  "Holder Analytics is an independent on-chain analytics platform and is not endorsed by, paid by, or affiliated with any cryptocurrency token or project. Content is informational and educational only: it is not financial, investment, legal, or tax advice, and it is not an offer or solicitation to buy or sell any security or token. Data may be incomplete or delayed and is provided without warranty of accuracy or completeness; users should verify it on-chain.";

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
      <div className="container mx-auto px-4 py-4 sm:py-6">
        {/* Donation Section */}
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Heart className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Support Holder Analytics</h3>
          </div>
          <p className="text-xs text-muted-foreground max-w-2xl mx-auto mb-1">
            This site is community-run. If you find it useful, consider donating to help cover hosting + development costs
          </p>
          <p className="text-xs text-muted-foreground max-w-2xl mx-auto mb-3">
            Donations can be sent to the EVM address below — All EVM networks supported
          </p>
          <button
            onClick={copyAddress}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-card border border-border hover:bg-muted transition-colors group"
            title="Click to copy address"
            type="button"
          >
            {/* No aria-label: the accessible name is this prefix plus the
                visible address, so it always contains what is on screen. */}
            <span className="sr-only">Copy donation address: </span>
            <code className="text-xs font-mono text-foreground group-hover:text-foreground">
              <span className="hidden sm:inline">{donationAddress}</span>
              <span className="sm:hidden">{donationAddress.slice(0, 10)}...{donationAddress.slice(-8)}</span>
            </code>
            <Copy aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
          </button>
          {copied && (
            <p role="status" className="text-xs text-primary mt-2 animate-fade-in">Copied!</p>
          )}
        </div>

        {/* Copyright */}
        <div className="mt-4 pt-4 border-t border-border/30 text-center text-[13px] text-muted-foreground space-y-0.5">
          <p>© {new Date().getFullYear()} Holder Analytics. All rights reserved.</p>
          <p>Price data powered by CoinGecko</p>
          <p className="max-w-4xl mx-auto pt-2" data-testid="site-disclaimer">
            {SITE_DISCLAIMER}
          </p>
        </div>
      </div>
    </footer>
  );
};
