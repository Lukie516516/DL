import assert from "node:assert/strict";

import { formatEther, type Address, type Hex } from "viem";

type ForkStakeRecoveryInput = {
  publicClient: any;
  governance: any;
  dToken: any;
  holder: Address;
  required: bigint;
};

async function waitFor(publicClient: any, hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `fork transaction failed: ${hash}`);
}

/**
 * A fork test must not assume that a D holder keeps all governance power in
 * wallet balance. D staked in terminal proposals is still owned by the holder
 * and can be reclaimed on the fork before exercising another scenario.
 */
export async function ensureForkSpendableD({
  publicClient,
  governance,
  dToken,
  holder,
  required,
}: ForkStakeRecoveryInput): Promise<void> {
  const walletBefore = (await dToken.read.balanceOf([holder])) as bigint;
  const stakedBefore = (await governance.read.currentStakedOf([holder])) as bigint;

  assert.ok(
    walletBefore + stakedBefore >= required,
    `fork D holder only controls ${formatEther(walletBefore + stakedBefore)} D ` +
      `(${formatEther(walletBefore)} wallet + ${formatEther(stakedBefore)} staked), ` +
      `below required ${formatEther(required)} D`,
  );

  if (walletBefore >= required) return;

  const proposalCount = (await governance.read.proposalCount()) as bigint;
  for (let proposalId = 1n; proposalId <= proposalCount; proposalId += 1n) {
    const [support, veto] = (await Promise.all([
      governance.read.stakeOf([proposalId, holder]),
      governance.read.vetoStakeOf([proposalId, holder]),
    ])) as [bigint, bigint];
    if (support === 0n && veto === 0n) continue;

    try {
      await waitFor(publicClient, await governance.write.claimBack([proposalId]));
    } catch {
      // Active or otherwise non-claimable proposals remain locked. Continue
      // scanning because another terminal proposal may restore enough balance.
    }

    const walletNow = (await dToken.read.balanceOf([holder])) as bigint;
    if (walletNow >= required) return;
  }

  const walletAfter = (await dToken.read.balanceOf([holder])) as bigint;
  const stakedAfter = (await governance.read.currentStakedOf([holder])) as bigint;
  assert.fail(
    `fork holder controls enough total D but only ${formatEther(walletAfter)} D is spendable; ` +
      `${formatEther(stakedAfter)} D remains in non-claimable proposals`,
  );
}
