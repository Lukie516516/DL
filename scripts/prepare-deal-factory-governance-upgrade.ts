/**
 * Read-only production preflight for the ETH/BSC/Base DealFactory governance upgrade.
 *
 * This script never signs or sends a transaction.
 */
import { existsSync, readFileSync } from "node:fs";

import {
  concat,
  createPublicClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  getCreate2Address,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";

const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const CREATE2_DEPLOYER = getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const FACTORY_SALT = keccak256(stringToHex("DEAL_FACTORY_GOVERNANCE_CONTROL_2026_08_12_V1"));
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const MAJOR = 2;
const LZ_GAS = 500_000n;

const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function crossChainGovernance() view returns (address)",
  "function treasury() view returns (address)",
  "function specialNoFeeToken() view returns (address)",
  "function msgPriceAmountInToken() view returns (uint256)",
  "function createBurnAmountInToken() view returns (uint256)",
  "function upgradeToAndCall(address,bytes) payable",
]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
]);
const broadcasterAbi = parseAbi([
  "function governance() view returns (address)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
]);
const registryAbi = parseAbi([
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
]);

type ChainConfig = {
  label: "ETH" | "BSC" | "Base";
  id: 1 | 56 | 8453;
  factory: Address;
  executor?: Address;
  chainKey?: number;
  client: ReturnType<typeof createPublicClient>;
};

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ||= value;
  }
}

function rpc(name: string, fallback: string) {
  return process.env[name]?.trim() || fallback;
}

function privateKey(): Hex | undefined {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY?.trim()
    || process.env.BSC_MAINNET_PRIVATE_KEY?.trim()
    || process.env.BASE_MAINNET_PRIVATE_KEY?.trim()
    || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!raw) return undefined;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

function implementationAddress(word: Hex | undefined): Address {
  if (!word) return zeroAddress;
  return getAddress(`0x${word.slice(-40)}`);
}

function json(value: unknown) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

loadEnv();

const artifact = JSON.parse(
  readFileSync("artifacts/contracts/DealFactory.sol/DealFactory.json", "utf8"),
) as {
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, Array<{ start: number; length: number }>>;
};
if (!artifact.bytecode || artifact.bytecode === "0x") throw new Error("DealFactory artifact has no creation bytecode");

const creationCodeHash = keccak256(artifact.bytecode);
const runtimeCodeHash = keccak256(artifact.deployedBytecode);
const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
const predictedImplementation = getCreate2Address({
  from: CREATE2_DEPLOYER,
  salt: FACTORY_SALT,
  bytecodeHash: creationCodeHash,
});
function materializeRuntime(code: Hex, implementation: Address): Hex {
  let body = code.slice(2);
  const value = implementation.slice(2).toLowerCase().padStart(64, "0");
  for (const refs of Object.values(artifact.immutableReferences)) {
    for (const ref of refs) {
      if (ref.length !== 32) throw new Error(`Unexpected immutable length ${ref.length}`);
      const start = ref.start * 2;
      body = `${body.slice(0, start)}${value}${body.slice(start + ref.length * 2)}`;
    }
  }
  return `0x${body}` as Hex;
}
const expectedRuntimeCode = materializeRuntime(artifact.deployedBytecode, predictedImplementation);
const expectedRuntimeCodeHash = keccak256(expectedRuntimeCode);
const create2Calldata = concat([FACTORY_SALT, artifact.bytecode]);

const eth = createPublicClient({ chain: mainnet, transport: http(rpc("ETH_MAINNET_RPC_URL", "https://eth-mainnet.public.blastapi.io"), { timeout: 30_000 }) });
const bscClient = createPublicClient({ chain: bsc, transport: http(rpc("BSC_MAINNET_RPC_URL", "https://bsc-mainnet.public.blastapi.io"), { timeout: 30_000 }) });
const baseClient = createPublicClient({ chain: base, transport: http(rpc("BASE_MAINNET_RPC_URL", "https://base-mainnet.public.blastapi.io"), { timeout: 30_000 }) });

const chains: ChainConfig[] = [
  { label: "ETH", id: 1, factory: getAddress("0x02330431f96b21776274f3147bd4c233caf7d752"), client: eth },
  { label: "BSC", id: 56, factory: getAddress("0x1Ca748Feb347d0d177E844E7D4CDCA908957c256"), executor: getAddress("0x407381d841DD48bBBd40Bd37f9dB268CE75950A8"), chainKey: 30_102, client: bscClient },
  { label: "Base", id: 8453, factory: getAddress("0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D"), executor: getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218"), chainKey: 30_184, client: baseClient },
];

const key = privateKey();
const signer = key ? privateKeyToAccount(key) : undefined;
const upgradeCalldata = encodeFunctionData({
  abi: factoryAbi,
  functionName: "upgradeToAndCall",
  args: [predictedImplementation, "0x"],
});
const destinationChains = chains.filter((chain) => chain.executor);
const broadcastCalldata = encodeFunctionData({
  abi: broadcasterAbi,
  functionName: "broadcast",
  args: [
    destinationChains.map((chain) => chain.chainKey!),
    destinationChains.map((chain) => chain.factory),
    upgradeCalldata,
    LZ_GAS,
  ],
});

const deployerCodes = await Promise.all(chains.map(async (chain) => {
  if (await chain.client.getChainId() !== chain.id) throw new Error(`${chain.label} RPC chain mismatch`);
  const code = await chain.client.getCode({ address: CREATE2_DEPLOYER });
  return { label: chain.label, present: Boolean(code && code !== "0x"), codeHash: code && code !== "0x" ? keccak256(code) : null };
}));
const deployerHashes = new Set(deployerCodes.map((item) => item.codeHash).filter(Boolean));

const chainStatus = await Promise.all(chains.map(async (chain) => {
  const [owner, admin, governance, treasury, specialNoFeeToken, messagePrice, createBurnAmount, slot, predictedCode, deployerBalance] = await Promise.all([
    chain.client.readContract({ address: chain.factory, abi: factoryAbi, functionName: "owner" }),
    chain.client.readContract({ address: chain.factory, abi: factoryAbi, functionName: "admin" }),
    chain.client.readContract({ address: chain.factory, abi: factoryAbi, functionName: "crossChainGovernance" }),
    chain.client.readContract({ address: chain.factory, abi: factoryAbi, functionName: "treasury" }),
    chain.client.readContract({ address: chain.factory, abi: factoryAbi, functionName: "specialNoFeeToken" }),
    chain.client.readContract({ address: chain.factory, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
    chain.client.readContract({ address: chain.factory, abi: factoryAbi, functionName: "createBurnAmountInToken" }),
    chain.client.getStorageAt({ address: chain.factory, slot: IMPLEMENTATION_SLOT }),
    chain.client.getCode({ address: predictedImplementation }),
    signer ? chain.client.getBalance({ address: signer.address }) : Promise.resolve(0n),
  ]);
  const predictedPresent = Boolean(predictedCode && predictedCode !== "0x");
  let deploymentGas: bigint | null = null;
  let deploymentEstimateError: string | null = null;
  if (signer && !predictedPresent) {
    try {
      deploymentGas = await chain.client.estimateGas({
        account: signer.address,
        to: CREATE2_DEPLOYER,
        data: create2Calldata,
      });
    } catch (error) {
      deploymentEstimateError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
  }
  let executor: unknown = null;
  if (chain.executor) {
    const [executorOwner, threshold, factoryAllowed] = await Promise.all([
      chain.client.readContract({ address: chain.executor, abi: executorAbi, functionName: "owner" }),
      chain.client.readContract({ address: chain.executor, abi: executorAbi, functionName: "threshold" }),
      chain.client.readContract({ address: chain.executor, abi: executorAbi, functionName: "allowedTargets", args: [chain.factory] }),
    ]);
    executor = { address: chain.executor, owner: executorOwner, threshold, factoryAllowed };
  }
  return {
    label: chain.label,
    blockNumber: await chain.client.getBlockNumber(),
    factory: chain.factory,
    currentImplementation: implementationAddress(slot),
    owner,
    admin,
    crossChainGovernance: governance,
    treasury,
    specialNoFeeToken,
    messagePrice,
    createBurnAmount,
    predictedImplementationPresent: predictedPresent,
    predictedImplementationCodeHash: predictedPresent ? keccak256(predictedCode!) : null,
    signerBalance: formatEther(deployerBalance),
    deploymentGas,
    deploymentEstimateError,
    executor,
  };
}));

const upgradeSelector = toFunctionSelector("upgradeToAndCall(address,bytes)");
const [broadcasterGovernance, broadcasterChainIds, bscRoute, baseRoute, bscRule, baseRule, quotedFee, exactActionAllowed] = await Promise.all([
  eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "governance" }),
  eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
  eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [30_102] }),
  eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [30_184] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, chains[1].factory, upgradeSelector] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, chains[2].factory, upgradeSelector] }),
  eth.readContract({
    address: BROADCASTER,
    abi: broadcasterAbi,
    functionName: "quoteFees",
    args: [destinationChains.map((chain) => chain.chainKey!), destinationChains.map((chain) => chain.factory), upgradeCalldata, LZ_GAS],
  }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, 0n, broadcastCalldata] }),
]);

const blockers: string[] = [];
if (!signer || getAddress(signer.address) !== OWNER) blockers.push("configured signer is missing or is not the expected 9893 owner");
if (runtimeBytes >= 24_576) blockers.push("runtime exceeds EIP-170");
if (deployerCodes.some((item) => !item.present) || deployerHashes.size !== 1) blockers.push("CREATE2 deployer is missing or differs across chains");
if (chainStatus.some((item) => getAddress(item.owner) !== (item.label === "Base" ? getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218") : OWNER))) blockers.push("Factory owner mismatch");
if (chainStatus.some((item) => item.predictedImplementationPresent && item.predictedImplementationCodeHash !== expectedRuntimeCodeHash)) blockers.push("predicted implementation address contains unexpected code");
if (chainStatus.some((item) => !item.predictedImplementationPresent && item.deploymentGas === null)) blockers.push("CREATE2 deployment gas estimation failed");
if (getAddress(broadcasterGovernance) !== GOVERNANCE || !bscRoute[6] || !baseRoute[6]) blockers.push("Broadcaster governance/routes mismatch");
if (destinationChains.some((chain) => !broadcasterChainIds.includes(chain.chainKey!))) blockers.push("Broadcaster active chain list mismatch");
if (!exactActionAllowed) blockers.push("exact cross-chain Factory upgrade action is not allowed by current DAO policy");

console.log(json({
  status: blockers.length === 0 ? "PASS" : "BLOCKED",
  readOnly: true,
  transactionSent: false,
  signer: signer?.address ?? null,
  artifact: { runtimeBytes, creationCodeHash, artifactRuntimeCodeHash: runtimeCodeHash, expectedRuntimeCodeHash },
  create2: { deployer: CREATE2_DEPLOYER, salt: FACTORY_SALT, predictedImplementation },
  upgrade: { selector: upgradeSelector, calldata: upgradeCalldata },
  broadcaster: {
    address: BROADCASTER,
    governance: broadcasterGovernance,
    chainIds: broadcasterChainIds,
    bscActive: bscRoute[6],
    baseActive: baseRoute[6],
    quotedFee,
    quotedFeeEth: formatEther(quotedFee),
    exactActionAllowed,
    broadcastCalldata,
    bscRule,
    baseRule,
  },
  create2Deployers: deployerCodes,
  chains: chainStatus,
  blockers,
}));
