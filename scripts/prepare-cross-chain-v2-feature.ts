/**
 * Read-only planner for onboarding one audited feature through the production
 * ETH -> satellite-chain CrossChainBroadcasterV2 path.
 *
 * It never loads a private key and has no transaction-writing branch.
 *
 * Usage:
 *   node --import tsx/esm scripts/prepare-cross-chain-v2-feature.ts \
 *     --config config/cross-chain-v2-existing-canary.json
 *
 * Optional:
 *   --out deployments/cross-chain-v2-feature-plan.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { bsc, mainnet } from "viem/chains";

import {
  actionSelector,
  BROADCAST_SELECTOR,
  broadcasterAbi,
  buildProposalPlan,
  executorAbi,
  governanceAbi,
  normalizeFeatureManifest,
  registryAbi,
  sameNumberSet,
} from "./lib/cross-chain-v2-feature.js";

type Deployment = {
  chainId: number;
  addresses: Record<string, Address>;
};

type Stage1 = {
  stage: string;
  eth: { address: Address; verified: boolean };
  bsc: { address: Address; verified: boolean };
};

type CrossChain = {
  params: { bscChainKey: number };
};

type RuleExpectation = {
  kind: number;
  target: Address;
  selector: Hex;
  allowed: true;
  validateNestedBroadcast: false;
  nestedOnly: boolean;
  maxValue: bigint;
};

type RuleView = readonly [boolean, boolean, boolean, bigint] & {
  allowed?: boolean;
  validateNestedBroadcast?: boolean;
  nestedOnly?: boolean;
  maxValue?: bigint;
};

function loadEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] ||= match[2].trim();
    }
  } catch {}
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

function argument(name: string, required = false): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function ruleTuple(rule: RuleView): [boolean, boolean, boolean, bigint] {
  return [
    rule.allowed ?? rule[0],
    rule.validateNestedBroadcast ?? rule[1],
    rule.nestedOnly ?? rule[2],
    rule.maxValue ?? rule[3],
  ];
}

function ruleSatisfies(rule: RuleView, expected: RuleExpectation): boolean {
  const [allowed, validateNested, nestedOnly, maxValue] = ruleTuple(rule);
  return (
    allowed &&
    !validateNested &&
    nestedOnly === expected.nestedOnly &&
    maxValue >= expected.maxValue
  );
}

function ruleKey(rule: RuleExpectation): string {
  return `${rule.kind}:${rule.target.toLowerCase()}:${rule.selector.toLowerCase()}`;
}

async function main() {
  loadEnv();
  const configPath = argument("--config", true)!;
  const outputPath = argument("--out");
  const manifest = normalizeFeatureManifest(loadJson<unknown>(configPath));

  const ethDeployment = loadJson<Deployment>("deployments/eth-mainnet-1.json");
  const stage1 = loadJson<Stage1>("deployments/ccip-v2-mainnet-stage1.json");
  const crossChain = loadJson<CrossChain>("deployments/mainnet-cross-chain.json");
  if (
    ethDeployment.chainId !== 1 ||
    stage1.stage !== "both_deployed" ||
    !stage1.eth.verified ||
    !stage1.bsc.verified
  ) {
    throw new Error("Verified ETH deployment and CCIP V2 stage-1 record required");
  }

  const governance = getAddress(ethDeployment.addresses.dealGovernance);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const broadcaster = getAddress(stage1.eth.address);
  const executor = getAddress(stage1.bsc.address);
  const bscChainKey = crossChain.params.bscChainKey;

  const ethClient = createPublicClient({
    chain: mainnet,
    transport: http(requiredEnv("ETH_MAINNET_RPC_URL")),
  });
  const bscClient = createPublicClient({
    chain: bsc,
    transport: http(
      process.env.BSC_MAINNET_RPC_URL?.trim() ||
        "https://bsc-rpc.publicnode.com",
    ),
  });
  const [
    ethChainId,
    bscChainId,
    ethBlock,
    bscBlock,
    broadcasterCode,
    executorCode,
    broadcasterGovernance,
    registryGovernance,
    governanceRegistry,
    currentNonce,
    activeConfigIds,
    threshold,
    proposalCount,
    majorProposalFee,
    activationThreshold,
  ] = await Promise.all([
    ethClient.getChainId(),
    bscClient.getChainId(),
    ethClient.getBlockNumber(),
    bscClient.getBlockNumber(),
    ethClient.getCode({ address: broadcaster }),
    bscClient.getCode({ address: executor }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "governance",
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "governance",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "policyRegistry",
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "getChainIds",
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "threshold",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "majorProposalFee",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "activationThreshold",
    }),
  ]);

  if (ethChainId !== 1 || bscChainId !== 56) throw new Error("RPC chain mismatch");
  if (!broadcasterCode || broadcasterCode === "0x") {
    throw new Error("CrossChainBroadcasterV2 has no code");
  }
  if (!executorCode || executorCode === "0x") {
    throw new Error("DualBridgeExecutorV2 has no code");
  }
  if (
    broadcasterGovernance.toLowerCase() !== governance.toLowerCase() ||
    registryGovernance.toLowerCase() !== governance.toLowerCase() ||
    governanceRegistry.toLowerCase() !== registry.toLowerCase()
  ) {
    throw new Error("Governance, Registry and Broadcaster wiring mismatch");
  }
  if (threshold !== 2n) throw new Error(`Unexpected executor threshold ${threshold}`);

  const activeChainKeys: number[] = [];
  for (const chainKey of activeConfigIds) {
    const route = await ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "chains",
      args: [chainKey],
    });
    if (route[6]) activeChainKeys.push(chainKey);
  }
  if (!activeChainKeys.includes(bscChainKey)) {
    throw new Error("Production BSC V2 route is not active");
  }

  const plan = buildProposalPlan(manifest, broadcaster, currentNonce);
  const blockers: string[] = [];
  const requiredRules = new Map<string, RuleExpectation>();
  const requiredBscAllowlist = new Map<
    string,
    { target: Address; calldata: Hex }
  >();
  const quoteResults: Array<{
    label: string;
    liveQuoteWei?: bigint;
    feeBudgetWei: bigint;
    sufficient?: boolean;
    error?: string;
  }> = [];

  for (const action of manifest.localActions) {
    const [code, rule, allowed] = await Promise.all([
      ethClient.getCode({ address: action.target }),
      ethClient.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [
          manifest.proposalKind,
          action.target,
          actionSelector(action.calldata),
        ],
      }) as Promise<RuleView>,
      ethClient.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "isActionAllowed",
        args: [
          manifest.proposalKind,
          action.target,
          action.valueWei,
          action.calldata,
        ],
      }),
    ]);
    if (!code || code === "0x") {
      blockers.push(`ETH target has no code: ${action.label} ${action.target}`);
    }
    const expected: RuleExpectation = {
      kind: manifest.proposalKind,
      target: action.target,
      selector: actionSelector(action.calldata),
      allowed: true,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: action.valueWei,
    };
    if (!ruleSatisfies(rule, expected)) {
      requiredRules.set(ruleKey(expected), expected);
      blockers.push(`ETH direct policy missing or too narrow: ${action.label}`);
    } else if (!allowed) {
      blockers.push(`ETH action rejected by Registry: ${action.label}`);
    }
  }

  for (const broadcast of manifest.broadcasts) {
    const chainKeys = broadcast.targets.map((target) => target.chainKey);
    if (!sameNumberSet(chainKeys, activeChainKeys)) {
      blockers.push(
        `${broadcast.label} must target every active chain exactly once; active=${activeChainKeys.join(",")}`,
      );
    }
    if (chainKeys.some((chainKey) => chainKey !== bscChainKey)) {
      blockers.push(
        `${broadcast.label} contains a chain without a configured read-only verifier`,
      );
    }

    for (const target of broadcast.targets) {
      if (target.chainKey !== bscChainKey) continue;
      const innerSelector = actionSelector(broadcast.calldata);
      const [code, allowlisted, rule] = await Promise.all([
        bscClient.getCode({ address: target.target }),
        bscClient.readContract({
          address: executor,
          abi: executorAbi,
          functionName: "allowedTargets",
          args: [target.target],
        }),
        ethClient.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "getRule",
          args: [manifest.proposalKind, target.target, innerSelector],
        }) as Promise<RuleView>,
      ]);
      if (!code || code === "0x") {
        blockers.push(
          `BSC target has no code: ${broadcast.label} ${target.target}`,
        );
      }
      if (!allowlisted) {
        const key = target.target.toLowerCase();
        requiredBscAllowlist.set(key, {
          target: target.target,
          calldata: encodeFunctionData({
            abi: executorAbi,
            functionName: "setAllowedTarget",
            args: [target.target, true],
          }),
        });
        blockers.push(`BSC Executor allowlist missing: ${broadcast.label}`);
      }
      const expected: RuleExpectation = {
        kind: manifest.proposalKind,
        target: target.target,
        selector: innerSelector,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: true,
        maxValue: 0n,
      };
      if (!ruleSatisfies(rule, expected)) {
        requiredRules.set(ruleKey(expected), expected);
        blockers.push(`BSC nested policy missing or mismatched: ${broadcast.label}`);
      }
    }

    const plannedAction = plan.actions.find(
      (action) => action.type === "broadcast" && action.label === broadcast.label,
    );
    if (!plannedAction) throw new Error(`Missing planned broadcast ${broadcast.label}`);
    try {
      const [quote, outerRule, allowed] = await Promise.all([
        ethClient.readContract({
          address: broadcaster,
          abi: broadcasterAbi,
          functionName: "quoteFees",
          args: [
            broadcast.targets.map((target) => target.chainKey),
            broadcast.targets.map((target) => target.target),
            broadcast.calldata,
            broadcast.lzGas,
          ],
        }),
        ethClient.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "getRule",
          args: [manifest.proposalKind, broadcaster, BROADCAST_SELECTOR],
        }) as Promise<RuleView>,
        ethClient.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "isActionAllowed",
          args: [
            manifest.proposalKind,
            broadcaster,
            plannedAction.valueWei,
            plannedAction.calldata,
          ],
        }),
      ]);
      const [outerAllowed, validateNested, nestedOnly, maxValue] =
        ruleTuple(outerRule);
      if (
        !outerAllowed ||
        !validateNested ||
        nestedOnly ||
        plannedAction.valueWei > maxValue
      ) {
        blockers.push(`Broadcaster outer policy mismatch: ${broadcast.label}`);
      }
      if (!allowed && requiredRules.size === 0) {
        blockers.push(`Nested broadcast rejected by Registry: ${broadcast.label}`);
      }
      const sufficient = quote <= broadcast.feeBudgetWei;
      quoteResults.push({
        label: broadcast.label,
        liveQuoteWei: quote,
        feeBudgetWei: broadcast.feeBudgetWei,
        sufficient,
      });
      if (!sufficient) {
        blockers.push(
          `Bridge fee budget below live quote: ${broadcast.label} ${broadcast.feeBudgetWei}/${quote}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      quoteResults.push({
        label: broadcast.label,
        feeBudgetWei: broadcast.feeBudgetWei,
        error: message,
      });
      blockers.push(`Fee/policy preflight failed: ${broadcast.label}`);
    }
  }

  const ruleInputs = [...requiredRules.values()];
  const setRulesCalldata =
    ruleInputs.length === 0
      ? undefined
      : encodeFunctionData({
          abi: registryAbi,
          functionName: "setRules",
          args: [ruleInputs],
        });

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    transactionSent: false,
    featureId: manifest.featureId,
    readyToCreateProposal: blockers.length === 0,
    blockers,
    snapshot: {
      ethBlock,
      bscBlock,
      governance,
      registry,
      broadcaster,
      executor,
      activeChainKeys,
      executorThreshold: threshold,
      currentBroadcastNonce: currentNonce,
      proposalCount,
      expectedNextProposalId: proposalCount + 1n,
      majorProposalFee,
      activationThreshold,
    },
    proposal: {
      kind: manifest.proposalKind,
      title: manifest.title,
      description: plan.description,
      actions: plan.actions,
      createProposalCalldata: plan.createProposalCalldata,
      predictedMessages: plan.predictedMessages,
      predictedMessageWarning:
        "Hashes are valid only if no other broadcast changes broadcastNonce before execution. Monitor the actual Broadcast event after execution.",
    },
    liveQuotes: quoteResults,
    requiredSetup: {
      bscAllowlist: [...requiredBscAllowlist.values()],
      registryRules: ruleInputs,
      registrySetRulesTarget: ruleInputs.length ? registry : undefined,
      registrySetRulesCalldata: setRulesCalldata,
      policyMustExecuteBeforeFeatureProposal: ruleInputs.length > 0,
    },
  };

  const rendered = `${stringify(output)}\n`;
  if (outputPath) {
    writeFileSync(join(process.cwd(), outputPath), rendered, "utf8");
  }
  process.stdout.write(rendered);
  if (blockers.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
