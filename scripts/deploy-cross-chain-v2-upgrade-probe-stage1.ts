/**
 * Stage 1 only: deploy fresh asset-free UUPS upgrade probes on ETH and BSC.
 *
 * Per chain, and only in this order:
 *   1. GovernanceProbe V1 implementation
 *   2. ERC1967Proxy initialized with the chain controller
 *   3. GovernanceProbeUpgradeMock V2 implementation
 *
 * This script has no allowlist, token, DAO proposal, stake, execute, upgrade,
 * Git commit, or Git push path.
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/deploy-cross-chain-v2-upgrade-probe-stage1.ts --preflight
 *
 * Explicit write gate:
 *   CROSS_CHAIN_V2_UPGRADE_PROBE_DEPLOY_CONFIRM=DEPLOY_ASSET_FREE_UPGRADE_PROBES_ON_ETH_AND_BSC \
 *     node --import tsx/esm scripts/deploy-cross-chain-v2-upgrade-probe-stage1.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  http,
  parseAbi,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";

const ROOT = process.cwd();
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  "cross-chain-v2-upgrade-probe-stage1.json",
);
const WRITE_CONFIRM = "DEPLOY_ASSET_FREE_UPGRADE_PROBES_ON_ETH_AND_BSC";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ZERO_MARKER = `0x${"00".repeat(32)}` as Hex;
const MIN_BALANCE = parseEther("0.003");
const SCOPE =
  "deploy six asset-free probe contracts only; no allowlist, token, proposal, stake, execute or upgrade";

type Artifact = {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences?: Record<string, Array<{ start: number; length: number }>>;
};

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type Stage1 = {
  stage: string;
  signers: { eth: Address; bsc: Address };
  eth: { address: Address; verified: boolean };
  bsc: { address: Address; verified: boolean };
};

type ContractRecord = {
  address: Address;
  nonce: number;
  txHash?: Hex;
  blockNumber?: string;
  gasUsed?: string;
  verified?: boolean;
};

type ChainRecord = {
  chainId: 1 | 56;
  controller: Address;
  v1Implementation: ContractRecord;
  proxy: ContractRecord;
  v2Implementation: ContractRecord;
  verified?: boolean;
};

type DeploymentState = {
  schemaVersion: 1;
  scope: string;
  stage:
    | "prepared"
    | "eth_partial"
    | "eth_deployed"
    | "bsc_partial"
    | "both_deployed";
  startedAt: string;
  updatedAt: string;
  signers: { eth: Address; bsc: Address };
  eth: ChainRecord;
  bsc: ChainRecord;
  verification?: {
    ethProxyImplementation: Address;
    bscProxyImplementation: Address;
    ethController: Address;
    bscController: Address;
    ethVersion: string;
    bscVersion: string;
    bscAllowlisted: boolean;
    ethPolicyAllowed: boolean;
    bscPolicyAllowed: boolean;
    transactionCount: number;
  };
};

const probeAbi = parseAbi([
  "function initialize(address)",
  "function controller() view returns (address)",
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
  "function version() view returns (uint256)",
  "function proxiableUUID() view returns (bytes32)",
]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function allowedTargets(address) view returns (bool)",
]);
const broadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
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

function privateKey(primary: string, fallback: string): Hex {
  const raw = process.env[primary]?.trim() || process.env[fallback]?.trim();
  if (!raw) throw new Error(`Missing ${primary} and fallback ${fallback}`);
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function save(state: DeploymentState) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(OUTPUT_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

async function assertRuntime(
  client: any,
  label: string,
  address: Address,
  expected: Artifact,
) {
  const code = (await client.getCode({ address })) as Hex | undefined;
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
  if (code.length !== expected.deployedBytecode.length) {
    throw new Error(`${label} runtime length mismatch`);
  }
  if (
    maskImmutables(code, expected.immutableReferences) !==
    maskImmutables(expected.deployedBytecode, expected.immutableReferences)
  ) {
    throw new Error(`${label} runtime bytecode mismatch`);
  }
}

async function nonceState(client: any, address: Address) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { latest: Number(latest), pending: Number(pending) };
}

async function assertEmpty(client: any, label: string, address: Address) {
  const code = await client.getCode({ address });
  if (code && code !== "0x") throw new Error(`${label} already has code at ${address}`);
}

async function ensureDeployment(args: {
  chainLabel: "ETH" | "BSC";
  client: any;
  wallet: any;
  account: ReturnType<typeof privateKeyToAccount>;
  artifact: Artifact;
  constructorArgs?: readonly unknown[];
  record: ContractRecord;
  confirmations: number;
  state: DeploymentState;
  partialStage: "eth_partial" | "bsc_partial";
}) {
  const {
    chainLabel,
    client,
    wallet,
    account,
    artifact: artifact_,
    constructorArgs = [],
    record,
    confirmations,
    state,
    partialStage,
  } = args;

  let code = await client.getCode({ address: record.address });
  if (!code || code === "0x") {
    const nonce = await nonceState(client, account.address);
    if (nonce.latest !== record.nonce || nonce.pending !== record.nonce) {
      throw new Error(
        `${chainLabel} nonce mismatch before ${record.address}: ${nonce.latest}/${nonce.pending}, expected ${record.nonce}`,
      );
    }
    const hash = await wallet.deployContract({
      account,
      abi: artifact_.abi,
      bytecode: artifact_.bytecode,
      args: constructorArgs,
      nonce: record.nonce,
    });
    record.txHash = hash;
    state.stage = partialStage;
    save(state);
    console.log(`${chainLabel} submitted nonce=${record.nonce}: ${hash}`);

    const receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations,
      timeout: 300_000,
    });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`${chainLabel} deployment failed: ${hash}`);
    }
    if (!sameAddress(getAddress(receipt.contractAddress), record.address)) {
      throw new Error(
        `${chainLabel} contract address mismatch: ${receipt.contractAddress} != ${record.address}`,
      );
    }
    record.blockNumber = receipt.blockNumber.toString();
    record.gasUsed = receipt.gasUsed.toString();
    save(state);
    code = await client.getCode({ address: record.address });
  }
  await assertRuntime(client, `${chainLabel} deployment`, record.address, artifact_);
  record.verified = true;
  save(state);
}

async function verifyChain(
  client: any,
  label: "ETH" | "BSC",
  chain: ChainRecord,
  probeArtifact: Artifact,
  proxyArtifact: Artifact,
  upgradeArtifact: Artifact,
) {
  await Promise.all([
    assertRuntime(
      client,
      `${label} GovernanceProbe V1`,
      chain.v1Implementation.address,
      probeArtifact,
    ),
    assertRuntime(
      client,
      `${label} ERC1967Proxy`,
      chain.proxy.address,
      proxyArtifact,
    ),
    assertRuntime(
      client,
      `${label} GovernanceProbe V2`,
      chain.v2Implementation.address,
      upgradeArtifact,
    ),
  ]);
  const [slot, controller, marker, count, proxyVersion, v1Uuid, v2Uuid, v2Version] =
    await Promise.all([
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
  if (!sameAddress(slotAddress(slot), chain.v1Implementation.address)) {
    throw new Error(`${label} proxy implementation slot mismatch`);
  }
  if (!sameAddress(getAddress(controller), chain.controller)) {
    throw new Error(`${label} proxy controller mismatch`);
  }
  if (marker !== ZERO_MARKER || count !== 0n || proxyVersion !== 1n) {
    throw new Error(
      `${label} unexpected initial state: marker=${marker}, count=${count}, version=${proxyVersion}`,
    );
  }
  if (
    String(v1Uuid).toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase() ||
    String(v2Uuid).toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase() ||
    v2Version !== 2n
  ) {
    throw new Error(`${label} UUPS/V2 verification mismatch`);
  }
  chain.verified = true;
  return {
    implementation: slotAddress(slot),
    controller: getAddress(controller),
    version: proxyVersion,
  };
}

async function main() {
  const preflightOnly = process.argv.includes("--preflight");
  if (
    !preflightOnly &&
    process.env.CROSS_CHAIN_V2_UPGRADE_PROBE_DEPLOY_CONFIRM !== WRITE_CONFIRM
  ) {
    throw new Error(
      `Write gate closed: set CROSS_CHAIN_V2_UPGRADE_PROBE_DEPLOY_CONFIRM=${WRITE_CONFIRM}`,
    );
  }

  const ethDeployment = loadJson<Deployment>("deployments/eth-mainnet-1.json");
  const bscDeployment = loadJson<Deployment>("deployments/bsc-mainnet-56.json");
  const ccipStage1 = loadJson<Stage1>("deployments/ccip-v2-mainnet-stage1.json");
  if (
    ethDeployment.chainId !== 1 ||
    bscDeployment.chainId !== 56 ||
    ccipStage1.stage !== "both_deployed" ||
    !ccipStage1.eth.verified ||
    !ccipStage1.bsc.verified
  ) {
    throw new Error("Canonical ETH/BSC/CCIP V2 deployment records are invalid");
  }

  const governance = getAddress(ethDeployment.addresses.dealGovernance);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const broadcaster = getAddress(ccipStage1.eth.address);
  const executor = getAddress(ccipStage1.bsc.address);
  const ethExpectedSigner = getAddress(ethDeployment.deployer);
  const bscExpectedSigner = getAddress(bscDeployment.deployer);
  const ethAccount = privateKeyToAccount(
    privateKey("ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"),
  );
  const bscAccount = privateKeyToAccount(
    privateKey("BSC_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"),
  );
  if (!sameAddress(ethAccount.address, ethExpectedSigner)) {
    throw new Error(`ETH signer mismatch: ${ethAccount.address}`);
  }
  if (!sameAddress(bscAccount.address, bscExpectedSigner)) {
    throw new Error(`BSC signer mismatch: ${bscAccount.address}`);
  }
  if (
    !sameAddress(getAddress(ccipStage1.signers.eth), ethAccount.address) ||
    !sameAddress(getAddress(ccipStage1.signers.bsc), bscAccount.address)
  ) {
    throw new Error("CCIP V2 signer records do not match active signers");
  }

  const ethRpc =
    process.env.ETH_MAINNET_RPC_URL?.trim() ||
    "https://ethereum-rpc.publicnode.com";
  const bscRpc =
    process.env.BSC_MAINNET_RPC_URL?.trim() ||
    "https://bsc-mainnet.public.blastapi.io";
  const ethClient = createPublicClient({
    chain: mainnet,
    transport: http(ethRpc),
  });
  const bscClient = createPublicClient({
    chain: bsc,
    transport: http(bscRpc),
  });
  const ethWallet = createWalletClient({
    account: ethAccount,
    chain: mainnet,
    transport: http(ethRpc),
  });
  const bscWallet = createWalletClient({
    account: bscAccount,
    chain: bsc,
    transport: http(bscRpc),
  });

  const [
    ethChainId,
    bscChainId,
    ethNonce,
    bscNonce,
    ethBalance,
    bscBalance,
    broadcasterOwner,
    broadcasterGovernance,
    executorOwner,
  ] = await Promise.all([
    ethClient.getChainId(),
    bscClient.getChainId(),
    nonceState(ethClient, ethAccount.address),
    nonceState(bscClient, bscAccount.address),
    ethClient.getBalance({ address: ethAccount.address }),
    bscClient.getBalance({ address: bscAccount.address }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "owner",
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "governance",
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "owner",
    }),
  ]);
  if (ethChainId !== 1 || bscChainId !== 56) {
    throw new Error(`RPC chain mismatch: ${ethChainId}/${bscChainId}`);
  }
  if (ethBalance < MIN_BALANCE || bscBalance < MIN_BALANCE) {
    throw new Error(`Insufficient deployer balance: ${ethBalance}/${bscBalance}`);
  }
  if (
    !sameAddress(getAddress(broadcasterOwner), ethAccount.address) ||
    !sameAddress(getAddress(broadcasterGovernance), governance) ||
    !sameAddress(getAddress(executorOwner), bscAccount.address)
  ) {
    throw new Error("Current V2 owner/governance wiring mismatch");
  }

  const probeArtifact = artifact(
    "GovernanceProbe.sol/GovernanceProbe.json",
  );
  const proxyArtifact = artifact("TestProxy.sol/ERC1967Proxy.json");
  const upgradeArtifact = artifact(
    "test/GovernanceProbeUpgradeMock.sol/GovernanceProbeUpgradeMock.json",
  );

  let state: DeploymentState;
  if (existsSync(OUTPUT_FILE)) {
    state = JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as DeploymentState;
    if (
      state.scope !== SCOPE ||
      !sameAddress(state.signers.eth, ethAccount.address) ||
      !sameAddress(state.signers.bsc, bscAccount.address) ||
      !sameAddress(state.eth.controller, governance) ||
      !sameAddress(state.bsc.controller, executor)
    ) {
      throw new Error("Existing upgrade-probe state does not match this deployment");
    }
  } else {
    if (
      ethNonce.latest !== ethNonce.pending ||
      bscNonce.latest !== bscNonce.pending
    ) {
      throw new Error(
        `Pending nonce detected: ETH=${ethNonce.latest}/${ethNonce.pending}, BSC=${bscNonce.latest}/${bscNonce.pending}`,
      );
    }
    const ethStart = ethNonce.pending;
    const bscStart = bscNonce.pending;
    state = {
      schemaVersion: 1,
      scope: SCOPE,
      stage: "prepared",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      signers: { eth: ethAccount.address, bsc: bscAccount.address },
      eth: {
        chainId: 1,
        controller: governance,
        v1Implementation: {
          nonce: ethStart,
          address: getContractAddress({
            from: ethAccount.address,
            nonce: BigInt(ethStart),
          }),
        },
        proxy: {
          nonce: ethStart + 1,
          address: getContractAddress({
            from: ethAccount.address,
            nonce: BigInt(ethStart + 1),
          }),
        },
        v2Implementation: {
          nonce: ethStart + 2,
          address: getContractAddress({
            from: ethAccount.address,
            nonce: BigInt(ethStart + 2),
          }),
        },
      },
      bsc: {
        chainId: 56,
        controller: executor,
        v1Implementation: {
          nonce: bscStart,
          address: getContractAddress({
            from: bscAccount.address,
            nonce: BigInt(bscStart),
          }),
        },
        proxy: {
          nonce: bscStart + 1,
          address: getContractAddress({
            from: bscAccount.address,
            nonce: BigInt(bscStart + 1),
          }),
        },
        v2Implementation: {
          nonce: bscStart + 2,
          address: getContractAddress({
            from: bscAccount.address,
            nonce: BigInt(bscStart + 2),
          }),
        },
      },
    };
  }

  if (state.stage === "prepared") {
    await Promise.all([
      assertEmpty(
        ethClient,
        "ETH V1 implementation",
        state.eth.v1Implementation.address,
      ),
      assertEmpty(ethClient, "ETH proxy", state.eth.proxy.address),
      assertEmpty(
        ethClient,
        "ETH V2 implementation",
        state.eth.v2Implementation.address,
      ),
      assertEmpty(
        bscClient,
        "BSC V1 implementation",
        state.bsc.v1Implementation.address,
      ),
      assertEmpty(bscClient, "BSC proxy", state.bsc.proxy.address),
      assertEmpty(
        bscClient,
        "BSC V2 implementation",
        state.bsc.v2Implementation.address,
      ),
    ]);
  }

  console.log(
    JSON.stringify(
      {
        preflightOnly,
        signers: state.signers,
        ethNonce,
        bscNonce,
        eth: state.eth,
        bsc: state.bsc,
      },
      null,
      2,
    ),
  );
  if (preflightOnly) {
    console.log("Preflight passed. No transaction was signed or sent.");
    return;
  }

  if (!existsSync(OUTPUT_FILE)) save(state);

  await ensureDeployment({
    chainLabel: "ETH",
    client: ethClient,
    wallet: ethWallet,
    account: ethAccount,
    artifact: probeArtifact,
    record: state.eth.v1Implementation,
    confirmations: 2,
    state,
    partialStage: "eth_partial",
  });
  const ethInit = encodeFunctionData({
    abi: probeAbi,
    functionName: "initialize",
    args: [governance],
  });
  await ensureDeployment({
    chainLabel: "ETH",
    client: ethClient,
    wallet: ethWallet,
    account: ethAccount,
    artifact: proxyArtifact,
    constructorArgs: [state.eth.v1Implementation.address, ethInit],
    record: state.eth.proxy,
    confirmations: 2,
    state,
    partialStage: "eth_partial",
  });
  await ensureDeployment({
    chainLabel: "ETH",
    client: ethClient,
    wallet: ethWallet,
    account: ethAccount,
    artifact: upgradeArtifact,
    record: state.eth.v2Implementation,
    confirmations: 2,
    state,
    partialStage: "eth_partial",
  });
  const ethVerified = await verifyChain(
    ethClient,
    "ETH",
    state.eth,
    probeArtifact,
    proxyArtifact,
    upgradeArtifact,
  );
  state.stage = "eth_deployed";
  save(state);

  await ensureDeployment({
    chainLabel: "BSC",
    client: bscClient,
    wallet: bscWallet,
    account: bscAccount,
    artifact: probeArtifact,
    record: state.bsc.v1Implementation,
    confirmations: 3,
    state,
    partialStage: "bsc_partial",
  });
  const bscInit = encodeFunctionData({
    abi: probeAbi,
    functionName: "initialize",
    args: [executor],
  });
  await ensureDeployment({
    chainLabel: "BSC",
    client: bscClient,
    wallet: bscWallet,
    account: bscAccount,
    artifact: proxyArtifact,
    constructorArgs: [state.bsc.v1Implementation.address, bscInit],
    record: state.bsc.proxy,
    confirmations: 3,
    state,
    partialStage: "bsc_partial",
  });
  await ensureDeployment({
    chainLabel: "BSC",
    client: bscClient,
    wallet: bscWallet,
    account: bscAccount,
    artifact: upgradeArtifact,
    record: state.bsc.v2Implementation,
    confirmations: 3,
    state,
    partialStage: "bsc_partial",
  });
  const bscVerified = await verifyChain(
    bscClient,
    "BSC",
    state.bsc,
    probeArtifact,
    proxyArtifact,
    upgradeArtifact,
  );

  const upgradeSelector = "0x4f1ef286" as Hex;
  const [bscAllowlisted, ethRule, bscRule] = await Promise.all([
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
      args: [2, state.eth.proxy.address, upgradeSelector],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [2, state.bsc.proxy.address, upgradeSelector],
    }),
  ]);
  const ethPolicyAllowed = ethRule[0];
  const bscPolicyAllowed = bscRule[0];
  if (bscAllowlisted || ethPolicyAllowed || bscPolicyAllowed) {
    throw new Error(
      `Deployment scope exceeded: allowlisted=${bscAllowlisted}, ethPolicy=${ethPolicyAllowed}, bscPolicy=${bscPolicyAllowed}`,
    );
  }

  state.stage = "both_deployed";
  state.verification = {
    ethProxyImplementation: ethVerified.implementation,
    bscProxyImplementation: bscVerified.implementation,
    ethController: ethVerified.controller,
    bscController: bscVerified.controller,
    ethVersion: ethVerified.version.toString(),
    bscVersion: bscVerified.version.toString(),
    bscAllowlisted,
    ethPolicyAllowed,
    bscPolicyAllowed,
    transactionCount: 6,
  };
  save(state);
  console.log(JSON.stringify(state, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
