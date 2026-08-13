import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther, toFunctionSelector, type Hex } from "viem";

const RUN = process.env.BASE_CROSS_CHAIN_V2_POLICY_PROPOSAL_ETH_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
const BASE_PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const BASE_CHAIN_KEY = 30_184;
const MAJOR = 2;
const FEE = parseEther("1000");
const SELECTOR = toFunctionSelector("recordMarker(bytes32)");

type Plan = {
  currentState: { proposalCount: string; expectedPolicyProposalId: string };
  policy: { description: string; setRulesCalldata: Hex };
};

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

forkDescribe("Base CrossChain V2 policy proposal Ethereum fork", function () {
  it("mints and consumes exactly 1000 DC while creating only the Pending policy proposal", async function () {
    const plan = JSON.parse(
      readFileSync("deployments/base-cross-chain-v2-canary-plan.json", "utf8"),
    ) as Plan;
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
    const treasury = getAddress(await governance.read.treasury());
    const dc = await viem.getContractAt("DCToken", dcAddress);

    const countBefore = await governance.read.proposalCount();
    assert.equal(countBefore.toString(), plan.currentState.proposalCount);
    assert.equal((countBefore + 1n).toString(), plan.currentState.expectedPolicyProposalId);
    assert.equal(await governance.read.majorProposalFee(), FEE);
    assert.equal(await dc.read.balanceOf([OWNER]), 0n);
    assert.equal(await dc.read.allowance([OWNER, GOVERNANCE]), 0n);
    const supplyBefore = await dc.read.totalSupply();
    const treasuryBefore = await dc.read.balanceOf([treasury]);
    const nonceBefore = await broadcaster.read.broadcastNonce();
    assert.equal((await broadcaster.read.chains([BASE_CHAIN_KEY]))[6], false);
    assertEmptyRule(await registry.read.getRule([MAJOR, BSC_PROBE, SELECTOR]));
    assertEmptyRule(await registry.read.getRule([MAJOR, BASE_PROBE, SELECTOR]));

    for (let id = 1n; id <= countBefore; id += 1n) {
      const actions = await governance.read.getActions([id]);
      const duplicate = actions[0].length === 1
        && actions[0][0].toLowerCase() === REGISTRY.toLowerCase()
        && actions[1].length === 1 && actions[1][0] === 0n
        && actions[2].length === 1
        && actions[2][0].toLowerCase() === plan.policy.setRulesCalldata.toLowerCase();
      assert.equal(duplicate, false, `duplicate proposal ${id}`);
    }

    await networkHelpers.impersonateAccount(OWNER);
    await networkHelpers.setBalance(OWNER, parseEther("2"));
    const ownerWallet = await viem.getWalletClient(OWNER);
    const dcAsOwner = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: ownerWallet },
    });
    const governanceAsOwner = await viem.getContractAt("DealGovernance", GOVERNANCE, {
      client: { public: publicClient, wallet: ownerWallet },
    });

    await waitFor(publicClient, await dcAsOwner.write.mint([OWNER, FEE]));
    assert.equal(await dc.read.balanceOf([OWNER]), FEE);
    assert.equal(await dc.read.totalSupply(), supplyBefore + FEE);
    await waitFor(publicClient, await dcAsOwner.write.approve([GOVERNANCE, FEE]));
    assert.equal(await dc.read.allowance([OWNER, GOVERNANCE]), FEE);

    await waitFor(publicClient, await governanceAsOwner.write.createProposal([
      [REGISTRY],
      [0n],
      [plan.policy.setRulesCalldata],
      plan.policy.description,
      MAJOR,
    ]));

    const proposalId = countBefore + 1n;
    const proposal = await governance.read.getProposal([proposalId]);
    const actions = await governance.read.getActions([proposalId]);
    assert.equal(await governance.read.proposalCount(), proposalId);
    assert.equal(await governance.read.state([proposalId]), 1);
    assert.equal(getAddress(proposal.proposer), OWNER);
    assert.equal(proposal.kind, MAJOR);
    assert.equal(proposal.totalStaked, 0n);
    assert.equal(proposal.executed, false);
    assert.equal(proposal.description, plan.policy.description);
    assert.deepEqual(actions[0].map(getAddress), [REGISTRY]);
    assert.deepEqual(actions[1], [0n]);
    assert.deepEqual(actions[2].map((data) => data.toLowerCase()), [plan.policy.setRulesCalldata.toLowerCase()]);
    assert.equal(await dc.read.balanceOf([OWNER]), 0n);
    assert.equal(await dc.read.allowance([OWNER, GOVERNANCE]), 0n);
    assert.equal(await dc.read.totalSupply(), supplyBefore + FEE);
    assert.equal(await dc.read.balanceOf([treasury]), treasuryBefore + FEE);
    assertEmptyRule(await registry.read.getRule([MAJOR, BSC_PROBE, SELECTOR]));
    assertEmptyRule(await registry.read.getRule([MAJOR, BASE_PROBE, SELECTOR]));
    assert.equal((await broadcaster.read.chains([BASE_CHAIN_KEY]))[6], false);
    assert.equal(await broadcaster.read.broadcastNonce(), nonceBefore);
  });
});
