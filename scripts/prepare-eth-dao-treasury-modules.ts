/**
 * ETH mainnet SatoshiVault + DealDividendVault UUPS preparation script.
 *
 * Default: read-only dry-run.
 *
 * Deploy two implementations and two ERC1967 proxies:
 *   DAO_TREASURY_MODULES_MAINNET_DEPLOY_CONFIRM=DEPLOY_DAO_TREASURY_MODULES_ON_ETHEREUM_MAINNET
 *
 * Approve exactly one Major proposal fee (approval only, never mints DC):
 *   DAO_TREASURY_MODULES_FEE_APPROVE_CONFIRM=APPROVE_DAO_TREASURY_MODULE_RULES_FEE
 *
 * Create the Major proposal that adds four exact rules:
 *   DAO_TREASURY_MODULES_MAINNET_PROPOSE_CONFIRM=CREATE_DAO_TREASURY_MODULE_RULES_PROPOSAL
 *
 * All three write modes are mutually exclusive. This script has no stake or
 * execute path.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { network } from "hardhat";
import {
  encodeFunctionData,
  formatEther,
  getAddress,
  getContractAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

import {
  buildDaoV2PolicyRules,
  buildDaoV2TreasuryModuleRules,
  DAO_V2_PROPOSAL_KIND,
} from "./dao-v2-policy.js";
import { assertArtifactRuntime } from "./deployed-runtime-code.js";

const ETH_DEPLOYMENT_FILE = "deployments/eth-mainnet-1.json";
const CROSS_CHAIN_DEPLOYMENT_FILE = "deployments/mainnet-cross-chain.json";
const DEPLOY_CONFIRM = "DEPLOY_DAO_TREASURY_MODULES_ON_ETHEREUM_MAINNET";
const APPROVE_CONFIRM = "APPROVE_DAO_TREASURY_MODULE_RULES_FEE";
const PROPOSE_CONFIRM = "CREATE_DAO_TREASURY_MODULE_RULES_PROPOSAL";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};
type CrossChainDeployment = {
  params: { bscDealFactory: Address };
};

const governanceAbi = parseAbi([
  "function dToken() view returns (address)",
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const registryAbi = parseAbi([
  "event RuleUpdated(uint8 indexed kind,address indexed target,bytes4 indexed selector,bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns ((bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue))",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
  "function setRules((uint8 kind,address target,bytes4 selector,bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)[])"
]);
const treasuryAbi = parseAbi([
  "function controller() view returns (address)",
  "function bootstrapLocked() view returns (bool)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const satoshiAbi = parseAbi([
  "function initialize(address,address)",
  "function dealCoin() view returns (address)",
  "function controller() view returns (address)",
]);
const dividendAbi = parseAbi([
  "function initialize(address,address,address)",
  "function dToken() view returns (address)",
  "function dealCoin() view returns (address)",
  "function governance() view returns (address)",
  "function roundsCount() view returns (uint256)",
  "function reservedUnclaimed() view returns (uint256)",
]);
const uupsAbi = parseAbi(["function proxiableUUID() view returns (bytes32)"]);

function loadDeployment(): Deployment {
  return JSON.parse(readFileSync(join(process.cwd(), ETH_DEPLOYMENT_FILE), "utf8")) as Deployment;
}

function loadCrossChainDeployment(): CrossChainDeployment {
  return JSON.parse(
    readFileSync(join(process.cwd(), CROSS_CHAIN_DEPLOYMENT_FILE), "utf8"),
  ) as CrossChainDeployment;
}

function envAddress(name: string): Address | undefined {
  const value = process.env[name]?.trim();
  return value ? getAddress(value) : undefined;
}

function sameAddress(a: unknown, b: Address): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function slotAddress(word: Hex | undefined): Address {
  if (!word || word.length !== 66) throw new Error("Implementation slot missing");
  return getAddress(`0x${word.slice(-40)}`);
}

async function assertCode(client: any, label: string, address: Address): Promise<void> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

async function assertUupsImplementation(client: any, label: string, address: Address): Promise<void> {
  await assertCode(client, label, address);
  const uuid = await client.readContract({ address, abi: uupsAbi, functionName: "proxiableUUID" });
  if (String(uuid).toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase()) {
    throw new Error(`${label} has unexpected proxiableUUID ${uuid}`);
  }
}

function assertRuleMatches(label: string, actual: any, expected: any): void {
  for (const key of ["allowed", "validateNestedBroadcast", "nestedOnly", "maxValue"] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${label}.${key} mismatch: expected ${String(expected[key])}, got ${String(actual[key])}`,
      );
    }
  }
}

async function assertBaselinePolicy(
  client: any,
  registry: Address,
  addresses: {
    governance: Address;
    dealFactory: Address;
    crossChainBroadcaster: Address;
    protocolTreasury: Address;
    bscDealFactory: Address;
  },
): Promise<number> {
  const expectedRules = buildDaoV2PolicyRules({
    ...addresses,
    policyRegistry: registry,
  });
  const actualRules = await Promise.all(
    expectedRules.map((rule) =>
      client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [rule.kind, rule.target, rule.selector],
      }),
    ),
  );
  expectedRules.forEach((expected, index) =>
    assertRuleMatches(`Baseline rule ${index + 1} (${expected.label})`, actualRules[index], expected),
  );
  return expectedRules.length;
}

async function nonceState(client: any, address: Address) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { latest, pending };
}

async function waitFor(client: any, hash: Hex, label: string) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  OK ${label}: ${hash}`);
  return receipt;
}

function artifactSize(contractName: string): { creation: number; runtime: number } {
  const artifact = JSON.parse(
    readFileSync(
      join(process.cwd(), "artifacts", "contracts", `${contractName}.sol`, `${contractName}.json`),
      "utf8",
    ),
  ) as { bytecode: Hex; deployedBytecode: Hex };
  return {
    creation: (artifact.bytecode.length - 2) / 2,
    runtime: (artifact.deployedBytecode.length - 2) / 2,
  };
}

async function verifyModules(
  client: any,
  expected: {
    governance: Address;
    d: Address;
    dc: Address;
    satoshiImplementation: Address;
    satoshiProxy: Address;
    dividendImplementation: Address;
    dividendProxy: Address;
  },
): Promise<void> {
  const cwd = process.cwd();
  await assertArtifactRuntime(
    client,
    "SatoshiVault implementation",
    expected.satoshiImplementation,
    cwd,
    "artifacts/contracts/SatoshiVault.sol/SatoshiVault.json",
  );
  await assertArtifactRuntime(
    client,
    "DealDividendVault implementation",
    expected.dividendImplementation,
    cwd,
    "artifacts/contracts/DealDividendVault.sol/DealDividendVault.json",
  );
  await assertArtifactRuntime(
    client,
    "SatoshiVault ERC1967Proxy",
    expected.satoshiProxy,
    cwd,
    "artifacts/contracts/TestProxy.sol/ERC1967Proxy.json",
  );
  await assertArtifactRuntime(
    client,
    "DealDividendVault ERC1967Proxy",
    expected.dividendProxy,
    cwd,
    "artifacts/contracts/TestProxy.sol/ERC1967Proxy.json",
  );
  await assertUupsImplementation(
    client,
    "SatoshiVault implementation",
    expected.satoshiImplementation,
  );
  await assertUupsImplementation(
    client,
    "DealDividendVault implementation",
    expected.dividendImplementation,
  );
  await assertCode(client, "SatoshiVault proxy", expected.satoshiProxy);
  await assertCode(client, "DealDividendVault proxy", expected.dividendProxy);
  const [satoshiSlot, dividendSlot] = await Promise.all([
    client.getStorageAt({ address: expected.satoshiProxy, slot: IMPLEMENTATION_SLOT }),
    client.getStorageAt({ address: expected.dividendProxy, slot: IMPLEMENTATION_SLOT }),
  ]);
  if (slotAddress(satoshiSlot) !== expected.satoshiImplementation) {
    throw new Error("SatoshiVault proxy implementation mismatch");
  }
  if (slotAddress(dividendSlot) !== expected.dividendImplementation) {
    throw new Error("DealDividendVault proxy implementation mismatch");
  }
  const [satoshiDc, satoshiController, dividendD, dividendDc, dividendGovernance, rounds, reserved] =
    await Promise.all([
      client.readContract({ address: expected.satoshiProxy, abi: satoshiAbi, functionName: "dealCoin" }),
      client.readContract({ address: expected.satoshiProxy, abi: satoshiAbi, functionName: "controller" }),
      client.readContract({ address: expected.dividendProxy, abi: dividendAbi, functionName: "dToken" }),
      client.readContract({ address: expected.dividendProxy, abi: dividendAbi, functionName: "dealCoin" }),
      client.readContract({ address: expected.dividendProxy, abi: dividendAbi, functionName: "governance" }),
      client.readContract({ address: expected.dividendProxy, abi: dividendAbi, functionName: "roundsCount" }),
      client.readContract({ address: expected.dividendProxy, abi: dividendAbi, functionName: "reservedUnclaimed" }),
    ]);
  for (const [label, actual, wanted] of [
    ["SatoshiVault.dealCoin", satoshiDc, expected.dc],
    ["SatoshiVault.controller", satoshiController, expected.governance],
    ["DealDividendVault.dToken", dividendD, expected.d],
    ["DealDividendVault.dealCoin", dividendDc, expected.dc],
    ["DealDividendVault.governance", dividendGovernance, expected.governance],
  ] as const) {
    if (!sameAddress(actual, wanted)) throw new Error(`${label} mismatch: ${actual} != ${wanted}`);
  }
  if (rounds !== 0n || reserved !== 0n) {
    throw new Error(`Fresh DealDividendVault is not empty: rounds=${rounds}, reserved=${reserved}`);
  }
}

async function main() {
  const deployment = loadDeployment();
  const crossChainDeployment = loadCrossChainDeployment();
  if (deployment.chainId !== 1) throw new Error("ETH deployment file chainId must be 1");
  const governance = getAddress(deployment.addresses.dealGovernance);
  const governanceImplementation = getAddress(deployment.addresses.dealGovernanceImpl);
  const registry = getAddress(deployment.addresses.governancePolicyRegistry);
  const treasury = getAddress(deployment.addresses.protocolTreasury);
  const d = getAddress(deployment.addresses.dToken);
  const dc = getAddress(deployment.addresses.dlToken);
  const dealFactory = getAddress(deployment.addresses.dealFactory);
  const crossChainBroadcaster = getAddress(deployment.addresses.crossChainBroadcaster);
  const bscDealFactory = getAddress(crossChainDeployment.params.bscDealFactory);

  const deployEnabled =
    process.env.DAO_TREASURY_MODULES_MAINNET_DEPLOY_CONFIRM === DEPLOY_CONFIRM;
  const approveEnabled =
    process.env.DAO_TREASURY_MODULES_FEE_APPROVE_CONFIRM === APPROVE_CONFIRM;
  const proposeEnabled =
    process.env.DAO_TREASURY_MODULES_MAINNET_PROPOSE_CONFIRM === PROPOSE_CONFIRM;
  if ([deployEnabled, approveEnabled, proposeEnabled].filter(Boolean).length > 1) {
    throw new Error("Deploy, fee approval and proposal write modes are mutually exclusive");
  }

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== 1) throw new Error(`Refusing chainId ${chainId}; expected Ethereum mainnet`);
  const blockNumber = await publicClient.getBlockNumber();
  console.log(`ETH chainId: ${chainId}`);
  console.log(`ETH block: ${blockNumber}`);
  for (const [label, address] of [
    ["DealGovernance proxy", governance],
    ["DealGovernance implementation", governanceImplementation],
    ["GovernancePolicyRegistry", registry],
    ["ProtocolTreasury", treasury],
    ["D", d],
    ["DC", dc],
  ] as const) {
    await assertCode(publicClient, label, address);
  }
  const [governanceSlot, chainD, chainDc, chainTreasury, chainRegistry, registryGovernance, treasuryController, bootstrapLocked] =
    await Promise.all([
      publicClient.getStorageAt({ address: governance, slot: IMPLEMENTATION_SLOT }),
      publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "dToken" }),
      publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "dcToken" }),
      publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "treasury" }),
      publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "policyRegistry" }),
      publicClient.readContract({ address: registry, abi: registryAbi, functionName: "governance" }),
      publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "controller" }),
      publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "bootstrapLocked" }),
    ]);
  for (const [label, actual, expected] of [
    ["governance implementation", slotAddress(governanceSlot), governanceImplementation],
    ["DealGovernance.dToken", chainD, d],
    ["DealGovernance.dcToken", chainDc, dc],
    ["DealGovernance.treasury", chainTreasury, treasury],
    ["DealGovernance.policyRegistry", chainRegistry, registry],
    ["registry.governance", registryGovernance, governance],
    ["treasury.controller", treasuryController, governance],
  ] as const) {
    if (!sameAddress(actual, expected)) throw new Error(`${label} mismatch: ${actual} != ${expected}`);
  }
  if (!bootstrapLocked) throw new Error("ProtocolTreasury bootstrap is not locked");
  const baselineRuleCount = await assertBaselinePolicy(publicClient, registry, {
    governance,
    dealFactory,
    crossChainBroadcaster,
    protocolTreasury: treasury,
    bscDealFactory,
  });
  if (baselineRuleCount !== 48) throw new Error(`Expected 48 baseline rules, got ${baselineRuleCount}`);
  console.log(`DAO V2 policy baseline: ${baselineRuleCount}/48 exact rules matched`);

  const sizes = {
    satoshiVault: artifactSize("SatoshiVault"),
    dealDividendVault: artifactSize("DealDividendVault"),
  };
  for (const [name, size] of Object.entries(sizes)) {
    if (size.runtime > 24_576 || size.creation > 49_152) {
      throw new Error(`${name} exceeds an EVM code-size limit`);
    }
  }
  console.log(
    `Module sizes: SatoshiVault=${sizes.satoshiVault.runtime} runtime bytes; ` +
      `DealDividendVault=${sizes.dealDividendVault.runtime} runtime bytes`,
  );

  const wallets = await viem.getWalletClients();
  const wallet = wallets[0];
  if ((deployEnabled || approveEnabled || proposeEnabled) && !wallet) {
    throw new Error("A configured Ethereum mainnet wallet is required for write mode");
  }
  const proposer = wallet ? getAddress(wallet.account.address) : undefined;
  let proposerNativeBalance: bigint | undefined;
  if (proposer) {
    const [nonce, nativeBalance] = await Promise.all([
      nonceState(publicClient, proposer),
      publicClient.getBalance({ address: proposer }),
    ]);
    proposerNativeBalance = nativeBalance;
    console.log(
      `Configured wallet: ${proposer}; nonce latest=${nonce.latest}, pending=${nonce.pending}; ` +
        `native balance=${formatEther(nativeBalance)} ETH`,
    );
    if ((deployEnabled || approveEnabled || proposeEnabled) && nonce.latest !== nonce.pending) {
      throw new Error("Refusing write while the configured wallet has pending transactions");
    }
    if ((deployEnabled || approveEnabled || proposeEnabled) && nativeBalance === 0n) {
      throw new Error("Configured wallet has no native balance for transaction gas");
    }
  }

  let satoshiImplementation = envAddress("DAO_SATOSHI_VAULT_IMPLEMENTATION_ADDRESS");
  let satoshiProxy = envAddress("DAO_SATOSHI_VAULT_PROXY_ADDRESS");
  let dividendImplementation = envAddress("DAO_DIVIDEND_VAULT_IMPLEMENTATION_ADDRESS");
  let dividendProxy = envAddress("DAO_DIVIDEND_VAULT_PROXY_ADDRESS");
  const explicitAddresses = [
    "DAO_SATOSHI_VAULT_IMPLEMENTATION_ADDRESS",
    "DAO_SATOSHI_VAULT_PROXY_ADDRESS",
    "DAO_DIVIDEND_VAULT_IMPLEMENTATION_ADDRESS",
    "DAO_DIVIDEND_VAULT_PROXY_ADDRESS",
  ].every((name) => Boolean(process.env[name]?.trim()));
  if (!satoshiImplementation && proposer) {
    const nonce = (await nonceState(publicClient, proposer)).pending;
    satoshiImplementation = getContractAddress({ from: proposer, nonce: BigInt(nonce) });
    satoshiProxy = getContractAddress({ from: proposer, nonce: BigInt(nonce + 1) });
    dividendImplementation = getContractAddress({ from: proposer, nonce: BigInt(nonce + 2) });
    dividendProxy = getContractAddress({ from: proposer, nonce: BigInt(nonce + 3) });
  }
  if (!satoshiImplementation || !satoshiProxy || !dividendImplementation || !dividendProxy) {
    throw new Error("Cannot predict module addresses without a configured wallet");
  }
  console.log("\nModule address plan:");
  console.log(`  SatoshiVault implementation: ${satoshiImplementation}`);
  console.log(`  SatoshiVault proxy:          ${satoshiProxy}`);
  console.log(`  Dividend implementation:    ${dividendImplementation}`);
  console.log(`  Dividend proxy:             ${dividendProxy}`);
  console.log(`  Satoshi initializer: DC=${dc}, controller=${governance}`);
  console.log(`  Dividend initializer: D=${d}, DC=${dc}, governance=${governance}`);

  const rules = buildDaoV2TreasuryModuleRules(satoshiProxy, dividendProxy);
  console.log("\nFour exact module rules:");
  for (const [index, rule] of rules.entries()) {
    console.log(
      `  ${index + 1}. kind=${rule.kind} target=${rule.target} selector=${rule.selector} maxValue=${rule.maxValue}`,
    );
  }
  const setRulesData = encodeFunctionData({
    abi: registryAbi,
    functionName: "setRules",
    args: [rules],
  });
  const policyActionAllowed = await publicClient.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "isActionAllowed",
    args: [DAO_V2_PROPOSAL_KIND.Major, registry, 0n, setRulesData],
  });
  if (!policyActionAllowed) throw new Error("Current registry does not allow its own Major setRules action");
  console.log("\nMajor policy proposal preview:");
  console.log(`  target: ${registry}`);
  console.log("  value: 0");
  console.log(`  calldata: ${setRulesData}`);

  const configuredAddresses = {
    governance,
    d,
    dc,
    satoshiImplementation,
    satoshiProxy,
    dividendImplementation,
    dividendProxy,
  };
  if (approveEnabled && !explicitAddresses) {
    throw new Error("Fee approval mode requires all four explicit deployed module addresses");
  }
  if (explicitAddresses && !deployEnabled) await verifyModules(publicClient, configuredAddresses);
  if (deployEnabled || !explicitAddresses) {
    for (const [label, address] of [
      ["SatoshiVault implementation", satoshiImplementation],
      ["SatoshiVault proxy", satoshiProxy],
      ["DealDividendVault implementation", dividendImplementation],
      ["DealDividendVault proxy", dividendProxy],
    ] as const) {
      const code = await publicClient.getCode({ address });
      if (code && code !== "0x") {
        throw new Error(`${label} target already has code at ${address}`);
      }
    }
  }

  const majorFee = await publicClient.readContract({
    address: governance,
    abi: governanceAbi,
    functionName: "majorProposalFee",
  });
  let feeState: Record<string, string> | undefined;
  if (proposer) {
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [proposer] }),
      publicClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "allowance",
        args: [proposer, governance],
      }),
    ]);
    feeState = {
      majorFeeWei: majorFee.toString(),
      balanceWei: balance.toString(),
      allowanceWei: allowance.toString(),
    };
    console.log(
      `Major fee readiness: fee=${formatEther(majorFee)} DC, ` +
        `balance=${formatEther(balance)} DC, allowance=${formatEther(allowance)} DC`,
    );
    if ((approveEnabled || proposeEnabled) && balance < majorFee) {
      throw new Error(`Proposer DC balance ${balance} is below Major fee ${majorFee}; this script never mints`);
    }
    if (proposeEnabled && allowance < majorFee) {
      throw new Error("Major fee allowance is insufficient; run the separately confirmed approval phase first");
    }
  }

  const output: Record<string, unknown> = {
    preparedAt: new Date().toISOString(),
    chainId,
    blockNumber: blockNumber.toString(),
    deployer: proposer,
    deployerNativeBalanceWei: proposerNativeBalance?.toString(),
    governance,
    governanceImplementation,
    registry,
    treasury,
    d,
    dc,
    modules: {
      satoshiImplementation,
      satoshiProxy,
      dividendImplementation,
      dividendProxy,
    },
    sizes,
    baselineRuleCount,
    rules,
    setRulesCalldata: setRulesData,
    feeState,
  };

  if (deployEnabled) {
    if (!wallet || !proposer) throw new Error("Missing deployment wallet");
    const nonce = (await nonceState(publicClient, proposer)).pending;
    const expected = [satoshiImplementation, satoshiProxy, dividendImplementation, dividendProxy];
    const actualPredictions = [0, 1, 2, 3].map((offset) =>
      getContractAddress({ from: proposer, nonce: BigInt(nonce + offset) }),
    );
    if (expected.some((address, index) => address !== actualPredictions[index])) {
      throw new Error("Configured/predicted module addresses do not match the next four CREATE addresses");
    }
    const client = { public: publicClient, wallet } as const;
    console.log("\n--- MAINNET WRITE ENABLED: deploy SatoshiVault implementation + proxy ---");
    const deployedSatoshiImplementation = await viem.deployContract("SatoshiVault", [], { client });
    if (getAddress(deployedSatoshiImplementation.address) !== satoshiImplementation) {
      throw new Error("SatoshiVault implementation CREATE address mismatch");
    }
    const satoshiInitData = encodeFunctionData({
      abi: satoshiAbi,
      functionName: "initialize",
      args: [dc, governance],
    });
    const deployedSatoshiProxy = await viem.deployContract(
      "ERC1967Proxy",
      [satoshiImplementation, satoshiInitData],
      { client },
    );
    if (getAddress(deployedSatoshiProxy.address) !== satoshiProxy) {
      throw new Error("SatoshiVault proxy CREATE address mismatch");
    }

    console.log("\n--- MAINNET WRITE ENABLED: deploy DealDividendVault implementation + proxy ---");
    const deployedDividendImplementation = await viem.deployContract("DealDividendVault", [], { client });
    if (getAddress(deployedDividendImplementation.address) !== dividendImplementation) {
      throw new Error("DealDividendVault implementation CREATE address mismatch");
    }
    const dividendInitData = encodeFunctionData({
      abi: dividendAbi,
      functionName: "initialize",
      args: [d, dc, governance],
    });
    const deployedDividendProxy = await viem.deployContract(
      "ERC1967Proxy",
      [dividendImplementation, dividendInitData],
      { client },
    );
    if (getAddress(deployedDividendProxy.address) !== dividendProxy) {
      throw new Error("DealDividendVault proxy CREATE address mismatch");
    }
    await verifyModules(publicClient, configuredAddresses);
    output.deploymentVerified = true;
  }

  if (approveEnabled) {
    if (!wallet || !proposer) throw new Error("Missing approval wallet");
    const client = { public: publicClient, wallet } as const;
    const token = await viem.getContractAt("DCToken", dc, { client });
    console.log("\n--- MAINNET WRITE ENABLED: approve exact Major proposal fee only ---");
    const hash = await token.write.approve([governance, majorFee]);
    const receipt = await waitFor(publicClient, hash, "approve exact Major proposal fee");
    const allowance = await publicClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    });
    if (allowance !== majorFee) throw new Error(`Exact fee approval mismatch: ${allowance}`);
    output.approvalTx = hash;
    output.approvalBlock = receipt.blockNumber.toString();
  }

  if (proposeEnabled) {
    if (!wallet || !proposer) throw new Error("Missing proposal wallet");
    if (!explicitAddresses) {
      throw new Error("Proposal mode requires all four explicit deployed module addresses");
    }
    const existingRules = await Promise.all(
      rules.map((rule) =>
        publicClient.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "getRule",
          args: [rule.kind, rule.target, rule.selector],
        }),
      ),
    );
    if (existingRules.some((rule) => rule.allowed)) {
      throw new Error("At least one module rule is already enabled; refusing a duplicate policy proposal");
    }
    const client = { public: publicClient, wallet } as const;
    const governanceContract = await viem.getContractAt("DealGovernance", governance, { client });
    const description =
      process.env.DAO_TREASURY_MODULES_PROPOSAL_DESCRIPTION?.trim() ||
      "Enable DAO-controlled SatoshiVault and DealDividendVault UUPS proxy actions";
    console.log("\n--- MAINNET WRITE ENABLED: create Major four-rule proposal only ---");
    const hash = await governanceContract.write.createProposal([
      [registry],
      [0n],
      [setRulesData],
      description,
      DAO_V2_PROPOSAL_KIND.Major,
    ]);
    const receipt = await waitFor(publicClient, hash, "create module policy Major proposal");
    const proposalId = await publicClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    });
    output.proposalTx = hash;
    output.proposalBlock = receipt.blockNumber.toString();
    output.proposalId = proposalId.toString();
    console.log(`  proposalId: ${proposalId}`);
  }

  if (deployEnabled || approveEnabled || proposeEnabled) {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const outputDir = join(process.cwd(), "deployments", "dao-treasury-modules");
    mkdirSync(outputDir, { recursive: true });
    const outputFile = join(outputDir, `eth-mainnet-dao-treasury-modules-${timestamp}.json`);
    writeFileSync(outputFile, JSON.stringify(output, (_, value) =>
      typeof value === "bigint" ? value.toString() : value, 2), "utf8");
    console.log(`Wrote ${outputFile}`);
  } else {
    console.log("\nDRY-RUN ONLY: no transaction sent and no deployment file changed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
