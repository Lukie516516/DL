import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, maxUint256, parseAbi, parseEther, toHex, type Hex } from "viem";
import {
  ACTION_FEE_BUDGET, BASE_CHAIN_KEY, BASE_EXECUTOR, BASE_PROBE, BROADCASTER,
  BSC_CHAIN_KEY, GOVERNANCE, LZ_GAS, MAJOR, MAJOR_PROPOSAL_FEE, OWNER, REGISTRY,
  broadcasterAbi, executorAbi, governanceAbi, registryAbi,
} from "../scripts/lib/cross-chain-message-fee-canary.js";
import {
  BASE_PROBE_CLEANUP_DESCRIPTION, buildBaseProbeCleanupBroadcastCalldata,
  buildBaseProbeCleanupInnerCalldata,
} from "../scripts/lib/base-probe-cleanup.js";
import { ensureForkSpendableD } from "./helpers/mainnetForkGovernance.js";

const RUN = process.env.BASE_PROBE_CLEANUP_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const HOLDER = getAddress("0x14800e9a1a8b39fb84aa7fa4e6d7beb553cbf0fd");
const tokenAbi = parseAbi([
  "function mint(address,uint256)", "function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)",
]);
async function waitFor(client: any, hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, "success");
}

forkDescribe("Base Probe cleanup production flow", function () {
  it("creates #27 while both routes are active and executes only after temporary BSC isolation", async function () {
    const { viem, networkHelpers } = await network.connect({ network: "hardhatEthFork", chainType: "l1" });
    const client = await viem.getPublicClient();
    const governance = await viem.getContractAt("DealGovernance", GOVERNANCE);
    const registry = await viem.getContractAt("GovernancePolicyRegistry", REGISTRY);
    const broadcaster = await viem.getContractAt("CrossChainBroadcasterV2", BROADCASTER);
    const inner = buildBaseProbeCleanupInnerCalldata();
    const outer = buildBaseProbeCleanupBroadcastCalldata();
    assert.equal(await governance.read.proposalCount(), 26n);
    assert.equal(await registry.read.isActionAllowed([MAJOR, BROADCASTER, ACTION_FEE_BUDGET, outer]), true);
    assert.equal((await broadcaster.read.chains([BSC_CHAIN_KEY]))[6], true);
    assert.equal((await broadcaster.read.chains([BASE_CHAIN_KEY]))[6], true);
    await assert.rejects(() => broadcaster.read.quoteFees([[BASE_CHAIN_KEY], [BASE_EXECUTOR], inner, LZ_GAS]));

    await networkHelpers.impersonateAccount(OWNER); await networkHelpers.setBalance(OWNER, parseEther("10"));
    const ownerWallet = await viem.getWalletClient(OWNER);
    const broadcasterAsOwner = await viem.getContractAt("CrossChainBroadcasterV2", BROADCASTER, { client: { public: client, wallet: ownerWallet } });
    const governanceAsOwner = await viem.getContractAt("DealGovernance", GOVERNANCE, { client: { public: client, wallet: ownerWallet } });
    const dcAddress = getAddress(await governance.read.dcToken());
    const dcAsOwner = await viem.getContractAt("DCToken", dcAddress, { client: { public: client, wallet: ownerWallet } });
    await waitFor(client, await dcAsOwner.write.mint([OWNER, MAJOR_PROPOSAL_FEE]));
    await waitFor(client, await dcAsOwner.write.approve([GOVERNANCE, MAJOR_PROPOSAL_FEE]));
    await waitFor(client, await governanceAsOwner.write.createProposal([[BROADCASTER], [ACTION_FEE_BUDGET], [outer], BASE_PROBE_CLEANUP_DESCRIPTION, MAJOR]));
    assert.equal(await governance.read.proposalCount(), 27n);
    assert.equal(await governance.read.state([27n]), 1);
    assert.equal((await governance.read.getProposal([27n])).totalStaked, 0n);
    assert.equal(await broadcaster.read.broadcastNonce(), 5n);

    await networkHelpers.impersonateAccount(HOLDER); await networkHelpers.setBalance(HOLDER, parseEther("5"));
    const holderWallet = await viem.getWalletClient(HOLDER);
    const dAddress = getAddress(await governance.read.dToken());
    const dAsHolder = await viem.getContractAt("D", dAddress, { client: { public: client, wallet: holderWallet } });
    const governanceAsHolder = await viem.getContractAt("DealGovernance", GOVERNANCE, { client: { public: client, wallet: holderWallet } });
    await ensureForkSpendableD({ publicClient: client, governance: governanceAsHolder, dToken: dAsHolder, holder: HOLDER, required: parseEther("70") });
    await waitFor(client, await dAsHolder.write.approve([GOVERNANCE, maxUint256]));
    await waitFor(client, await governanceAsHolder.write.stake([27n, parseEther("70")]));
    assert.equal(await governance.read.state([27n]), 3);
    await assert.rejects(() => governanceAsHolder.write.execute([27n], { value: ACTION_FEE_BUDGET }));
    assert.equal(await governance.read.state([27n]), 3);

    await waitFor(client, await broadcasterAsOwner.write.setChainActive([BSC_CHAIN_KEY, false]));
    const quote = await broadcaster.read.quoteFees([[BASE_CHAIN_KEY], [BASE_EXECUTOR], inner, LZ_GAS]);
    assert.ok(quote > 0n && quote <= ACTION_FEE_BUDGET);
    await waitFor(client, await governanceAsHolder.write.execute([27n], { value: ACTION_FEE_BUDGET }));
    assert.equal(await governance.read.state([27n]), 6);
    assert.equal(await broadcaster.read.broadcastNonce(), 6n);
    await waitFor(client, await broadcasterAsOwner.write.setChainActive([BSC_CHAIN_KEY, true]));
    assert.equal((await broadcaster.read.chains([BSC_CHAIN_KEY]))[6], true);
    assert.equal((await broadcaster.read.chains([BASE_CHAIN_KEY]))[6], true);
  });

  it("closes the Base Probe after two synthetic confirmations without affecting Executor self access", async function () {
    const { viem, networkHelpers } = await network.connect({ network: "hardhatBaseFork", chainType: "op" });
    const client = await viem.getPublicClient();
    const executor = await viem.getContractAt("DualBridgeExecutorV2", BASE_EXECUTOR);
    assert.equal(await executor.read.allowedTargets([BASE_PROBE]), true);
    assert.equal(await executor.read.allowedTargets([BASE_EXECUTOR]), true);
    const payload = encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bytes" }], [999n, BASE_EXECUTOR, buildBaseProbeCleanupInnerCalldata()]);
    const hash = keccak256(payload);
    const endpoint = getAddress(await executor.read.endpoint());
    const router = getAddress(await executor.read.ccipRouter());
    const peer = await executor.read.peers([30_101]);
    const selector = await executor.read.ccipSrcChainSelector();
    await networkHelpers.impersonateAccount(endpoint); await networkHelpers.setBalance(endpoint, parseEther("2"));
    await networkHelpers.impersonateAccount(router); await networkHelpers.setBalance(router, parseEther("2"));
    const endpointWallet = await viem.getWalletClient(endpoint), routerWallet = await viem.getWalletClient(router);
    const asLz = await viem.getContractAt("DualBridgeExecutorV2", BASE_EXECUTOR, { client: { public: client, wallet: endpointWallet } });
    const asCcip = await viem.getContractAt("DualBridgeExecutorV2", BASE_EXECUTOR, { client: { public: client, wallet: routerWallet } });
    await waitFor(client, await asLz.write.lzReceive([{ srcEid: 30_101, sender: peer, nonce: 999n }, keccak256(toHex(999n)), payload, BASE_EXECUTOR, "0x"]));
    assert.equal(await executor.read.allowedTargets([BASE_PROBE]), true);
    await waitFor(client, await asCcip.write.ccipReceive([{ messageId: keccak256(toHex(1000n)), sourceChainSelector: selector, sender: encodeAbiParameters([{ type: "address" }], [BROADCASTER]), data: payload, destTokenAmounts: [] }]));
    assert.equal((await executor.read.confirmStatus([hash]))[4], true);
    assert.equal(await executor.read.executionAttempts([hash]), 1n);
    assert.equal(await executor.read.allowedTargets([BASE_PROBE]), false);
    assert.equal(await executor.read.allowedTargets([BASE_EXECUTOR]), true);
  });
});
