import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, zeroAddress } from "viem";

describe("DCDomainSwap governance handoff", function () {
  it("moves only the parameter authority and leaves the configured protocol links unchanged", async function () {
    const { viem } = await network.connect();
    const [deployer, governance, outsider] = await viem.getWalletClients();
    const client = { public: await viem.getPublicClient(), wallet: deployer } as const;

    const swap = await viem.deployContract(
      "DCDomainSwap",
      [deployer.account.address, governance.account.address, outsider.account.address],
      { client },
    );

    assert.equal(getAddress(await swap.read.owner()), getAddress(deployer.account.address));
    assert.equal(getAddress(await swap.read.dcDomain()), getAddress(deployer.account.address));
    assert.equal(getAddress(await swap.read.dcRank()), getAddress(governance.account.address));
    assert.equal(getAddress(await swap.read.FACTORY()), getAddress(outsider.account.address));

    await assert.rejects(
      swap.write.transferOwner([zeroAddress]),
      /DCDomainSwap: zero owner/,
    );

    const swapAsOutsider = await viem.getContractAt("DCDomainSwap", swap.address, {
      client: { public: client.public, wallet: outsider },
    });
    await assert.rejects(
      swapAsOutsider.write.transferOwner([outsider.account.address]),
      /DCDomainSwap: not owner/,
    );

    await swap.write.transferOwner([governance.account.address]);
    assert.equal(getAddress(await swap.read.owner()), getAddress(governance.account.address));

    await assert.rejects(
      swap.write.setReplaceTimeoutSeconds([180n]),
      /DCDomainSwap: not owner/,
    );

    const swapAsGovernance = await viem.getContractAt("DCDomainSwap", swap.address, {
      client: { public: client.public, wallet: governance },
    });
    await swapAsGovernance.write.setReplaceTimeoutSeconds([180n]);
    assert.equal(await swap.read.replaceTimeoutSeconds(), 180n);

    assert.equal(getAddress(await swap.read.dcDomain()), getAddress(deployer.account.address));
    assert.equal(getAddress(await swap.read.dcRank()), getAddress(governance.account.address));
    assert.equal(getAddress(await swap.read.FACTORY()), getAddress(outsider.account.address));
  });
});
