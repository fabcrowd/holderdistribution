import { useState } from "react";
import { ExternalLink, MessageSquare, Mail, Heart, Copy } from "lucide-react";
import { toast } from "sonner";

export const Footer = () => {
  const [copied, setCopied] = useState(false);
  const donationAddress = "0xce98fE636e83D36EA64cafEfF4020317B8B718EA";

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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl mx-auto">
          {/* Official Sites */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-2">Official Sites</h3>
            <ul className="space-y-1">
              <li>
                <a
                  href="https://www.telco.in/en"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <ExternalLink className="h-4 w-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                  <span>Telcoin Holdings</span>
                </a>
              </li>
              <li>
                <a
                  href="https://www.telcoin.org/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <ExternalLink className="h-4 w-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                  <span>Telcoin Association</span>
                </a>
              </li>
              <li>
                <a
                  href="https://www.telcoin.network/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <ExternalLink className="h-4 w-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                  <span>Telcoin Network</span>
                </a>
              </li>
              <li>
                <a
                  href="https://www.telx.network/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <ExternalLink className="h-4 w-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                  <span>TELx</span>
                </a>
              </li>
            </ul>
          </div>

          {/* Social Media */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-2">Social Media</h3>
            <ul className="space-y-1">
              <li>
                <a
                  href="/social"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <ExternalLink className="h-4 w-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                  <span>All Social Links</span>
                </a>
              </li>
              <li>
                <a
                  href="https://x.com/telcoin"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <svg
                    className="h-4 w-4 group-hover:scale-110 transition-transform"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  <span>Telcoin X</span>
                </a>
              </li>
              <li>
                <a
                  href="https://x.com/TelcoinTAO"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <svg
                    className="h-4 w-4 group-hover:scale-110 transition-transform"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  <span>TelcoinTAO X</span>
                </a>
              </li>
              <li>
                <a
                  href="https://t.co/nKC2qhNtlX"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <MessageSquare className="h-4 w-4 group-hover:scale-110 transition-transform" />
                  <span>Telcoin Association Discord</span>
                </a>
              </li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-2">Contact</h3>
            <ul className="space-y-1">
              <li>
                <a
                  href="https://x.com/TelcoinHub"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <svg
                    className="h-4 w-4 group-hover:scale-110 transition-transform"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  <span>TelcoinHub X</span>
                </a>
              </li>
              <li>
                <a
                  href="mailto:thetelcoinhub@gmail.com"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <Mail className="h-4 w-4 group-hover:scale-110 transition-transform" />
                  <span>thetelcoinhub@gmail.com</span>
                </a>
              </li>
              <li>
                <a
                  href="https://t.me/telfamcommunity"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors group py-1"
                >
                  <svg
                    className="h-4 w-4 group-hover:scale-110 transition-transform"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.692-1.653-1.123-2.678-1.799-1.185-.781-.417-1.21.258-1.911.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.062 3.345-.479.329-.913.489-1.302.481-.428-.008-1.252-.241-1.865-.44-.752-.244-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635.099-.002.321.023.465.141.121.099.155.232.171.326.016.094.036.308.02.475z"/>
                  </svg>
                  <span>Telcoin Hub</span>
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Donation Section */}
        <div className="mt-6 pt-6 border-t border-border/30 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Heart className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Support the TelcoinHub</h3>
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
          >
            <code className="text-xs font-mono text-foreground group-hover:text-foreground">
              <span className="hidden sm:inline">{donationAddress}</span>
              <span className="sm:hidden">{donationAddress.slice(0, 10)}...{donationAddress.slice(-8)}</span>
            </code>
            <Copy className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
          </button>
          {copied && (
            <p className="text-xs text-primary mt-2 animate-fade-in">Copied!</p>
          )}
        </div>

        {/* Copyright */}
        <div className="mt-4 pt-4 border-t border-border/30 text-center text-xs text-muted-foreground space-y-0.5">
          <p>© {new Date().getFullYear()} Telcoin Community Hub. All rights reserved.</p>
          <p className="opacity-70">Price data powered by CoinGecko</p>
          <br />
          <p className="opacity-70 max-w-4xl mx-auto">
            *This website is an independent, community-run project. It is not operated by, endorsed by, or affiliated
            with Telcoin Holdings, the Telcoin Association, or any of their subsidiaries. While every effort is made to
            ensure the accuracy and timeliness of token data and related information, no guarantees are provided. All
            content is offered “as is” for informational purposes only and does not constitute financial advice.
          </p>
        </div>
      </div>
    </footer>
  );
};
