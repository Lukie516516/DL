# Deal / OpenTT：新事件、工厂方法与前端用法（简版）

面向前端与索引服务：如何用**最少订阅**拿到时间线、奖励汇总与成交后聊天相关能力。

---

## 1. 当前能力对齐（你问的三件事）

| 主题 | 状态 | 说明 |
|------|------|------|
| **时间戳 / 时间线** | 已对齐 | 交易进程事件都带 `uint64 when`（OpenTT 的 `APreAccepted` 用 `at`），等于当时 `block.timestamp`。`Completed` / `Canceled` 也已带 `when`。 |
| **瘦身（Deal 库拆分）** | 部署侧按文档接线 | 逻辑在 `DealLib` / `DealAssetNftLib` 等库与实现合约中；**新创建的 clone** 才用新实现。部署、换实现指针、库链接见 [Deal库拆分部署接线说明](./Deal库拆分部署接线说明.md)。 |
| **成交后聊天** | 已支持 | 前端统一调用 `DealMessageHub.postMessage(deal, content)`。Hub 校验 `deal` 已在 Factory 登记，且 `msg.sender` 是该 deal 当前 `a` 或 `b`；`Completed` / `Canceled` / `Abandoned` 也可写。 |

---

## 2. 奖励结果：优先读 `DealResultIndex`，事件只做兜底

新增独立索引合约 `DealResultIndex`，用于把成交后的奖励结果、信用增量结果、交易过程时间线落到 storage，前端不需要每次扫历史 logs。

### 2.1 奖励 view

```solidity
rewardOfDeal(address deal) -> RewardRecord
rewardDealCount(address user) -> uint256
getRewardDeals(address user, uint256 offset, uint256 limit, bool newestFirst) -> address[]
getRewards(address user, uint256 offset, uint256 limit, bool newestFirst) -> RewardRecord[]
```

`RewardRecord` 字段：

| 字段 | 说明 |
| --- | --- |
| `exists` | 是否有奖励记录 |
| `deal` | deal 地址 |
| `partyA` / `partyB` | 双方地址 |
| `cAddr` | C 位奖励接收地址 |
| `toA` / `toB` / `toC` | 本笔增发 DL 奖励 |
| `timestamp` | 写入奖励记录的链上时间 |

### 2.2 信用增量 view

```solidity
creditOfDeal(address deal) -> CreditRecord
creditDealCount(uint256 tokenId) -> uint256
getCreditDeals(uint256 tokenId, uint256 offset, uint256 limit, bool newestFirst) -> address[]
getCreditRecords(uint256 tokenId, uint256 offset, uint256 limit, bool newestFirst) -> CreditRecord[]
```

`CreditRecord` 字段：

| 字段 | 说明 |
| --- | --- |
| `exists` | 是否有信用增量记录 |
| `deal` | deal 地址 |
| `partyA` / `partyB` | 双方地址 |
| `aTokenId` / `bTokenId` | 产生信用增量的官方 InfoNFT |
| `baseCredit` | 本笔基础信用贡献 |
| `aDelta` / `bDelta` | 本笔实际增加信用 |
| `timestamp` | 写入信用记录的链上时间 |

`limit` 超过 100 时按 100 返回。历史旧 deal 在索引合约部署前没有 storage 结果记录，需要事件或离线迁移补录。

### 2.3 交易过程时间线 view

用于前端展示“已加入 / 已注金 / 已投票 / 已超时 / 已被移除 / 已退出 / 已完成 / 已失败”等系统提示。

```solidity
timelineCount(address deal) -> uint256
getTimeline(address deal, uint256 offset, uint256 limit, bool newestFirst) -> TimelineRecord[]
```

`TimelineRecord` 字段：

| 字段 | 说明 |
| --- | --- |
| `action` | 动作编码，见下表 |
| `actor` | 本次动作的地址；终局类可能为 `address(0)` |
| `isPartyA` | `true` 表示 A 侧动作，`false` 表示 B 侧或系统动作 |
| `value` | 辅助值，例如投票枚举、完成原因、清退原因 |
| `timestamp` | 写入索引时的链上时间 |

`action` 编码：

| action | 对应提示 | `actor` | `value` |
| --- | --- | --- | --- |
| `1` | `{用户名称}已加入合约` | 加入的 B | B 的 `bNftId`，没有则 `0` |
| `2` | `{用户名称}已完成注金` | 注金方 | `0` |
| `3` | `{用户名称}已撤金` | 撤金方 | `0` |
| `4` | `{用户名称}已同意/拒绝交易` | 投票方 | `1 = Accept`，`2 = Reject` |
| `5` | `{用户名称}已超时触发` | 调用 `forceComplete` 的地址 | `1 = 强制成交`，`0 = 强制取消` |
| `6` | `DEAL!!! / 交易完成` | `address(0)` | `CompletionReason` |
| `7` | `交易失败` | `address(0)` | `0` |
| `8` | `交易已废弃` | A | `0` |
| `9` | `{用户名称}已被移除交易 / 已退出交易` | 被清掉的旧 B | `1 = B 主动退出`，`2 = A 踢 B`，`3 = Active 超时被顶替`，`4 = Locked 未投票被顶替` |
| `10` | `{用户名称}已被移除交易` | 拒绝后被清掉的 B | `0` |
| `11` | `A 已预同意` | A | `0` |
| `12` | `交易进入 Locked` | `address(0)` | `0` |

推荐前端读取：

```text
DealResultIndex.getTimeline(deal, 0, 50, false)
```

如需最新在前：

```text
DealResultIndex.getTimeline(deal, 0, 50, true)
```

`limit` 超过 100 时按 100 返回。历史旧 deal 在本索引逻辑上线前没有过程时间线 storage 记录，旧数据仍需要扫旧事件或离线补录。

### 2.4 storage / gas 成本说明

这套索引不会让已部署合约的代码体积越来越大。合约代码部署后是固定的，后续增长的是 `DealResultIndex` 里的链上状态数据。

成本边界：

| 项目 | 影响 |
| --- | --- |
| 写入过程时间线 | 每次关键动作会多写 1 条 `TimelineRecord`，该笔交易会多一点固定 gas |
| 查询单个 deal 时间线 | 按 `deal` 地址读取自己的数组，复杂度只和 `limit` 有关，不和全链区块高度有关 |
| 查询很多历史 deal | 前端要自己分页，不要一次性拉过大的列表 |
| 合约体积 | 不会因为 storage 记录变多而变大 |

推荐前端单次 `limit` 用 20-50；合约层超过 100 会按 100 截断。

## 3. 工厂：`DealRewardsLogged` + `mintAndRecordDealRewards`（事件兜底）

### 3.1 方法（由 **Deal clone 在成交时内部调用**，前端一般不直接调）

- **`DealFactory.mintAndRecordDealRewards(batch)`**
  - **权限**：仅工厂登记的 Deal / OpenTT 实例（`onlyDeal`）可调用。
  - **作用**：成交时批量完成 DL 奖励 mint、奖励索引写入、InfoNFT minted 统计，并在工厂上打一笔汇总日志。日志内容与各 Deal 上的 `RewardsMinted` 一致，便于**只订阅工厂地址**做奖励展示/扫链。

### 3.2 事件

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

### 3.3 事件用法

1. 订阅 **`DealFactory` 地址** 上的 `DealRewardsLogged`。  
2. 用 `deal` 索引过滤「某合约实例」；用 `partyA` / `partyB` 过滤「某地址参与的成交」。  
3. 时间：用该 log 的 **block timestamp**（或交易 `block.timestamp`）；这是工厂奖励汇总事件，不是单笔 deal 进程事件。

---

## 4. Deal / OpenTT（clone）上的进程事件（交易时间线）

以下事件在 **`Deal` 与 `DealOpenTokenToken` 实例地址**上发出（模板一致；OpenTT 另有 §3.2 的补充事件）。

### 4.1 带 `when` 的字段（推荐直接展示，无需再推算业务时间）

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
| `Completed(reason, when)` | 成交终局 |
| `Canceled(when)` | 取消终局 |

**`Vote` 枚举（ABI 编码为 uint8）**：`Unset = 0`，`Accept = 1`，`Reject = 2`。  
**`CompletionReason`（`Completed`）**：`BothAccepted`、`ForcedByA`、`ForcedByB`（具体数值以生成 ABI 为准）。

### 4.2 OpenTT 专有

| 事件 | 说明 |
|------|------|
| `APreAccepted(a_, at)` | A 预同意（`at` 为时间戳） |
| `BExpelledOnReject(prevB, when)` | B 拒绝且被规则清退回 Ready（带 `when`） |

### 4.3 终局时间

- **`Completed(CompletionReason reason, uint64 when)`**、**`Canceled(uint64 when)`**：直接读取 `when`。  
- 前端不需要再为这两个终局事件额外查区块时间。

### 4.4 昵称 `{用户名称}`

链上事件给的是 **地址**（如 `who`、`payer`、`b`）。展示名请前端用 **InfoNFT / 用户配置** 等链下或合约视图解析，不宜在事件里塞长字符串。

---

## 5. 取消（`Canceled`）与废弃（`Abandoned`）：A / B 分别能做什么

合约里**没有**一个叫「cancel」的对外函数名给双方共用；前端说的「取消 / 废弃」要对应到**具体函数 + 终态 `status`**，否则会和「B 退出回到 Ready」搞混。

### 5.1 废弃 `Abandoned`（整单结束；托管已清，仍可链上留言）

| 项目 | 说明 |
|------|------|
| **谁可以** | **仅 A（发起方）** 调用 `abandonByA()`。 |
| **允许阶段** | **`Ready` 或 `Active`**（尚未进入 `Locked`）。 |
| **链上效果** | 全额退回双方已托管资产、解锁相关 NFT、清理 B 与索引标记，状态变为 **`Abandoned`**。 |
| **事件** | **`DealAbandoned(initiator, when)`**，`initiator` 恒为 **A**。 |
| **留言** | 通过 **`DealMessageHub.postMessage(deal, content)`** 写入；但 **`abandonByA` 会执行 `b = address(0)`**（见 `_refundAllToParties`），故通常 **只有 A** 仍是当前参与方；前 B 地址无法再留言。 |

**没有**对称的 `abandonByB`：B 不能在同一语义下「废弃整单」；B 在 Active 阶段只能 **`exitByB`**（见下 §5.3）。

---

### 5.2 取消 `Canceled`（Locked 上谈判失败；退款后仍可链上留言）

| 项目 | 说明 |
|------|------|
| **谁触发** | 不是单独一个「某方取消」按钮函数，而是逻辑走到内部 **`_cancel()`**。 |
| **允许阶段** | 仅在 **`Locked`**（双方已付清/满足锁定条件后投票）。 |
| **典型触发** | ① **A、B 都投 `Reject`**（`setMyVote`）；② **B 投 `Reject`、A 未投票**时，B 可在 `timeoutSeconds` 后调用 `forceComplete` 取消。A 投 `Reject`、B 未投票时，A 不能再靠超时强制取消。 |
| **链上效果** | 状态 **`Canceled`**；对已付款/托管侧做退款与 `Claimed` 事件，再 **`Canceled(when)`**。 |
| **事件** | 前序多有 **`VoteCast`**；超时取消时还有 **`ForcedAfterTimeout(caller, completed=false, when)`**；最后 **`Canceled(when)`**（该事件**不带地址**，要靠前几笔 log 判断是谁投了什么、谁调了 `forceComplete`）。 |
| **留言** | **`DealMessageHub.postMessage(deal, content)` 允许**（仍仅当前 A/B）。 |

与 **成交**对比：双方 **`Accept`**，或 A 已 **`Accept`** 且 B 未投票后由 A 超时 `forceComplete` → **`Completed`**，并有 `RewardsMinted` / 工厂的 `DealRewardsLogged` 等。

---

### 5.3 非终局：B 离开或 A 踢 B（回到 `Ready`，不是 `Canceled` / `Abandoned`）

在 **`Active`** 且已有 B 时：

| 调用 | 谁 | 结果状态 | 事件（便于 UI） |
|------|----|----------|-----------------|
| **`exitByB`** | B | **`Ready`**，`b` 清空，退款 | **`ActivePartnerCleared(prevB, reason=1, when)`** |
| **`kickBByA`** | A | 同上 | **`ActivePartnerCleared(prevB, reason=2, when)`** |
| **`replaceInactiveBAndJoin`** | 外部新 B | **`Active`**，旧 B 清空并退款，新 B 成为当前 B | **`ActivePartnerCleared(prevB, reason=3, when)`** + 同 tx 的 **`Joined(newB, ...)`** |
| **`replaceNonVotingBAndJoin`** | 外部新 B | **`Locked`** 下 A 已 Accept、B 未投票且超时，旧 B 清空并退款，新 B 成为当前 B，交易回到 Active | **`ActivePartnerCleared(prevB, reason=4, when)`** + 同 tx 的 **`Joined(newB, ...)`** |

这是「退出本轮对手方 / 被踢出」，**整单仍可被 A 重新找人继续**；不要把它画成和 **`Canceled`** 同一种「交易失败终局」。

`replaceInactiveBAndJoin` 只适用于 `DealOpenTokenToken` 的 `Open` 模式：`bJoinedAt + replaceTimeoutSeconds` 之后仍未进入 `Locked`，外部用户才能顶替。`replaceTimeoutSeconds` 建议默认 120 秒，合约允许范围 60 秒到 1 天。

`replaceNonVotingBAndJoin` 适用于 `Locked`：A 已 Accept、B 未投票，且 `max(lockedAt, aAt) + replaceTimeoutSeconds` 之后，外部用户可以顶替 B，旧 B 退款，交易回到 `Active`。被清掉的旧 B 会记录为 `lastRemovedB`，不能自己马上重新 join；A 主动 `openJoinFor(lastRemovedB)` 后才允许回来。

---

### 5.4 OpenTT 模板多一种「拒绝即清 B」

在 **`DealOpenTokenToken`** 的 **`Locked`** 里，若 **B 投 `Reject`** 而 **A 尚未 `Reject`**，会走内部 **`_expelBOnReject`**：**清掉 B、状态回 `Ready`**，并 **`BExpelledOnReject(prevB, when)`**。  
这不是 **`Canceled`**，也**不是** **`Abandoned`**；若 A 已 **`Reject`** 且 B 也 **`Reject`**，则仍是双方拒绝 → **`_cancel()`** → **`Canceled`**。

---

### 5.5 和链上聊天的关系（再确认）

| `status` | `DealMessageHub.postMessage(deal, content)` |
|----------|----------------|
| **全部六种** `status` | 在 **`msg.sender` 仍为当前 `a` 或 `b`** 时均允许（Factory 已配置 `dealMessageHub`；计费由 Factory 的 message price rule 执行）。**特例**：`abandonByA` 后 **`b` 已清零**，仅 **A** 可发。 |

---

## 6. 最简单集成路径（推荐）

1. **奖励 / 信用结果**：优先读 **`DealResultIndex`**，不要每次扫历史 logs。
2. **单笔交易时间线**：当前状态读 `DealReader`；过程提示优先读 **`DealResultIndex.getTimeline`**，事件只做旧数据兜底。
3. **成交后留言**：`Completed` 后仍调 **`DealMessageHub.postMessage(deal, content)`**。  
4. **ABI**：本次 **`Joined` / `Paid` / `WithdrawnInActive` / `Locked` / `Completed` / `Canceled` / `BExpelledOnReject`** 等与旧版相比**签名已变或新增**，前端解码需更新 artifact。

---

## 7. 相关源码（便于对 ABI）

- `contracts/DealResultIndex.sol`：奖励明细、信用增量明细 view 索引
- `contracts/DealFactory.sol`：`DealRewardsLogged`、`mintAndRecordDealRewards`、`DLMinted`
- `contracts/Deal.sol` / 各 Deal implementation：进程事件
- `contracts/DealMessageHub.sol`：链上留言写入与读取
- `contracts/DealOpenTokenToken.sol`：同上 + `APreAccepted`、`BExpelledOnReject`、`replaceInactiveBAndJoin`、`replaceNonVotingBAndJoin`
- 部署与库拆分：`docs/Deal库拆分部署接线说明.md`
