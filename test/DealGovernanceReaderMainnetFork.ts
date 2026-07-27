import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { zeroAddress } from "viem";

const GOVERNANCE = "0x9a41a9A85C16F590789C846Fb933fF8C715407F7" as const;
const PROPOSAL_13_DESCRIPTION = "DAO V2 cross-chain migration stage 3: copy the existing V1 Parameter and Major broadcast rules to CrossChainBroadcasterV2 0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6 while preserving the V1 rules. This proposal only updates GovernancePolicyRegistry. It does not activate the BSC route, switch the BSC DealFactory executor, send any cross-chain message, or disable V1. Purpose: prepare a controlled zero-business-change canary; immediate business impact: none.";

const describeFork = process.env.DAO_READER_MAINNET_FORK === "1" ? describe : describe.skip;

describeFork("DealGovernanceReader ETH mainnet fork", function () {
  it("matches direct DealGovernance reads and exposes proposal 13 unchanged", async function () {
    const { viem } = await network.connect({ network: "hardhatEthFork" });
    const governance = await viem.getContractAt("DealGovernance", GOVERNANCE);
    const reader = await viem.deployContract("DealGovernanceReader", [
      GOVERNANCE,
      [],
      [],
    ]);

    const total = await governance.read.proposalCount();
    assert.ok(total >= 13n);

    const directProposal = await governance.read.getProposal([13n]);
    const directState = await governance.read.state([13n]);
    const [readerProposal, readerTargets, readerValues, readerCalldatas] =
      await reader.read.getProposalDetail([13n, zeroAddress]);
    const [directTargets, directValues, directCalldatas] = await governance.read.getActions([13n]);

    assert.equal(readerProposal.proposalId, 13n);
    assert.equal(readerProposal.description, PROPOSAL_13_DESCRIPTION);
    assert.equal(readerProposal.description, directProposal.description);
    assert.equal(readerProposal.currentState, directState);
    assert.equal(readerProposal.actionsHash, directProposal.actionsHash);
    assert.equal(
      BigInt(readerProposal.createdAt),
      BigInt(directProposal.createdAt),
    );
    assert.ok(BigInt(readerProposal.createdAt) > 0n);
    assert.deepEqual(readerTargets, directTargets);
    assert.deepEqual(readerValues, directValues);
    assert.deepEqual(readerCalldatas, directCalldatas);

    const [latestPage, readerTotal] = await reader.read.getProposalPage([
      zeroAddress,
      0n,
      10n,
      true,
    ]);
    assert.equal(readerTotal, total);
    assert.equal(latestPage[0].proposalId, total);
  });
});
