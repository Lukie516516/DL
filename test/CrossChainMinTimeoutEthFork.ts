import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, maxUint256, parseEther, type Hex } from "viem";

import {
  ACTION_FEE_BUDGET,
  BASE_FACTORY,
  BROADCASTER,
  BSC_FACTORY,
  CANARY_DESCRIPTION,
  CANARY_MIN_TIMEOUT,
  CHAINS,
  CURRENT_MIN_TIMEOUT,
  GOVERNANCE,
  LZ_GAS,
  MAJOR,
  MAJOR_PROPOSAL_FEE,
  MIN_TIMEOUT_SETTER_SELECTOR,
  OWNER,
  POLICY_DESCRIPTION,
  REGISTRY,
  RESTORE_DESCRIPTION,
  buildBroadcastCalldata,
  buildMinTimeoutCalldata,
  buildSetRulesCalldata,
} from "../scripts/lib/cross-chain-min-timeout-canary.js";
import { ensureForkSpendableD } from "./helpers/mainnetForkGovernance.js";

const RUN = process.env.CROSS_CHAIN_MIN_TIMEOUT_ETH_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const D_HOLDER = getAddress("0x14800e9a1a8b39fb84aa7fa4e6d7beb553cbf0fd");
const FAST_PASS_STAKE = parseEther("70");

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
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

forkDescribe("BSC + Base minimum-timeout Ethereum governance fork", function () {
  it("executes policy, 3601 canary and separate 3600 restore without changing unrelated governance state", async function () {
    try {
      const { viem, networkHelpers } = await network.connect({ network: "hardhatEthFork", chainType: "l1" });
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
      const governanceWiringBefore = {
        dToken: getAddress(await governance.read.dToken()),
        dcToken: getAddress(await governance.read.dcToken()),
        treasury: getAddress(await governance.read.treasury()),
        policyRegistry: getAddress(await governance.read.policyRegistry()),
        activationThreshold: await governance.read.activationThreshold(),
        fastPassThreshold: await governance.read.fastPassThreshold(),
        majorFee: await governance.read.majorProposalFee(),
      };
      assert.equal(countBefore, 21n);
      assert.equal(governanceWiringBefore.policyRegistry, REGISTRY);
      assert.equal(governanceWiringBefore.majorFee, MAJOR_PROPOSAL_FEE);
      assert.equal(await dc.read.balanceOf([OWNER]), 0n);
      assert.equal(await dc.read.allowance([OWNER, GOVERNANCE]), 0n);
      assertEmptyRule(await registry.read.getRule([MAJOR, BSC_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR]));
      assertEmptyRule(await registry.read.getRule([MAJOR, BASE_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR]));

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
        assert.equal(await dc.read.balanceOf([OWNER]), 0n);
        assert.equal(await dc.read.allowance([OWNER, GOVERNANCE]), 0n);
        await waitFor(publicClient, await dcAsOwner.write.mint([OWNER, MAJOR_PROPOSAL_FEE]));
        await waitFor(publicClient, await dcAsOwner.write.approve([GOVERNANCE, MAJOR_PROPOSAL_FEE]));
        await waitFor(publicClient, await governanceAsOwner.write.createProposal([
          [target], [value], [data], description, MAJOR,
        ]));
        const id = before + 1n;
        const proposal = await governance.read.getProposal([id]);
        const actions = await governance.read.getActions([id]);
        assert.equal(await governance.read.proposalCount(), id);
        assert.equal(await governance.read.state([id]), 1);
        assert.equal(getAddress(proposal.proposer), OWNER);
        assert.equal(proposal.kind, MAJOR);
        assert.equal(proposal.totalStaked, 0n);
        assert.equal(proposal.executed, false);
        assert.equal(proposal.description, description);
        assert.deepEqual(actions[0].map((address) => getAddress(address)), [getAddress(target)]);
        assert.deepEqual(actions[1], [value]);
        assert.deepEqual(actions[2].map((item) => item.toLowerCase()), [data.toLowerCase()]);
        assert.equal(await dc.read.balanceOf([OWNER]), 0n);
        assert.equal(await dc.read.allowance([OWNER, GOVERNANCE]), 0n);
        expectedTreasury += MAJOR_PROPOSAL_FEE;
        assert.equal(await dc.read.balanceOf([treasury]), expectedTreasury);
        return id;
      };

      const policyData = buildSetRulesCalldata();
      assert.equal(
        await registry.read.isActionAllowed([MAJOR, REGISTRY, 0n, policyData]),
        true,
      );
      const policyId = await createMajor(REGISTRY, 0n, policyData, POLICY_DESCRIPTION);
      assert.equal(policyId, countBefore + 1n);
      await waitFor(publicClient, await governanceAsHolder.write.stake([policyId, FAST_PASS_STAKE]));
      assert.equal(await governance.read.state([policyId]), 3);
      await waitFor(publicClient, await governanceAsHolder.write.execute([policyId]));
      assert.equal(await governance.read.state([policyId]), 6);
      assertNestedRule(await registry.read.getRule([MAJOR, BSC_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR]));
      assertNestedRule(await registry.read.getRule([MAJOR, BASE_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR]));
      await waitFor(publicClient, await governanceAsHolder.write.claimBack([policyId]));

      const canaryBroadcast = buildBroadcastCalldata(CANARY_MIN_TIMEOUT);
      const restoreBroadcast = buildBroadcastCalldata(CURRENT_MIN_TIMEOUT);
      assert.equal(await registry.read.isActionAllowed([MAJOR, BROADCASTER, ACTION_FEE_BUDGET, canaryBroadcast]), true);
      assert.equal(await registry.read.isActionAllowed([MAJOR, BROADCASTER, ACTION_FEE_BUDGET, restoreBroadcast]), true);
      const canaryQuote = await broadcaster.read.quoteFees([
        CHAINS.map((chain) => chain.chainKey),
        CHAINS.map((chain) => chain.factory),
        buildMinTimeoutCalldata(CANARY_MIN_TIMEOUT),
        LZ_GAS,
      ]);
      assert.ok(canaryQuote > 0n && canaryQuote <= ACTION_FEE_BUDGET);
      const canaryId = await createMajor(BROADCASTER, ACTION_FEE_BUDGET, canaryBroadcast, CANARY_DESCRIPTION);
      assert.equal(canaryId, countBefore + 2n);
      await waitFor(publicClient, await governanceAsHolder.write.stake([canaryId, FAST_PASS_STAKE]));
      await waitFor(publicClient, await governanceAsHolder.write.execute([canaryId], { value: ACTION_FEE_BUDGET }));
      assert.equal(await governance.read.state([canaryId]), 6);
      assert.equal(await broadcaster.read.broadcastNonce(), nonceBefore + 1n);
      await waitFor(publicClient, await governanceAsHolder.write.claimBack([canaryId]));

      const restoreQuote = await broadcaster.read.quoteFees([
        CHAINS.map((chain) => chain.chainKey),
        CHAINS.map((chain) => chain.factory),
        buildMinTimeoutCalldata(CURRENT_MIN_TIMEOUT),
        LZ_GAS,
      ]);
      assert.ok(restoreQuote > 0n && restoreQuote <= ACTION_FEE_BUDGET);
      const restoreId = await createMajor(BROADCASTER, ACTION_FEE_BUDGET, restoreBroadcast, RESTORE_DESCRIPTION);
      assert.equal(restoreId, countBefore + 3n);
      await waitFor(publicClient, await governanceAsHolder.write.stake([restoreId, FAST_PASS_STAKE]));
      await waitFor(publicClient, await governanceAsHolder.write.execute([restoreId], { value: ACTION_FEE_BUDGET }));
      assert.equal(await governance.read.state([restoreId]), 6);
      assert.equal(await broadcaster.read.broadcastNonce(), nonceBefore + 2n);
      await waitFor(publicClient, await governanceAsHolder.write.claimBack([restoreId]));

      assert.equal(await governance.read.proposalCount(), countBefore + 3n);
      assert.equal(await governance.read.executedProposalCount(), executedBefore + 3n);
      assert.equal(await dc.read.totalSupply(), supplyBefore + MAJOR_PROPOSAL_FEE * 3n);
      assert.equal(await dc.read.balanceOf([treasury]), treasuryBefore + MAJOR_PROPOSAL_FEE * 3n);
      assert.equal(await d.read.balanceOf([D_HOLDER]), holderSpendableStart);
      assert.deepEqual({
        dToken: getAddress(await governance.read.dToken()),
        dcToken: getAddress(await governance.read.dcToken()),
        treasury: getAddress(await governance.read.treasury()),
        policyRegistry: getAddress(await governance.read.policyRegistry()),
        activationThreshold: await governance.read.activationThreshold(),
        fastPassThreshold: await governance.read.fastPassThreshold(),
        majorFee: await governance.read.majorProposalFee(),
      }, governanceWiringBefore);
    } catch (error) {
      console.error("Minimum-timeout ETH governance fork error:", error);
      throw error;
    }
  });
});
