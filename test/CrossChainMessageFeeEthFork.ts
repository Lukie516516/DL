import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, maxUint256, parseEther, type Hex } from "viem";

import {
  ACTION_FEE_BUDGET,
  BASE_EXECUTOR,
  BASE_FACTORY,
  BASE_PROBE,
  BROADCASTER,
  BSC_FACTORY,
  BSC_PROBE,
  CANARY_DESCRIPTION,
  CANARY_MESSAGE_FEE,
  CHAIN_FEE_CONFIGS,
  CURRENT_MESSAGE_FEE,
  EXECUTOR_ALLOWLIST_SELECTOR,
  GOVERNANCE,
  LZ_GAS,
  MAJOR,
  MAJOR_PROPOSAL_FEE,
  MESSAGE_FEE_SETTER_SELECTOR,
  OWNER,
  POLICY_DESCRIPTION,
  PROBE_MARKER_SELECTOR,
  REGISTRY,
  RESTORE_DESCRIPTION,
  buildMessageFeeActions,
  buildSetRulesCalldata,
} from "../scripts/lib/cross-chain-message-fee-canary.js";
import { ensureForkSpendableD } from "./helpers/mainnetForkGovernance.js";

const RUN = process.env.CROSS_CHAIN_MESSAGE_FEE_ETH_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const D_HOLDER = getAddress("0x14800e9a1a8b39fb84aa7fa4e6d7beb553cbf0fd");
const FAST_PASS_STAKE = parseEther("70");

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
}

function assertEmptyRule(rule: any) {
  assert.equal(rule.allowed ?? rule[0], false);
  assert.equal(rule.validateNestedBroadcast ?? rule[1], false);
  assert.equal(rule.nestedOnly ?? rule[2], false);
  assert.equal(rule.maxValue ?? rule[3], 0n);
}

function assertNestedRule(rule: any) {
  assert.equal(rule.allowed ?? rule[0], true);
  assert.equal(rule.validateNestedBroadcast ?? rule[1], false);
  assert.equal(rule.nestedOnly ?? rule[2], true);
  assert.equal(rule.maxValue ?? rule[3], 0n);
}

forkDescribe("BSC + Base message-fee Ethereum governance fork", function () {
  it("closes Probe policies and executes separate 104 -> 105 -> 104 broadcasts", async function () {
    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 1);
    const governance = await viem.getContractAt("DealGovernance", GOVERNANCE);
    const registry = await viem.getContractAt("GovernancePolicyRegistry", REGISTRY);
    const broadcaster = await viem.getContractAt("CrossChainBroadcasterV2", BROADCASTER);
    const dcAddress = getAddress(await governance.read.dcToken());
    const dAddress = getAddress(await governance.read.dToken());
    const treasury = getAddress(await governance.read.treasury());
    const dc = await viem.getContractAt("DCToken", dcAddress);
    const d = await viem.getContractAt("D", dAddress);

    const countBefore = await governance.read.proposalCount();
    const executedBefore = await governance.read.executedProposalCount();
    const nonceBefore = await broadcaster.read.broadcastNonce();
    const supplyBefore = await dc.read.totalSupply();
    const treasuryBefore = await dc.read.balanceOf([treasury]);
    assert.equal(countBefore, 23n);
    assert.equal(await governance.read.majorProposalFee(), MAJOR_PROPOSAL_FEE);
    assert.equal(await dc.read.balanceOf([OWNER]), 0n);
    assert.equal(await dc.read.allowance([OWNER, GOVERNANCE]), 0n);
    assertNestedRule(await registry.read.getRule([MAJOR, BSC_PROBE, PROBE_MARKER_SELECTOR]));
    assertNestedRule(await registry.read.getRule([MAJOR, BASE_PROBE, PROBE_MARKER_SELECTOR]));
    assertEmptyRule(await registry.read.getRule([MAJOR, BSC_FACTORY, MESSAGE_FEE_SETTER_SELECTOR]));
    assertEmptyRule(await registry.read.getRule([MAJOR, BASE_FACTORY, MESSAGE_FEE_SETTER_SELECTOR]));
    assertEmptyRule(await registry.read.getRule([MAJOR, BASE_EXECUTOR, EXECUTOR_ALLOWLIST_SELECTOR]));

    await networkHelpers.impersonateAccount(OWNER);
    await networkHelpers.setBalance(OWNER, parseEther("5"));
    const ownerWallet = await viem.getWalletClient(OWNER);
    const dcAsOwner = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: ownerWallet },
    });
    const governanceAsOwner = await viem.getContractAt("DealGovernance", GOVERNANCE, {
      client: { public: publicClient, wallet: ownerWallet },
    });

    await networkHelpers.impersonateAccount(D_HOLDER);
    await networkHelpers.setBalance(D_HOLDER, parseEther("5"));
    const holderWallet = await viem.getWalletClient(D_HOLDER);
    const dAsHolder = await viem.getContractAt("D", dAddress, {
      client: { public: publicClient, wallet: holderWallet },
    });
    const governanceAsHolder = await viem.getContractAt("DealGovernance", GOVERNANCE, {
      client: { public: publicClient, wallet: holderWallet },
    });
    await ensureForkSpendableD({
      publicClient,
      governance: governanceAsHolder,
      dToken: dAsHolder,
      holder: D_HOLDER,
      required: FAST_PASS_STAKE,
    });
    const holderSpendableStart = await d.read.balanceOf([D_HOLDER]);
    await waitFor(publicClient, await dAsHolder.write.approve([GOVERNANCE, maxUint256]));

    let expectedTreasury = treasuryBefore;
    const createMajor = async (target: `0x${string}`, value: bigint, data: Hex, description: string) => {
      const before = await governance.read.proposalCount();
      await waitFor(publicClient, await dcAsOwner.write.mint([OWNER, MAJOR_PROPOSAL_FEE]));
      await waitFor(publicClient, await dcAsOwner.write.approve([GOVERNANCE, MAJOR_PROPOSAL_FEE]));
      await waitFor(publicClient, await governanceAsOwner.write.createProposal([
        [target], [value], [data], description, MAJOR,
      ]));
      const id = before + 1n;
      const proposal = await governance.read.getProposal([id]);
      assert.equal(await governance.read.state([id]), 1);
      assert.equal(proposal.description, description);
      assert.equal(proposal.totalStaked, 0n);
      assert.equal(proposal.executed, false);
      expectedTreasury += MAJOR_PROPOSAL_FEE;
      assert.equal(await dc.read.balanceOf([treasury]), expectedTreasury);
      assert.equal(await dc.read.balanceOf([OWNER]), 0n);
      assert.equal(await dc.read.allowance([OWNER, GOVERNANCE]), 0n);
      return id;
    };

    const policyData = buildSetRulesCalldata();
    assert.equal(await registry.read.isActionAllowed([MAJOR, REGISTRY, 0n, policyData]), true);
    const policyId = await createMajor(REGISTRY, 0n, policyData, POLICY_DESCRIPTION);
    await waitFor(publicClient, await governanceAsHolder.write.stake([policyId, FAST_PASS_STAKE]));
    assert.equal(await governance.read.state([policyId]), 3);
    await waitFor(publicClient, await governanceAsHolder.write.execute([policyId]));
    await waitFor(publicClient, await governanceAsHolder.write.claimBack([policyId]));
    assertEmptyRule(await registry.read.getRule([MAJOR, BSC_PROBE, PROBE_MARKER_SELECTOR]));
    assertEmptyRule(await registry.read.getRule([MAJOR, BASE_PROBE, PROBE_MARKER_SELECTOR]));
    assertNestedRule(await registry.read.getRule([MAJOR, BSC_FACTORY, MESSAGE_FEE_SETTER_SELECTOR]));
    assertNestedRule(await registry.read.getRule([MAJOR, BASE_FACTORY, MESSAGE_FEE_SETTER_SELECTOR]));
    assertNestedRule(await registry.read.getRule([MAJOR, BASE_EXECUTOR, EXECUTOR_ALLOWLIST_SELECTOR]));

    for (const [price, description] of [
      [CANARY_MESSAGE_FEE, CANARY_DESCRIPTION],
      [CURRENT_MESSAGE_FEE, RESTORE_DESCRIPTION],
    ] as const) {
      const action = buildMessageFeeActions(price)[0];
      const quote = await broadcaster.read.quoteFees([
        CHAIN_FEE_CONFIGS.map((chain) => chain.chainKey),
        CHAIN_FEE_CONFIGS.map((chain) => chain.factory),
        action.innerCalldata,
        LZ_GAS,
      ]);
      assert.ok(quote > 0n && quote <= ACTION_FEE_BUDGET);
      assert.equal(
        await registry.read.isActionAllowed([MAJOR, BROADCASTER, action.value, action.calldata]),
        true,
      );
      const id = await createMajor(BROADCASTER, action.value, action.calldata, description);
      await waitFor(publicClient, await governanceAsHolder.write.stake([id, FAST_PASS_STAKE]));
      await waitFor(publicClient, await governanceAsHolder.write.execute([id], { value: action.value }));
      await waitFor(publicClient, await governanceAsHolder.write.claimBack([id]));
    }

    assert.equal(await governance.read.proposalCount(), countBefore + 3n);
    assert.equal(await governance.read.executedProposalCount(), executedBefore + 3n);
    assert.equal(await broadcaster.read.broadcastNonce(), nonceBefore + 2n);
    assert.equal(await dc.read.totalSupply(), supplyBefore + MAJOR_PROPOSAL_FEE * 3n);
    assert.equal(await d.read.balanceOf([D_HOLDER]), holderSpendableStart);
  });
});
