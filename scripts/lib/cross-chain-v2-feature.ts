import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isHex,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

export const BROADCAST_SELECTOR = "0xfd9c0ab9" as Hex;

export const broadcasterAbi = parseAbi([
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
]);

export const governanceAbi = parseAbi([
  "function majorProposalFee() view returns (uint256)",
  "function activationThreshold() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function policyRegistry() view returns (address)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);

export const registryAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
  "function setRules((uint8 kind,address target,bytes4 selector,bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)[])",
]);

export const executorAbi = parseAbi([
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
  "function setAllowedTarget(address,bool)",
  "function confirmStatus(bytes32) view returns (bool layerZero,bool chainlinkCcip,bool axelar,uint256 count,bool executed)",
  "function executionAttempts(bytes32) view returns (uint256)",
]);

type JsonRecord = Record<string, unknown>;

export type FeatureAction = {
  label: string;
  target: Address;
  valueWei: bigint;
  calldata: Hex;
};

export type RemoteTarget = {
  chainKey: number;
  target: Address;
};

export type FeatureBroadcast = {
  label: string;
  targets: RemoteTarget[];
  calldata: Hex;
  lzGas: bigint;
  feeBudgetWei: bigint;
};

export type FeatureManifest = {
  schemaVersion: 1;
  featureId: string;
  proposalKind: 0 | 2;
  title: string;
  body: string;
  localActions: FeatureAction[];
  broadcasts: FeatureBroadcast[];
};

export type PlannedAction = {
  label: string;
  target: Address;
  valueWei: bigint;
  calldata: Hex;
  selector: Hex;
  type: "local" | "broadcast";
};

export type PredictedRemoteMessage = {
  broadcastLabel: string;
  nonce: bigint;
  chainKey: number;
  target: Address;
  calldata: Hex;
  messageHash: Hex;
};

export type ProposalPlan = {
  description: string;
  actions: PlannedAction[];
  createProposalCalldata: Hex;
  predictedMessages: PredictedRemoteMessage[];
};

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function uint(value: unknown, label: string): bigint {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+$/.test(String(value))
  ) {
    throw new Error(`${label} must be an unsigned integer string`);
  }
  return BigInt(value);
}

function calldata(value: unknown, label: string): Hex {
  if (
    typeof value !== "string" ||
    !isHex(value) ||
    value.length < 10 ||
    value.length % 2 !== 0
  ) {
    throw new Error(`${label} must contain at least a 4-byte selector`);
  }
  return value as Hex;
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`${label} must be an address`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid EVM address`);
  }
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function selector(data: Hex): Hex {
  return data.slice(0, 10) as Hex;
}

export function normalizeFeatureManifest(input: unknown): FeatureManifest {
  const root = record(input, "manifest");
  if (root.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const proposalKind = Number(root.proposalKind);
  if (proposalKind !== 0 && proposalKind !== 2) {
    throw new Error("proposalKind must be 0 (Parameter) or 2 (Major)");
  }

  const title = stringField(root.title, "title");
  if (title.includes("\n") || [...title].length > 32) {
    throw new Error("title must be one line and no longer than 32 characters");
  }

  const localActions = array(root.localActions ?? [], "localActions").map(
    (raw, index): FeatureAction => {
      const item = record(raw, `localActions[${index}]`);
      return {
        label: stringField(item.label, `localActions[${index}].label`),
        target: address(item.target, `localActions[${index}].target`),
        valueWei: uint(item.valueWei ?? "0", `localActions[${index}].valueWei`),
        calldata: calldata(item.calldata, `localActions[${index}].calldata`),
      };
    },
  );

  const broadcasts = array(root.broadcasts, "broadcasts").map(
    (raw, index): FeatureBroadcast => {
      const item = record(raw, `broadcasts[${index}]`);
      const targets = array(item.targets, `broadcasts[${index}].targets`).map(
        (rawTarget, targetIndex): RemoteTarget => {
          const target = record(
            rawTarget,
            `broadcasts[${index}].targets[${targetIndex}]`,
          );
          const chainKey = Number(
            uint(
              target.chainKey,
              `broadcasts[${index}].targets[${targetIndex}].chainKey`,
            ),
          );
          if (!Number.isSafeInteger(chainKey) || chainKey <= 0) {
            throw new Error(
              `broadcasts[${index}].targets[${targetIndex}].chainKey is unsafe`,
            );
          }
          return {
            chainKey,
            target: address(
              target.target,
              `broadcasts[${index}].targets[${targetIndex}].target`,
            ),
          };
        },
      );
      if (targets.length === 0) {
        throw new Error(`broadcasts[${index}].targets cannot be empty`);
      }
      if (new Set(targets.map((target) => target.chainKey)).size !== targets.length) {
        throw new Error(`broadcasts[${index}] contains duplicate chain keys`);
      }

      const lzGas = uint(item.lzGas, `broadcasts[${index}].lzGas`);
      if (lzGas === 0n || lzGas > (1n << 128n) - 1n) {
        throw new Error(`broadcasts[${index}].lzGas must fit uint128 and be non-zero`);
      }
      const feeBudgetWei = uint(
        item.feeBudgetWei,
        `broadcasts[${index}].feeBudgetWei`,
      );
      if (feeBudgetWei === 0n) {
        throw new Error(`broadcasts[${index}].feeBudgetWei must be non-zero`);
      }

      return {
        label: stringField(item.label, `broadcasts[${index}].label`),
        targets,
        calldata: calldata(item.calldata, `broadcasts[${index}].calldata`),
        lzGas,
        feeBudgetWei,
      };
    },
  );
  if (broadcasts.length === 0) throw new Error("broadcasts cannot be empty");

  return {
    schemaVersion: 1,
    featureId: stringField(root.featureId, "featureId"),
    proposalKind,
    title,
    body: stringField(root.body, "body"),
    localActions,
    broadcasts,
  };
}

export function messageHash(nonce: bigint, target: Address, data: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [nonce, target, data],
    ),
  );
}

export function buildProposalPlan(
  manifest: FeatureManifest,
  broadcaster: Address,
  currentBroadcastNonce: bigint,
): ProposalPlan {
  const actions: PlannedAction[] = manifest.localActions.map((action) => ({
    ...action,
    selector: selector(action.calldata),
    type: "local",
  }));
  const predictedMessages: PredictedRemoteMessage[] = [];

  manifest.broadcasts.forEach((broadcast, index) => {
    const nonce = currentBroadcastNonce + BigInt(index) + 1n;
    const chainKeys = broadcast.targets.map((target) => target.chainKey);
    const targets = broadcast.targets.map((target) => target.target);
    const broadcastCalldata = encodeFunctionData({
      abi: broadcasterAbi,
      functionName: "broadcast",
      args: [chainKeys, targets, broadcast.calldata, broadcast.lzGas],
    });
    actions.push({
      label: broadcast.label,
      target: broadcaster,
      valueWei: broadcast.feeBudgetWei,
      calldata: broadcastCalldata,
      selector: BROADCAST_SELECTOR,
      type: "broadcast",
    });
    for (const target of broadcast.targets) {
      predictedMessages.push({
        broadcastLabel: broadcast.label,
        nonce,
        chainKey: target.chainKey,
        target: target.target,
        calldata: broadcast.calldata,
        messageHash: messageHash(nonce, target.target, broadcast.calldata),
      });
    }
  });

  const description = `${manifest.title}\n\n${manifest.body}`;
  const createProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [
      actions.map((action) => action.target),
      actions.map((action) => action.valueWei),
      actions.map((action) => action.calldata),
      description,
      manifest.proposalKind,
    ],
  });

  return {
    description,
    actions,
    createProposalCalldata,
    predictedMessages,
  };
}

export function actionSelector(data: Hex): Hex {
  return selector(data);
}

export function sameNumberSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, index) => value === right[index]);
}
