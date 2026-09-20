/** Known USDC/USDT payees from association-forensics/recipient-profiles.json */
export const STABLECOIN_PAYEE_LABELS: Record<string, string> = {
  "0x3dcb7cfbb431a11cabb6f7f2296e2354f488efc2": "Payout-operator Safe",
  "0xfb7a6e949da9622eb7cc7222256acc28f035c7b0": "Uphold deposit",
  "0x2010db06b1dfd2526f213b41f86df7694224664c": "$150k payment #1",
  "0xe636e237eb330876fd850885d9fab209446418d4": "$150k payment #2",
  "0x150e806545f0f3c260ce2a0f2cf3fd9e9ca1b559": "$150k payment #3",
  "0xf370b302c2a555c086c676d00cdf8cc2377d4d86": "Make-it pro GmbH",
  "0x8185bd383445bd2b88373fd1430c955d350471fd": "Andersen build",
  "0x6341d512d97776d26cd19b1f118ebc397bf593ef": "STORM Finops",
  "0xce32d238876f1dfb9f196e4d47cfa9ff3a29f337": "BizRa TAO Finops (candidate)",
  "0xdaf17de47c1c91159210abbc178e4158882d2807": "David Palmer advisory",
  "0x9246b2c653015e28087b63db3b9a7afe4c6eb408": "STORM Partners",
  "0x9246ac673f5cf7ba3bb14f852a6650ee4c6eb408": "STORM Partners (community)",
  "0x9ee208768d37eadee749dc3514cbee4b1e5e41e1": "Forwarder contract",
  "0x3acad81bf4d1b80982cc656ca86231d49f8ba9dd": "Disbursement hub",
  "0xa260e3732593e4ecf9ddc144fd6c4c5fe7077978": "Polygon USDT hub (LiFi/1inch)",
  "0x1380f2f57553ada04b31ee7b1e039e496939db3d": "1inch settlement wallet",
  "0x204280d181c3bbd0066bc945c1a69ba849cc7851": "Coinbase Prime deposit",
};

export const stablecoinPayeeLabel = (address: string | null | undefined): string | null => {
  if (!address) return null;
  return STABLECOIN_PAYEE_LABELS[address.trim().toLowerCase()] ?? null;
};
