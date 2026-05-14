# DealOpenTokenToken 前端接入说明

## 1. 这个模板是什么

`DealOpenTokenToken` 是开放式币币点对点交易模板。

它不是 swap，也不是订单簿。它的核心是：

```text
A 先创建一笔币币交易条件
外部 B 进来接单
双方资产进入托管
双方确认后成交
```

适用场景：

```text
templateType = 0
openTokenTokenFast = true
joinMode = Open 或 ExactAddress
无商品 NFT 交割
无门禁 NFT
```

## 2. 创建参数

前端仍然调用 `DealFactory.createDeal`。

关键字段：

| 字段 | 说明 |
| --- | --- |
| `init.openTokenTokenFast` | 必须为 `true` |
| `init.templateType` | 必须为 `0`，即 TokenToToken |
| `init.joinMode` | `0 = Open`，`1 = ExactAddress` |
| `init.expectedB` | ExactAddress 模式下指定 B；Open 模式传空地址 |
| `init.aNftId` | A 的官方 `DealInfoNFT tokenId`；没有就传 `0` |
| `init.title` | 标题，最大 96 bytes |
| `init.description` | 交易描述，最大 1500 bytes，可为空 |
| `init.timeoutSeconds` | 两个用途：Locked 后投票超时窗口；Active 阶段 B 卡单可被顶替的等待窗口 |

如果 A 想参与信用分和 C 位候选，创建时要传自己的官方 `DealInfoNFT tokenId` 到 `aNftId`。

## 3. 主流程

```text
A 创建 deal
↓
状态 Ready
↓
A 可以先 pay()
↓
A 可以 preAccept()
↓
B join(optId, trackMe)
↓
状态 Active
↓
B pay()
↓
双方条件满足后进入 Locked
↓
A / B setMyVote(Accept)
↓
Completed
↓
资产结算、DL 奖励、信用分记录
```

`optId` 是 B 的官方 `DealInfoNFT tokenId`。没有就传 `0`。

## 4. B 卡单顶替流程

当 B 加入后，合约会记录：

```text
bJoinedAt
```

如果一直没有进入 `Locked`，并且：

```text
block.timestamp >= bJoinedAt + timeoutSeconds
```

外部新用户可以调用：

```solidity
replaceInactiveBAndJoin(uint256 optId, bool trackMe)
```

结果：

```text
旧 B 被清掉
旧 B 已付资产退款
旧 B 的 InfoNFT 解锁
新用户成为当前 B
A 已经预付的资产保留
deal 继续保持 Active
```

如果 C 顶替 B 后，C 也卡住，那么后面的 D 也可以继续按同样规则顶替 C。

前端索引事件：

```text
ActivePartnerCleared(prevB, reason = 3, when)
Joined(newB, nftLocked, when)
```

这两个事件会在同一笔交易里出现。

## 5. 旧 B 防反复占坑

以下情况会把旧 B 记录为：

```text
lastRemovedB
```

触发情况：

| 情况 | 说明 |
| --- | --- |
| `exitByB()` | B 自己退出 |
| `kickBByA()` | A 主动踢掉 B |
| `replaceInactiveBAndJoin()` | B 超时后被外部用户顶替 |
| `setMyVote(Reject)` | OpenTT 中 B 在 Locked 后单方拒绝并被清退 |

规则：

```text
lastRemovedB 不能自己马上重新 join
```

除非 A 主动调用：

```solidity
openJoinFor(lastRemovedB)
```

也就是说，旧 B 想回来，必须由 A 再次指定。

## 6. Locked 后 B 拒绝

`DealOpenTokenToken` 有一个特殊规则：

```text
如果已经 Locked
B 调 setMyVote(Reject)
且 A 不是 Reject
```

结果：

```text
B 被清退
状态回 Ready
B 资产退款
B InfoNFT 解锁
A 的预付和 preAccept 保留
```

前端索引事件：

```text
BExpelledOnReject(prevB, when)
```

这不是 `Canceled`，也不是 `Abandoned`。

如果 A 已经 Reject，B 再 Reject，则是双方拒绝，进入 `Canceled`。

## 7. 信用分和奖励

只有最终 `Completed` 才会产生信用分。

规则：

```text
谁最终成交，谁加信用
被清退或被顶替的旧 B 不加信用
没有官方 DealInfoNFT 的一方不加信用
同 owner 持有的两个官方 NFT 交易不刷信用
```

OpenTokenToken 成交后会调用信用系统：

```text
A 的 aNftId
最终 B 的 optId
本次手续费 U 价值
```

然后 `DealCreditGraph` 记录：

```text
CreditUpdated(tokenId, delta, newCredit)
DealCreditRecorded(deal, aTokenId, bTokenId, baseCredit, aDelta, bDelta)
```

前端展示：

| 展示项 | 查询方式 |
| --- | --- |
| 累计信用分 | `DealCreditGraph.creditScore(tokenId)` |
| 本笔增加信用 | 索引 `DealCreditRecorded` 的 `aDelta / bDelta` |
| DL 奖励 | 索引 `DealFactory.DealRewardsLogged` |

## 8. 前端常用读取

| 字段 / 函数 | 用途 |
| --- | --- |
| `status()` | 当前状态 |
| `a()` | 创建者 |
| `b()` | 当前 B |
| `aNftId()` | A 绑定的官方 InfoNFT |
| `bNftId()` | 当前 B 绑定的官方 InfoNFT |
| `bJoinedAt()` | 当前 B 加入时间 |
| `timeoutSeconds()` | Locked 投票超时窗口，也是 Active 顶替等待窗口 |
| `lastRemovedB()` | 最近被清退/顶替的 B |
| `aPaid()` / `bPaid()` | 双方是否已付款 |
| `aHasPreAccepted()` | A 是否预同意 |

## 9. 前端按钮建议

| 页面情况 | 展示动作 |
| --- | --- |
| `Ready` 且 `b == 0` | 显示“接单” |
| `Active` 且当前用户是 A | 可显示“踢出 B” |
| `Active` 且当前用户是 B | 可显示“退出”或“付款” |
| `Active` 且当前用户不是 A/B，且已超过 `bJoinedAt + timeoutSeconds` | 显示“顶替接单” |
| `Locked` 且当前用户是 A/B | 显示“确认 / 拒绝” |
| `Completed` | 显示成交结果、DL 奖励、信用增加 |
| `Canceled` / `Abandoned` | 显示终局状态 |

## 10. 留言接入

OpenTokenToken 不再从 deal 实例直接发留言，前端统一调用：

```solidity
DealMessageHub.postMessage(address deal, string content)
```

规则：

```text
deal 必须是 Factory 登记过的 deal
msg.sender 必须是当前 a 或当前 b
Completed / Canceled / Abandoned 后仍可留言
abandonByA 后 b 会被清零，所以通常只有 A 还能留言
```

读取：

```solidity
DealMessageHub.messagesCount(deal)
DealMessageHub.getMessages(deal, offset, limit)
```

## 11. 事件索引

| 事件 | 说明 |
| --- | --- |
| `Joined(b, nftLocked, when)` | 新 B 加入 |
| `Paid(payer, isPartyA, when)` | 某方付款 |
| `APreAccepted(a_, at)` | A 预同意 |
| `Locked(when)` | 进入 Locked |
| `VoteCast(who, isPartyA, vote, when)` | 投票 |
| `ActivePartnerCleared(prevB, reason, when)` | B 被清掉 |
| `BExpelledOnReject(prevB, when)` | B 在 Locked 后 Reject 被清退 |
| `Completed(reason, when)` | 成交 |
| `Canceled(when)` | 取消 |

`ActivePartnerCleared.reason`：

| reason | 含义 |
| --- | --- |
| `1` | B 自己 `exitByB` |
| `2` | A 调 `kickBByA` |
| `3` | 外部用户 `replaceInactiveBAndJoin` 顶替 |

## 12. 人话总结

```text
A 挂一个币币交易。
B 进来接。
B 如果正常推进，就进入托管确认并成交。
B 如果卡住，超时后 C 可以顶替。
C 如果也卡住，D 也可以继续顶替。
被清掉的旧 B 不能自己马上回来占坑。
只有最终真正成交的 A 和最终 B，才会获得信用分。
```
