import {
  getAddress,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

export const DAO_V2_PROPOSAL_KIND = {
  Parameter: 0,
  Treasury: 1,
  Major: 2,
  Satoshi: 3,
} as const;

export type DaoV2ProposalKind =
  (typeof DAO_V2_PROPOSAL_KIND)[keyof typeof DAO_V2_PROPOSAL_KIND];

export const DEFAULT_BROADCAST_MAX_VALUE = parseEther("0.01");

export type DaoV2PolicyAddresses = {
  governance: Address;
  policyRegistry: Address;
  dealFactory: Address;
  crossChainBroadcaster: Address;
  protocolTreasury: Address;
  bscDealFactory: Address;
  satoshiVault?: Address;
};

export type DaoV2RuleInput = {
  kind: number;
  target: Address;
  selector: Hex;
  allowed: boolean;
  validateNestedBroadcast: boolean;
  nestedOnly: boolean;
  maxValue: bigint;
};

export type DaoV2PolicyRule = DaoV2RuleInput & {
  label: string;
  signature: string;
  scope: "direct" | "broadcast-target";
};

export type DaoV2PolicyOptions = {
  broadcastMaxValue?: bigint;
  satoshiVaultFunction?: string;
};

const BROADCAST_SIGNATURE = "broadcast(uint32[],address[],bytes,uint128)";

const FACTORY_PARAMETER_SIGNATURES = [
  "setMinTimeoutSeconds(uint64)",
  "setMinWindowSec(uint32)",
  "setRecognizedTokens(address,address)",
  "setAllowedMarginToken(address,bool)",
  "setFeesAndMintOnFees(uint32,uint32,uint32,uint32)",
  "setMessagePriceRule(bool,address,uint256)",
  "setCreateBurnRule(bool,address,uint256)",
] as const;

const FACTORY_MAJOR_SIGNATURES = [
  "setDealImplementation(address)",
  "setPairImplementation(address)",
  "setCoreGlobals(address,address,address,address)",
  "setServiceGlobals(address,address,address,address,address)",
  "setOpsGlobals(address,address,address)",
  "setAllowedCreateFor(address,bool)",
] as const;

const GOVERNANCE_MAJOR_SIGNATURES = [
  "upgradeToAndCall(address,bytes)",
  "setPolicyRegistry(address)",
  "setNftVetoRegistry(address)",
  "setActivationThreshold(uint256)",
  "setTreasuryPassThreshold(uint256)",
  "setSatoshiPassThreshold(uint256)",
  "setParamWindowSeconds(uint256)",
  "setMajorWindowSeconds(uint256)",
  "setMajorProposalFee(uint256)",
  "setDcToken(address)",
  "setTreasury(address)",
  "setNftVetoThresholdBps(uint256)",
  "setFastPassThreshold(uint256)",
] as const;

const REGISTRY_MAJOR_SIGNATURES = [
  "setRule((uint8,address,bytes4,bool,bool,bool,uint256))",
  "setRules((uint8,address,bytes4,bool,bool,bool,uint256)[])",
] as const;

const TREASURY_SIGNATURES = [
  "payNative(address,uint256)",
  "payToken(address,address,uint256)",
  "approveToken(address,address,uint256)",
  "approveAndCreateDividendRound(address,address,uint256)",
] as const;

function normalizeAddresses(input: DaoV2PolicyAddresses): DaoV2PolicyAddresses {
  return {
    governance: getAddress(input.governance),
    policyRegistry: getAddress(input.policyRegistry),
    dealFactory: getAddress(input.dealFactory),
    crossChainBroadcaster: getAddress(input.crossChainBroadcaster),
    protocolTreasury: getAddress(input.protocolTreasury),
    bscDealFactory: getAddress(input.bscDealFactory),
    satoshiVault: input.satoshiVault ? getAddress(input.satoshiVault) : undefined,
  };
}

export function buildDaoV2PolicyRules(
  addressInput: DaoV2PolicyAddresses,
  options: DaoV2PolicyOptions = {},
): DaoV2PolicyRule[] {
  const addresses = normalizeAddresses(addressInput);
  const broadcastMaxValue = options.broadcastMaxValue ?? DEFAULT_BROADCAST_MAX_VALUE;
  if (broadcastMaxValue <= 0n) {
    throw new Error("DAO V2 broadcaster max value must be greater than zero");
  }
  if (Boolean(addresses.satoshiVault) !== Boolean(options.satoshiVaultFunction)) {
    throw new Error("SatoshiVault address and exact function signature must be configured together");
  }

  const rules: DaoV2PolicyRule[] = [];
  const add = (
    label: string,
    kind: DaoV2ProposalKind,
    target: Address,
    signature: string,
    settings: {
      maxValue?: bigint;
      validateNestedBroadcast?: boolean;
      nestedOnly?: boolean;
      scope?: DaoV2PolicyRule["scope"];
    } = {},
  ) => {
    rules.push({
      label,
      kind,
      target,
      signature,
      selector: toFunctionSelector(signature),
      allowed: true,
      validateNestedBroadcast: settings.validateNestedBroadcast ?? false,
      nestedOnly: settings.nestedOnly ?? false,
      maxValue: settings.maxValue ?? 0n,
      scope: settings.scope ?? "direct",
    });
  };

  for (const signature of FACTORY_PARAMETER_SIGNATURES) {
    add(`ETH DealFactory.${signature}`, DAO_V2_PROPOSAL_KIND.Parameter, addresses.dealFactory, signature);
  }
  add(
    `CrossChainBroadcaster.${BROADCAST_SIGNATURE}`,
    DAO_V2_PROPOSAL_KIND.Parameter,
    addresses.crossChainBroadcaster,
    BROADCAST_SIGNATURE,
    { maxValue: broadcastMaxValue, validateNestedBroadcast: true },
  );
  for (const signature of FACTORY_PARAMETER_SIGNATURES) {
    add(
      `BSC DealFactory.${signature}`,
      DAO_V2_PROPOSAL_KIND.Parameter,
      addresses.bscDealFactory,
      signature,
      { nestedOnly: true, scope: "broadcast-target" },
    );
  }

  for (const signature of TREASURY_SIGNATURES) {
    add(
      `ProtocolTreasury.${signature}`,
      DAO_V2_PROPOSAL_KIND.Treasury,
      addresses.protocolTreasury,
      signature,
    );
  }

  for (const signature of GOVERNANCE_MAJOR_SIGNATURES) {
    add(`DealGovernance.${signature}`, DAO_V2_PROPOSAL_KIND.Major, addresses.governance, signature);
  }
  for (const signature of REGISTRY_MAJOR_SIGNATURES) {
    add(
      `GovernancePolicyRegistry.${signature}`,
      DAO_V2_PROPOSAL_KIND.Major,
      addresses.policyRegistry,
      signature,
    );
  }
  for (const signature of FACTORY_MAJOR_SIGNATURES) {
    add(`ETH DealFactory.${signature}`, DAO_V2_PROPOSAL_KIND.Major, addresses.dealFactory, signature);
  }
  add(
    `ProtocolTreasury.setController(address)`,
    DAO_V2_PROPOSAL_KIND.Major,
    addresses.protocolTreasury,
    "setController(address)",
  );
  add(
    `CrossChainBroadcaster.${BROADCAST_SIGNATURE}`,
    DAO_V2_PROPOSAL_KIND.Major,
    addresses.crossChainBroadcaster,
    BROADCAST_SIGNATURE,
    { maxValue: broadcastMaxValue, validateNestedBroadcast: true },
  );
  for (const signature of FACTORY_MAJOR_SIGNATURES) {
    add(
      `BSC DealFactory.${signature}`,
      DAO_V2_PROPOSAL_KIND.Major,
      addresses.bscDealFactory,
      signature,
      { nestedOnly: true, scope: "broadcast-target" },
    );
  }

  if (addresses.satoshiVault && options.satoshiVaultFunction) {
    add(
      `SatoshiVault.${options.satoshiVaultFunction}`,
      DAO_V2_PROPOSAL_KIND.Satoshi,
      addresses.satoshiVault,
      options.satoshiVaultFunction,
    );
  }

  assertDaoV2PolicyRules(rules, addresses, Boolean(addresses.satoshiVault));
  return rules;
}

export function toRegistryRuleInputs(rules: DaoV2PolicyRule[]): DaoV2RuleInput[] {
  return rules.map(({ kind, target, selector, allowed, validateNestedBroadcast, nestedOnly, maxValue }) => ({
    kind,
    target,
    selector,
    allowed,
    validateNestedBroadcast,
    nestedOnly,
    maxValue,
  }));
}

export function assertDaoV2PolicyRules(
  rules: DaoV2PolicyRule[],
  addresses: DaoV2PolicyAddresses,
  satoshiVaultEnabled: boolean,
): void {
  const keys = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.kind}:${rule.target.toLowerCase()}:${rule.selector.toLowerCase()}`;
    if (keys.has(key)) throw new Error(`Duplicate DAO V2 rule: ${rule.label}`);
    keys.add(key);
    if (!rule.allowed) throw new Error(`Initial DAO V2 rule must be allowed: ${rule.label}`);
    if (rule.scope === "broadcast-target" && rule.validateNestedBroadcast) {
      throw new Error(`Nested target cannot recursively validate broadcasts: ${rule.label}`);
    }
    if ((rule.scope === "broadcast-target") !== rule.nestedOnly) {
      throw new Error(`DAO V2 rule scope/nestedOnly mismatch: ${rule.label}`);
    }
  }

  const requireRule = (kind: DaoV2ProposalKind, target: Address, signature: string) => {
    const key = `${kind}:${target.toLowerCase()}:${toFunctionSelector(signature).toLowerCase()}`;
    if (!keys.has(key)) throw new Error(`Missing mandatory DAO V2 rule: ${signature}`);
  };
  requireRule(DAO_V2_PROPOSAL_KIND.Major, addresses.governance, "upgradeToAndCall(address,bytes)");
  requireRule(DAO_V2_PROPOSAL_KIND.Major, addresses.governance, "setPolicyRegistry(address)");
  requireRule(
    DAO_V2_PROPOSAL_KIND.Major,
    addresses.policyRegistry,
    "setRule((uint8,address,bytes4,bool,bool,bool,uint256))",
  );
  requireRule(
    DAO_V2_PROPOSAL_KIND.Major,
    addresses.policyRegistry,
    "setRules((uint8,address,bytes4,bool,bool,bool,uint256)[])",
  );
  const satoshiRules = rules.filter((rule) => rule.kind === DAO_V2_PROPOSAL_KIND.Satoshi);
  if (satoshiVaultEnabled ? satoshiRules.length !== 1 : satoshiRules.length !== 0) {
    throw new Error("Satoshi policy must be deny-all until one exact SatoshiVault action is configured");
  }
}

export function policyRuleKey(rule: Pick<DaoV2RuleInput, "kind" | "target" | "selector">): string {
  return `${rule.kind}:${rule.target.toLowerCase()}:${rule.selector.toLowerCase()}`;
}

/// Rules installed by the post-V2 Major proposal after the two ETH treasury
/// module proxies are deployed. These are intentionally separate from the
/// original 48-rule production baseline so the deployed registry can be
/// audited against its exact genesis configuration.
export function buildDaoV2TreasuryModuleRules(
  satoshiVaultInput: Address,
  dividendVaultInput: Address,
): DaoV2RuleInput[] {
  const satoshiVault = getAddress(satoshiVaultInput);
  const dividendVault = getAddress(dividendVaultInput);
  return [
    {
      kind: DAO_V2_PROPOSAL_KIND.Satoshi,
      target: satoshiVault,
      selector: toFunctionSelector("payDC(address,uint256)"),
      allowed: true,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    },
    {
      kind: DAO_V2_PROPOSAL_KIND.Treasury,
      target: dividendVault,
      selector: toFunctionSelector("createRound(uint256)"),
      allowed: true,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    },
    {
      kind: DAO_V2_PROPOSAL_KIND.Major,
      target: satoshiVault,
      selector: toFunctionSelector("upgradeToAndCall(address,bytes)"),
      allowed: true,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    },
    {
      kind: DAO_V2_PROPOSAL_KIND.Major,
      target: dividendVault,
      selector: toFunctionSelector("upgradeToAndCall(address,bytes)"),
      allowed: true,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    },
  ];
}
