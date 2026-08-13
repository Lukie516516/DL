import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseAbi, parseEther, parseEventLogs, type Address, type Hex } from "viem";

const RUN = process.env.DEAL_FACTORY_CROSSCHAIN_UPGRADE_EXECUTION_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const PROPOSAL_ID = 23n;
const EXECUTION_VALUE = parseEther("0.005");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const BSC_FACTORY = getAddress("0x1Ca748Feb347d0d177E844E7D4CDCA908957c256");
const BASE_FACTORY = getAddress("0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D");
const broadcastEventAbi = parseAbi([
  "event Broadcast(uint256 indexed nonce,uint32[] targetChainIds,address[] targets,bytes data)",
]);

type ProposalRecord = {
  proposalId: string;
  broadcastNonceBefore: string;
  broadcastCalldata: Hex;
  innerUpgradeCalldata: Hex;
};

forkDescribe("DealFactory cross-chain upgrade proposal execution", function () {
  it("executes only proposal #23 and emits one exact BSC + Base broadcast", async function () {
    const saved = JSON.parse(
      readFileSync("deployments/deal-factory-crosschain-upgrade-proposal.json", "utf8"),
    ) as ProposalRecord;
    assert.equal(saved.proposalId, PROPOSAL_ID.toString());

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 1);
    const governance = await viem.getContractAt("DealGovernance", GOVERNANCE);
    const broadcaster = await viem.getContractAt("CrossChainBroadcasterV2", BROADCASTER);
    const [proposal, actions, nonceBefore, executedCountBefore] = await Promise.all([
      governance.read.getProposal([PROPOSAL_ID]),
      governance.read.getActions([PROPOSAL_ID]),
      broadcaster.read.broadcastNonce(),
      governance.read.executedProposalCount(),
    ]);

    assert.equal(await governance.read.state([PROPOSAL_ID]), 3);
    assert.equal(proposal.totalStaked, parseEther("70"));
    assert.equal(proposal.executed, false);
    assert.deepEqual(actions[0].map(getAddress), [BROADCASTER]);
    assert.deepEqual(actions[1], [EXECUTION_VALUE]);
    assert.equal(actions[2][0].toLowerCase(), saved.broadcastCalldata.toLowerCase());
    assert.equal(nonceBefore, BigInt(saved.broadcastNonceBefore));
    assert.deepEqual(await broadcaster.read.getChainIds(), [BSC_CHAIN_KEY, BASE_CHAIN_KEY]);
    assert.equal((await broadcaster.read.chains([BSC_CHAIN_KEY]))[6], true);
    assert.equal((await broadcaster.read.chains([BASE_CHAIN_KEY]))[6], true);
    const quote = await broadcaster.read.quoteFees([
      [BSC_CHAIN_KEY, BASE_CHAIN_KEY],
      [BSC_FACTORY, BASE_FACTORY],
      saved.innerUpgradeCalldata,
      500_000n,
    ]);
    assert.ok(quote > 0n && quote <= EXECUTION_VALUE);

    await networkHelpers.impersonateAccount(OWNER);
    await networkHelpers.setBalance(OWNER, parseEther("2"));
    const ownerWallet = await viem.getWalletClient(OWNER);
    const governanceAsOwner = await viem.getContractAt("DealGovernance", GOVERNANCE, {
      client: { public: publicClient, wallet: ownerWallet },
    });
    const hash = await governanceAsOwner.write.execute([PROPOSAL_ID], {
      value: EXECUTION_VALUE,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");

    const finalProposal = await governance.read.getProposal([PROPOSAL_ID]);
    assert.equal(await governance.read.state([PROPOSAL_ID]), 6);
    assert.equal(finalProposal.executed, true);
    assert.equal(finalProposal.totalStaked, parseEther("70"));
    assert.equal(await governance.read.executedProposalCount(), executedCountBefore + 1n);
    assert.equal(await broadcaster.read.broadcastNonce(), nonceBefore + 1n);

    // Decode the mined receipt directly. This avoids relying on a second RPC
    // log-index query, which some fork providers do not index synchronously.
    const broadcastEvents = parseEventLogs({
      abi: broadcastEventAbi,
      logs: receipt.logs.filter((log) => getAddress(log.address) === BROADCASTER),
      eventName: "Broadcast",
    });
    assert.equal(broadcastEvents.length, 1);
    assert.equal(broadcastEvents[0].args.nonce, nonceBefore + 1n);
    assert.deepEqual(broadcastEvents[0].args.targetChainIds, [BSC_CHAIN_KEY, BASE_CHAIN_KEY]);
    assert.deepEqual(broadcastEvents[0].args.targets?.map((item: Address) => getAddress(item)), [BSC_FACTORY, BASE_FACTORY]);
    assert.equal(broadcastEvents[0].args.data?.toLowerCase(), saved.innerUpgradeCalldata.toLowerCase());
  });
});
