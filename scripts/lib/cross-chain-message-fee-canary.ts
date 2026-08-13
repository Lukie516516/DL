import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

export const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
export const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
export const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
export const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");

export const BSC_FACTORY = getAddress("0x1Ca748Feb347d0d177E844E7D4CDCA908957c256");
export const BSC_DC = getAddress("0xFF5efE3B23762170a99F8F4C66abea11613b982D");
export const BSC_EXECUTOR = getAddress("0x407381d841DD48bBBd40Bd37f9dB268CE75950A8");
export const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
export const BASE_FACTORY = getAddress("0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D");
export const BASE_DC = getAddress("0xBB88a5b4aCDD18Fca66C2eb14cBdB791b9e8Df23");
export const BASE_EXECUTOR = getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218");
export const BASE_PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");

export const BSC_CHAIN_KEY = 30_102;
export const BASE_CHAIN_KEY = 30_184;
export const MAJOR = 2 as const;
export const LZ_GAS = 500_000n;
export const ACTION_FEE_BUDGET = parseEther("0.005");
export const MAJOR_PROPOSAL_FEE = parseEther("1000");
export const CURRENT_MESSAGE_FEE = parseEther("104");
export const CANARY_MESSAGE_FEE = parseEther("105");
export const MESSAGE_FEE_SETTER_SIGNATURE = "setMessagePriceAmount(uint256)";
export const MESSAGE_FEE_SETTER_SELECTOR = toFunctionSelector(MESSAGE_FEE_SETTER_SIGNATURE);
export const EXECUTOR_ALLOWLIST_SELECTOR = toFunctionSelector("setAllowedTarget(address,bool)");
export const PROBE_MARKER_SELECTOR = toFunctionSelector("recordMarker(bytes32)");

export const POLICY_DESCRIPTION = "关闭BSC和Base测试权限，并授权DAO调节两链留言费和Base白名单。";
export const CANARY_DESCRIPTION = "测试BSC和Base留言费由104改为105 DC。";
export const RESTORE_DESCRIPTION = "恢复BSC和Base留言费为104 DC。";

export const governanceAbi = parseAbi([
  "function dToken() view returns (address)",
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description,uint48 createdAt))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
  "function stake(uint256,uint256)",
  "function execute(uint256) payable",
  "function currentStakedOf(address) view returns (uint256)",
  "function stakeOf(uint256,address) view returns (uint256)",
  "function vetoStakeOf(uint256,address) view returns (uint256)",
  "function claimBack(uint256)",
]);

export const registryAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
  "function setRules((uint8 kind,address target,bytes4 selector,bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)[])",
]);

export const broadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
  "function setChainActive(uint32,bool)",
]);

export const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function crossChainGovernance() view returns (address)",
  "function msgPriceEnabled() view returns (bool)",
  "function msgPriceToken() view returns (address)",
  "function msgPriceAmountInToken() view returns (uint256)",
  "function setAdmin(address)",
  "function setMessagePriceRuleByAdmin(uint256)",
  "function setMessagePriceAmount(uint256)",
]);

export const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function endpoint() view returns (address)",
  "function peers(uint32) view returns (bytes32)",
  "function ccipRouter() view returns (address)",
  "function ccipSrcChainSelector() view returns (uint64)",
  "function ccipSrcSender() view returns (address)",
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
  "function setAllowedTarget(address,bool)",
  "function confirmStatus(bytes32) view returns (bool layerZero,bool chainlinkCcip,bool axelar,uint256 count,bool executed)",
  "function executionAttempts(bytes32) view returns (uint256)",
  "function lzReceive((uint32 srcEid,bytes32 sender,uint64 nonce),bytes32,bytes,address,bytes)",
  "function ccipReceive((bytes32 messageId,uint64 sourceChainSelector,bytes sender,bytes data,(address token,uint256 amount)[] destTokenAmounts))",
]);

export type ChainFeeConfig = {
  label: "BSC" | "Base";
  chainId: 56 | 8453;
  chainKey: number;
  factory: Address;
  dc: Address;
  executor: Address;
};

export const CHAIN_FEE_CONFIGS: readonly ChainFeeConfig[] = [
  { label: "BSC", chainId: 56, chainKey: BSC_CHAIN_KEY, factory: BSC_FACTORY, dc: BSC_DC, executor: BSC_EXECUTOR },
  { label: "Base", chainId: 8453, chainKey: BASE_CHAIN_KEY, factory: BASE_FACTORY, dc: BASE_DC, executor: BASE_EXECUTOR },
] as const;

export type PolicyRuleInput = {
  kind: number;
  target: Address;
  selector: Hex;
  allowed: boolean;
  validateNestedBroadcast: boolean;
  nestedOnly: boolean;
  maxValue: bigint;
};

export type MessageFeeAction = {
  chain: "BSC+Base";
  target: Address;
  value: bigint;
  innerCalldata: Hex;
  calldata: Hex;
};

export const POLICY_RULES: readonly PolicyRuleInput[] = [
  ...[
    { target: BSC_PROBE, selector: PROBE_MARKER_SELECTOR },
    { target: BASE_PROBE, selector: PROBE_MARKER_SELECTOR },
  ].map(({ target, selector }) => ({
    kind: MAJOR,
    target,
    selector,
    allowed: false,
    validateNestedBroadcast: false,
    nestedOnly: false,
    maxValue: 0n,
  })),
  ...CHAIN_FEE_CONFIGS.map((chain) => ({
    kind: MAJOR,
    target: chain.factory,
    selector: MESSAGE_FEE_SETTER_SELECTOR,
    allowed: true,
    validateNestedBroadcast: false,
    nestedOnly: true,
    maxValue: 0n,
  })),
  {
    kind: MAJOR,
    target: BASE_EXECUTOR,
    selector: EXECUTOR_ALLOWLIST_SELECTOR,
    allowed: true,
    validateNestedBroadcast: false,
    nestedOnly: true,
    maxValue: 0n,
  },
];

export function buildSetRulesCalldata(): Hex {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "setRules",
    args: [POLICY_RULES],
  });
}

export function buildPolicyProposalCalldata(): Hex {
  return encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[REGISTRY], [0n], [buildSetRulesCalldata()], POLICY_DESCRIPTION, MAJOR],
  });
}

export function buildFactoryFeeCalldata(price: bigint): Hex {
  return encodeFunctionData({
    abi: factoryAbi,
    functionName: "setMessagePriceAmount",
    args: [price],
  });
}

export function buildMessageFeeActions(price: bigint): MessageFeeAction[] {
  const innerCalldata = buildFactoryFeeCalldata(price);
  return [{
    chain: "BSC+Base",
    target: BROADCASTER,
    value: ACTION_FEE_BUDGET,
    innerCalldata,
    calldata: encodeFunctionData({
      abi: broadcasterAbi,
      functionName: "broadcast",
      args: [
        CHAIN_FEE_CONFIGS.map((chain) => chain.chainKey),
        CHAIN_FEE_CONFIGS.map((chain) => chain.factory),
        innerCalldata,
        LZ_GAS,
      ],
    }),
  }];
}

export function buildMessageFeeProposalCalldata(
  price: bigint,
  description: string,
): Hex {
  const actions = buildMessageFeeActions(price);
  return encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [
      actions.map((action) => action.target),
      actions.map((action) => action.value),
      actions.map((action) => action.calldata),
      description,
      MAJOR,
    ],
  });
}

export function isExactNestedRule(rule: any): boolean {
  return (rule.allowed ?? rule[0]) === true
    && (rule.validateNestedBroadcast ?? rule[1]) === false
    && (rule.nestedOnly ?? rule[2]) === true
    && BigInt(rule.maxValue ?? rule[3]) === 0n;
}

export function isEmptyRule(rule: any): boolean {
  return (rule.allowed ?? rule[0]) === false
    && (rule.validateNestedBroadcast ?? rule[1]) === false
    && (rule.nestedOnly ?? rule[2]) === false
    && BigInt(rule.maxValue ?? rule[3]) === 0n;
}
