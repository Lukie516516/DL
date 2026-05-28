# 深度回归与安全审计摘要

**范围**：当前分支 `contracts/` 内 Deal / OpenTT / Factory / MessageHub 相关逻辑；重点覆盖近期变更（进程事件时间戳、`DealRewardsLogged` / `mintAndRecordDealRewards`、`DealMessageHub.postMessage` 含 `Canceled` / `Abandoned`）。

**结论（执行层）**：Hardhat 与 Foundry 全套测试通过；Slither 在既有排除规则下未暴露需立即阻断的单一「高危」条目，但存在大量信息级/风格类告警，需结合业务人工筛。

---

## 1. 回归测试执行结果

| 套件 | 命令 | 结果 |
|------|------|------|
| Foundry | `forge test`（默认 profile） | **30 passed**；见 `foundry.toml` 中 `[fuzz] runs = 512`、`[invariant] runs = 256, depth = 32`（单不变式每 run 约 **8192** 次 handler 调用） |
| Hardhat | `node node_modules/hardhat/dist/src/cli.js test` | **71 passing**（BusinessFlow、DealRules、Router、OrderBook、DomainFlows 等） |

**Foundry 覆盖一览**

| 文件 | 类型 | 内容 |
|------|------|------|
| `forge-test/DealOpenTokenTokenFull.t.sol` | 单元 / fuzz | OpenTT 主路径、超时、Hub 留言（含 `Canceled` / `Abandoned`） |
| 同上 `DealOpenTokenTokenInvariantTest` | **6 个 invariant** | `status` 有界、无 B 则无 B-NFT、成交清 NFT、**托管余额 ≤ 应托管上限**、**`Abandoned` ⇒ `b==0`**、**`Active`/`Locked` ⇒ `b!=0`** |
| `forge-test/DealMessageHubFuzz.t.sol` | fuzz | 追加消息一致性；**未登记 deal 调用 `postMessage` / `postFromDeal` 必 `NotDeal`** |
| `forge-test/TimeRangeFuzz.t.sol` | fuzz / 属性 | 工厂与 Deal 时间窗判定一致 |

**不变式 handler 修正**：`step_forceCompleteA/B` 中原先 `vm.warp(block.timestamp + aAt/bAt + timeout)` 会错误叠加时间；已改为与单元测试一致的 **绝对截止** `aAt/bAt + timeoutSeconds`（并不再误加当前块时间）。

**更狠的 fuzz**（可选）：`FOUNDRY_FUZZ_RUNS=2048 forge test` 或临时调高 `[invariant] runs`。

**新增/补强**：Foundry 增加 `test_postMessage_afterCanceled`、`test_postMessage_afterAbandoned`，锁定「终局取消/废弃后仍可通过 Hub 留言」回归（及 `Abandoned` 仅 A 可发）。

---

## 2. 静态分析（Slither）

- **配置**：`slither.config.json`（排除 `node_modules`、`forge-test`；排除 naming / solc-version 等探测器）。
- **结果规模**：约 **168 个合约**、**317 条**探测器输出；多数为 **timestamp 依赖**、**圈复杂度**、**dead-code**、**low-level call**、**missing-inheritance**、**unindexed-event** 等信息或低优先级类。
- **说明**：Slither 对 DeFi 协议常见「业务不变式」（托管守恒、投票顺序）**无法自动证明**；须依赖本仓库 **不变式测试 + 集成测试**。

---

## 3. 人工关注点（与近期功能相关）

### 3.1 `DealMessageHub.postMessage`

- 前端入口是 `postMessage(deal, content)`。
- Hub 校验 `factory.isDeal(deal)`，并读取该 deal 当前 `a()` / `b()`，只允许当前 A/B 写入。
- Hub 不额外限制 `status`，所以 `Completed` / `Canceled` / `Abandoned` 后只要仍是当前参与方也可留言。

### 3.2 `DealFactory.mintAndRecordDealRewards`

- `onlyDeal`：仅已登记 clone 可调用；成交时批量完成 DC 奖励 mint、`DealResultIndex.recordReward`、`DealRewardsLogged`、InfoNFT minted 累计记录。
- `DealRewardsLogged` 事件参数顺序为 `(deal, partyA, partyB, toA, toB, cAddr, toC)`，与 `RewardsMinted` 数据对齐，供索引单点订阅。

### 3.3 进程事件与时间戳

- 带 `when` 的事件与 `block.timestamp` 一致；`Completed(reason, when)` / `Canceled(when)` 也直接带终局时间。
- 前端/子图需 **更新 ABI**（若干事件签名相对历史版本已变）。

### 3.4 Hub 留言与 `Canceled` / `Abandoned`

- 六种 `status` 下**只要**调用者仍是当前 **`a` 或 `b`** 即可通过 Hub 发（需 `dealMessageHub` 已配置）。
- **`abandonByA`**：`Deal` / `DealOpenTokenToken` 的 `_refundAllToParties` 会 **`b = address(0)`**，故 **`Abandoned` 后通常仅 A 可发**；前 B 会 `NotParticipant`。**`Canceled`** 路径不清 `b`，A/B 仍可发。

### 3.5 OpenTT 与标准 Deal 差异

- **B 单方拒绝**可能走 `_expelBOnReject`（回 `Ready`），与双方拒绝的 **`Canceled`** 不同；索引与时间线需区分 `BExpelledOnReject` vs `Canceled`。

---

## 4. 残余风险与建议（非阻断）

1. **形式化/不变式**：可对「托管余额 ≥ 应退金额」类性质保持现有 Foundry invariant，并在重大改动后提高 fuzz runs。
2. **Slither 降噪**：可按模块逐步处理 `dead-code`、补接口继承（`missing-inheritance`），主要为可维护性，非即时安全漏洞。
3. **链下索引**：`Canceled(when)` 无地址字段，谁触发取消仍需依赖前置 `VoteCast` / `ForcedAfterTimeout`。
4. **部署一致性**：Deal 库拆分见 [Deal库拆分部署接线说明](./Deal库拆分部署接线说明.md)；**旧 clone 不自动升级**。

---

## 5. 签核清单（发版前）

- [ ] `forge test` + `npx hardhat test` CI 绿灯  
- [ ] 前端/子图 ABI 与事件主题同步  
- [ ] 工厂与 Hub 地址、OpenTT/Deal 实现指针与库链接与文档一致  
- [ ] （可选）提高 `fuzz_runs` 或跑 `slither` 全量并归档报告  

---

*本文件为执行记录与审计笔记，不构成对外法律或财务保证。*
