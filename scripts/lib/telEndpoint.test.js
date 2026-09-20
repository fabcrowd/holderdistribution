import { describe, expect, it } from "vitest";
import { classifyDestination, classifyTelMovement, resolveTelEndpoint } from "./telEndpoint.js";

const BITGO = "0xbd02c51150a4ab6ce97b9de2025644594f3e75b8";
const BITGO_RELAY = "0xb1714f449b85e8ba04ac9e9060928f6fdc0fd533";
const KUCOIN = "0x9ac5637d295fea4f51e086c329d791cc157b1c84";
const KUCOIN_RELAY = "0x1128a473c43a9e0779113c4bf6d3aa186182bb41";
const KUCOIN_32 = "0x58edf78281334335effa23101bbe3371b6a36a51";
const KUCOIN_RELAY_2 = "0x5b34f69fe6da995f4c5e0de92adcbf02bfe6b4b0";
const UPHOLD = "0x1c727a55ea3c11b0ab7d3a361fe0f3c47ce6de5d";
const UPHOLD_RELAY = "0x00d328532f71b593510d712146fce346efe2667c";
const BRIDGE = "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf";
const BRIDGE_RELAY = "0xacea3a74d6c0d288aea9886a3b78b0654def8c07";
const KYBER_AGG = "0xc47a52645b9a684ea65c87e60fc60397541d9e0e";
const REWARD = "0x8f702676830ddca2801a4a7cdb971cde4df697ae";
const ZERO = "0x0000000000000000000000000000000000000000";
const ANCHORAGE = "0xaa9ae53fc7a69fde1baaf6aa03796e6ccc764271";
const UNKNOWN = "0x1111111111111111111111111111111111111111";
const COW = "0x9008d19f58aabd9ed0d60971565aa8510560ab41";
const TREASURY = "0x2580ccb2e5cd9c4d526d1326143416fb20704e1a";
const TAO_SAFE = "0xf4bc288d616c4f57071a57f5a4050b5e516fe7e5";
const TELX_COUNCIL = "0x583d596b0a79c0e83c87851ea9fb1a91e80290b2";
const SETTLEMENT_HUB = "0x17fcc1f337fd68ff831017684798d08cbd424143";
const TA_SALE = "0x11cb903d2f797d4410fd5e65ba9aa641a0741fc3";
const POLY_RELAY = "0x707856c0089fd59d9e686a47784d5dad7c0784c4";
const BASE_BRIDGE = "0x3154cf16ccdb4c6d922629664174b904d80f2c35";
const BASE_REWARDS = "0xe3a465e1460e9987c772c36b91020946bc60af52";

const labelMap = new Map([
  [BITGO, { name: "BitGo Custody", category: "escrow" }],
  [ANCHORAGE, { name: "Anchorage Digital Vault", category: "escrow" }],
]);
const cexMap = new Map([
  [KUCOIN, { label: "KuCoin", walletName: "KuCoin 23" }],
  [KUCOIN_32, { label: "KuCoin", walletName: "KuCoin 32" }],
  [UPHOLD, { label: "Uphold", walletName: "Uphold" }],
]);
const controlledSet = new Set([TAO_SAFE, TELX_COUNCIL, SETTLEMENT_HUB, TA_SALE, TREASURY]);

describe("resolveTelEndpoint", () => {
  it("hops the BitGo pass-through to BitGo Custody", () => {
    expect(resolveTelEndpoint(BITGO_RELAY)).toEqual({
      endpoint: BITGO,
      hop: "relay",
      label: "BitGo Custody",
    });
  });

  it("hops the KuCoin deposit relay to a tagged KuCoin wallet", () => {
    expect(resolveTelEndpoint(KUCOIN_RELAY)).toMatchObject({
      endpoint: KUCOIN,
      hop: "relay",
      label: "KuCoin",
    });
  });

  it("hops the second KuCoin deposit relay to tagged KuCoin 32", () => {
    expect(resolveTelEndpoint(KUCOIN_RELAY_2)).toEqual({
      endpoint: KUCOIN_32,
      hop: "relay",
      label: "KuCoin",
    });
  });

  it("treats the zero address as a burn", () => {
    expect(resolveTelEndpoint(ZERO)).toEqual({
      endpoint: ZERO,
      hop: "burn",
      label: "Burn",
    });
  });

  it("leaves a direct destination unchanged", () => {
    expect(resolveTelEndpoint(ANCHORAGE)).toEqual({
      endpoint: ANCHORAGE,
      hop: "direct",
      label: null,
    });
  });
});

describe("classifyDestination", () => {
  it("classifies the BitGo relay as custody at BitGo, not unlabeled", () => {
    const hit = classifyDestination(BITGO_RELAY, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("custody");
    expect(hit.endpoint).toBe(BITGO);
    expect(hit.toLabel).toBe("BitGo Custody");
  });

  it("classifies the KuCoin relay as an exchange, not unlabeled", () => {
    const hit = classifyDestination(KUCOIN_RELAY, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("cex");
    expect(hit.endpoint).toBe(KUCOIN);
    expect(hit.toLabel).toBe("KuCoin");
  });

  it("classifies the second KuCoin relay as an exchange at KuCoin 32", () => {
    const hit = classifyDestination(KUCOIN_RELAY_2, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("cex");
    expect(hit.endpoint).toBe(KUCOIN_32);
    expect(hit.toLabel).toBe("KuCoin");
  });

  it("classifies the zero address as burned", () => {
    const hit = classifyDestination(ZERO, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("burn");
    expect(hit.toLabel).toBe("Burn");
  });

  it("keeps a direct custody destination (Anchorage) as custody", () => {
    const hit = classifyDestination(ANCHORAGE, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("custody");
    expect(hit.endpoint).toBe(ANCHORAGE);
  });

  it("leaves a genuinely unknown EOA unlabeled", () => {
    const hit = classifyDestination(UNKNOWN, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("unlabeled");
    expect(hit.endpoint).toBe(UNKNOWN);
  });

  it("still classifies CoW as a DEX venue", () => {
    const hit = classifyDestination(COW, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("dex_venue");
    expect(hit.venue).toBe("cow");
  });

  it("hops the Treasury pass-through to Uphold", () => {
    const hit = classifyDestination(UPHOLD_RELAY, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("cex");
    expect(hit.endpoint).toBe(UPHOLD);
    expect(hit.toLabel).toBe("Uphold");
  });

  it("hops the Treasury bridge relay to the Polygon predicate", () => {
    const hit = classifyDestination(BRIDGE_RELAY, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("bridge");
    expect(hit.endpoint).toBe(BRIDGE);
  });

  it("classifies the Kyber aggregator as a DEX venue", () => {
    const hit = classifyDestination(KYBER_AGG, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("dex_venue");
    expect(hit.venue).toBe("kyber");
  });
});

describe("classifyTelMovement", () => {
  it("treats unlabeled outflows from a reward contract as reward claimants", () => {
    const hit = classifyTelMovement(REWARD, UNKNOWN, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("reward_payout");
    expect(hit.toLabel).toBe("Reward claimant");
  });

  it("does not relabel a classified destination just because it came from a reward contract", () => {
    const hit = classifyTelMovement(REWARD, COW, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("dex_venue");
  });

  it("does not stop Treasury→acea at the Polygon predicate — lands at TELx Council", () => {
    const hit = classifyTelMovement(TREASURY, BRIDGE_RELAY, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("chain_transport");
    expect(hit.endpoint).toBe(TELX_COUNCIL);
    expect(hit.toLabel).toBe("TELx Council");
    expect(hit.endpointChain).toBe("polygon");
  });

  it("does not stop Treasury→0x707856 at the relay or predicate — lands at TAO Safe", () => {
    const hit = classifyTelMovement(TREASURY, POLY_RELAY, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("chain_transport");
    expect(hit.endpoint).toBe(TAO_SAFE);
    expect(hit.toLabel).toBe("TAO Safe");
  });

  it("treats Settlement hub→predicate as a chain hop, not a destination", () => {
    const hit = classifyTelMovement(SETTLEMENT_HUB, BRIDGE, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("chain_transport");
    expect(hit.endpoint).toBe(SETTLEMENT_HUB);
  });

  it("follows TA Sale→Base bridge through to the Base rewards contract", () => {
    const hit = classifyTelMovement(TA_SALE, BASE_BRIDGE, labelMap, cexMap, controlledSet);
    expect(hit.classification).toBe("reward_contract");
    expect(hit.endpoint).toBe(BASE_REWARDS);
    expect(hit.toLabel).toBe("TELx rewards (Base)");
    expect(hit.endpointChain).toBe("base");
  });
});
