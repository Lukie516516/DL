# Lukie 侧合约说明（给 Aris）

**分工**：Deal 核心、手续费状态机、详细接口以 **`Aris_Update_1.md` + `Deal.sol`** 为准。  
本文只概括 **域名 / Rank / Hall / Swap / Market** 及 **与 Deal 的衔接**，方便你对照产品边界。

---

## 1. 和 Deal 相关的衔接点

| 点 | 说明 |
|----|------|
| **Relay** | `DealFactory.setTrustedDealRelay(DCDomainHall, true)`，Hall 才能 `createDealFor` / `chargeMessageFeeFrom`。 |
| **大厅建单** | `InitParams.deferCounterpartyPick == true`：须 Open + `expectedB=0`；`join` 被挡直到 A 调 `openJoinFor`；详见下节。 |
| **留言费** | Deal 内留言：用户授权 **Deal**；Hall 留言：授权 **DealFactory**（`chargeMessageFeeFrom` → `burnFrom`）。 |

---

## 2. Deal：`deferCounterpartyPick`（先建单 → 大厅 → 选人）

- **`joinOpenBlocked`**：`join()` → `JoinBlocked`，直到 **`openJoinFor(chosenB)`** → `ExactAddress` + `CounterpartyOpened`。
- **`hadDeferredPick`**：B 因 **`exitByB` / `kickBByA`** 清空后，可再次回到「大厅选人」（Open + 挡 join）。
- **`reopenCounterpartyPick()`**：已选人但 B 还没 join 时，A 可撤回选人。
- **`kickUnpaidBAndJoin`**：不触发「回到大厅」。
- Factory 的 **`InitParams`** 末尾多 **`deferCounterpartyPick`**（与 `Deal` 字段顺序一致）。

---

## 3. DCDomainHall（撮合大厅）

**部署**：依赖 Rank、DCDomain、DealFactory；Factory 须信任本合约。

**已删掉**：旧 **MatchSession** 整套（按 sessionId 撮合再建单）。

**推荐主路径**（模板②③ 币-空 / 空-空）：

1. `createHallDealTemplate23`（defer 建单）  
2. `postMessageOnDeal(domain, deal, content)`  
3. `confirmHallDealCounterparty(domain, deal, visitor)` → 内部 `Deal.openJoinFor`

**TTE**：`createTteHallDeal` → 同上 2、3。

**其它**：商户↔单访客 `postMessage` / `getMessages`；不经大厅直接指定 B：`pickUserAndCreateDeal`（`deferCounterpartyPick: false`）。

就根据你的加上之前的模板 改的这个撮合大厅 需求实现路径看2

---

## 4. DCDomainRank（进门费 / 商家扣费 / 排行）

| 角色 | 链上行为 |
|------|----------|
| **访客** | `enterDomain` **不扣费**；`VisitorEntered` 里 `feePaid` 恒为 0。 |
| **商家** | 首次 **`deposit`** 扣 **`entryFee` → treasury**，其余进押金。 |
| **扣时间费** | 按 **`hourlyRate`** 从押金里扣给 **域名 NFT 持有人**（`_pendingConsume`，按小时取整，在 `deposit/withdraw/settle` 等时结算；不是每个区块打一笔）。 |
| **排行** | `getLeaderboard`：按 `totalConsumed + pendingConsume` 降序。 |

黑名单、踢访客、踢长期未 `deposit` 的商家等：见合约注释。

---

## 5. 其它域名合约（一句话）

- **DCDomain**：域名 NFT、`resolve`、`marketSyncResolve`（二级市场同步持有人）。  
- **DCDomainSwap**：带 Rank 校验的 `createDeal`；默认 **`deferCounterpartyPick: false`**（公开接单，与 Hall 分流）。  
- **DCDomainMarket**：域名 NFT 二级，`buy` 后同步 `resolve`。

---

## 6. DEX Pair / Router（与 Deal 并列模块）

- **`DealSwapTemplate`**：`swap(..., bool feeInDl)`。  
  - **`feeInDl == true`**：手续费 **千 2**，从 **DL** 扣并 **burn**。  
  - **`feeInDl == false`**：手续费 **千 3**，从 **OTHER**（AUSD/USDT/AGI 等）扣，转 **`feeRecipient`**（Factory `createPair` 时写入 **treasury**）。  
- **`DealSwapRouter`**：各对外 swap 多参数 **`feeInDl`**（在 `deadline` 前）；双跳两跳共用同一开关。  
- **`setPairFee` 不再影响上述 swap 费率**（仅保留存储/兼容）。

---

## 7. 测试

`test/DealRules.ts`：`init` 需带 **`bDepositKickGraceSeconds`**、**`deferCounterpartyPick`**；有一条 **`deferCounterpartyPick: true`** 全流程用例。

---

## 8. 未做 / 链外

- 需求里的 **DEX 虚拟流动性** 等：本仓库未按产品全文实现。  
- **「仅域内成员可见合同」**：链上 Deal 公开；是否展示给访客由 **Rank + 前端** 控制。
