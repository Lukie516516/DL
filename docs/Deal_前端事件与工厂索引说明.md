# Deal / OpenTT：新事件、工厂方法与前端用法（简版）

面向前端与索引服务：如何用**最少订阅**拿到时间线、奖励汇总与成交后聊天相关能力。

---

## 1. 当前能力对齐（你问的三件事）

| 主题 | 状态 | 说明 |
|------|------|------|
| **时间戳 / 时间线** | 已对齐 | 多数进程事件带 `uint64 when`（或 OpenTT 的 `APreAccepted.at`），等于当时 `block.timestamp`。终局 `Completed` / `Canceled` 无额外字段时，用**该 log 所在区块**的 `timestamp` 即可（与 `when` 同源）。 |
| **瘦身（Deal 库拆分）** | 部署侧按文档接线 | 逻辑在 `DealLib` / `DealAssetNftLib` 等库与实现合约中；**新创建的 clone** 才用新实现。部署、换实现指针、库链接见 [Deal库拆分部署接线说明](./Deal库拆分部署接线说明.md)。 |
| **成交后聊天** | 已支持 | `Deal` / `DealOpenTokenToken` 的 `postMessage` 在 **含 `Completed` / `Canceled` / `Abandoned` 在内任意 `status`** 均允许（仅 A/B，且需工厂配置 `dealMessageHub`）。留言落 `DealMessageHub` 时照常有 `MessageStored` 等（以 Hub ABI 为准）。 |

---

## 2. 工厂：`DealRewardsLogged` + `logDealRewards`（索引只盯工厂时用最省事）

### 2.1 新方法（由 **Deal clone 在成交时内部调用**，前端一般不直接调）

- **`DealFactory.logDealRewards(partyA, toA, partyB, toB, cAddr, toC)`**  
  - **权限**：仅工厂登记的 Deal / OpenTT 实例（`onlyDeal`）可调用。  
  - **作用**：在工厂上打一笔汇总日志，内容与各 Deal 上的 `RewardsMinted` 一致，便于**只订阅工厂地址**做奖励展示/扫链。

### 2.2 事件

```solidity
event DealRewardsLogged(
    address indexed deal,
    address indexed partyA,
    address indexed partyB,
    uint256 toA,
    uint256 toB,
    address cAddr,
    uint256 toC
);
```

- **`deal`**：发起调用的 **Deal / OpenTT clone 地址**（`msg.sender`）。  
- 与 **`DLMinted(to, amount, deal)`** 的关系：`mintDL` 每转一笔 DL 仍会发 `DLMinted`（最多 3 条）；`DealRewardsLogged` 是**同一笔成交的奖励汇总（1 条）**。

### 2.3 最简单用法

1. 订阅 **`DealFactory` 地址** 上的 `DealRewardsLogged`。  
2. 用 `deal` 索引过滤「某合约实例」；用 `partyA` / `partyB` 过滤「某地址参与的成交」。  
3. 时间：用该 log 的 **block timestamp**（或交易 `block.timestamp`）。

---

## 3. Deal / OpenTT（clone）上的进程事件（交易时间线）

以下事件在 **`Deal` 与 `DealOpenTokenToken` 实例地址**上发出（模板一致；OpenTT 另有 §3.2 的补充事件）。

### 3.1 带 `when` 的字段（推荐直接展示，无需再推算业务时间）

| 事件 | 用途（示例文案方向） |
|------|----------------------|
| `Joined(b, nftLockedB, when)` | B 加入，进入 Active |
| `Paid(payer, isPartyA, when)` | 某侧完成注金（pay） |
| `WithdrawnInActive(payer, isPartyA, when)` | Active 下撤金 |
| `Locked(when)` | 双方条件满足，进入 Locked 可投票 |
| `VoteCast(who, isPartyA, vote, when)` | 某方投同意/拒绝（见下枚举） |
| `ForcedAfterTimeout(caller, completed, when)` | 超时后 `forceComplete`：`completed==true` 成交，`false` 取消 |
| `ActivePartnerCleared(prevB, reason, when)` | B 从 Active 被清掉：`reason 1 = exitByB`，`2 = kickBByA` |
| `DealAbandoned(initiator, when)` | A 废弃（`abandonByA`） |

**`Vote` 枚举（ABI 编码为 uint8）**：`Unset = 0`，`Accept = 1`，`Reject = 2`。  
**`CompletionReason`（`Completed`）**：`BothAccepted`、`ForcedByA`、`ForcedByB`（具体数值以生成 ABI 为准）。

### 3.2 OpenTT 专有

| 事件 | 说明 |
|------|------|
| `APreAccepted(a_, at)` | A 预同意（`at` 为时间戳） |
| `BExpelledOnReject(prevB, when)` | B 拒绝且被规则清退回 Ready（带 `when`） |

### 3.3 终局与区块时间

- **`Completed(CompletionReason reason)`**、**`Canceled()`**：事件体内**没有**额外 `when`；时间请用 **该事件所在区块 timestamp**。  
- 与带 `when` 的事件在**同一秒级时钟**下一致。

### 3.4 昵称 `{用户名称}`

链上事件给的是 **地址**（如 `who`、`payer`、`b`）。展示名请前端用 **InfoNFT / 用户配置** 等链下或合约视图解析，不宜在事件里塞长字符串。

---

## 4. 取消（`Canceled`）与废弃（`Abandoned`）：A / B 分别能做什么

合约里**没有**一个叫「cancel」的对外函数名给双方共用；前端说的「取消 / 废弃」要对应到**具体函数 + 终态 `status`**，否则会和「B 退出回到 Ready」搞混。

### 4.1 废弃 `Abandoned`（整单结束；托管已清，仍可链上留言）

| 项目 | 说明 |
|------|------|
| **谁可以** | **仅 A（发起方）** 调用 `abandonByA()`。 |
| **允许阶段** | **`Ready` 或 `Active`**（尚未进入 `Locked`）。 |
| **链上效果** | 全额退回双方已托管资产、解锁相关 NFT、清理 B 与索引标记，状态变为 **`Abandoned`**。 |
| **事件** | **`DealAbandoned(initiator, when)`**，`initiator` 恒为 **A**。 |
| **留言** | **`postMessage` 在 `Abandoned` 状态下允许**，但 **`abandonByA` 会执行 `b = address(0)`**（见 `_refundAllToParties`），故通常 **只有 A** 仍满足 `onlyAB`；前 B 地址无法再在该实例上留言。 |

**没有**对称的 `abandonByB`：B 不能在同一语义下「废弃整单」；B 在 Active 阶段只能 **`exitByB`**（见下 §4.3）。

---

### 4.2 取消 `Canceled`（Locked 上谈判失败；退款后仍可链上留言）

| 项目 | 说明 |
|------|------|
| **谁触发** | 不是单独一个「某方取消」按钮函数，而是逻辑走到内部 **`_cancel()`**。 |
| **允许阶段** | 仅在 **`Locked`**（双方已付清/满足锁定条件后投票）。 |
| **典型触发** | ① **A、B 都投 `Reject`**（`setMyVote`）；② **`forceComplete` 超时**：已投票一方选的是 **`Reject`**，对侧迟迟不投，超时后由已投方调用 `forceComplete`，走 **`_cancel()`**（会先 `ForcedAfterTimeout(..., completed: false, ...)`）。 |
| **链上效果** | 状态 **`Canceled`**；对已付款/托管侧做退款与 `Claimed` 事件，再 **`Canceled()`**。 |
| **事件** | 前序多有 **`VoteCast`**；超时取消时还有 **`ForcedAfterTimeout(caller, completed=false, when)`**；最后 **`Canceled()`**（该事件**不带地址**，要靠前几笔 log 判断是谁投了什么、谁调了 `forceComplete`）。 |
| **留言** | **`postMessage` 允许**（仍仅 A/B）。 |

与 **成交**对比：双方 **`Accept`** 或超时 **`Accept`** 一方 `forceComplete` → **`Completed`**，并有 `RewardsMinted` / 工厂的 `DealRewardsLogged` 等。

---

### 4.3 非终局：B 离开或 A 踢 B（回到 `Ready`，不是 `Canceled` / `Abandoned`）

在 **`Active`** 且已有 B 时：

| 调用 | 谁 | 结果状态 | 事件（便于 UI） |
|------|----|----------|-----------------|
| **`exitByB`** | B | **`Ready`**，`b` 清空，退款 | **`ActivePartnerCleared(prevB, reason=1, when)`** |
| **`kickBByA`** | A | 同上 | **`ActivePartnerCleared(prevB, reason=2, when)`** |

这是「退出本轮对手方 / 被踢出」，**整单仍可被 A 重新找人继续**；不要把它画成和 **`Canceled`** 同一种「交易失败终局」。

---

### 4.4 OpenTT 模板多一种「拒绝即清 B」

在 **`DealOpenTokenToken`** 的 **`Locked`** 里，若 **B 投 `Reject`** 而 **A 尚未 `Reject`**，会走内部 **`_expelBOnReject`**：**清掉 B、状态回 `Ready`**，并 **`BExpelledOnReject(prevB, when)`**。  
这不是 **`Canceled`**，也**不是** **`Abandoned`**；若 A 已 **`Reject`** 且 B 也 **`Reject`**，则仍是双方拒绝 → **`_cancel()`** → **`Canceled`**。

---

### 4.5 和链上聊天的关系（再确认）

| `status` | `postMessage` |
|----------|----------------|
| **全部六种** `status` | 在 **`msg.sender` 仍为当前 `a` 或 `b`** 时均允许（`dealMessageHub` 非零；计费按 `msgPrice*`）。**特例**：`abandonByA` 后 **`b` 已清零**，仅 **A** 可发。 |

---

## 5. 最简单集成路径（推荐）

1. **奖励 / 汇总**：只订 **`DealFactory`** → `DealRewardsLogged`（+ 如需 DL 明细再订 `DLMinted`）。  
2. **单笔交易时间线**：订 **该 Deal / OpenTT 实例地址** → 上表事件；按 `when` 或 log 区块时间排序。  
3. **成交后留言**：`Completed` 后仍调实例的 **`postMessage`**（及 Hub 侧配置与计费规则不变）。  
4. **ABI**：本次 **`Joined` / `Paid` / `WithdrawnInActive` / `Locked` / `BExpelledOnReject`** 等与旧版相比**签名已变**（增加时间戳等），前端解码需更新 artifact。

---

## 6. 相关源码（便于对 ABI）

- `contracts/DealFactory.sol`：`DealRewardsLogged`、`logDealRewards`、`DLMinted`  
- `contracts/Deal.sol`：进程事件、`postMessage`  
- `contracts/DealOpenTokenToken.sol`：同上 + `APreAccepted`、`BExpelledOnReject`  
- 部署与库拆分：`docs/Deal库拆分部署接线说明.md`
