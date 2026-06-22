/**
 * 集票否决深度测试
 * 覆盖：边界场景、状态机、会计正确性、潜在漏洞
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";

const D_UNIT = 10n ** 18n;
const ACTIVATION_THRESHOLD = 25n * D_UNIT / 10n; // 2.5 D

async function setup() {
  const { viem } = await network.connect({ network: "hardhatMainnet" });
  const publicClient = await viem.getPublicClient();
  const testClient   = await viem.getTestClient();
  const wallets      = await viem.getWalletClients();
  const [owner, alice, bob, carol] = wallets;

  const d   = await viem.deployContract("D",       [owner.account.address]);
  const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
  const impl = await viem.deployContract("DealGovernance", []);
  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [d.address, zeroAddress, dc.address, owner.account.address],
  });
  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
  const gov   = await viem.getContractAt("DealGovernance", proxy.address);

  // 工具函数
  async function w(p: Promise<`0x${string}`>) {
    return publicClient.waitForTransactionReceipt({ hash: await p });
  }
  async function govAs(wallet: typeof owner) {
    return viem.getContractAt("DealGovernance", gov.address, { client: { wallet } });
  }
  async function dAs(wallet: typeof owner) {
    return viem.getContractAt("D", d.address, { client: { wallet } });
  }
  async function approve(wallet: typeof owner, amount: bigint) {
    await w((await dAs(wallet)).write.approve([gov.address, amount]));
  }

  // noop calldata（用于创建无副作用提案）
  const noop = (desc: string) => encodeFunctionData({
    abi: gov.abi,
    functionName: "setFastPassThreshold",
    args: [70n * D_UNIT],
  });

  return { viem, publicClient, testClient, owner, alice, bob, carol, d, dc, gov, w, govAs, dAs, approve, noop };
}

describe("集票否决深度测试", async function () {

  // ─── 1. Pending 阶段可以集票 ──────────────────────────────────────────────

  it("Pending 阶段（未激活）可以 vetoStake，达门槛后立即否决", async function () {
    const { owner, alice, bob, gov, w, govAs, approve, noop, d } = await setup();

    await w((await (await (async () => {
      const dC = await import("viem");
      return { write: { transfer: (args: [string, bigint]) => d.write.transfer(args) } };
    })()).write.transfer([alice.account.address, ACTIVATION_THRESHOLD])));

    // 使用 d.write.transfer 分发 D
    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    await w(d.write.transfer([bob.account.address,   ACTIVATION_THRESHOLD]));

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);
    const govBob   = await govAs(bob);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "pending veto test", 0]));
    assert.equal(await gov.read.state([1n]), 1 /* Pending */);

    // alice 投 1.5 D（< 2.5 D，不触发）
    const PT15 = 15n * D_UNIT / 10n;
    await approve(alice, PT15);
    await w(govAlice.write.vetoStake([1n, PT15]));
    assert.equal(await gov.read.state([1n]), 1 /* 仍然 Pending */);
    assert.equal(await gov.read.totalVetoStaked([1n]), PT15);

    // bob 投 1 D，累计 2.5 D → 触发否决
    const ONE = 1n * D_UNIT;
    await approve(bob, ONE);
    await w(govBob.write.vetoStake([1n, ONE]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);
  });

  // ─── 2. 单人一次性 2.5 D 直接触发 ────────────────────────────────────────

  it("单人一次性投入 2.5 D vetoStake 立即否决", async function () {
    const { owner, alice, gov, w, govAs, approve, noop, d } = await setup();

    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "single shot", 0]));

    // 先激活提案
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);

    // alice 一次投 2.5 D → 立即否决
    await approve(alice, ACTIVATION_THRESHOLD);
    await w(govAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);
    assert.equal(await gov.read.totalVetoStaked([1n]), ACTIVATION_THRESHOLD);
  });

  // ─── 3. 同一人可多次 vetoStake，累计计算 ─────────────────────────────────

  it("同一地址可多次 vetoStake，vetoStakeOf 正确累计", async function () {
    const { owner, alice, gov, w, govAs, approve, noop, d } = await setup();

    const FIVE_D = 5n * D_UNIT;
    await w(d.write.transfer([alice.account.address, FIVE_D]));
    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "multi veto", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    const ONE = 1n * D_UNIT;
    // 三次分批投入
    await approve(alice, FIVE_D);
    await w(govAlice.write.vetoStake([1n, ONE]));
    assert.equal(await gov.read.vetoStakeOf([1n, alice.account.address]), ONE);

    await w(govAlice.write.vetoStake([1n, ONE]));
    assert.equal(await gov.read.vetoStakeOf([1n, alice.account.address]), 2n * ONE);

    // 第三次 0.5 D 达到 2.5 D 门槛
    const PT5 = 5n * D_UNIT / 10n;
    await w(govAlice.write.vetoStake([1n, PT5]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);
    assert.equal(await gov.read.vetoStakeOf([1n, alice.account.address]), 2n * ONE + PT5);
  });

  // ─── 4. 只有 vetoStake 时 claimBack 正常 ─────────────────────────────────

  it("没有支持质押、只有否决质押时 claimBack 正常退还", async function () {
    const { owner, alice, gov, w, govAs, approve, noop, d } = await setup();

    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "only veto stake", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    await approve(alice, ACTIVATION_THRESHOLD);
    await w(govAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD])); // 触发否决

    assert.equal(await gov.read.stakeOf([1n, alice.account.address]), 0n);
    assert.equal(await gov.read.vetoStakeOf([1n, alice.account.address]), ACTIVATION_THRESHOLD);

    const before = await d.read.balanceOf([alice.account.address]);
    await w(govAlice.write.claimBack([1n]));
    const after  = await d.read.balanceOf([alice.account.address]);
    assert.equal(after - before, ACTIVATION_THRESHOLD);

    // 重复 claimBack → NothingToClaim
    await assert.rejects(govAlice.write.claimBack([1n]), /NothingToClaim/);
  });

  // ─── 5. 提案未结束时 claimBack 应拒绝 ────────────────────────────────────

  it("Parameter 提案进行中（未否决/执行/取消）时 claimBack 报 NotExecutable", async function () {
    const { owner, alice, gov, w, govAs, approve, noop, d } = await setup();

    await w(d.write.transfer([alice.account.address, 1n * D_UNIT]));
    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "not ended test", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD])); // 激活

    // alice 投 1 D（未达门槛，提案仍 Active）
    const ONE = 1n * D_UNIT;
    await approve(alice, ONE);
    await w(govAlice.write.vetoStake([1n, ONE]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);

    // 提案没结束，claimBack 应失败
    await assert.rejects(govAlice.write.claimBack([1n]), /NotExecutable/);
  });

  // ─── 6. 已否决后再 vetoStake 应失败 ─────────────────────────────────────

  it("提案已被否决后再 vetoStake 报 AlreadyEnded", async function () {
    const { owner, alice, bob, gov, w, govAs, approve, noop, d } = await setup();

    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    await w(d.write.transfer([bob.account.address,   ACTIVATION_THRESHOLD]));
    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);
    const govBob   = await govAs(bob);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "already vetoed", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    // alice 触发否决
    await approve(alice, ACTIVATION_THRESHOLD);
    await w(govAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);

    // bob 再投应失败
    await approve(bob, ACTIVATION_THRESHOLD);
    await assert.rejects(govBob.write.vetoStake([1n, ACTIVATION_THRESHOLD]), /AlreadyVetoed|AlreadyEnded/);
  });

  // ─── 7. 取消的提案不能再 vetoStake ───────────────────────────────────────

  it("提案被提案人取消后 vetoStake 报 AlreadyEnded", async function () {
    const { owner, alice, gov, w, govAs, approve, noop, d } = await setup();

    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "cancel test", 0]));
    // 取消（Pending 状态时提案人可取消）
    await w(govOwner.write.cancel([1n]));
    assert.equal(await gov.read.state([1n]), 5 /* Canceled */);

    await approve(alice, ACTIVATION_THRESHOLD);
    await assert.rejects(govAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD]), /AlreadyEnded/);
  });

  // ─── 8. zero amount 报错 ─────────────────────────────────────────────────

  it("vetoStake 传入 0 报 ZeroAmount", async function () {
    const { owner, gov, w, govAs, noop } = await setup();

    const govOwner = await govAs(owner);
    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "zero test", 0]));

    await assert.rejects(govOwner.write.vetoStake([1n, 0n]), /ZeroAmount/);
  });

  // ─── 9. 集票否决可以覆盖 fast-pass ────────────────────────────────────────

  it("fast-pass 已通过（Succeeded）时集票否决仍然有效", async function () {
    const { owner, alice, bob, gov, w, govAs, approve, noop, d } = await setup();

    // owner 有 ~97.5 D，alice 70 D，bob 2.5 D
    const SEVENTY = 70n * D_UNIT;
    await w(d.write.transfer([alice.account.address, SEVENTY]));
    await w(d.write.transfer([bob.account.address,   ACTIVATION_THRESHOLD]));

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);
    const govBob   = await govAs(bob);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "fastpass then veto", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);

    // alice fast-pass approve (70 D ≥ fastPassThreshold) → Succeeded
    await approve(alice, SEVENTY);
    const dAsAlice = await (async () => {
      const { viem } = await network.connect({ network: "hardhatMainnet" });
      return viem.getContractAt("D", d.address, { client: { wallet: alice } });
    })();
    // fast-pass: alice's D balance counts, no transfer
    await w(govAlice.write.approve([1n]));
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded */);

    // bob 仍然可以集票否决（窗口未到期）
    await approve(bob, ACTIVATION_THRESHOLD);
    await w(govBob.write.vetoStake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);

    // 否决后不可执行
    await assert.rejects(govAlice.write.execute([1n]), /AlreadyVetoed|AlreadyEnded/);
  });

  // ─── 10. Satoshi 提案集票否决 ────────────────────────────────────────────

  it("Satoshi 提案可以集票否决，Satoshi Succeeded 后仍可否决", async function () {
    const { owner, alice, bob, gov, w, govAs, approve, noop, d } = await setup();

    const SATOSHI_THRESHOLD = 90n * D_UNIT;
    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    // 创建 Satoshi 提案（kind=3），只有 D seat 才能创建
    const noop_data = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    // owner 有足够 D 创建 Satoshi
    await w(govOwner.write.createProposal([[gov.address], [0n], [noop_data], "satoshi test", 3 /* Satoshi */]));

    // 质押 90 D 使 Satoshi 提案 Succeeded
    await approve(owner, SATOSHI_THRESHOLD);
    await w(govOwner.write.stake([1n, SATOSHI_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded */);

    // alice 集票否决（Satoshi 无窗口限制）
    const PT15 = 15n * D_UNIT / 10n;
    await approve(alice, PT15);
    await w(govAlice.write.vetoStake([1n, PT15]));
    // state() 优先判断 vetoed → 未触发时仍为 Succeeded（satoshiSucceeded=true 永久保留）
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded，1.5 D < 2.5 D 未触发否决 */);

    await approve(alice, ACTIVATION_THRESHOLD - PT15);
    await w(govAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD - PT15]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);
  });

  // ─── 11. _currentStaked 会计正确性 ───────────────────────────────────────

  it("vetoStake 增加 _currentStaked，claimBack 减回，最终归零", async function () {
    const { owner, alice, gov, w, govAs, approve, noop, d } = await setup();

    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "current staked test", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    // alice vetoStake 2.5 D
    await approve(alice, ACTIVATION_THRESHOLD);
    await w(govAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.currentStakedOf([alice.account.address]), ACTIVATION_THRESHOLD);
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);

    // claimBack 后归零
    await w(govAlice.write.claimBack([1n]));
    assert.equal(await gov.read.currentStakedOf([alice.account.address]), 0n);
  });

  // ─── 12. activeProposalCount 正确递减 ────────────────────────────────────

  it("集票否决触发后 activeProposalCount 正确递减", async function () {
    const { owner, alice, gov, w, govAs, approve, noop, d } = await setup();

    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "active count test", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.activeProposalCount(), 1n);

    // 集票否决
    await approve(alice, ACTIVATION_THRESHOLD);
    await w(govAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.activeProposalCount(), 0n); // 应该减为 0
  });

  // ─── 13. totalVetoStaked 不随 claimBack 减少的漏洞检测 ───────────────────
  //
  // 场景：Major 提案的 activationReturnable=true，允许提前 claimBack。
  // alice vetoStake 1 D，未达门槛。提案激活后 activationReturnable=true。
  // alice 提前 claimBack 取回 1 D → vetoStakeOf 归零，但 totalVetoStaked 仍为 1 D。
  // bob 再投 1.6 D → totalVetoStaked = 2.6 D ≥ 2.5 D → 否决触发！
  // 实际上只有 1.6 D 在合约里，但却被按 2.6 D 计算。
  // 这是一个会计漏洞：claimBack 没有减少 totalVetoStaked。

  it("【漏洞】Major 提案提前 claimBack 不减少 totalVetoStaked，导致幽灵贡献触发否决", async function () {
    const { viem, owner, alice, bob, gov, dc, w, govAs, approve, noop, d } = await setup();

    const PT16 = 16n * D_UNIT / 10n; // 1.6 D
    await w(d.write.transfer([alice.account.address, 1n * D_UNIT]));
    await w(d.write.transfer([bob.account.address,   PT16]));

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);
    const govBob   = await govAs(bob);

    // Major 提案需要支付 1000 DC 手续费：先 mint DC 给 owner 并 approve
    const DC_FEE = 1000n * D_UNIT;
    await w(dc.write.mint([owner.account.address, DC_FEE]));
    const dcAsOwner = await viem.getContractAt("DCToken", dc.address, { client: { wallet: owner } });
    await w(dcAsOwner.write.approve([gov.address, DC_FEE]));

    // Major 提案（kind=2）
    const noop_data = noop("m");
    await w(govOwner.write.createProposal([[gov.address], [0n], [noop_data], "major bug test", 2 /* Major */]));

    // alice vetoStake 1 D（未达 2.5 D 门槛）
    const ONE = 1n * D_UNIT;
    await approve(alice, ONE);
    await w(govAlice.write.vetoStake([1n, ONE]));
    assert.equal(await gov.read.totalVetoStaked([1n]), ONE);
    assert.equal(await gov.read.state([1n]), 1 /* Pending */);

    // owner 质押 2.5 D 激活 Major 提案 → activationReturnable = true
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal((await gov.read.getProposal([1n])).activationReturnable, true);

    // alice 通过 activationReturnable 提前 claimBack 取回 1 D
    const aliceBefore = await d.read.balanceOf([alice.account.address]);
    await w(govAlice.write.claimBack([1n]));
    const aliceAfter  = await d.read.balanceOf([alice.account.address]);
    assert.equal(aliceAfter - aliceBefore, ONE); // alice 成功取回了 D

    // 修复后：claimBack 时 totalVetoStaked 同步归零，不再有幽灵贡献
    const vetoTotalAfterClaim = await gov.read.totalVetoStaked([1n]);
    assert.equal(vetoTotalAfterClaim, 0n, "claimBack 应该同步减少 totalVetoStaked");

    // bob 投 1.6 D → totalVetoStaked = 0 + 1.6 = 1.6 D，未达门槛，提案不被否决
    await approve(bob, PT16);
    await w(govBob.write.vetoStake([1n, PT16]));
    assert.equal(await gov.read.state([1n]), 2 /* Active，1.6 D < 2.5 D */);
    assert.equal(await gov.read.totalVetoStaked([1n]), PT16);

    // bob 再补 0.9 D 才触发否决
    const PT09 = 9n * D_UNIT / 10n;
    await w(d.write.transfer([bob.account.address, PT09]));
    await approve(bob, PT09);
    await w(govBob.write.vetoStake([1n, PT09]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed，1.6 + 0.9 = 2.5 D */);
    assert.equal(await gov.read.totalVetoStaked([1n]), PT16 + PT09);
  });

  // ─── 14. 跨提案隔离：提案 A 的 vetoStake 不影响提案 B ─────────────────────

  it("两个提案的 totalVetoStaked 完全独立，互不影响", async function () {
    const { owner, alice, bob, gov, w, govAs, approve, noop, d } = await setup();

    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    await w(d.write.transfer([bob.account.address,   ACTIVATION_THRESHOLD]));

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);
    const govBob   = await govAs(bob);

    const noopData = noop("x");
    // 创建两个提案
    await w(govOwner.write.createProposal([[gov.address], [0n], [noopData], "prop A", 0]));
    await w(govOwner.write.createProposal([[gov.address], [0n], [noopData], "prop B", 0]));

    // alice 对提案 1 投 1.5 D
    await approve(alice, ACTIVATION_THRESHOLD);
    const PT15 = 15n * D_UNIT / 10n;
    await w(govAlice.write.vetoStake([1n, PT15]));

    // bob 对提案 2 投 1 D
    await approve(bob, ACTIVATION_THRESHOLD);
    const ONE = 1n * D_UNIT;
    await w(govBob.write.vetoStake([2n, ONE]));

    // 提案 1 的 totalVetoStaked = 1.5 D，提案 2 = 1 D，互不干扰
    assert.equal(await gov.read.totalVetoStaked([1n]), PT15);
    assert.equal(await gov.read.totalVetoStaked([2n]), ONE);
    assert.equal(await gov.read.state([1n]), 1 /* Pending */);
    assert.equal(await gov.read.state([2n]), 1 /* Pending */);
  });

  // ─── 15. ERC20 余额不足：合约状态未发生改变（CEI 安全性）─────────────────

  it("vetoStake 余额不足时 ERC20 失败，totalVetoStaked 不变", async function () {
    const { owner, alice, gov, w, govAs, approve, noop, d } = await setup();

    // alice 只有 1 D，试图 vetoStake 2 D
    const ONE = 1n * D_UNIT;
    const TWO = 2n * D_UNIT;
    await w(d.write.transfer([alice.account.address, ONE]));

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "balance test", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    // approve 超过实际持有量（approve 只是授权，不会失败）
    await approve(alice, TWO);
    // 实际转账时会失败：alice 余额只有 1 D
    await assert.rejects(govAlice.write.vetoStake([1n, TWO]));

    // 合约状态未改变
    assert.equal(await gov.read.totalVetoStaked([1n]), 0n);
    assert.equal(await gov.read.vetoStakeOf([1n, alice.account.address]), 0n);
    assert.equal(await gov.read.currentStakedOf([alice.account.address]), 0n);
  });

  // ─── 16. 原始支持质押者在集票否决触发后能正常 claimBack ──────────────────

  it("集票否决触发后，支持提案的质押者也能通过 claimBack 取回 D", async function () {
    const { owner, alice, bob, gov, w, govAs, approve, noop, d } = await setup();

    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    await w(d.write.transfer([bob.account.address,   ACTIVATION_THRESHOLD]));

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);
    const govBob   = await govAs(bob);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "support then veto", 0]));

    // alice 质押 2.5 D 支持（激活提案）
    await approve(alice, ACTIVATION_THRESHOLD);
    await w(govAlice.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);

    // bob 集票否决
    await approve(bob, ACTIVATION_THRESHOLD);
    await w(govBob.write.vetoStake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);

    // alice 取回支持质押 2.5 D
    const aliceBefore = await d.read.balanceOf([alice.account.address]);
    await w(govAlice.write.claimBack([1n]));
    const aliceAfter = await d.read.balanceOf([alice.account.address]);
    assert.equal(aliceAfter - aliceBefore, ACTIVATION_THRESHOLD);

    // bob 取回否决质押 2.5 D
    const bobBefore = await d.read.balanceOf([bob.account.address]);
    await w(govBob.write.claimBack([1n]));
    const bobAfter = await d.read.balanceOf([bob.account.address]);
    assert.equal(bobAfter - bobBefore, ACTIVATION_THRESHOLD);
  });

  // ─── 17. Pending 阶段 vetoStake，激活后 totalVetoStaked 持续累计 ──────────

  it("Pending 阶段已有 vetoStake，激活后 totalVetoStaked 不重置，可继续累计触发否决", async function () {
    const { owner, alice, bob, gov, w, govAs, approve, noop, d } = await setup();

    const ONE  = 1n * D_UNIT;
    const PT15 = 15n * D_UNIT / 10n;
    await w(d.write.transfer([alice.account.address, ONE]));
    await w(d.write.transfer([bob.account.address,   PT15])); // bob 需要 1.5 D

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);
    const govBob   = await govAs(bob);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "pending persist", 0]));
    assert.equal(await gov.read.state([1n]), 1 /* Pending */);

    // alice 在 Pending 阶段投 1 D
    await approve(alice, ONE);
    await w(govAlice.write.vetoStake([1n, ONE]));
    assert.equal(await gov.read.totalVetoStaked([1n]), ONE);

    // owner 激活提案（此时 totalVetoStaked 仍为 1 D）
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);
    assert.equal(await gov.read.totalVetoStaked([1n]), ONE); // 激活不重置

    // bob 再投 1.5 D → 累计 2.5 D → 触发否决
    await approve(bob, PT15);
    await w(govBob.write.vetoStake([1n, PT15]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);
    assert.equal(await gov.read.totalVetoStaked([1n]), ONE + PT15);
  });

  // ─── 18. vetoStake 计入红利分配快照 ──────────────────────────────────────

  it("vetoStake 后 getPastStakedOf 反映正确的历史质押量，计入红利快照", async function () {
    const { owner, alice, gov, w, govAs, approve, noop, d, viem } = await setup();

    const publicClient = await viem.getPublicClient();
    const testClient   = await viem.getTestClient();

    await w(d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "dividend test", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    // alice vetoStake 2.5 D → 触发否决
    await approve(alice, ACTIVATION_THRESHOLD);
    await w(govAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);

    // 挖一个块，获取快照时间点
    await testClient.mine({ blocks: 1 });
    const clock = await (await viem.getContractAt("D", d.address)).read.clock();
    const snapshot = BigInt(clock) - 1n;

    // vetoStake 应计入快照
    const pastStaked = await gov.read.getPastStakedOf([alice.account.address, snapshot]);
    assert.equal(pastStaked, ACTIVATION_THRESHOLD);

    // alice claimBack 后当前 currentStaked 归零，但历史快照不变
    await w(govAlice.write.claimBack([1n]));
    assert.equal(await gov.read.currentStakedOf([alice.account.address]), 0n);
    const pastStakedAfter = await gov.read.getPastStakedOf([alice.account.address, snapshot]);
    assert.equal(pastStakedAfter, ACTIVATION_THRESHOLD); // 历史不变
  });

  // ─── 19. 不存在的 proposalId 报 ProposalMissing ────────────────────────────

  it("vetoStake 不存在的提案 ID 报 ProposalMissing", async function () {
    const { owner, gov, approve, govAs } = await setup();
    const govOwner = await govAs(owner);
    await approve(owner, ACTIVATION_THRESHOLD);
    await assert.rejects(govOwner.write.vetoStake([999n, ACTIVATION_THRESHOLD]), /ProposalMissing/);
  });

  // ─── 20. vetoer 字段记录最后触发者 ───────────────────────────────────────

  it("p.vetoer 记录的是最后一笔使 totalVetoStaked 过门槛的人", async function () {
    const { owner, alice, bob, gov, w, govAs, approve, noop, d } = await setup();

    const PT15 = 15n * D_UNIT / 10n;
    await w(d.write.transfer([alice.account.address, PT15]));
    await w(d.write.transfer([bob.account.address,   PT15]));

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);
    const govBob   = await govAs(bob);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "vetoer test", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    // alice 先投 1.5 D（未触发）
    await approve(alice, PT15);
    await w(govAlice.write.vetoStake([1n, PT15]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);

    // bob 投 1 D → 2.5 D 触发，bob 是最终触发者
    const ONE = 1n * D_UNIT;
    await approve(bob, ONE);
    await w(govBob.write.vetoStake([1n, ONE]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);

    const prop = await gov.read.getProposal([1n]);
    assert.equal(prop.vetoer.toLowerCase(), bob.account.address.toLowerCase());
  });

  // ─── 21. 全部 claimBack 后 totalVetoStaked 归零 ──────────────────────────

  it("否决触发、全员 claimBack 后 totalVetoStaked 归零", async function () {
    const { owner, alice, bob, gov, w, govAs, approve, noop, d } = await setup();

    const PT15 = 15n * D_UNIT / 10n;
    const ONE  = 1n * D_UNIT;
    await w(d.write.transfer([alice.account.address, PT15]));
    await w(d.write.transfer([bob.account.address,   ONE]));

    const govOwner = await govAs(owner);
    const govAlice = await govAs(alice);
    const govBob   = await govAs(bob);

    await w(govOwner.write.createProposal([[gov.address], [0n], [noop("p")], "zero after claim", 0]));
    await approve(owner, ACTIVATION_THRESHOLD);
    await w(govOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    await approve(alice, PT15);
    await w(govAlice.write.vetoStake([1n, PT15]));
    await approve(bob, ONE);
    await w(govBob.write.vetoStake([1n, ONE]));
    // 2.5 D 触发否决
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);
    assert.equal(await gov.read.totalVetoStaked([1n]), PT15 + ONE);

    // 全员 claimBack
    await w(govAlice.write.claimBack([1n]));
    await w(govBob.write.claimBack([1n]));

    // 修复后：totalVetoStaked 随 claimBack 归零
    assert.equal(await gov.read.totalVetoStaked([1n]), 0n);
  });
});
