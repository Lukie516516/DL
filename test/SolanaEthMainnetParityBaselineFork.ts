import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  getAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import {
  buildDaoV2PolicyRules,
  buildDaoV2TreasuryModuleRules,
} from "../scripts/dao-v2-policy.js";

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const RUN_FORK = process.env.SOLANA_ETH_PARITY_FORK === "1";
const describeFork = RUN_FORK ? describe : describe.skip;

type Deployment = {
  chainId: number;
  addresses: Record<string, Address>;
  abi: Record<string, Abi>;
};

type ChainDeployment = {
  addresses: Record<string, Address>;
};

const LIVE_ABI_BY_ADDRESS_KEY: Record<string, string> = {
  dlToken: "DCToken",
  dealFactory: "DealFactory",
  dealMessageHub: "DealMessageHub",
  dealCreditGraph: "DealCreditGraph",
  dealActivityIndex: "DealActivityIndex",
  dealResultIndex: "DealResultIndex",
  dealInfoNFT: "DealInfoNFT",
  dealInfoNFTRenderer: "DealInfoNFTRenderer",
  pairStable0: "DealSwapTemplate",
  pairStable1: "DealSwapTemplate",
  pairWrappedNative: "DealSwapTemplate",
  dealSwapOrderBook: "DealSwapOrderBook",
  dealRouter: "DealRouter",
  dealRouterQuoter: "DealRouterQuoter",
  dealSwapAssetRegistry: "DealSwapAssetRegistry",
  dealReader: "DealReader",
  dcDomain: "DCDomain",
  dcDomainRank: "DCDomainRank",
  dcDomainRankReader: "DCDomainRankReader",
  dcDomainListReader: "DCDomainListReader",
  dcDomainMarket: "DCDomainMarket",
  dcDomainSwap: "DCDomainSwap",
  dcDomainHall: "DCDomainHall",
  dToken: "D",
  dealNftGovernanceActivity: "DealNftGovernanceActivity",
  nftVetoRegistry: "NftVetoRegistry",
  dealSeatVetoGovernor: "DealSeatVetoGovernor",
  voteDividendClaimer: "VoteDividendClaimer",
  protocolTreasury: "ProtocolTreasury",
  dealGovernance: "DealGovernance",
  crossChainBroadcaster: "CrossChainBroadcaster",
  governancePolicyRegistry: "GovernancePolicyRegistry",
};

const PROXY_IMPLEMENTATIONS: ReadonlyArray<readonly [string, string]> = [
  ["dealFactory", "dealFactoryImplementation"],
  ["dcDomainRank", "dcDomainRankImplementation"],
  ["dealGovernance", "dealGovernanceImpl"],
  ["satoshiVault", "satoshiVaultImplementation"],
  ["dealDividendVault", "dealDividendVaultImplementation"],
];

function slotAddress(word: Hex | undefined): Address {
  assert.ok(word && word.length === 66, "implementation slot is missing");
  return getAddress(`0x${word.slice(-40)}`);
}

function render(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(render);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, render(nested)]),
    );
  }
  return value;
}

describeFork("Solana parity ETH mainnet fork baseline", function () {
  it("pins deployed code, proxy implementations, readable state and all D custody", async function () {
    const deployment = JSON.parse(
      readFileSync("deployments/eth-mainnet-1.json", "utf8"),
    ) as Deployment;
    const bscDeployment = JSON.parse(
      readFileSync("deployments/bsc-mainnet-56.json", "utf8"),
    ) as ChainDeployment;
    assert.equal(deployment.chainId, 1);

    const { viem } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 1);
    const block = await publicClient.getBlock();
    console.log(
      `Solana parity ETH baseline: block=${block.number} hash=${block.hash}`,
    );

    for (const [label, rawAddress] of Object.entries(deployment.addresses)) {
      const address = getAddress(rawAddress);
      const code = await publicClient.getBytecode({
        address,
        blockNumber: block.number,
      });
      assert.ok(code && code !== "0x", `${label} has no code at ${address}`);
    }

    for (const [proxyKey, implementationKey] of PROXY_IMPLEMENTATIONS) {
      const proxy = getAddress(deployment.addresses[proxyKey]);
      const expectedImplementation = getAddress(
        deployment.addresses[implementationKey],
      );
      const word = await publicClient.getStorageAt({
        address: proxy,
        slot: IMPLEMENTATION_SLOT,
        blockNumber: block.number,
      });
      assert.equal(
        slotAddress(word),
        expectedImplementation,
        `${proxyKey} implementation drift`,
      );
    }

    const readableState: Record<string, Record<string, unknown>> = {};
    const expectedProxyOnlyRevert = new Set(["proxiableUUID()"]);
    for (const [addressKey, abiKey] of Object.entries(LIVE_ABI_BY_ADDRESS_KEY)) {
      const address = getAddress(deployment.addresses[addressKey]);
      const abi = deployment.abi[abiKey];
      assert.ok(abi, `missing ${abiKey} ABI for ${addressKey}`);
      const state: Record<string, unknown> = {};

      for (const entry of abi) {
        if (
          entry.type !== "function" ||
          (entry.stateMutability !== "view" && entry.stateMutability !== "pure") ||
          entry.inputs.length !== 0
        ) {
          continue;
        }
        const signature = `${entry.name}()`;
        if (expectedProxyOnlyRevert.has(signature)) continue;
        const data = encodeFunctionData({
          abi: [entry],
          functionName: entry.name,
        } as any);
        const response = await publicClient.call({
          to: address,
          data,
          blockNumber: block.number,
        });
        state[signature] = render(
          decodeFunctionResult({
            abi: [entry],
            functionName: entry.name,
            data: response.data ?? "0x",
          } as any),
        );
      }
      readableState[addressKey] = state;
    }

    const dAddress = getAddress(deployment.addresses.dToken);
    const governanceAddress = getAddress(deployment.addresses.dealGovernance);
    const d = await viem.getContractAt("D", dAddress);
    const factory = await viem.getContractAt(
      "DealFactory",
      getAddress(deployment.addresses.dealFactory),
    );
    const governance = await viem.getContractAt(
      "DealGovernance",
      governanceAddress,
    );
    assert.equal(await factory.read.minTimeoutSeconds(), 3_600n);
    assert.equal(await factory.read.MAX_TIMEOUT_SECONDS(), 3_153_600_000n);
    assert.equal(await factory.read.MIN_REPLACE_TIMEOUT_SECONDS(), 60n);
    assert.equal(await factory.read.MAX_REPLACE_TIMEOUT_SECONDS(), 86_400n);
    const totalSupply = await d.read.totalSupply();
    assert.equal(totalSupply, 100n * 10n ** 18n, "D fixed supply drift");

    const proposalCount = await governance.read.proposalCount();
    let accountedCustody = 0n;
    const holderTotals = new Map<Address, bigint>();
    for (let proposalId = 1n; proposalId <= proposalCount; proposalId += 1n) {
      const stakers = await governance.read.getStakerList([proposalId]);
      for (const rawStaker of stakers) {
        const staker = getAddress(rawStaker);
        const [support, veto] = await Promise.all([
          governance.read.stakeOf([proposalId, staker]),
          governance.read.vetoStakeOf([proposalId, staker]),
        ]);
        const custody = support + veto;
        accountedCustody += custody;
        holderTotals.set(staker, (holderTotals.get(staker) ?? 0n) + custody);
      }
    }

    const governanceBalance = await d.read.balanceOf([governanceAddress]);
    assert.equal(
      governanceBalance,
      accountedCustody,
      "Governance D balance is not fully explained by proposal stake ledgers",
    );
    for (const [holder, expected] of holderTotals) {
      assert.equal(
        await governance.read.currentStakedOf([holder]),
        expected,
        `currentStakedOf drift for ${holder}`,
      );
    }

    const treasury = await viem.getContractAt(
      "ProtocolTreasury",
      getAddress(deployment.addresses.protocolTreasury),
    );
    assert.equal(
      getAddress(await treasury.read.controller()),
      governanceAddress,
      "Treasury controller drift",
    );
    assert.equal(await treasury.read.bootstrapLocked(), true);

    const satoshiVault = await viem.getContractAt(
      "SatoshiVault",
      getAddress(deployment.addresses.satoshiVault),
    );
    assert.equal(getAddress(await satoshiVault.read.controller()), governanceAddress);
    assert.equal(
      getAddress(await satoshiVault.read.dealCoin()),
      getAddress(deployment.addresses.dlToken),
    );

    const dividendVault = await viem.getContractAt(
      "DealDividendVault",
      getAddress(deployment.addresses.dealDividendVault),
    );
    assert.equal(
      getAddress(await dividendVault.read.governance()),
      governanceAddress,
    );
    assert.equal(
      getAddress(await dividendVault.read.dToken()),
      dAddress,
    );
    assert.equal(
      getAddress(await dividendVault.read.dealCoin()),
      getAddress(deployment.addresses.dlToken),
    );

    const policyRegistryAddress = getAddress(
      deployment.addresses.governancePolicyRegistry,
    );
    const policyRegistry = await viem.getContractAt(
      "GovernancePolicyRegistry",
      policyRegistryAddress,
    );
    const productionRules = [
      ...buildDaoV2PolicyRules({
        governance: governanceAddress,
        policyRegistry: policyRegistryAddress,
        dealFactory: getAddress(deployment.addresses.dealFactory),
        crossChainBroadcaster: getAddress(
          deployment.addresses.crossChainBroadcaster,
        ),
        protocolTreasury: getAddress(deployment.addresses.protocolTreasury),
        bscDealFactory: getAddress(bscDeployment.addresses.dealFactory),
      }),
      ...buildDaoV2TreasuryModuleRules(
        getAddress(deployment.addresses.satoshiVault),
        getAddress(deployment.addresses.dealDividendVault),
      ),
    ];
    assert.equal(productionRules.length, 52);
    const actualRules = await Promise.all(
      productionRules.map((rule) =>
        policyRegistry.read.getRule([rule.kind, rule.target, rule.selector]),
      ),
    );
    for (let index = 0; index < productionRules.length; index += 1) {
      const expected = productionRules[index];
      const actual = actualRules[index];
      const label = "label" in expected ? expected.label : `module rule ${index}`;
      assert.equal(actual.allowed, expected.allowed, `${label} allowed`);
      assert.equal(
        actual.validateNestedBroadcast,
        expected.validateNestedBroadcast,
        `${label} nested validation`,
      );
      assert.equal(actual.nestedOnly, expected.nestedOnly, `${label} nestedOnly`);
      assert.equal(actual.maxValue, expected.maxValue, `${label} maxValue`);
    }

    console.log(
      `ETH baseline verified: addresses=${Object.keys(deployment.addresses).length} ` +
        `liveComponents=${Object.keys(readableState).length} ` +
        `proposals=${proposalCount} policies=${productionRules.length} D=${formatEther(totalSupply)} ` +
        `staked=${formatEther(governanceBalance)}`,
    );
  });
});
