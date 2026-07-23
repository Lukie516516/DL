/**
 * ETH mainnet DealGovernance V2 preparation and guarded execution script.
 *
 * Default behavior is read-only dry-run. Mainnet writes require exact, separate
 * confirmations so deploying contracts never implicitly creates a proposal.
 *
 * Deploy registry + implementation:
 *   DAO_V2_MAINNET_DEPLOY_CONFIRM=DEPLOY_DAO_V2_ON_ETHEREUM_MAINNET
 *
 * Create the Major upgrade proposal (and approve its DC fee if needed):
 *   DAO_V2_MAINNET_PROPOSE_CONFIRM=CREATE_DAO_V2_UPGRADE_PROPOSAL
 *   DAO_V2_POLICY_REGISTRY_ADDRESS=0x...
 *   DAO_V2_IMPLEMENTATION_ADDRESS=0x...
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { network } from "hardhat";
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  getContractAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";

import { assertDealGovernanceStorageLayout } from "./check-deal-governance-storage-layout.js";
import { assertContractSizes } from "./check-contract-sizes.js";
import {
  buildDaoV2PolicyRules,
  DEFAULT_BROADCAST_MAX_VALUE,
  DAO_V2_PROPOSAL_KIND,
  toRegistryRuleInputs,
  type DaoV2PolicyAddresses,
  type DaoV2PolicyRule,
} from "./dao-v2-policy.js";

const ETH_DEPLOYMENT_FILE = "deployments/eth-mainnet-1.json";
const BSC_DEPLOYMENT_FILE = "deployments/bsc-mainnet-56.json";
const CROSS_CHAIN_FILE = "deployments/mainnet-cross-chain.json";
const DEPLOY_CONFIRM = "DEPLOY_DAO_V2_ON_ETHEREUM_MAINNET";
const PROPOSE_CONFIRM = "CREATE_DAO_V2_UPGRADE_PROPOSAL";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const DRY_REGISTRY = getAddress("0x000000000000000000000000000000000000D0A2");
const DRY_IMPLEMENTATION = getAddress("0x000000000000000000000000000000000000D0A3");

type Deployment = {
  chainId: number;
  deployedAt: string;
  deployer: Address;
  addresses: Record<string, Address>;
};

type CrossChainDeployment = {
  eth: { chainId: number; broadcaster: Address };
  bsc: { chainId: number; executor: Address };
  params: {
    ethGovernance: Address;
    bscChainKey: number;
    bscDealFactory: Address;
  };
};

const governanceReadAbi = parseAbi([
  "function dToken() view returns (address)",
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function nftVetoRegistry() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
]);
const factoryReadAbi = parseAbi([
  "function crossChainGovernance() view returns (address)",
  "function minWindowSec() view returns (uint32)",
]);
const broadcasterReadAbi = parseAbi([
  "function governance() view returns (address)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
]);
const treasuryReadAbi = parseAbi([
  "function controller() view returns (address)",
  "function bootstrapLocked() view returns (bool)",
]);
const registryReadAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns ((bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue))",
]);
const tokenReadAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const governanceUpgradeAbi = parseAbi([
  "function setPolicyRegistry(address)",
  "function upgradeToAndCall(address,bytes) payable",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const erc20ApproveAbi = parseAbi(["function approve(address,uint256) returns (bool)"]);
const uupsReadAbi = parseAbi(["function proxiableUUID() view returns (bytes32)"]);

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

function envAddress(name: string): Address | undefined {
  const raw = process.env[name]?.trim();
  return raw ? getAddress(raw) : undefined;
}

function sameAddress(actual: unknown, expected: Address): boolean {
  return String(actual).toLowerCase() === expected.toLowerCase();
}

function implementationFromSlot(word: Hex | undefined): Address {
  if (!word || word.length !== 66) throw new Error("Governance implementation slot is empty");
  return getAddress(`0x${word.slice(-40)}`);
}

async function waitFor(publicClient: any, hash: Hex, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  OK ${label}: ${hash}`);
  return receipt;
}

async function assertCode(publicClient: any, label: string, address: Address): Promise<void> {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

async function assertUupsImplementation(publicClient: any, address: Address): Promise<void> {
  const uuid = await publicClient.readContract({
    address,
    abi: uupsReadAbi,
    functionName: "proxiableUUID",
  });
  if (uuid.toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase()) {
    throw new Error(`Implementation ${address} has unexpected UUPS UUID ${uuid}`);
  }
}

async function readNonceState(publicClient: any, address: Address) {
  const [latest, pending] = await Promise.all([
    publicClient.getTransactionCount({ address, blockTag: "latest" }),
    publicClient.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { latest, pending };
}

async function assertRegistryRules(
  publicClient: any,
  registry: Address,
  rules: DaoV2PolicyRule[],
): Promise<void> {
  for (const expected of rules) {
    const actual = await publicClient.readContract({
      address: registry,
      abi: registryReadAbi,
      functionName: "getRule",
      args: [expected.kind, expected.target, expected.selector],
    });
    if (
      !actual.allowed ||
      actual.validateNestedBroadcast !== expected.validateNestedBroadcast ||
      actual.nestedOnly !== expected.nestedOnly ||
      actual.maxValue !== expected.maxValue
    ) {
      throw new Error(`Registry rule mismatch: ${expected.label}`);
    }
  }
}

function printPolicy(rules: DaoV2PolicyRule[]): void {
  const kindName = ["Parameter", "Treasury", "Major", "Satoshi"];
  console.log(`\nInitial policy rules (${rules.length}):`);
  for (const [index, rule] of rules.entries()) {
    const nested = rule.validateNestedBroadcast ? " nested-check" : "";
    const scope = rule.nestedOnly ? " nested-only" : "";
    console.log(
      `  ${String(index + 1).padStart(2, "0")}. ${kindName[rule.kind]} ${rule.label} ` +
        `${rule.target} ${rule.selector} maxValue=${rule.maxValue}${nested}${scope}`,
    );
  }
  if (!rules.some((rule) => rule.kind === DAO_V2_PROPOSAL_KIND.Satoshi)) {
    console.log("  Satoshi: deny-all (no deployed SatoshiVault exact action configured)");
  }
}

async function main() {
  const ethDeployment = loadJson<Deployment>(ETH_DEPLOYMENT_FILE);
  const bscDeployment = loadJson<Deployment>(BSC_DEPLOYMENT_FILE);
  const crossChain = loadJson<CrossChainDeployment>(CROSS_CHAIN_FILE);
  if (ethDeployment.chainId !== 1 || bscDeployment.chainId !== 56) {
    throw new Error("Deployment file chain IDs do not match ETH=1 and BSC=56");
  }

  const addresses = ethDeployment.addresses;
  const governance = getAddress(addresses.dealGovernance);
  const expectedImplementation = getAddress(addresses.dealGovernanceImpl);
  const dToken = getAddress(addresses.dToken);
  const dcToken = getAddress(addresses.dlToken);
  const nftVetoRegistry = getAddress(addresses.nftVetoRegistry);
  const protocolTreasury = getAddress(addresses.protocolTreasury);
  const broadcaster = getAddress(addresses.crossChainBroadcaster);
  const dealFactory = getAddress(addresses.dealFactory);
  const bscDealFactory = getAddress(crossChain.params.bscDealFactory);
  const bscExecutor = getAddress(crossChain.bsc.executor);

  if (!sameAddress(crossChain.params.ethGovernance, governance)) {
    throw new Error("Cross-chain ETH governance address differs from ETH deployment file");
  }
  if (!sameAddress(crossChain.eth.broadcaster, broadcaster)) {
    throw new Error("Cross-chain broadcaster differs from ETH deployment file");
  }
  if (!sameAddress(bscDeployment.addresses.dealFactory, bscDealFactory)) {
    throw new Error("Cross-chain BSC DealFactory differs from BSC deployment file");
  }

  const storage = assertDealGovernanceStorageLayout();
  console.log(
    `Storage layout: ${storage.v1FieldCount} V1 fields preserved; ` +
      `${storage.appendedField.label} appended at slot ${storage.appendedField.slot}`,
  );
  const sizes = assertContractSizes();
  const governanceSize = sizes.rows.find((row) => row.contractName === "DealGovernance");
  const registrySize = sizes.rows.find((row) => row.contractName === "GovernancePolicyRegistry");
  if (!governanceSize || !registrySize) {
    throw new Error("DAO V2 compiled artifacts missing from contract size check");
  }
  console.log(
    `Contract sizes: DealGovernance=${governanceSize.runtimeBytes} bytes, ` +
      `GovernancePolicyRegistry=${registrySize.runtimeBytes} bytes; ${sizes.checked} artifacts checked`,
  );

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== 1) throw new Error(`Refusing non-ETH-mainnet chainId ${chainId}; expected 1`);
  const blockNumber = await publicClient.getBlockNumber();
  console.log(`ETH chainId: ${chainId}`);
  console.log(`ETH block: ${blockNumber}`);

  for (const [label, address] of [
    ["DealGovernance proxy", governance],
    ["current DealGovernance implementation", expectedImplementation],
    ["D", dToken],
    ["DC", dcToken],
    ["NftVetoRegistry", nftVetoRegistry],
    ["ProtocolTreasury", protocolTreasury],
    ["CrossChainBroadcaster", broadcaster],
    ["DealFactory", dealFactory],
  ] as const) {
    await assertCode(publicClient, label, address);
  }

  const slotWord = await publicClient.getStorageAt({ address: governance, slot: IMPLEMENTATION_SLOT });
  const currentImplementation = implementationFromSlot(slotWord);
  if (!sameAddress(currentImplementation, expectedImplementation)) {
    throw new Error(
      `Governance implementation mismatch: deployment=${expectedImplementation}, chain=${currentImplementation}`,
    );
  }

  const [chainD, chainDc, chainTreasury, chainNftVeto, factoryGovernance, broadcasterGovernance] =
    await Promise.all([
      publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "dToken" }),
      publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "dcToken" }),
      publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "treasury" }),
      publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "nftVetoRegistry" }),
      publicClient.readContract({ address: dealFactory, abi: factoryReadAbi, functionName: "crossChainGovernance" }),
      publicClient.readContract({ address: broadcaster, abi: broadcasterReadAbi, functionName: "governance" }),
    ]);
  for (const [label, actual, expected] of [
    ["DealGovernance.dToken", chainD, dToken],
    ["DealGovernance.dcToken", chainDc, dcToken],
    ["DealGovernance.treasury", chainTreasury, protocolTreasury],
    ["DealGovernance.nftVetoRegistry", chainNftVeto, nftVetoRegistry],
    ["DealFactory.crossChainGovernance", factoryGovernance, governance],
    ["CrossChainBroadcaster.governance", broadcasterGovernance, governance],
  ] as const) {
    if (!sameAddress(actual, expected)) throw new Error(`${label} mismatch: ${actual} != ${expected}`);
  }

  const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-dataseed.binance.org";
  const bscClient = createPublicClient({ chain: bsc, transport: http(bscRpc) });
  if ((await bscClient.getChainId()) !== 56) throw new Error("BSC RPC did not return chainId 56");
  await assertCode(bscClient, "BSC DealFactory", bscDealFactory);
  await assertCode(bscClient, "BSC DualBridgeExecutor", bscExecutor);
  const bscFactoryGovernance = await bscClient.readContract({
    address: bscDealFactory,
    abi: factoryReadAbi,
    functionName: "crossChainGovernance",
  });
  if (!sameAddress(bscFactoryGovernance, bscExecutor)) {
    throw new Error(`BSC DealFactory.crossChainGovernance mismatch: ${bscFactoryGovernance}`);
  }

  const proposalBlockers: string[] = [];
  const treasuryController = await publicClient.readContract({
    address: protocolTreasury,
    abi: treasuryReadAbi,
    functionName: "controller",
  });
  const treasuryBootstrapLocked = await publicClient.readContract({
    address: protocolTreasury,
    abi: treasuryReadAbi,
    functionName: "bootstrapLocked",
  });
  if (!sameAddress(treasuryController, governance)) {
    proposalBlockers.push(
      `ProtocolTreasury.controller is ${treasuryController}; expected governance ${governance}`,
    );
  }
  if (!treasuryBootstrapLocked) {
    proposalBlockers.push("ProtocolTreasury.bootstrapLocked is false");
  }

  const currentMinWindow = await publicClient.readContract({
    address: dealFactory,
    abi: factoryReadAbi,
    functionName: "minWindowSec",
  });
  const probeInnerData = encodeFunctionData({
    abi: parseAbi(["function setMinWindowSec(uint32)"]),
    functionName: "setMinWindowSec",
    args: [currentMinWindow],
  });
  const currentBroadcastQuote = await publicClient.readContract({
    address: broadcaster,
    abi: broadcasterReadAbi,
    functionName: "quoteFees",
    args: [[crossChain.params.bscChainKey], [bscDealFactory], probeInnerData, 300_000n],
  });
  const broadcastMaxValue = process.env.DAO_V2_BROADCAST_MAX_VALUE_WEI
    ? BigInt(process.env.DAO_V2_BROADCAST_MAX_VALUE_WEI)
    : DEFAULT_BROADCAST_MAX_VALUE;
  if (currentBroadcastQuote > broadcastMaxValue) {
    proposalBlockers.push(
      `Current broadcast quote ${currentBroadcastQuote} exceeds configured cap ${broadcastMaxValue}`,
    );
  }
  console.log(
    `Broadcast quote probe: ${formatEther(currentBroadcastQuote)} ETH; ` +
      `policy cap ${formatEther(broadcastMaxValue)} ETH`,
  );

  const walletClients = await viem.getWalletClients();
  const wallet = walletClients[0];
  const deployEnabled = process.env.DAO_V2_MAINNET_DEPLOY_CONFIRM === DEPLOY_CONFIRM;
  const proposeEnabled = process.env.DAO_V2_MAINNET_PROPOSE_CONFIRM === PROPOSE_CONFIRM;
  if ((deployEnabled || proposeEnabled) && !wallet) {
    throw new Error("A configured ETH mainnet wallet is required for explicitly enabled writes");
  }

  let predictedRegistry = envAddress("DAO_V2_POLICY_REGISTRY_ADDRESS");
  let predictedImplementation = envAddress("DAO_V2_IMPLEMENTATION_ADDRESS");
  if (!predictedRegistry && wallet) {
    const nonceState = await readNonceState(publicClient, wallet.account.address);
    if (nonceState.latest !== nonceState.pending) {
      console.log(
        `Deployment address preview uses pending nonce ${nonceState.pending}; ` +
          `latest nonce is ${nonceState.latest}. Explicit deployment will refuse until they match.`,
      );
    }
    predictedRegistry = getContractAddress({
      from: wallet.account.address,
      nonce: BigInt(nonceState.pending),
    });
    if (!predictedImplementation) {
      predictedImplementation = getContractAddress({
        from: wallet.account.address,
        nonce: BigInt(nonceState.pending + 1),
      });
    }
  }
  predictedRegistry ??= DRY_REGISTRY;
  predictedImplementation ??= DRY_IMPLEMENTATION;

  const satoshiVault = envAddress("DAO_V2_SATOSHI_VAULT_ADDRESS");
  const satoshiVaultFunction = process.env.DAO_V2_SATOSHI_VAULT_FUNCTION?.trim();
  const policyAddresses: DaoV2PolicyAddresses = {
    governance,
    policyRegistry: predictedRegistry,
    dealFactory,
    crossChainBroadcaster: broadcaster,
    protocolTreasury,
    bscDealFactory,
    satoshiVault,
  };
  let rules = buildDaoV2PolicyRules(policyAddresses, {
    broadcastMaxValue,
    satoshiVaultFunction,
  });
  printPolicy(rules);

  let registryAddress = envAddress("DAO_V2_POLICY_REGISTRY_ADDRESS");
  let implementationAddress = envAddress("DAO_V2_IMPLEMENTATION_ADDRESS");
  const output: Record<string, unknown> = {
    preparedAt: new Date().toISOString(),
    chainId,
    blockNumber: blockNumber.toString(),
    governance,
    currentImplementation,
    broadcastQuoteWei: currentBroadcastQuote.toString(),
    broadcastMaxValueWei: broadcastMaxValue.toString(),
    proposalBlockers,
  };

  if (deployEnabled) {
    const client = { public: publicClient, wallet } as const;
    const nonceState = await readNonceState(publicClient, wallet.account.address);
    if (nonceState.latest !== nonceState.pending) {
      throw new Error(
        `Refusing deployment while wallet has pending transactions: ` +
          `latest nonce=${nonceState.latest}, pending nonce=${nonceState.pending}`,
      );
    }
    const nextNonce = nonceState.pending;
    const exactPredictedRegistry = getContractAddress({
      from: wallet.account.address,
      nonce: BigInt(nextNonce),
    });
    const exactPredictedImplementation = getContractAddress({
      from: wallet.account.address,
      nonce: BigInt(nextNonce + 1),
    });
    if (registryAddress && !sameAddress(registryAddress, exactPredictedRegistry)) {
      throw new Error(
        `Configured registry ${registryAddress} does not match next CREATE address ${exactPredictedRegistry}`,
      );
    }
    if (
      implementationAddress &&
      !sameAddress(implementationAddress, exactPredictedImplementation)
    ) {
      throw new Error(
        `Configured implementation ${implementationAddress} does not match second CREATE address ` +
          exactPredictedImplementation,
      );
    }
    registryAddress = exactPredictedRegistry;
    policyAddresses.policyRegistry = registryAddress;
    rules = buildDaoV2PolicyRules(policyAddresses, { broadcastMaxValue, satoshiVaultFunction });

    console.log("\n--- MAINNET WRITE ENABLED: deploy GovernancePolicyRegistry ---");
    const deployedRegistry = await viem.deployContract(
      "GovernancePolicyRegistry",
      [governance, toRegistryRuleInputs(rules)],
      { client },
    );
    if (!sameAddress(deployedRegistry.address, registryAddress)) {
      throw new Error(`Registry CREATE address mismatch: ${deployedRegistry.address} != ${registryAddress}`);
    }
    registryAddress = getAddress(deployedRegistry.address);
    await assertCode(publicClient, "new GovernancePolicyRegistry", registryAddress);
    await assertRegistryRules(publicClient, registryAddress, rules);

    console.log("\n--- MAINNET WRITE ENABLED: deploy DealGovernance implementation ---");
    const implementation = await viem.deployContract("DealGovernance", [], { client });
    if (!sameAddress(implementation.address, exactPredictedImplementation)) {
      throw new Error(
        `Implementation CREATE address mismatch: ${implementation.address} != ` +
          exactPredictedImplementation,
      );
    }
    implementationAddress = getAddress(implementation.address);
    await assertCode(publicClient, "new DealGovernance implementation", implementationAddress);
    await assertUupsImplementation(publicClient, implementationAddress);
    console.log(`  GovernancePolicyRegistry: ${registryAddress}`);
    console.log(`  DealGovernance implementation: ${implementationAddress}`);
    output.registryAddress = registryAddress;
    output.implementationAddress = implementationAddress;
  }

  if (!deployEnabled && registryAddress) {
    await assertCode(publicClient, "configured GovernancePolicyRegistry", registryAddress);
    const registryGovernance = await publicClient.readContract({
      address: registryAddress,
      abi: registryReadAbi,
      functionName: "governance",
    });
    if (!sameAddress(registryGovernance, governance)) {
      throw new Error(`Registry governance mismatch: ${registryGovernance}`);
    }
    await assertRegistryRules(publicClient, registryAddress, rules);
    console.log(`Configured GovernancePolicyRegistry verified: ${registryAddress}`);
  }
  if (!deployEnabled && implementationAddress) {
    await assertCode(publicClient, "configured DealGovernance implementation", implementationAddress);
    await assertUupsImplementation(publicClient, implementationAddress);
    console.log(`Configured DealGovernance implementation verified: ${implementationAddress}`);
  }

  const upgradeInitData = encodeFunctionData({
    abi: governanceUpgradeAbi,
    functionName: "setPolicyRegistry",
    args: [registryAddress ?? predictedRegistry],
  });
  const upgradeCalldata = encodeFunctionData({
    abi: governanceUpgradeAbi,
    functionName: "upgradeToAndCall",
    args: [implementationAddress ?? predictedImplementation, upgradeInitData],
  });
  console.log("\nUpgrade proposal preview:");
  console.log(`  target: ${governance}`);
  console.log("  value: 0");
  console.log(`  registry: ${registryAddress ?? predictedRegistry}`);
  console.log(`  implementation: ${implementationAddress ?? predictedImplementation}`);
  console.log(`  calldata: ${upgradeCalldata}`);

  if (proposeEnabled) {
    if (!wallet) throw new Error("Missing mainnet wallet");
    if (!registryAddress || !implementationAddress) {
      throw new Error(
        "Proposal creation requires deployed DAO_V2_POLICY_REGISTRY_ADDRESS and DAO_V2_IMPLEMENTATION_ADDRESS",
      );
    }
    if (proposalBlockers.length > 0) {
      throw new Error(`Upgrade proposal readiness blockers:\n- ${proposalBlockers.join("\n- ")}`);
    }
    await assertCode(publicClient, "configured GovernancePolicyRegistry", registryAddress);
    await assertCode(publicClient, "configured DealGovernance implementation", implementationAddress);
    const registryGovernance = await publicClient.readContract({
      address: registryAddress,
      abi: registryReadAbi,
      functionName: "governance",
    });
    if (!sameAddress(registryGovernance, governance)) {
      throw new Error(`Registry governance mismatch: ${registryGovernance}`);
    }
    policyAddresses.policyRegistry = registryAddress;
    rules = buildDaoV2PolicyRules(policyAddresses, { broadcastMaxValue, satoshiVaultFunction });
    await assertRegistryRules(publicClient, registryAddress, rules);

    const majorFee = await publicClient.readContract({
      address: governance,
      abi: governanceReadAbi,
      functionName: "majorProposalFee",
    });
    const proposer = getAddress(wallet.account.address);
    const [feeBalance, feeAllowance] = await Promise.all([
      publicClient.readContract({ address: dcToken, abi: tokenReadAbi, functionName: "balanceOf", args: [proposer] }),
      publicClient.readContract({
        address: dcToken,
        abi: tokenReadAbi,
        functionName: "allowance",
        args: [proposer, governance],
      }),
    ]);
    if (feeBalance < majorFee) {
      throw new Error(`Proposer DC balance ${feeBalance} is below Major fee ${majorFee}`);
    }
    const client = { public: publicClient, wallet } as const;
    if (feeAllowance < majorFee) {
      const dc = await viem.getContractAt("DCToken", dcToken, { client });
      await waitFor(publicClient, await dc.write.approve([governance, majorFee]), "approve Major proposal fee");
    }

    const governanceContract = await viem.getContractAt("DealGovernance", governance, { client });
    const description =
      process.env.DAO_V2_PROPOSAL_DESCRIPTION?.trim() ||
      "Upgrade ETH DealGovernance proxy to DAO V2 and atomically install GovernancePolicyRegistry";
    console.log("\n--- MAINNET WRITE ENABLED: create Major upgrade proposal ---");
    await waitFor(
      publicClient,
      await governanceContract.write.createProposal([
        [governance],
        [0n],
        [upgradeCalldata],
        description,
        DAO_V2_PROPOSAL_KIND.Major,
      ]),
      "create DAO V2 Major proposal",
    );
    const proposalId = await publicClient.readContract({
      address: governance,
      abi: governanceReadAbi,
      functionName: "proposalCount",
    });
    console.log(`  proposalId: ${proposalId}`);
    output.proposalId = proposalId.toString();
  }

  if (deployEnabled || proposeEnabled) {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const outputDir = join(process.cwd(), "deployments", "dao-v2-preparation");
    mkdirSync(outputDir, { recursive: true });
    const outputFile = join(outputDir, `eth-mainnet-dao-v2-${timestamp}.json`);
    writeFileSync(outputFile, JSON.stringify(output, null, 2), "utf8");
    console.log(`Wrote ${outputFile}`);
  } else {
    console.log("\nDRY-RUN ONLY: no transaction sent and no deployment file changed.");
    if (proposalBlockers.length > 0) {
      console.log("Proposal readiness blockers:");
      for (const blocker of proposalBlockers) console.log(`  - ${blocker}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
