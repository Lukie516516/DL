# OpenTokenToken B 方踢人与超时字段说明

本文说明 `DealOpenTokenToken` 里 B 方被踢、被替换、主动退出、拒绝交易的完整逻辑，以及这次升级需要重部署和重接线的合约。

## 1. 三个时间字段

| 字段 | 来源 | 用途 | 是否用于踢 B |
| --- | --- | --- | --- |
| `timeStart` / `timeEnd` | 创建 deal 时传入 | 合同展示/业务周期，给前端展示开始、结束、阶段时间 | 否 |
| `timeoutSeconds` | 创建 deal 时传入 | `Locked` 后，一方已投票、另一方不投票时，允许 `forceComplete` / `cancel` 的等待时间 | 否，不用于 C 顶替 B |
| `replaceTimeoutSeconds` | 创建 deal 时传入 | B 占坑、卡注入、卡确认时，外部 C 可顶替 B 的等待时间 | 是 |

结论：

```text
timeStart/timeEnd 是展示时间。
timeoutSeconds 是终局强制处理时间。
replaceTimeoutSeconds 是踢 B / 顶替 B 时间。
```

## 2. `replaceTimeoutSeconds` 范围

`DealFactory` 对 `openTokenTokenFast = true` 的交易强制校验：

```text
replaceTimeoutSeconds >= 60 秒
replaceTimeoutSeconds <= 1 天
```

建议默认值：

```text
120 秒
```

`DCDomainSwap` 当前默认也是 `120` 秒，并且 owner 可以调用：

```solidity
setReplaceTimeoutSeconds(uint64 value)
```

调整范围同样是 60 秒到 1 天。

## 3. B 方状态分叉

### 3.1 还没有 B

状态：

```text
Ready
```

此时没有 B，不存在踢 B。

A 可以：

- 先注入资产。
- 调用 `preAccept()` 预确认。
- 等 B 加入。

### 3.2 B 加入但未完成注入

B 调用：

```solidity
join(uint256 optId, bool trackMe)
```

进入：

```text
Active
```

合约会记录：

```text
bJoinedAt = 当前区块时间
```

如果 B 加入后超过：

```text
bJoinedAt + replaceTimeoutSeconds
```

但 deal 仍然没有进入 `Locked`，说明 B 没把本轮推进完。外部 C 可以调用：

```solidity
replaceInactiveBAndJoin(uint256 optId, bool trackMe)
```

结果：

- 旧 B 被清掉。
- 旧 B 已注入的资金退回。
- 旧 B 的官方 InfoNFT 解锁。
- 新 C 成为当前 B。
- deal 仍处于 `Active`。
- A 已注入的资产保留。

事件：

```solidity
ActivePartnerCleared(prevB, 3, when)
Joined(newB, ...)
```

### 3.3 双方已注入，进入 Locked

当 A/B 两边资产都准备好后，deal 进入：

```text
Locked
```

合约记录：

```text
lockedAt = 当前区块时间
```

如果 A 之前调用过 `preAccept()`，进入 Locked 时会自动带上：

```text
aVote = Accept
aAt = aPreAcceptAt
```

否则 A/B 都需要在 Locked 后手动投票。

### 3.4 Locked 后 A 已确认，B 不确认

条件：

```text
status == Locked
joinMode == Open
aVote == Accept
bVote == Unset
当前时间 >= max(lockedAt, aAt) + replaceTimeoutSeconds
```

外部 C 可以调用：

```solidity
replaceNonVotingBAndJoin(uint256 optId, bool trackMe)
```

结果：

- 旧 B 被清掉。
- 旧 B 已注入资金退回。
- 旧 B 的官方 InfoNFT 解锁。
- 新 C 成为当前 B。
- deal 回到 `Active`。
- A 已注入资产保留。
- A 的确认状态会保留为预确认，C 后续注入后可以继续推进。

事件：

```solidity
ActivePartnerCleared(prevB, 4, when)
Joined(newB, ...)
```

注意：

```text
C 顶替后不是直接成交。
C 顶替后 deal 回到 Active，C 需要再调用 pay() 注入资产。
```

### 3.5 B 主动拒绝

B 在 `Locked` 状态调用：

```solidity
setMyVote(Reject)
```

如果 A 不是已经 Reject，则 B 会被清出去。

结果：

- 旧 B 被清掉。
- 旧 B 已注入资金退回。
- 旧 B 的官方 InfoNFT 解锁。
- deal 回到 `Ready`。

事件：

```solidity
BExpelledOnReject(prevB, when)
```

### 3.6 A 主动踢 B

A 可以在 `Active` 状态调用：

```solidity
kickBByA()
```

结果：

- B 被清掉。
- A/B 在 Active 阶段已注入的资产都会退回。
- deal 回到 `Ready`。

事件：

```solidity
ActivePartnerCleared(prevB, 2, when)
```

### 3.7 B 主动退出

B 可以在 `Active` 状态调用：

```solidity
exitByB()
```

结果：

- B 被清掉。
- A/B 在 Active 阶段已注入的资产都会退回。
- deal 回到 `Ready`。

事件：

```solidity
ActivePartnerCleared(prevB, 1, when)
```

## 4. 旧 B 能不能马上回来

不能。

被清掉的旧 B 会被记录为：

```text
lastRemovedB
```

旧 B 不能自己马上重新 `join()` 占坑。

只有 A 主动调用：

```solidity
openJoinFor(lastRemovedB)
```

把他指定回来，旧 B 才能再次加入。

## 5. 哪些模式支持外部 C 顶替

只有：

```text
DealOpenTokenToken
joinMode == Open
```

也就是公开接单模式。

不支持：

- `ExactAddress` 指定钱包模式。
- 普通旧 `Deal` 模板。
- NFT 资产模板。
- NoAsset 模板。

原因是：指定钱包模式本来就是 A 明确指定 B，外部 C 不应该绕过 A 的指定。

## 6. 前端按钮展示建议

| 当前状态 | 展示动作 | 判断条件 |
| --- | --- | --- |
| `Ready` | 加入交易 | 当前用户不是 A，且满足 joinMode |
| `Active` | B 退出 | 当前用户是 B |
| `Active` | A 踢 B | 当前用户是 A，且已有 B |
| `Active` | C 顶替 B | `joinMode == Open`，当前用户不是 A/B/lastRemovedB，且 `now >= bJoinedAt + replaceTimeoutSeconds` |
| `Locked` | 投票确认/拒绝 | 当前用户是 A 或 B |
| `Locked` | C 顶替不确认的 B | `joinMode == Open`，`aVote == Accept`，`bVote == Unset`，且 `now >= max(lockedAt, aAt) + replaceTimeoutSeconds` |

前端倒计时可读字段：

```solidity
bJoinedAt()
lockedAt()
aAt()
replaceTimeoutSeconds()
timeoutSeconds()
```

## 7. 事件索引

| 场景 | 事件 |
| --- | --- |
| B 加入 | `Joined(b, bNftId, when)` |
| A 预确认 | `APreAccepted(a, when)` |
| 一方注入 | `Paid(user, isA, when)` |
| 进入 Locked | `Locked(when)` |
| B 主动退出 | `ActivePartnerCleared(prevB, 1, when)` |
| A 主动踢 B | `ActivePartnerCleared(prevB, 2, when)` |
| Active 阶段 C 顶替 B | `ActivePartnerCleared(prevB, 3, when)` + `Joined(newB, ...)` |
| Locked 阶段 C 顶替不确认的 B | `ActivePartnerCleared(prevB, 4, when)` + `Joined(newB, ...)` |
| B 拒绝后被清退 | `BExpelledOnReject(prevB, when)` |
| 完成 | `Completed(reason, when)` |
| 取消 | `Canceled(when)` |

`ActivePartnerCleared.reason`：

| reason | 含义 |
| --- | --- |
| `1` | B 主动退出 |
| `2` | A 主动踢 B |
| `3` | Active 阶段外部 C 顶替 B |
| `4` | Locked 阶段 B 不确认，外部 C 顶替 B |

## 8. 这次需要重部署什么

因为 `InitParams` 新增了 `replaceTimeoutSeconds`，并且 `DealOpenTokenToken`、`DCDomainSwap` ABI/逻辑发生变化，这次不能只替换前端。

至少需要重部署：

| 合约 | 原因 |
| --- | --- |
| `DealOpenTokenToken` implementation | 新增 Locked 阶段 C 顶替 B 逻辑；读取和使用 `replaceTimeoutSeconds` |
| `DealFactory` | `InitParams` 字段变更；创建时校验 `replaceTimeoutSeconds` |
| `DealImplementationRegistry` | 需要指向新的 `DealOpenTokenToken` implementation |
| `DCDomainSwap` | 新增 owner 可调 `replaceTimeoutSeconds`；创建域名 OpenTT deal 时传新字段 |
| `DCDomainHall` | `InitParams` 结构同步变更，避免 ABI/编码不一致 |
| `DealReader` | 如部署包中 ABI/读取结构跟随更新，需要同步前端地址和 ABI |

如果本轮部署采用整套升级脚本，也可以整套重部署 deal 相关合约，保留状态合约。

## 9. 这次需要重接线什么

新 Factory / 新入口部署后，需要做以下接线：

```text
DL.grantRole(MINTER_ROLE, newFactory)
DealInfoNFT.addFactory(newFactory)
DealInfoNFT.setFactory(newFactory)
DealCreditGraph.setRecorder(newFactory, true)
newFactory.setAllowedCreateFor(newDCDomainSwap, true)
newFactory.setAllowedCreateFor(newDCDomainHall, true)
DCDomainRank.setDealReporter(newDCDomainSwap, true)
DCDomainRank.setDealReporter(newDCDomainHall, true)
```

如果 `DCDomainSwap` 默认 120 秒不改，可以不用额外调用。

如果要改成其他值：

```solidity
DCDomainSwap.setReplaceTimeoutSeconds(value)
```

`value` 范围：

```text
60 <= value <= 86400
```

## 10. 前端需要更新什么

前端需要更新：

- `DealFactory` 地址和 ABI。
- `DealOpenTokenToken` ABI。
- `DCDomainSwap` 地址和 ABI。
- `DCDomainHall` 地址和 ABI。
- 如果用 Reader，更新 `DealReader` 地址和 ABI。

创建 `openTokenTokenFast = true` 的 deal 时必须传：

```text
init.replaceTimeoutSeconds
```

建议默认：

```text
120
```

如果不传或传 0，Factory 会拒绝创建。

## 11. 人话总结

```text
B 进来以后会开始计时。
如果 B 只是占坑不注入，超过 replaceTimeoutSeconds 后，C 可以顶替。
如果 B 已经注入但不确认，且 A 已确认，超过 replaceTimeoutSeconds 后，C 也可以顶替。
C 顶替后不会直接成交，而是回到 Active，让 C 自己注入。
合同展示时间 timeStart/timeEnd 不参与踢人。
终局强制时间 timeoutSeconds 不参与 C 顶替。
真正控制踢人的字段只有 replaceTimeoutSeconds。
```
