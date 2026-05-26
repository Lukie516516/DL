import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";

const DEFAULT_FILE = "agiking-31415926.json";

/** Keys present in `deployments/agiking-31415926.json` → `addresses`. */
export type AgikingDeploymentAddresses = {
  dlToken: Address;
  ausd: Address;
  usdt: Address;
  agi?: Address;
  wrappedNative: Address;
  dealLib: Address;
  dealAssetNftLib?: Address;
  dealImplementation: Address;
  dealNoAssetImplementation?: Address;
  dealAAssetNftImplementation?: Address;
  dealBAssetNftImplementation?: Address;
  dealAAssetNftOnlyImplementation?: Address;
  dealBAssetNftOnlyImplementation?: Address;
  dealOpenTokenTokenImplementation?: Address;
  dealImplementationRegistry?: Address;
  pairImplementation: Address;
  dealFactory: Address;
  dealMessageHub: Address;
  dealCreditGraph?: Address;
  dealActivityIndex?: Address;
  dealResultIndex?: Address;
  dealPairManager?: Address;
  dealInfoNFT: Address;
  pairDlAusd: Address;
  pairDlUsdt: Address;
  pairDlAgi?: Address;
  dealSwapAssetRegistry?: Address;
  dealSwapOrderBook: Address;
  dealRouter: Address;
  dealReader: Address;
  dcDomain: Address;
  dcDomainRank: Address;
  dcDomainRankReader?: Address;
  dcDomainListReader?: Address;
  dcDomainMarket: Address;
  dcDomainSwap: Address;
  dcDomainHall: Address;
  dToken: Address;
  dealTimelock?: Address;
  dealGovernor?: Address;
  dealNftGovernanceActivity?: Address;
  nftVetoRegistry?: Address;
  dealSeatVetoGovernor?: Address;
  voteDividendClaimer: Address;
};

export function loadAgikingDeploymentAddresses(
  fileName: string = DEFAULT_FILE,
): AgikingDeploymentAddresses {
  const path = join(process.cwd(), "deployments", fileName);
  const j = JSON.parse(readFileSync(path, "utf8")) as { addresses: AgikingDeploymentAddresses };
  return j.addresses;
}
