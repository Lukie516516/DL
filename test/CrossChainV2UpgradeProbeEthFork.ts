import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

const MAJOR = 2;
const BSC_CHAIN_KEY = 30102;
const FEE_BUDGET = parseEther("0.002");
const runFork = process.env.CROSS_CHAIN_V2_UPGRADE_PROBE_ETH_FORK === "1";
const forkDescribe = runFork ? describe : describe.skip;

type EthDeployment = {
  chainId: number;
  addresses: Record<string, Address>;
};

type Stage1 = {
  stage: string;
  eth: { address: Address; verified: boolean };
  bsc: { address: Address; verified: boolean };
};

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

forkDescribe("asset-free upgrade probe ETH mainnet fork", function () {
  it("accepts the exact live V2 policy shape and preserves probe state through UUPS", async function () {
    const eth = JSON.parse(
      readFileSync("deployments/eth-mainnet-1.json", "utf8"),
    ) as EthDeployment;
    const stage1 = JSON.parse(
      readFileSync("deployments/ccip-v2-mainnet-stage1.json", "utf8"),
    ) as Stage1;
    assert.equal(eth.chainId, 1);
    assert.equal(stage1.stage, "both_deployed");
    assert.equal(stage1.eth.verified, true);
    assert.equal(stage1.bsc.verified, true);

    const governanceAddress = getAddress(eth.addresses.dealGovernance);
    const registryAddress = getAddress(eth.addresses.governancePolicyRegistry);
    const broadcasterAddress = getAddress(stage1.eth.address);

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    const [deployer] = await viem.getWalletClients();
    assert.equal(await publicClient.getChainId(), 1);
    console.log(
      `CrossChain V2 upgrade probe ETH fork block: ${await publicClient.getBlockNumber()}`,
    );

    const governanceCode = await publicClient.getCode({ address: governanceAddress });
    const registryCode = await publicClient.getCode({ address: registryAddress });
    const broadcasterCode = await publicClient.getCode({ address: broadcasterAddress });
    assert.ok(governanceCode && governanceCode !== "0x");
    assert.ok(registryCode && registryCode !== "0x");
    assert.ok(broadcasterCode && broadcasterCode !== "0x");

    const broadcaster = await viem.getContractAt(
      "CrossChainBroadcasterV2",
      broadcasterAddress,
    );
    const registry = await viem.getContractAt(
      "GovernancePolicyRegistry",
      registryAddress,
    );
    assert.equal(
      getAddress(await broadcaster.read.governance()),
      governanceAddress,
    );
    assert.equal(getAddress(await registry.read.governance()), governanceAddress);
    assert.equal((await broadcaster.read.getChainIds()).includes(BSC_CHAIN_KEY), true);
    const chainConfig = await broadcaster.read.chains([BSC_CHAIN_KEY]);
    assert.equal(chainConfig[6], true);

    const deployClient = { public: publicClient, wallet: deployer } as const;
    const ethV1Implementation = await viem.deployContract("GovernanceProbe", [], {
      client: deployClient,
    });
    const bscV1Implementation = await viem.deployContract("GovernanceProbe", [], {
      client: deployClient,
    });
    const ethProxy = await viem.deployContract(
      "ERC1967Proxy",
      [
        ethV1Implementation.address,
        encodeFunctionData({
          abi: ethV1Implementation.abi,
          functionName: "initialize",
          args: [governanceAddress],
        }),
      ],
      { client: deployClient },
    );
    const virtualBscProxy = await viem.deployContract(
      "ERC1967Proxy",
      [
        bscV1Implementation.address,
        encodeFunctionData({
          abi: bscV1Implementation.abi,
          functionName: "initialize",
          args: [getAddress(stage1.bsc.address)],
        }),
      ],
      { client: deployClient },
    );
    const ethV2Implementation = await viem.deployContract(
      "GovernanceProbeUpgradeMock",
      [],
      { client: deployClient },
    );
    const bscV2Implementation = await viem.deployContract(
      "GovernanceProbeUpgradeMock",
      [],
      { client: deployClient },
    );
    const ethProbe = await viem.getContractAt("GovernanceProbe", ethProxy.address);
    assert.equal(getAddress(await ethProbe.read.controller()), governanceAddress);

    const upgradeSelector = toFunctionSelector("upgradeToAndCall(address,bytes)");
    await networkHelpers.impersonateAccount(governanceAddress);
    await networkHelpers.setBalance(governanceAddress, parseEther("10"));
    const governanceWallet = await viem.getWalletClient(governanceAddress);
    const registryAsGovernance = await viem.getContractAt(
      "GovernancePolicyRegistry",
      registryAddress,
      { client: { public: publicClient, wallet: governanceWallet } },
    );
    await waitFor(
      publicClient,
      await registryAsGovernance.write.setRules([
        [
          {
            kind: MAJOR,
            target: ethProxy.address,
            selector: upgradeSelector,
            allowed: true,
            validateNestedBroadcast: false,
            nestedOnly: false,
            maxValue: 0n,
          },
          {
            kind: MAJOR,
            target: virtualBscProxy.address,
            selector: upgradeSelector,
            allowed: true,
            validateNestedBroadcast: false,
            nestedOnly: true,
            maxValue: 0n,
          },
        ],
      ]),
    );

    const ethUpgradeData = encodeFunctionData({
      abi: ethProbe.abi,
      functionName: "upgradeToAndCall",
      args: [ethV2Implementation.address, "0x"],
    });
    const bscUpgradeData = encodeFunctionData({
      abi: bscV1Implementation.abi,
      functionName: "upgradeToAndCall",
      args: [bscV2Implementation.address, "0x"],
    });
    const broadcastData = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [
        [BSC_CHAIN_KEY],
        [virtualBscProxy.address],
        bscUpgradeData,
        500_000n,
      ],
    });
    assert.equal(
      await registry.read.isActionAllowed([
        MAJOR,
        ethProxy.address,
        0n,
        ethUpgradeData,
      ]),
      true,
    );
    assert.equal(
      await registry.read.isActionAllowed([
        MAJOR,
        broadcasterAddress,
        FEE_BUDGET,
        broadcastData,
      ]),
      true,
    );
    const liveQuote = await broadcaster.read.quoteFees([
      [BSC_CHAIN_KEY],
      [virtualBscProxy.address],
      bscUpgradeData,
      500_000n,
    ]);
    assert.ok(liveQuote > 0n);
    assert.ok(liveQuote <= FEE_BUDGET);

    const ethProbeAsGovernance = await viem.getContractAt(
      "GovernanceProbe",
      ethProxy.address,
      { client: { public: publicClient, wallet: governanceWallet } },
    );
    await waitFor(
      publicClient,
      await ethProbeAsGovernance.write.upgradeToAndCall([
        ethV2Implementation.address,
        "0x",
      ]),
    );
    const upgraded = await viem.getContractAt(
      "GovernanceProbeUpgradeMock",
      ethProxy.address,
    );
    assert.equal(await upgraded.read.version(), 2n);
    assert.equal(await upgraded.read.upgradedFeatureAvailable(), true);
    assert.equal(getAddress(await upgraded.read.controller()), governanceAddress);
    assert.equal(await upgraded.read.marker(), `0x${"00".repeat(32)}`);
    assert.equal(await upgraded.read.updateCount(), 0n);
  });
});
