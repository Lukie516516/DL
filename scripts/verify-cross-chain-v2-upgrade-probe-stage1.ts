/**
 * Independent read-only verification of the six stage-1 upgrade-probe deployments.
 *
 * No private key is loaded and no chain transaction can be sent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { bsc, mainnet } from "viem/chains";

const ROOT = process.cwd();
const STATE_FILE = join(
  ROOT,
  "deployments",
  "cross-chain-v2-upgrade-probe-stage1.json",
);
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  "cross-chain-v2-upgrade-probe-stage1-verification.json",
);
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const UPGRADE_SELECTOR = "0x4f1ef286" as Hex;
const ZERO_MARKER = `0x${"00".repeat(32)}` as Hex;

type Artifact = {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences?: Record<string, Array<{ start: number; length: number }>>;
};

type ContractRecord = {
  address: Address;
  nonce: number;
  txHash: Hex;
  blockNumber: string;
  gasUsed: string;
  verified: boolean;
};

type ChainRecord = {
  chainId: 1 | 56;
  controller: Address;
  v1Implementation: ContractRecord;
  proxy: ContractRecord;
  v2Implementation: ContractRecord;
  verified: boolean;
};

type DeploymentState = {
  schemaVersion: 1;
  scope: string;
  stage: string;
  signers: { eth: Address; bsc: Address };
  eth: ChainRecord;
  bsc: ChainRecord;
};

type CanonicalDeployment = {
  addresses: Record<string, Address>;
};

type CcipStage1 = {
  eth: { address: Address };
  bsc: { address: Address };
};

const probeAbi = parseAbi([
  "function initialize(address)",
  "function controller() view returns (address)",
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
  "function version() view returns (uint256)",
  "function proxiableUUID() view returns (bytes32)",
]);
const governanceAbi = parseAbi([
  "function proposalCount() view returns (uint256)",
]);
const broadcasterAbi = parseAbi([
  "function broadcastNonce() view returns (uint256)",
]);
const executorAbi = parseAbi([
  "function allowedTargets(address) view returns (bool)",
]);
const registryAbi = parseAbi([
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
]);

loadEnv();

function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] ||= match[2].trim();
    }
  } catch {}
}

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8")) as T;
}

function artifact(relativePath: string): Artifact {
  return loadJson<Artifact>(join("artifacts", "contracts", relativePath));
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function slotAddress(word: Hex | undefined): Address {
  if (!word || word.length !== 66) throw new Error("Implementation slot missing");
  return getAddress(`0x${word.slice(-40)}`);
}

function maskImmutables(
  bytecode: Hex,
  references: Artifact["immutableReferences"],
): string {
  const body = bytecode.slice(2).split("");
  for (const ranges of Object.values(references ?? {})) {
    for (const range of ranges) {
      for (let index = range.start; index < range.start + range.length; ++index) {
        body[index * 2] = "0";
        body[index * 2 + 1] = "0";
      }
    }
  }
  return body.join("");
}

function runtimeMatches(actual: Hex, expected: Artifact): boolean {
  return (
    actual.length === expected.deployedBytecode.length &&
    maskImmutables(actual, expected.immutableReferences) ===
      maskImmutables(expected.deployedBytecode, expected.immutableReferences)
  );
}

async function verifyTransaction(
  client: any,
  signer: Address,
  record: ContractRecord,
  expectedData: Hex,
) {
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: record.txHash }),
    client.getTransactionReceipt({ hash: record.txHash }),
  ]);
  if (
    receipt.status !== "success" ||
    !receipt.contractAddress ||
    !sameAddress(getAddress(receipt.contractAddress), record.address) ||
    !sameAddress(getAddress(tx.from), signer) ||
    tx.to !== null ||
    tx.nonce !== record.nonce ||
    tx.input.toLowerCase() !== expectedData.toLowerCase() ||
    tx.value !== 0n ||
    receipt.blockNumber.toString() !== record.blockNumber ||
    receipt.gasUsed.toString() !== record.gasUsed
  ) {
    throw new Error(`Deployment transaction mismatch: ${record.txHash}`);
  }
  return {
    txHash: record.txHash,
    nonce: tx.nonce,
    blockNumber: receipt.blockNumber,
    contractAddress: getAddress(receipt.contractAddress),
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    nativeCostWei: receipt.gasUsed * receipt.effectiveGasPrice,
    status: receipt.status,
    calldataHash: keccak256(tx.input),
  };
}

async function verifyChain(
  client: any,
  signer: Address,
  chain: ChainRecord,
  probeArtifact: Artifact,
  proxyArtifact: Artifact,
  upgradeArtifact: Artifact,
) {
  const initData = encodeFunctionData({
    abi: probeAbi,
    functionName: "initialize",
    args: [chain.controller],
  });
  const deployData = {
    v1Implementation: encodeDeployData({
      abi: probeArtifact.abi,
      bytecode: probeArtifact.bytecode,
    }),
    proxy: encodeDeployData({
      abi: proxyArtifact.abi,
      bytecode: proxyArtifact.bytecode,
      args: [chain.v1Implementation.address, initData],
    }),
    v2Implementation: encodeDeployData({
      abi: upgradeArtifact.abi,
      bytecode: upgradeArtifact.bytecode,
    }),
  };
  const [
    v1Tx,
    proxyTx,
    v2Tx,
    v1Code,
    proxyCode,
    v2Code,
    implementationWord,
    controller,
    marker,
    updateCount,
    proxyVersion,
    v1Uuid,
    v2Uuid,
    v2Version,
  ] = await Promise.all([
    verifyTransaction(
      client,
      signer,
      chain.v1Implementation,
      deployData.v1Implementation,
    ),
    verifyTransaction(client, signer, chain.proxy, deployData.proxy),
    verifyTransaction(
      client,
      signer,
      chain.v2Implementation,
      deployData.v2Implementation,
    ),
    client.getCode({ address: chain.v1Implementation.address }),
    client.getCode({ address: chain.proxy.address }),
    client.getCode({ address: chain.v2Implementation.address }),
    client.getStorageAt({ address: chain.proxy.address, slot: IMPLEMENTATION_SLOT }),
    client.readContract({
      address: chain.proxy.address,
      abi: probeAbi,
      functionName: "controller",
    }),
    client.readContract({
      address: chain.proxy.address,
      abi: probeAbi,
      functionName: "marker",
    }),
    client.readContract({
      address: chain.proxy.address,
      abi: probeAbi,
      functionName: "updateCount",
    }),
    client.readContract({
      address: chain.proxy.address,
      abi: probeAbi,
      functionName: "version",
    }),
    client.readContract({
      address: chain.v1Implementation.address,
      abi: probeAbi,
      functionName: "proxiableUUID",
    }),
    client.readContract({
      address: chain.v2Implementation.address,
      abi: probeAbi,
      functionName: "proxiableUUID",
    }),
    client.readContract({
      address: chain.v2Implementation.address,
      abi: probeAbi,
      functionName: "version",
    }),
  ]);
  if (
    !v1Code ||
    !proxyCode ||
    !v2Code ||
    !runtimeMatches(v1Code, probeArtifact) ||
    !runtimeMatches(proxyCode, proxyArtifact) ||
    !runtimeMatches(v2Code, upgradeArtifact)
  ) {
    throw new Error(`Runtime bytecode mismatch on chain ${chain.chainId}`);
  }
  if (
    !sameAddress(slotAddress(implementationWord), chain.v1Implementation.address) ||
    !sameAddress(getAddress(controller), chain.controller) ||
    marker !== ZERO_MARKER ||
    updateCount !== 0n ||
    proxyVersion !== 1n ||
    String(v1Uuid).toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase() ||
    String(v2Uuid).toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase() ||
    v2Version !== 2n
  ) {
    throw new Error(`Proxy/UUPS/state mismatch on chain ${chain.chainId}`);
  }
  return {
    chainId: chain.chainId,
    signer,
    controller: getAddress(controller),
    proxyImplementation: slotAddress(implementationWord),
    proxyVersion,
    marker,
    updateCount,
    v2ImplementationVersion: v2Version,
    runtimeHashes: {
      v1Implementation: keccak256(v1Code),
      proxy: keccak256(proxyCode),
      v2Implementation: keccak256(v2Code),
    },
    transactions: [v1Tx, proxyTx, v2Tx],
    totalNativeCostWei:
      v1Tx.nativeCostWei + proxyTx.nativeCostWei + v2Tx.nativeCostWei,
  };
}

async function main() {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as DeploymentState;
  if (state.stage !== "both_deployed") {
    throw new Error(`Unexpected deployment stage: ${state.stage}`);
  }
  const ethDeployment = loadJson<CanonicalDeployment>(
    "deployments/eth-mainnet-1.json",
  );
  const ccipStage1 = loadJson<CcipStage1>(
    "deployments/ccip-v2-mainnet-stage1.json",
  );
  const governance = getAddress(ethDeployment.addresses.dealGovernance);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const broadcaster = getAddress(ccipStage1.eth.address);
  const executor = getAddress(ccipStage1.bsc.address);

  const ethClient = createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.ETH_MAINNET_RPC_URL?.trim() ||
        "https://ethereum-rpc.publicnode.com",
    ),
  });
  const bscClient = createPublicClient({
    chain: bsc,
    transport: http(
      process.env.BSC_MAINNET_RPC_URL?.trim() ||
        "https://bsc-mainnet.public.blastapi.io",
    ),
  });
  const probeArtifact = artifact(
    "GovernanceProbe.sol/GovernanceProbe.json",
  );
  const proxyArtifact = artifact("TestProxy.sol/ERC1967Proxy.json");
  const upgradeArtifact = artifact(
    "test/GovernanceProbeUpgradeMock.sol/GovernanceProbeUpgradeMock.json",
  );

  const [
    ethBlock,
    bscBlock,
    eth,
    bscResult,
    proposalCount,
    broadcastNonce,
    bscAllowlisted,
    ethRule,
    bscRule,
  ] = await Promise.all([
    ethClient.getBlockNumber(),
    bscClient.getBlockNumber(),
    verifyChain(
      ethClient,
      getAddress(state.signers.eth),
      state.eth,
      probeArtifact,
      proxyArtifact,
      upgradeArtifact,
    ),
    verifyChain(
      bscClient,
      getAddress(state.signers.bsc),
      state.bsc,
      probeArtifact,
      proxyArtifact,
      upgradeArtifact,
    ),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [state.bsc.proxy.address],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [2, state.eth.proxy.address, UPGRADE_SELECTOR],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [2, state.bsc.proxy.address, UPGRADE_SELECTOR],
    }),
  ]);
  if (bscAllowlisted || ethRule[0] || bscRule[0]) {
    throw new Error("Unexpected allowlist or DAO policy write");
  }

  const output = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    readOnly: true,
    transactionSentByVerification: false,
    sourceDeployment: "deployments/cross-chain-v2-upgrade-probe-stage1.json",
    snapshot: {
      ethBlock,
      bscBlock,
      proposalCount,
      broadcastNonce,
    },
    eth,
    bsc: bscResult,
    scopeGuards: {
      bscAllowlisted,
      ethUpgradePolicyAllowed: ethRule[0],
      bscUpgradePolicyAllowed: bscRule[0],
      daoProposalCreatedByStage1: false,
      crossChainBroadcastSentByStage1: false,
      proxyUpgradePerformedByStage1: false,
    },
    result: {
      allSixReceiptsSuccessful: true,
      allSixCreateCalldataMatched: true,
      allSixRuntimeBytecodesMatched: true,
      bothProxyControllersMatched: true,
      bothProxiesStillOnV1: true,
      bothV2ImplementationsReady: true,
      deploymentScopeRespected: true,
    },
  };
  const rendered = `${stringify(output)}\n`;
  writeFileSync(OUTPUT_FILE, rendered, "utf8");
  process.stdout.write(rendered);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
