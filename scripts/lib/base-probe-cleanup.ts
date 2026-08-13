import { encodeFunctionData, parseEther, type Hex } from "viem";
import {
  ACTION_FEE_BUDGET, BASE_CHAIN_KEY, BASE_EXECUTOR, BASE_PROBE, BROADCASTER,
  LZ_GAS, MAJOR, broadcasterAbi, executorAbi, governanceAbi,
} from "./cross-chain-message-fee-canary.js";

export const BASE_PROBE_CLEANUP_DESCRIPTION = "关闭Base测试合约权限。";

export function buildBaseProbeCleanupInnerCalldata(): Hex {
  return encodeFunctionData({
    abi: executorAbi,
    functionName: "setAllowedTarget",
    args: [BASE_PROBE, false],
  });
}

export function buildBaseProbeCleanupBroadcastCalldata(): Hex {
  return encodeFunctionData({
    abi: broadcasterAbi,
    functionName: "broadcast",
    args: [[BASE_CHAIN_KEY], [BASE_EXECUTOR], buildBaseProbeCleanupInnerCalldata(), LZ_GAS],
  });
}

export function buildBaseProbeCleanupProposalCalldata(): Hex {
  return encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [
      [BROADCASTER],
      [ACTION_FEE_BUDGET],
      [buildBaseProbeCleanupBroadcastCalldata()],
      BASE_PROBE_CLEANUP_DESCRIPTION,
      MAJOR,
    ],
  });
}
