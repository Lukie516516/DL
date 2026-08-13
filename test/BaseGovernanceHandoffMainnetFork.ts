import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  getAddress,
  padHex,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";

import {
  BASE_GOVERNANCE_ADDRESS_KEYS,
  DC_DEFAULT_ADMIN_ROLE,
  DC_MINTER_ROLE,
  DC_PAUSER_ROLE,
  baseGovernanceTargets,
  buildBaseGovernanceHandoffPlan,
} from "../scripts/lib/base-governance-plan.js";

const RUN = process.env.BASE_GOVERNANCE_HANDOFF_MAINNET_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const DEPLOYMENT_FILE = "deployments/base-mainnet-8453.json";
const DEPLOYER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const ETH_BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const ETH_LZ_EID = 30_101;
const CANARY_MESSAGE_HASH = "0x87b861508858236eed41e1c5aaeb0a7925253c9f5cb0ea1f76eb77b5983962b2" as Hex;

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

const ownerAbi = parseAbi(["function owner() view returns (address)"]);
const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function crossChainGovernance() view returns (address)",
  "function msgPriceAmountInToken() view returns (uint256)",
]);
const treasuryAbi = parseAbi([
  "function controller() view returns (address)",
  "function bootstrapAdmin() view returns (address)",
  "function bootstrapLocked() view returns (bool)",
]);
const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function peers(uint32) view returns (bytes32)",
  "function allowedTargets(address) view returns (bool)",
  "function confirmStatus(bytes32) view returns (bool,bool,bool,uint256,bool)",
  "function executionAttempts(bytes32) view returns (uint256)",
]);
const pairAbi = parseAbi([
  "function liquidityInited() view returns (bool)",
  "function getReserves() view returns (uint256,uint256,uint32)",
  "function getVirtualReserves() view returns (uint256,uint256)",
  "function getEffectiveReserves() view returns (uint256,uint256)",
]);
const infoNftAbi = parseAbi(["function admin() view returns (address)"]);
const probeAbi = parseAbi([
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
]);

function same(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

forkDescribe("Base production governance handoff live-state fork", function () {
  it("executes all 39 actions, centralizes authority in Executor, and preserves live economics", async function () {
    const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
    assert.equal(deployment.chainId, 8453);
    assert.ok(same(deployment.deployer, DEPLOYER));
    for (const key of BASE_GOVERNANCE_ADDRESS_KEYS) {
      assert.ok(deployment.addresses[key], `missing deployment address ${key}`);
    }

    const a = Object.fromEntries(
      Object.entries(deployment.addresses).map(([key, value]) => [key, getAddress(value)]),
    ) as Record<string, Address>;
    const executor = getAddress(a.dualBridgeExecutorV2);
    const factory = getAddress(a.dealFactory);
    const treasury = getAddress(a.protocolTreasury);
    const dc = getAddress(a.dlToken);
    const probe = getAddress(a.governanceProbe);
    const pairs = [a.pairStable0, a.pairStable1, a.pairWrappedNative]
      .map((address) => getAddress(address));

    const { viem, networkHelpers } = await network.connect({ network: "hardhatBaseFork", chainType: "op" });
    const publicClient: any = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 8453);
    await networkHelpers.impersonateAccount(DEPLOYER);
    await networkHelpers.setBalance(DEPLOYER, parseEther("2"));
    const wallet: any = await viem.getWalletClient(DEPLOYER);

    async function read(address: Address, abi: any, functionName: string, args?: readonly unknown[]) {
      return publicClient.readContract({ address, abi, functionName, args });
    }

    async function snapshotProtectedState() {
      const poolState = [];
      for (const pair of pairs) {
        poolState.push({
          pair,
          initialized: await read(pair, pairAbi, "liquidityInited"),
          reserves: await read(pair, pairAbi, "getReserves"),
          virtualReserves: await read(pair, pairAbi, "getVirtualReserves"),
          effectiveReserves: await read(pair, pairAbi, "getEffectiveReserves"),
        });
      }
      return {
        totalSupply: await read(dc, tokenAbi, "totalSupply"),
        treasuryDc: await read(dc, tokenAbi, "balanceOf", [treasury]),
        messagePrice: await read(factory, factoryAbi, "msgPriceAmountInToken"),
        pools: poolState,
        canaryStatus: await read(executor, executorAbi, "confirmStatus", [CANARY_MESSAGE_HASH]),
        canaryAttempts: await read(executor, executorAbi, "executionAttempts", [CANARY_MESSAGE_HASH]),
        probeMarker: await read(probe, probeAbi, "marker"),
        probeUpdateCount: await read(probe, probeAbi, "updateCount"),
      };
    }

    assert.ok(same(await read(executor, ownerAbi, "owner"), DEPLOYER));
    assert.ok(same(await read(factory, factoryAbi, "owner"), DEPLOYER));
    assert.ok(same(await read(factory, factoryAbi, "admin"), DEPLOYER));
    assert.equal(await read(factory, factoryAbi, "crossChainGovernance"), "0x0000000000000000000000000000000000000000");
    assert.ok(same(await read(treasury, treasuryAbi, "controller"), DEPLOYER));
    assert.ok(same(await read(treasury, treasuryAbi, "bootstrapAdmin"), DEPLOYER));
    assert.equal(await read(treasury, treasuryAbi, "bootstrapLocked"), false);

    const before = await snapshotProtectedState();
    const actions = buildBaseGovernanceHandoffPlan({
      addresses: a,
      executor,
      deployer: DEPLOYER,
      ethBroadcaster: ETH_BROADCASTER,
    });
    assert.equal(actions.length, 39);

    let totalGas = 0n;
    for (const [index, action] of actions.entries()) {
      const hash = await wallet.sendTransaction({ to: action.target, data: action.data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success", `action ${index + 1} failed: ${action.label}`);
      totalGas += receipt.gasUsed;
    }

    assert.ok(same(await read(executor, executorAbi, "owner"), executor));
    assert.equal(
      String(await read(executor, executorAbi, "peers", [ETH_LZ_EID])).toLowerCase(),
      padHex(ETH_BROADCASTER, { size: 32 }).toLowerCase(),
    );
    for (const target of baseGovernanceTargets(a, executor)) {
      assert.equal(
        await read(executor, executorAbi, "allowedTargets", [target.address]),
        true,
        `${target.key} is not allowed by Executor`,
      );
    }

    assert.ok(same(await read(factory, factoryAbi, "owner"), executor));
    assert.ok(same(await read(factory, factoryAbi, "admin"), executor));
    assert.ok(same(await read(factory, factoryAbi, "crossChainGovernance"), executor));
    assert.ok(same(await read(treasury, treasuryAbi, "controller"), executor));
    assert.ok(same(await read(treasury, treasuryAbi, "bootstrapAdmin"), DEPLOYER));
    assert.equal(await read(treasury, treasuryAbi, "bootstrapLocked"), true);

    for (const [role, account, expected] of [
      [DC_MINTER_ROLE, factory, true],
      [DC_MINTER_ROLE, executor, true],
      [DC_PAUSER_ROLE, executor, true],
      [DC_DEFAULT_ADMIN_ROLE, executor, true],
      [DC_MINTER_ROLE, DEPLOYER, false],
      [DC_DEFAULT_ADMIN_ROLE, DEPLOYER, false],
    ] as const) {
      assert.equal(await read(dc, tokenAbi, "hasRole", [role, account]), expected);
    }

    for (const key of [
      "dealPairManager",
      "dealImplementationRegistry",
      "dealInfoNFT",
      "dealCreditGraph",
      "dealSwapOrderBook",
      "dealSwapAssetRegistry",
      "dcDomain",
      "dcDomainRank",
      "dcDomainMarket",
      "dcDomainSwap",
    ]) {
      assert.ok(same(await read(getAddress(a[key]), ownerAbi, "owner"), executor), `${key} owner mismatch`);
    }
    assert.ok(same(await read(getAddress(a.dealInfoNFT), infoNftAbi, "admin"), executor));

    assert.deepEqual(await snapshotProtectedState(), before);
    assert.ok(totalGas > 0n);
    console.log(`Base governance handoff fork: ${actions.length} actions, ${totalGas} total gas units`);
  });
});
