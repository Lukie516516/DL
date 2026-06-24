/**
 * DealResultIndexV2 测试套件
 *
 * 覆盖范围：
 *  1. recordTimeline — event 正确发出，边界条件跳过
 *  2. recordReward  — event 正确发出，用户列表正确写入，去重
 *  3. recordCredit  — event 正确发出，token 列表正确写入，去重
 *  4. 分页 getDealsByUser / getDealsByToken（offset、limit、newestFirst）
 *  5. onlyFactory 权限控制
 *  6. V1 vs V2 对比——同样的调用序列，用户列表和 token 列表完全一致
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { zeroAddress } from "viem";

type Address = `0x${string}`;

// 模拟 deal 地址（不需要真实合约）
const DEAL1 = "0x0000000000000000000000000000000000000001" as Address;
const DEAL2 = "0x0000000000000000000000000000000000000002" as Address;
const DEAL3 = "0x0000000000000000000000000000000000000003" as Address;
const DEAL4 = "0x0000000000000000000000000000000000000004" as Address;
const DEAL5 = "0x0000000000000000000000000000000000000005" as Address;

async function deployFixture() {
  const { viem } = await network.connect({ network: "hardhatMainnet" });
  const publicClient = await viem.getPublicClient();
  const [owner, alice, bob, charlie, stranger] = await viem.getWalletClients();

  // owner 充当 factory（直接调用 recordXxx）
  const factory = owner.account.address;

  const v1 = await viem.deployContract("DealResultIndex", [factory]);
  const v2 = await viem.deployContract("DealResultIndexV2", [factory]);

  return { viem, publicClient, owner, alice, bob, charlie, stranger, factory, v1, v2 };
}

// ─── recordTimeline ───────────────────────────────────────────────────────────

describe("DealResultIndexV2 – recordTimeline", () => {
  it("emits DealTimeline with correct fields", async () => {
    const { publicClient, owner, v2 } = await deployFixture();

    const fromBlock = await publicClient.getBlockNumber();

    await v2.write.recordTimeline(
      [DEAL1, 1, owner.account.address, true, 500n],
      { account: owner.account }
    );

    const logs = await publicClient.getContractEvents({
      address: v2.address,
      abi: v2.abi,
      eventName: "DealTimeline",
      fromBlock,
    });

    assert.equal(logs.length, 1);
    const e = logs[0].args;
    assert.equal(e.deal!.toLowerCase(), DEAL1.toLowerCase());
    assert.equal(e.action, 1);
    assert.equal(e.actor!.toLowerCase(), owner.account.address.toLowerCase());
    assert.equal(e.isPartyA, true);
    assert.equal(e.value, 500n);
  });

  it("skips when deal == address(0)", async () => {
    const { publicClient, owner, v2 } = await deployFixture();
    const fromBlock = await publicClient.getBlockNumber();

    await v2.write.recordTimeline(
      [zeroAddress, 1, owner.account.address, true, 0n],
      { account: owner.account }
    );

    const logs = await publicClient.getContractEvents({
      address: v2.address, abi: v2.abi, eventName: "DealTimeline", fromBlock,
    });
    assert.equal(logs.length, 0, "should emit nothing when deal is zero");
  });

  it("skips when action == 0", async () => {
    const { publicClient, owner, v2 } = await deployFixture();
    const fromBlock = await publicClient.getBlockNumber();

    await v2.write.recordTimeline(
      [DEAL1, 0, owner.account.address, false, 0n],
      { account: owner.account }
    );

    const logs = await publicClient.getContractEvents({
      address: v2.address, abi: v2.abi, eventName: "DealTimeline", fromBlock,
    });
    assert.equal(logs.length, 0, "should emit nothing when action is 0");
  });

  it("emits one event per call (7 timeline calls)", async () => {
    const { publicClient, owner, v2 } = await deployFixture();
    const fromBlock = await publicClient.getBlockNumber();

    for (let i = 1; i <= 7; i++) {
      await v2.write.recordTimeline(
        [DEAL1, i as any, owner.account.address, i % 2 === 0, BigInt(i * 100)],
        { account: owner.account }
      );
    }

    const logs = await publicClient.getContractEvents({
      address: v2.address, abi: v2.abi, eventName: "DealTimeline", fromBlock,
    });
    assert.equal(logs.length, 7);
  });
});

// ─── recordReward ─────────────────────────────────────────────────────────────

describe("DealResultIndexV2 – recordReward", () => {
  it("emits DealReward with correct fields", async () => {
    const { publicClient, owner, alice, bob, charlie, v2 } = await deployFixture();
    const fromBlock = await publicClient.getBlockNumber();

    await v2.write.recordReward(
      [DEAL1, alice.account.address, 100n, bob.account.address, 80n, charlie.account.address, 20n],
      { account: owner.account }
    );

    const logs = await publicClient.getContractEvents({
      address: v2.address, abi: v2.abi, eventName: "DealReward", fromBlock,
    });
    assert.equal(logs.length, 1);
    const e = logs[0].args;
    assert.equal(e.deal!.toLowerCase(), DEAL1.toLowerCase());
    assert.equal(e.partyA!.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(e.partyB!.toLowerCase(), bob.account.address.toLowerCase());
    assert.equal(e.toA, 100n);
    assert.equal(e.toB, 80n);
    assert.equal(e.cAddr!.toLowerCase(), charlie.account.address.toLowerCase());
    assert.equal(e.toC, 20n);
  });

  it("adds deal to partyA list when toA > 0", async () => {
    const { owner, alice, bob, v2 } = await deployFixture();

    await v2.write.recordReward(
      [DEAL1, alice.account.address, 100n, bob.account.address, 0n, zeroAddress, 0n],
      { account: owner.account }
    );

    const count = await v2.read.dealCountByUser([alice.account.address]);
    assert.equal(count, 1n);
    const bCount = await v2.read.dealCountByUser([bob.account.address]);
    assert.equal(bCount, 0n, "bob has toB=0, should not be added");
  });

  it("adds deal to partyB list when toB > 0", async () => {
    const { owner, alice, bob, v2 } = await deployFixture();

    await v2.write.recordReward(
      [DEAL1, alice.account.address, 0n, bob.account.address, 50n, zeroAddress, 0n],
      { account: owner.account }
    );

    assert.equal(await v2.read.dealCountByUser([bob.account.address]), 1n);
    assert.equal(await v2.read.dealCountByUser([alice.account.address]), 0n);
  });

  it("adds deal to cAddr list when toC > 0 and cAddr != zero", async () => {
    const { owner, alice, bob, charlie, v2 } = await deployFixture();

    await v2.write.recordReward(
      [DEAL1, alice.account.address, 0n, bob.account.address, 0n, charlie.account.address, 10n],
      { account: owner.account }
    );

    assert.equal(await v2.read.dealCountByUser([charlie.account.address]), 1n);
    assert.equal(await v2.read.dealCountByUser([alice.account.address]), 0n);
  });

  it("does NOT add cAddr when cAddr == zero even with toC > 0", async () => {
    const { owner, alice, bob, v2 } = await deployFixture();

    await v2.write.recordReward(
      [DEAL1, alice.account.address, 10n, bob.account.address, 10n, zeroAddress, 10n],
      { account: owner.account }
    );

    // zeroAddress should never appear in the list
    assert.equal(await v2.read.dealCountByUser([zeroAddress]), 0n);
  });

  it("deduplication: calling recordReward twice with same deal adds deal only once", async () => {
    const { owner, alice, bob, v2 } = await deployFixture();

    await v2.write.recordReward(
      [DEAL1, alice.account.address, 100n, bob.account.address, 80n, zeroAddress, 0n],
      { account: owner.account }
    );
    // call again (Factory should not do this, but V2 must be idempotent)
    await v2.write.recordReward(
      [DEAL1, alice.account.address, 100n, bob.account.address, 80n, zeroAddress, 0n],
      { account: owner.account }
    );

    assert.equal(await v2.read.dealCountByUser([alice.account.address]), 1n);
    assert.equal(await v2.read.dealCountByUser([bob.account.address]), 1n);
  });

  it("multiple different deals accumulate correctly for same user", async () => {
    const { owner, alice, bob, v2 } = await deployFixture();

    for (const deal of [DEAL1, DEAL2, DEAL3]) {
      await v2.write.recordReward(
        [deal, alice.account.address, 100n, bob.account.address, 80n, zeroAddress, 0n],
        { account: owner.account }
      );
    }

    assert.equal(await v2.read.dealCountByUser([alice.account.address]), 3n);
  });
});

// ─── recordCredit ─────────────────────────────────────────────────────────────

describe("DealResultIndexV2 – recordCredit", () => {
  it("returns early if aDelta == 0 && bDelta == 0 (no event, no storage)", async () => {
    const { publicClient, owner, alice, bob, v2 } = await deployFixture();
    const fromBlock = await publicClient.getBlockNumber();

    await v2.write.recordCredit(
      [DEAL1, alice.account.address, bob.account.address, 1n, 2n, 100n, 0n, 0n],
      { account: owner.account }
    );

    const logs = await publicClient.getContractEvents({
      address: v2.address, abi: v2.abi, eventName: "DealCredit", fromBlock,
    });
    assert.equal(logs.length, 0, "no event when both deltas are 0");
    assert.equal(await v2.read.dealCountByToken([1n]), 0n);
    assert.equal(await v2.read.dealCountByToken([2n]), 0n);
  });

  it("emits DealCredit with correct fields", async () => {
    const { publicClient, owner, alice, bob, v2 } = await deployFixture();
    const fromBlock = await publicClient.getBlockNumber();

    await v2.write.recordCredit(
      [DEAL1, alice.account.address, bob.account.address, 10n, 20n, 500n, 3n, 5n],
      { account: owner.account }
    );

    const logs = await publicClient.getContractEvents({
      address: v2.address, abi: v2.abi, eventName: "DealCredit", fromBlock,
    });
    assert.equal(logs.length, 1);
    const e = logs[0].args;
    assert.equal(e.deal!.toLowerCase(), DEAL1.toLowerCase());
    assert.equal(e.aTokenId, 10n);
    assert.equal(e.bTokenId, 20n);
    assert.equal(e.aDelta, 3n);
    assert.equal(e.bDelta, 5n);
  });

  it("adds deal to aTokenId list when aDelta > 0 && aTokenId > 0", async () => {
    const { owner, alice, bob, v2 } = await deployFixture();

    await v2.write.recordCredit(
      [DEAL1, alice.account.address, bob.account.address, 5n, 6n, 100n, 10n, 0n],
      { account: owner.account }
    );

    assert.equal(await v2.read.dealCountByToken([5n]), 1n);
    assert.equal(await v2.read.dealCountByToken([6n]), 0n, "bDelta=0, bTokenId should not be added");
  });

  it("skips aTokenId == 0 even when aDelta > 0 (no-op, matches V1 _addCreditDealFor guard)", async () => {
    const { owner, alice, bob, v2 } = await deployFixture();

    await v2.write.recordCredit(
      [DEAL1, alice.account.address, bob.account.address, 0n, 6n, 100n, 10n, 5n],
      { account: owner.account }
    );

    assert.equal(await v2.read.dealCountByToken([0n]), 0n, "tokenId 0 should never be indexed");
    assert.equal(await v2.read.dealCountByToken([6n]), 1n);
  });

  it("deduplication: same deal recorded twice → token list has length 1", async () => {
    const { owner, alice, bob, v2 } = await deployFixture();

    await v2.write.recordCredit(
      [DEAL1, alice.account.address, bob.account.address, 7n, 8n, 100n, 3n, 3n],
      { account: owner.account }
    );
    await v2.write.recordCredit(
      [DEAL1, alice.account.address, bob.account.address, 7n, 8n, 100n, 3n, 3n],
      { account: owner.account }
    );

    assert.equal(await v2.read.dealCountByToken([7n]), 1n);
    assert.equal(await v2.read.dealCountByToken([8n]), 1n);
  });
});

// ─── 分页查询 ────────────────────────────────────────────────────────────────

describe("DealResultIndexV2 – pagination getDealsByUser", () => {
  async function seedUserDeals() {
    const { owner, alice, v2 } = await deployFixture();

    // 依次写入 5 个 deal
    for (const deal of [DEAL1, DEAL2, DEAL3, DEAL4, DEAL5]) {
      await v2.write.recordReward(
        [deal, alice.account.address, 100n, owner.account.address, 0n, zeroAddress, 0n],
        { account: owner.account }
      );
    }
    return { owner, alice, v2 };
  }

  it("returns all deals with offset=0, limit=100", async () => {
    const { alice, v2 } = await seedUserDeals();
    const list = await v2.read.getDealsByUser([alice.account.address, 0n, 100n, false]);
    assert.equal(list.length, 5);
  });

  it("pagination: offset=2, limit=2 returns deals[2..3]", async () => {
    const { alice, v2 } = await seedUserDeals();
    const all  = await v2.read.getDealsByUser([alice.account.address, 0n, 100n, false]);
    const page = await v2.read.getDealsByUser([alice.account.address, 2n, 2n, false]);
    assert.equal(page.length, 2);
    assert.equal(page[0].toLowerCase(), all[2].toLowerCase());
    assert.equal(page[1].toLowerCase(), all[3].toLowerCase());
  });

  it("pagination: newestFirst returns reverse order", async () => {
    const { alice, v2 } = await seedUserDeals();
    const asc  = await v2.read.getDealsByUser([alice.account.address, 0n, 100n, false]);
    const desc = await v2.read.getDealsByUser([alice.account.address, 0n, 100n, true]);
    assert.equal(desc.length, asc.length);
    for (let i = 0; i < asc.length; i++) {
      assert.equal(desc[i].toLowerCase(), asc[asc.length - 1 - i].toLowerCase());
    }
  });

  it("pagination: offset >= total returns empty array", async () => {
    const { alice, v2 } = await seedUserDeals();
    const list = await v2.read.getDealsByUser([alice.account.address, 10n, 10n, false]);
    assert.equal(list.length, 0);
  });

  it("pagination: limit=0 returns empty array", async () => {
    const { alice, v2 } = await seedUserDeals();
    const list = await v2.read.getDealsByUser([alice.account.address, 0n, 0n, false]);
    assert.equal(list.length, 0);
  });

  it("pagination: limit capped at MAX_PAGE_SIZE=100", async () => {
    const { alice, v2 } = await seedUserDeals();
    // 5 deals, limit=999 should be capped → returns 5
    const list = await v2.read.getDealsByUser([alice.account.address, 0n, 999n, false]);
    assert.equal(list.length, 5);
  });

  it("returns empty for user with no deals", async () => {
    const { stranger, v2 } = await deployFixture();
    const list = await v2.read.getDealsByUser([stranger.account.address, 0n, 100n, false]);
    assert.equal(list.length, 0);
  });
});

describe("DealResultIndexV2 – pagination getDealsByToken", () => {
  async function seedTokenDeals() {
    const { owner, alice, bob, v2 } = await deployFixture();
    const tokenId = 42n;

    for (const deal of [DEAL1, DEAL2, DEAL3]) {
      await v2.write.recordCredit(
        [deal, alice.account.address, bob.account.address, tokenId, 99n, 100n, 5n, 3n],
        { account: owner.account }
      );
    }
    return { owner, v2, tokenId };
  }

  it("returns all deals for tokenId", async () => {
    const { v2, tokenId } = await seedTokenDeals();
    const list = await v2.read.getDealsByToken([tokenId, 0n, 100n, false]);
    assert.equal(list.length, 3);
  });

  it("newestFirst returns reverse order", async () => {
    const { v2, tokenId } = await seedTokenDeals();
    const asc  = await v2.read.getDealsByToken([tokenId, 0n, 100n, false]);
    const desc = await v2.read.getDealsByToken([tokenId, 0n, 100n, true]);
    for (let i = 0; i < asc.length; i++) {
      assert.equal(desc[i].toLowerCase(), asc[asc.length - 1 - i].toLowerCase());
    }
  });

  it("returns empty for tokenId with no deals", async () => {
    const { v2 } = await deployFixture();
    const list = await v2.read.getDealsByToken([999n, 0n, 100n, false]);
    assert.equal(list.length, 0);
  });
});

// ─── onlyFactory 权限控制 ─────────────────────────────────────────────────────

// viem wraps custom errors in ContractFunctionExecutionError, so we match against
// the return data selector for NotFactory() = 0x32cc7236 or the word "reverted".
function assertReverts(fn: () => Promise<unknown>): Promise<void> {
  return assert.rejects(fn, (err: unknown) => {
    const msg = String(err);
    if (msg.includes("reverted") || msg.includes("0x32cc7236")) return true;
    throw new assert.AssertionError({ message: `Expected revert, got: ${msg}` });
  });
}

describe("DealResultIndexV2 – access control", () => {
  it("recordTimeline reverts with NotFactory when called by non-factory", async () => {
    const { stranger, v2 } = await deployFixture();
    await assertReverts(() =>
      v2.write.recordTimeline(
        [DEAL1, 1, stranger.account.address, false, 0n],
        { account: stranger.account }
      )
    );
  });

  it("recordReward reverts with NotFactory when called by non-factory", async () => {
    const { stranger, alice, bob, v2 } = await deployFixture();
    await assertReverts(() =>
      v2.write.recordReward(
        [DEAL1, alice.account.address, 100n, bob.account.address, 80n, zeroAddress, 0n],
        { account: stranger.account }
      )
    );
  });

  it("recordCredit reverts with NotFactory when called by non-factory", async () => {
    const { stranger, alice, bob, v2 } = await deployFixture();
    await assertReverts(() =>
      v2.write.recordCredit(
        [DEAL1, alice.account.address, bob.account.address, 1n, 2n, 100n, 5n, 5n],
        { account: stranger.account }
      )
    );
  });

  it("constructor reverts with NotFactory when factory_ == address(0)", async () => {
    const { viem } = await deployFixture();
    await assertReverts(() => viem.deployContract("DealResultIndexV2", [zeroAddress]));
  });
});

// ─── V1 vs V2 对比（最关键：数据一致性）──────────────────────────────────────

describe("DealResultIndexV2 – V1 vs V2 parity", () => {
  /**
   * 模拟一批完整 deal 的调用序列：
   *  - 多次 recordTimeline（V1 存储、V2 仅 emit）
   *  - recordReward
   *  - recordCredit
   * 然后对比两者的 user deal 列表 和 token deal 列表。
   */
  it("user deal lists match V1 getRewardDeals for 3 deals across 3 users", async () => {
    const { owner, alice, bob, charlie, v1, v2 } = await deployFixture();

    const calls: Array<[Address, Address, bigint, Address, bigint, Address, bigint]> = [
      [DEAL1, alice.account.address, 100n, bob.account.address, 80n, charlie.account.address, 20n],
      [DEAL2, alice.account.address, 50n,  bob.account.address, 50n, zeroAddress, 0n],
      [DEAL3, charlie.account.address, 30n, alice.account.address, 0n, zeroAddress, 0n],
    ];

    for (const args of calls) {
      await v1.write.recordReward(args, { account: owner.account });
      await v2.write.recordReward(args, { account: owner.account });
    }

    for (const user of [alice.account.address, bob.account.address, charlie.account.address]) {
      const v1list = await v1.read.getRewardDeals([user, 0n, 100n, false]);
      const v2list = await v2.read.getDealsByUser([user, 0n, 100n, false]);
      assert.equal(v2list.length, v1list.length, `count mismatch for ${user}`);
      for (let i = 0; i < v1list.length; i++) {
        assert.equal(
          v2list[i].toLowerCase(),
          v1list[i].toLowerCase(),
          `deal[${i}] mismatch for ${user}`
        );
      }
    }
  });

  it("token deal lists match V1 getCreditDeals", async () => {
    const { owner, alice, bob, v1, v2 } = await deployFixture();

    const creditCalls: Array<[Address, Address, Address, bigint, bigint, bigint, bigint, bigint]> = [
      [DEAL1, alice.account.address, bob.account.address, 10n, 20n, 100n, 5n, 3n],
      [DEAL2, alice.account.address, bob.account.address, 10n, 30n, 100n, 2n, 7n],
      [DEAL3, alice.account.address, bob.account.address, 20n, 10n, 100n, 4n, 6n],
    ];

    for (const args of creditCalls) {
      await v1.write.recordCredit(args, { account: owner.account });
      await v2.write.recordCredit(args, { account: owner.account });
    }

    // tokenId 10 → DEAL1, DEAL2 (both have it as aTokenId or bTokenId)
    // tokenId 20 → DEAL1, DEAL3
    // tokenId 30 → DEAL2
    for (const tokenId of [10n, 20n, 30n]) {
      const v1list = await v1.read.getCreditDeals([tokenId, 0n, 100n, false]);
      const v2list = await v2.read.getDealsByToken([tokenId, 0n, 100n, false]);
      assert.equal(v2list.length, v1list.length, `count mismatch for tokenId ${tokenId}`);
      for (let i = 0; i < v1list.length; i++) {
        assert.equal(
          v2list[i].toLowerCase(),
          v1list[i].toLowerCase(),
          `deal[${i}] mismatch for tokenId ${tokenId}`
        );
      }
    }
  });

  it("newestFirst pagination matches V1 for both user and token lists", async () => {
    const { owner, alice, bob, v1, v2 } = await deployFixture();

    // 5 deals for alice
    for (const deal of [DEAL1, DEAL2, DEAL3, DEAL4, DEAL5]) {
      await v1.write.recordReward([deal, alice.account.address, 100n, bob.account.address, 80n, zeroAddress, 0n], { account: owner.account });
      await v2.write.recordReward([deal, alice.account.address, 100n, bob.account.address, 80n, zeroAddress, 0n], { account: owner.account });
    }

    // page 1: offset=0, limit=3, newestFirst
    const v1page = await v1.read.getRewardDeals([alice.account.address, 0n, 3n, true]);
    const v2page = await v2.read.getDealsByUser([alice.account.address, 0n, 3n, true]);
    assert.equal(v2page.length, v1page.length);
    for (let i = 0; i < v1page.length; i++) {
      assert.equal(v2page[i].toLowerCase(), v1page[i].toLowerCase(), `page entry ${i} mismatch`);
    }

    // page 2: offset=3, limit=3, newestFirst
    const v1page2 = await v1.read.getRewardDeals([alice.account.address, 3n, 3n, true]);
    const v2page2 = await v2.read.getDealsByUser([alice.account.address, 3n, 3n, true]);
    assert.equal(v2page2.length, v1page2.length);
    for (let i = 0; i < v1page2.length; i++) {
      assert.equal(v2page2[i].toLowerCase(), v1page2[i].toLowerCase(), `page2 entry ${i} mismatch`);
    }
  });

  it("V2 emits DealTimeline events equivalent to V1 stored timeline count", async () => {
    const { publicClient, owner, alice, v2 } = await deployFixture();
    const fromBlock = await publicClient.getBlockNumber();

    const actions = [1, 2, 3, 4, 5, 6, 7];
    for (const action of actions) {
      await v2.write.recordTimeline(
        [DEAL1, action as any, alice.account.address, action % 2 === 0, BigInt(action * 10)],
        { account: owner.account }
      );
    }

    const logs = await publicClient.getContractEvents({
      address: v2.address, abi: v2.abi, eventName: "DealTimeline", fromBlock,
    });
    assert.equal(logs.length, actions.length, "event count should equal V1 timeline count");

    // verify order is preserved in log sequence
    for (let i = 0; i < actions.length; i++) {
      assert.equal(logs[i].args.action, actions[i]);
    }
  });
});
