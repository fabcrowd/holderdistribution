import { describe, expect, it } from "vitest";
import { walletAddressHref } from "./WalletFlowsPanel";

const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const chains = [
  { key: "ethereum", explorer: "https://etherscan.io", origin: true },
  { key: "base", explorer: "https://basescan.org/" },
  { key: "solana", vm: "solana" as const },
  { key: "hedera", vm: "hedera" as const },
];
const evmExplorers = { ethereum: "https://etherscan.io", base: "https://basescan.org/" };

describe("walletAddressHref", () => {
  it("keeps EVM links on the configured explorer root", () => {
    expect(walletAddressHref(chains, "ethereum", "0xAbC", evmExplorers)).toBe("https://etherscan.io/address/0xAbC");
    expect(walletAddressHref(chains, "base", "0xAbC", evmExplorers)).toBe("https://basescan.org/address/0xAbC");
  });

  it("keeps Solana links on Solscan with the base58 case intact", () => {
    expect(walletAddressHref(chains, "solana", OWNER, evmExplorers)).toBe(`https://solscan.io/account/${OWNER}`);
  });

  it("links a Hedera id to HashScan", () => {
    expect(walletAddressHref(chains, "hedera", "0.0.1234", evmExplorers)).toBe("https://hashscan.io/mainnet/account/0.0.1234");
  });

  it("does not turn an unknown chain key with a 0x address into a non-EVM link", () => {
    expect(walletAddressHref([{ key: "solana", vm: "solana" }], "arbitrum", "0xa", {})).toBe("https://etherscan.io/address/0xa");
  });
});
