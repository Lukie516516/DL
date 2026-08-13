import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  padHex,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

const runFork = process.env.CCIP_BRIDGE_MAINNET_FORK === "1";
const forkDescribe = runFork ? describe : describe.skip;

const ETH_LZ_ENDPOINT = getAddress(
  "0x1a44076050125825900e736c501f859c50fE728c"
);
const BSC_LZ_ENDPOINT = getAddress(
  "0x1a44076050125825900e736c501f859c50fE728c"
);
const ETH_CCIP_ROUTER = getAddress(
  "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D"
);
const BSC_CCIP_ROUTER = getAddress(
  "0x34B03Cb9086d7D758AC55af71584F81A598759FE"
);
const ETH_AXELAR_GATEWAY = getAddress(
  "0x4F4495243837681061C4743b74B3eEdf548D56A5"
);
const ETH_AXELAR_GAS_SERVICE = getAddress(
  "0x2d5d7d31F671F86C782533cc367F14109a082712"
);
const BSC_AXELAR_GATEWAY = getAddress(
  "0x304acf330bbE08d1e512eefaa92F6a57871fD895"
);
const ETH_LZ_EID = 30101;
const BSC_LZ_EID = 30102;
const ETH_CCIP_SELECTOR = 5_009_297_550_715_157_269n;
const BSC_CCIP_SELECTOR = 11_344_663_589_394_136_015n;
const AXELAR_MIN_FEE = 1_000_000_000_000_000n;

type CrossChainState = {
  params: { bscChainKey: number; bscDealFactory: Address };
};

type Stage1State = {
  eth: { address: Address };
  bsc: { address: Address };
};

type EthDeployment = {
  deployer: Address;
  addresses: Record<string, Address>;
};

const STAGE3_DESCRIPTION =
  "DAO V2 cross-chain migration stage 3: copy the existing V1 Parameter and Major broadcast rules to CrossChainBroadcasterV2 0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6 while preserving the V1 rules. This proposal only updates GovernancePolicyRegistry. It does not activate the BSC route, switch the BSC DealFactory executor, send any cross-chain message, or disable V1. Purpose: prepare a controlled zero-business-change canary; immediate business impact: none.";

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

forkDescribe("CCIP bridge mainnet component forks", function () {
  it("deploys and sends through the real ETH LZ, CCIP and Axelar contracts", async function () {
    const crossChain = JSON.parse(
      readFileSync("deployments/mainnet-cross-chain.json", "utf8")
    ) as CrossChainState;
    const { viem } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 1);
    const [deployer, remoteReceiver] = await viem.getWalletClients();
    assert.ok(deployer && remoteReceiver, "fork wallets missing");

    const broadcaster = await viem.deployContract("CrossChainBroadcasterV2", [
      ETH_LZ_ENDPOINT,
      deployer.account.address,
      deployer.account.address,
      ETH_CCIP_ROUTER,
      ETH_AXELAR_GATEWAY,
      ETH_AXELAR_GAS_SERVICE,
    ]);
    await waitFor(
      publicClient,
      await broadcaster.write.setPeer([
        BSC_LZ_EID,
        padHex(remoteReceiver.account.address, { size: 32 }),
      ])
    );
    await waitFor(
      publicClient,
      await broadcaster.write.addChain([
        crossChain.params.bscChainKey,
        {
          lzDstEid: BSC_LZ_EID,
          ccipDstChainSelector: BSC_CCIP_SELECTOR,
          ccipReceiver: remoteReceiver.account.address,
          axDstChain: "binance",
          axDstAddress: remoteReceiver.account.address.toLowerCase(),
          axMinFee: AXELAR_MIN_FEE,
          active: true,
        },
      ])
    );

    const bscFactory = getAddress(crossChain.params.bscDealFactory);
    const innerData = encodeFunctionData({
      abi: parseAbi(["function setMinWindowSec(uint32 seconds_)"]),
      functionName: "setMinWindowSec",
      args: [1800],
    });
    const fee = await broadcaster.read.quoteFees([
      [crossChain.params.bscChainKey],
      [bscFactory],
      innerData,
      500_000n,
    ]);
    assert.ok(fee > AXELAR_MIN_FEE, `unexpected total bridge fee: ${fee}`);

    await waitFor(
      publicClient,
      await broadcaster.write.broadcast(
        [[crossChain.params.bscChainKey], [bscFactory], innerData, 500_000n],
        { value: fee }
      )
    );
    assert.equal(await broadcaster.read.broadcastNonce(), 1n);
    assert.equal(
      await publicClient.getBalance({ address: broadcaster.address }),
      0n
    );
  });

  it("deploys against real BSC dependencies and accepts only authenticated router/endpoint calls", async function () {
    const { viem, networkHelpers } = await network.connect({
      network: "hardhatBscFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 56);
    const [deployer] = await viem.getWalletClients();
    assert.ok(deployer, "fork wallet missing");

    const source = deployer.account.address;
    const sourceBytes32 = padHex(source, { size: 32 });
    const executor = await viem.deployContract("DualBridgeExecutorV2", [
      BSC_LZ_ENDPOINT,
      deployer.account.address,
      BSC_CCIP_ROUTER,
      ETH_CCIP_SELECTOR,
      source,
      BSC_AXELAR_GATEWAY,
      "Ethereum",
      source,
      2n,
    ]);
    const target = await viem.deployContract("MockTarget", []);
    await waitFor(
      publicClient,
      await executor.write.setPeer([ETH_LZ_EID, sourceBytes32])
    );
    await waitFor(
      publicClient,
      await executor.write.setAllowedTarget([target.address, true])
    );

    assert.equal(await executor.read.supportsInterface(["0x01ffc9a7"]), true);
    assert.equal(
      await executor.read.supportsInterface([
        toFunctionSelector(
          "ccipReceive((bytes32,uint64,bytes,bytes,(address,uint256)[]))"
        ),
      ]),
      true
    );

    const targetData = encodeFunctionData({
      abi: target.abi,
      functionName: "setParam",
      args: [77n],
    });
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [1n, target.address, targetData]
    );
    const msgHash = keccak256(payload);

    await networkHelpers.impersonateAccount(BSC_CCIP_ROUTER);
    await networkHelpers.setBalance(BSC_CCIP_ROUTER, parseEther("1"));
    const routerWallet = await viem.getWalletClient(BSC_CCIP_ROUTER);
    const executorAsRouter = await viem.getContractAt(
      "DualBridgeExecutorV2",
      executor.address,
      {
        client: { public: publicClient, wallet: routerWallet },
      }
    );
    await waitFor(
      publicClient,
      await executorAsRouter.write.ccipReceive([
        {
          messageId: keccak256("0x31"),
          sourceChainSelector: ETH_CCIP_SELECTOR,
          sender: encodeAbiParameters([{ type: "address" }], [source]),
          data: payload,
          destTokenAmounts: [],
        },
      ])
    );
    assert.deepEqual(await executor.read.confirmStatus([msgHash]), [
      false,
      true,
      false,
      1n,
      false,
    ]);

    await networkHelpers.impersonateAccount(BSC_LZ_ENDPOINT);
    await networkHelpers.setBalance(BSC_LZ_ENDPOINT, parseEther("1"));
    const endpointWallet = await viem.getWalletClient(BSC_LZ_ENDPOINT);
    const executorAsEndpoint = await viem.getContractAt(
      "DualBridgeExecutorV2",
      executor.address,
      {
        client: { public: publicClient, wallet: endpointWallet },
      }
    );
    await waitFor(
      publicClient,
      await executorAsEndpoint.write.lzReceive([
        { srcEid: ETH_LZ_EID, sender: sourceBytes32, nonce: 1n },
        keccak256("0x32"),
        payload,
        deployer.account.address,
        "0x",
      ])
    );
    assert.deepEqual(await executor.read.confirmStatus([msgHash]), [
      true,
      true,
      false,
      2n,
      true,
    ]);
    assert.equal(await executor.read.executionAttempts([msgHash]), 1n);
    assert.equal(await target.read.param(), 77n);
    assert.equal(await target.read.callCount(), 1n);
    assert.equal(
      (await target.read.lastCaller()).toLowerCase(),
      executor.address.toLowerCase()
    );
  });

  it("rehearses the exact deployed stage-2 wiring while keeping the route inactive", async function () {
    const crossChain = JSON.parse(
      readFileSync("deployments/mainnet-cross-chain.json", "utf8")
    ) as CrossChainState & {
      eth: { deployer: Address; broadcaster: Address };
      bsc: { executor: Address };
      params: CrossChainState["params"] & {
        ethLzEid: number;
        bscLzEid: number;
        bscAxelarChainName: string;
        axelarMinFeeWei: string;
      };
    };
    const stage1 = JSON.parse(
      readFileSync("deployments/ccip-v2-mainnet-stage1.json", "utf8")
    ) as Stage1State;
    const owner = getAddress(crossChain.eth.deployer);
    const broadcasterAddress = getAddress(stage1.eth.address);
    const executorAddress = getAddress(stage1.bsc.address);
    const factoryAddress = getAddress(crossChain.params.bscDealFactory);

    const ethConnection = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const ethPublic = await ethConnection.viem.getPublicClient();
    await ethConnection.networkHelpers.impersonateAccount(owner);
    await ethConnection.networkHelpers.setBalance(owner, parseEther("1"));
    const ethOwner = await ethConnection.viem.getWalletClient(owner);
    const broadcaster = await ethConnection.viem.getContractAt(
      "CrossChainBroadcasterV2",
      broadcasterAddress,
      { client: { public: ethPublic, wallet: ethOwner } }
    );
    const expectedExecutorPeer = padHex(executorAddress, { size: 32 });
    const currentEthPeer = await broadcaster.read.peers([
      crossChain.params.bscLzEid,
    ]);
    if (currentEthPeer.toLowerCase() !== expectedExecutorPeer.toLowerCase()) {
      assert.equal(currentEthPeer, padHex("0x", { size: 32 }));
      await waitFor(
        ethPublic,
        await broadcaster.write.setPeer([
          crossChain.params.bscLzEid,
          expectedExecutorPeer,
        ])
      );
    }
    const currentChainIds = await broadcaster.read.getChainIds();
    if (currentChainIds.length === 0) {
      await waitFor(
        ethPublic,
        await broadcaster.write.addChain([
          crossChain.params.bscChainKey,
          {
            lzDstEid: crossChain.params.bscLzEid,
            ccipDstChainSelector: BSC_CCIP_SELECTOR,
            ccipReceiver: executorAddress,
            axDstChain: crossChain.params.bscAxelarChainName,
            axDstAddress: executorAddress.toLowerCase(),
            axMinFee: BigInt(crossChain.params.axelarMinFeeWei),
            active: false,
          },
        ])
      );
    } else {
      assert.deepEqual(currentChainIds, [crossChain.params.bscChainKey]);
    }
    assert.deepEqual(await broadcaster.read.getChainIds(), [
      crossChain.params.bscChainKey,
    ]);
    const config = await broadcaster.read.chains([
      crossChain.params.bscChainKey,
    ]);
    assert.equal(config[0], crossChain.params.bscLzEid);
    assert.equal(config[1], BSC_CCIP_SELECTOR);
    assert.equal(config[2].toLowerCase(), executorAddress.toLowerCase());
    assert.equal(config[3], crossChain.params.bscAxelarChainName);
    assert.equal(config[4], executorAddress.toLowerCase());
    assert.equal(config[5], BigInt(crossChain.params.axelarMinFeeWei));
    assert.equal(config[6], false);
    await assert.rejects(
      broadcaster.read.quoteFees([
        [crossChain.params.bscChainKey],
        [factoryAddress],
        encodeAbiParameters([{ type: "uint256" }], [1n]),
        500_000n,
      ]),
      /NoActiveChains/
    );

    const bscConnection = await network.connect({
      network: "hardhatBscFork",
      chainType: "l1",
    });
    const bscPublic = await bscConnection.viem.getPublicClient();
    await bscConnection.networkHelpers.impersonateAccount(owner);
    await bscConnection.networkHelpers.setBalance(owner, parseEther("1"));
    const bscOwner = await bscConnection.viem.getWalletClient(owner);
    const executor = await bscConnection.viem.getContractAt(
      "DualBridgeExecutorV2",
      executorAddress,
      { client: { public: bscPublic, wallet: bscOwner } }
    );
    const expectedBroadcasterPeer = padHex(broadcasterAddress, { size: 32 });
    const currentBscPeer = await executor.read.peers([
      crossChain.params.ethLzEid,
    ]);
    if (
      currentBscPeer.toLowerCase() !== expectedBroadcasterPeer.toLowerCase()
    ) {
      assert.equal(currentBscPeer, padHex("0x", { size: 32 }));
      await waitFor(
        bscPublic,
        await executor.write.setPeer([
          crossChain.params.ethLzEid,
          expectedBroadcasterPeer,
        ])
      );
    }
    if (!(await executor.read.allowedTargets([factoryAddress]))) {
      await waitFor(
        bscPublic,
        await executor.write.setAllowedTarget([factoryAddress, true])
      );
    }
    assert.equal(
      (await executor.read.peers([crossChain.params.ethLzEid])).toLowerCase(),
      padHex(broadcasterAddress, { size: 32 }).toLowerCase()
    );
    assert.equal(await executor.read.allowedTargets([factoryAddress]), true);

    const factory = await bscConnection.viem.getContractAt(
      "DealFactory",
      factoryAddress
    );
    assert.equal(
      (await factory.read.crossChainGovernance()).toLowerCase(),
      crossChain.bsc.executor.toLowerCase()
    );
  });

  it("rehearses the exact stage-3 Major proposal without staking or executing", async function () {
    const deployment = JSON.parse(
      readFileSync("deployments/eth-mainnet-1.json", "utf8")
    ) as EthDeployment;
    const stage1 = JSON.parse(
      readFileSync("deployments/ccip-v2-mainnet-stage1.json", "utf8")
    ) as Stage1State;
    const owner = getAddress(deployment.deployer);
    const governanceAddress = getAddress(deployment.addresses.dealGovernance);
    const registryAddress = getAddress(
      deployment.addresses.governancePolicyRegistry
    );
    const dcAddress = getAddress(deployment.addresses.dlToken);
    const treasuryAddress = getAddress(deployment.addresses.protocolTreasury);
    const oldBroadcaster = getAddress(
      deployment.addresses.crossChainBroadcaster
    );
    const newBroadcaster = getAddress(stage1.eth.address);
    const selector = toFunctionSelector(
      "broadcast(uint32[],address[],bytes,uint128)"
    );

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    await networkHelpers.impersonateAccount(owner);
    await networkHelpers.setBalance(owner, parseEther("1"));
    const ownerWallet = await viem.getWalletClient(owner);
    const client = { public: publicClient, wallet: ownerWallet } as const;
    const governance = await viem.getContractAt(
      "DealGovernance",
      governanceAddress,
      { client }
    );
    const registry = await viem.getContractAt(
      "GovernancePolicyRegistry",
      registryAddress,
      { client }
    );
    const dc = await viem.getContractAt("DCToken", dcAddress, { client });
    const broadcaster = await viem.getContractAt(
      "CrossChainBroadcasterV2",
      newBroadcaster,
      { client }
    );

    const [oldParameterRule, oldMajorRule, newParameterRule, newMajorRule] =
      await Promise.all([
        registry.read.getRule([0, oldBroadcaster, selector]),
        registry.read.getRule([2, oldBroadcaster, selector]),
        registry.read.getRule([0, newBroadcaster, selector]),
        registry.read.getRule([2, newBroadcaster, selector]),
      ]);
    assert.deepEqual(oldParameterRule, {
      allowed: true,
      validateNestedBroadcast: true,
      nestedOnly: false,
      maxValue: parseEther("0.01"),
    });
    assert.deepEqual(oldMajorRule, oldParameterRule);
    assert.deepEqual(newParameterRule, {
      allowed: false,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    });
    assert.deepEqual(newMajorRule, newParameterRule);
    const chainConfigBefore = await broadcaster.read.chains([BSC_LZ_EID]);
    assert.equal(chainConfigBefore[6], false);

    const rules = [
      {
        kind: 0,
        target: newBroadcaster,
        selector,
        ...oldParameterRule,
      },
      {
        kind: 2,
        target: newBroadcaster,
        selector,
        ...oldMajorRule,
      },
    ];
    const setRulesData = encodeFunctionData({
      abi: registry.abi,
      functionName: "setRules",
      args: [rules],
    });
    assert.equal(
      await registry.read.isActionAllowed([
        2,
        registryAddress,
        0n,
        setRulesData,
      ]),
      true
    );

    const [majorFee, proposalCountBefore, ownerBalanceBefore, treasuryBefore] =
      await Promise.all([
        governance.read.majorProposalFee(),
        governance.read.proposalCount(),
        dc.read.balanceOf([owner]),
        dc.read.balanceOf([treasuryAddress]),
      ]);
    const minterRole = await dc.read.MINTER_ROLE();
    assert.equal(await dc.read.hasRole([minterRole, owner]), true);
    await waitFor(publicClient, await dc.write.mint([owner, majorFee]));
    await waitFor(
      publicClient,
      await dc.write.approve([governanceAddress, majorFee])
    );
    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [registryAddress],
        [0n],
        [setRulesData],
        STAGE3_DESCRIPTION,
        2,
      ])
    );

    const proposalId = proposalCountBefore + 1n;
    assert.equal(await governance.read.proposalCount(), proposalId);
    assert.equal(await governance.read.state([proposalId]), 1);
    const proposal = await governance.read.getProposal([proposalId]);
    assert.equal(proposal.proposer.toLowerCase(), owner.toLowerCase());
    assert.equal(proposal.kind, 2);
    assert.equal(proposal.totalStaked, 0n);
    assert.equal(proposal.windowEndsAt, 0n);
    assert.equal(proposal.executed, false);
    assert.equal(proposal.description, STAGE3_DESCRIPTION);
    const actions = await governance.read.getActions([proposalId]);
    assert.deepEqual(
      actions[0].map((value) => value.toLowerCase()),
      [registryAddress.toLowerCase()]
    );
    assert.deepEqual(actions[1], [0n]);
    assert.deepEqual(actions[2], [setRulesData]);
    assert.equal(await dc.read.balanceOf([owner]), ownerBalanceBefore);
    assert.equal(
      await dc.read.balanceOf([treasuryAddress]),
      treasuryBefore + majorFee
    );
    assert.deepEqual(
      await registry.read.getRule([0, newBroadcaster, selector]),
      newParameterRule
    );
    assert.deepEqual(
      await registry.read.getRule([2, newBroadcaster, selector]),
      newMajorRule
    );
    assert.deepEqual(
      await registry.read.getRule([0, oldBroadcaster, selector]),
      oldParameterRule
    );
    assert.equal((await broadcaster.read.chains([BSC_LZ_EID]))[6], false);
  });
});
