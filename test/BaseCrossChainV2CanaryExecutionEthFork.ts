import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther, type Address, type Hex } from "viem";

const RUN = process.env.BASE_CROSS_CHAIN_V2_CANARY_EXECUTION_ETH_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
const BASE_PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const PROPOSAL_ID = 21n;
const EXECUTION_VALUE = parseEther("0.005");
const LZ_GAS = 500_000n;

type ProposalRecord = {
  markerCalldata: Hex;
  broadcastCalldata: Hex;
  broadcastNonceBefore: string;
};

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
}

forkDescribe("Base CrossChain V2 Canary execution Ethereum fork", function () {
  it("executes only proposal 21 and emits one BSC + Base broadcast", async function () {
    try {
      const saved = JSON.parse(
        readFileSync("deployments/base-cross-chain-v2-canary-proposal.json", "utf8"),
      ) as ProposalRecord;
      const { viem, networkHelpers } = await network.connect({
        network: "hardhatEthFork",
        chainType: "l1",
      });
      const publicClient = await viem.getPublicClient();
      assert.equal(await publicClient.getChainId(), 1);
      const governance = await viem.getContractAt("DealGovernance", GOVERNANCE);
      const broadcaster = await viem.getContractAt("CrossChainBroadcasterV2", BROADCASTER);
      const proposal = await governance.read.getProposal([PROPOSAL_ID]);
      const actions = await governance.read.getActions([PROPOSAL_ID]);
      const nonceBefore = await broadcaster.read.broadcastNonce();

      assert.equal(await governance.read.state([PROPOSAL_ID]), 3);
      assert.equal(proposal.totalStaked, parseEther("70"));
      assert.equal(proposal.executed, false);
      assert.deepEqual(actions[0].map(getAddress), [BROADCASTER]);
      assert.deepEqual(actions[1], [EXECUTION_VALUE]);
      assert.deepEqual(
        actions[2].map((data) => data.toLowerCase()),
        [saved.broadcastCalldata.toLowerCase()],
      );
      assert.equal(nonceBefore, BigInt(saved.broadcastNonceBefore));
      assert.equal((await broadcaster.read.chains([BSC_CHAIN_KEY]))[6], true);
      assert.equal((await broadcaster.read.chains([BASE_CHAIN_KEY]))[6], true);
      const quote = await broadcaster.read.quoteFees([
        [BSC_CHAIN_KEY, BASE_CHAIN_KEY],
        [BSC_PROBE, BASE_PROBE],
        saved.markerCalldata,
        LZ_GAS,
      ]);
      assert.ok(quote > 0n && quote <= EXECUTION_VALUE);

      await networkHelpers.impersonateAccount(OWNER);
      await networkHelpers.setBalance(OWNER, parseEther("2"));
      const ownerWallet = await viem.getWalletClient(OWNER);
      const governanceAsOwner = await viem.getContractAt("DealGovernance", GOVERNANCE, {
        client: { public: publicClient, wallet: ownerWallet },
      });
      await waitFor(
        publicClient,
        await governanceAsOwner.write.execute([PROPOSAL_ID], { value: EXECUTION_VALUE }),
      );

      const executed = await governance.read.getProposal([PROPOSAL_ID]);
      assert.equal(await governance.read.state([PROPOSAL_ID]), 6);
      assert.equal(executed.executed, true);
      assert.equal(executed.totalStaked, parseEther("70"));
      assert.equal(await broadcaster.read.broadcastNonce(), nonceBefore + 1n);
    } catch (error) {
      console.error("Base Canary execution ETH fork error:", error);
      throw error;
    }
  });
});
