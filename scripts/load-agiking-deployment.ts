import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";

const DEFAULT_FILE = "agiking-31415926.json";

/** Keys present in `deployments/agiking-31415926.json` → `addresses`. */
export type AgikingDeploymentAddresses = {
  dlToken: Address;
  ausd: Address;
  usdt: Address;
  wrappedNative: Address;
  dealLib: Address;
  dealImplementation: Address;
  pairImplementation: Address;
  dealFactory: Address;
  dealMessageHub: Address;
  dealInfoNFT: Address;
  pairDlAusd: Address;
  pairDlUsdt: Address;
  dealSwapOrderBook: Address;
  dealRouter: Address;
  dealReader: Address;
  dcDomain: Address;
  dcDomainRank: Address;
  dcDomainMarket: Address;
  dcDomainSwap: Address;
  dcDomainHall: Address;
  dToken: Address;
  dealTimelock: Address;
  dealGovernor: Address;
  voteDividendClaimer: Address;
};

export function loadAgikingDeploymentAddresses(
  fileName: string = DEFAULT_FILE,
): AgikingDeploymentAddresses {
  const path = join(process.cwd(), "deployments", fileName);
  const j = JSON.parse(readFileSync(path, "utf8")) as { addresses: AgikingDeploymentAddresses };
  return j.addresses;
}
