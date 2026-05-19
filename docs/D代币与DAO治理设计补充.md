# D 代币与 DAO 治理设计补充

本文用于梳理 D 代币、DAO 治理、分红权、否决机制需要补充的设计维度。

当前项目已有基础代码：

| 模块 | 文件 | 当前作用 |
| --- | --- | --- |
| D 代币 | `contracts/D.sol` | ERC20Votes 投票代币 |
| 分红领取 | `contracts/VoteDividendClaimer.sol` | 按 D 的历史持仓快照领取 DL 分红 |
| 席位否决治理 | `contracts/DealSeatVetoGovernor.sol` | 席位提案、否决窗口、无人否决后执行 |

当前新部署口径不再使用旧 `DealGovernor` / `DealTimelock` 作为主治理路径，前端和运营只接 `DealSeatVetoGovernor`。

---

## 1. D 代币定位

D 代币建议定义为：

```text
协议治理席位 + 分红权凭证
```

它不是普通流通币，也不建议设计成无限流通资产。

核心定位：

| 维度 | 建议 |
| --- | --- |
| 代币名称 | D |
| 总量 | 最多 100 枚 |
| 单地址持有上限 | 最多 100 枚 |
| 小数位 | 8 位，和 Bitcoin 精度一致 |
| 投票权 | ERC20Votes 快照投票 |
| 分红权 | 按分红轮次快照时的 D 持仓比例领取 |
| 是否可转让 | 可以，但要明确转让后只影响未来分红和未来投票 |
| 是否可销毁 | 当前没有 burn；如无明确需求，先不开放 |

需要补充决策：

| 问题 | 建议 |
| --- | --- |
| D 是否必须固定总量 100 | 是 |
| D 是否允许二级转让 | 可以，但分红按快照防重复领取 |
| D 是否允许小数转让 | 可以；最小单位为 `0.00000001 D` |
| D 是否需要锁仓 | V1 不强制，后续可加 |
| D 是否可被协议回收 | 需要单独设计，不建议默认加入 |

---

## 2. 当前 D 合约与目标差距

当前 `D.sol`：

```text
部署时显式传入 initialHolder
100 D 会一次性 mint 给 initialHolder
总量上限 MAX_SUPPLY = 100 D
精度 decimals = 8
席位门槛 SEAT_THRESHOLD = 2.5 D
继承 ERC20Votes
支持 permit
没有增发函数
可转让
提供 hasSeat(account)
提供 hasVotingSeat(account)
```

所以如果目标是“最多 100 个 D、超过 2.5 D 拥有一票否决权”，当前已补齐第一版基础能力：

| 能力 | 当前是否有 | 是否需要补 |
| --- | --- | --- |
| 总量 100 | 已有 `MAX_SUPPLY = 100 D` | 已补 |
| 初始接收地址 | 构造参数 `initialHolder` | 已补 |
| 每地址最多 100 | 没有限制 | 可不补，因为总量本身 100 |
| 2.5 D 席位资格 | 已有 `SEAT_THRESHOLD = 2.5 D` 和 `hasSeat` | 已补 |
| 席位名单 | 没有独立名单 | 直接用 `balanceOf(account) >= 2.5 D` 判断 |
| 一人多地址识别 | 没有 | 链上难做，V1 不做 |
| 分红快照 | 已有 `getPastBalanceOf` / `getPastTotalBalance` | 已补 |
| 席位否决合约 | 已有 `DealSeatVetoGovernor` | 已补 V1 |

分红的人话逻辑：

```text
每次分红先创建一个轮次。
这个轮次只认创建前一个区块的 D 持仓。
用户后来把 D 转走，不影响这一轮已经产生的分红。
新买入 D 的人，从下一轮开始参与分红。
```

例如：

```text
D 总量 100
A 在快照时持有 1 D
本轮分红池 10,000 DL

A 可领取 = 1 / 100 * 10,000 = 100 DL
```

---

## 3. DAO 治理对象

DAO 不应该治理所有事情，只治理协议关键参数。

建议分为两类：

### 3.1 常规参数提案

适合治理：

| 参数 | 示例范围 |
| --- | --- |
| LP 手续费 | 0% - 2% |
| 合约手续费比例 | 0% - 1% |
| DC 奖励比例 | 不得高于合约手续费 |
| NFT 铸造费 | 由 DAO 调整上下限 |
| 社交费/消息费 | 可开关、可调价格 |
| 域名相关费用 | 注册、广告、域名市场手续费 |
| OpenTokenToken 顶替时间 | 60 秒 - 24 小时 |
| Deal timeout 参数 | 不超过最大安全窗口 |

常规参数必须有合约内置边界：

```text
DAO 只能在安全范围内调整
不能通过提案越界执行
```

### 3.2 重大合约提案

适合治理：

| 类型 | 示例 |
| --- | --- |
| 合约升级 | 新 Factory、新模块、新入口 |
| 新模板加入 | 新 Deal 模板、新 Swap 模块 |
| 权限变更 | Factory、Recorder、Reporter、Minter |
| Treasury 变更 | 国库地址、多签地址 |
| 分红规则变更 | 分红资产、分红比例、开轮权限 |
| D 代币规则变更 | 转让限制、席位资格、分红权范围 |

重大提案风险更高，需要比常规参数更严格的否决机制。

---

## 4. 提案权限

建议：

```text
只有席位钱包可以发起提案
```

席位钱包定义：

```text
持有 D >= 2.5
```

标准 Governor 仍然使用委托票权；席位否决合约和分红合约使用 D 持仓快照。

如果要走标准 Governor，可以更严格地要求：

```text
持有 D >= 2.5 且已 delegate 给自己
```

原因：

`ERC20Votes` 的投票权依赖 delegate。用户持有 D 但没有 delegate，`getVotes` 可能为 0。

V1 已经实现：

| 能力 | 建议 |
| --- | --- |
| 发起门槛 | 2.5 D 持仓快照 |
| 否决门槛 | 2.5 D 持仓快照 |
| 是否必须 delegate | 席位否决不需要；标准 Governor 需要 |
| 是否允许普通用户提案 | V1 不建议 |

---

## 5. 常规参数治理流程

建议流程：

```text
1. 席位钱包发起提案
2. 进入 48 小时否决窗口
3. 任意席位钱包投反对，提案直接失败
4. 48 小时内无人否决，提案通过
5. 任意席位钱包签名/执行，上链生效
```

人话：

```text
常规参数不是多数投票，而是席位否决制。
没人反对就过，有一个有效席位反对就不过。
```

适合常规参数的原因：

```text
这些参数调整频繁，不能每次都走重治理流程。
但又需要每个席位有刹车权。
```

V1 合约能力：

| 能力 | 当前是否有 |
| --- | --- |
| 48 小时常规提案窗口 | `DealSeatVetoGovernor.regularVetoWindow` |
| 单席位一票否决 | `veto(proposalId)` |
| 席位资格判断 | D 快照持仓 `>= 2.5 D` |
| 参数范围校验 | 各业务合约部分已有，但不完整 |
| 通过后任意席位执行 | `execute(proposalId)` 要求当前仍是席位 |

---

## 6. 重大提案治理流程

建议流程：

```text
1. 席位钱包发起重大提案
2. 第一重否决：席位钱包 120 小时内可否决
3. 如果席位未否决，进入第二重否决
4. 第二重否决：交易过的有效 NFT 在 120 小时内可否决
5. 若有效治理 NFT 否决比例 >= 20%，提案失败
6. 两轮都未触发否决，提案可执行
```

当前代码里已经落了席位否决和 NFT 否决接入：

```text
DealSeatVetoGovernor.ProposalKind.Major
默认 majorVetoWindow = 120 小时
任意 2.5 D 席位可否决
如果配置了 NftVetoRegistry，NFT 达到阈值也会让提案失败
```

第二重 NFT 否决已经按 V1 规则落地：

```text
只认官方 DealInfoNFT
一 NFT 一票
基于有效治理 NFT 分母
有效治理 NFT 反对票 >= 20%，提案失败
```

重大提案示例：

```text
合约升级
新合约加入
调整常规参数范围
修改 D 分红规则
修改核心权限
```

为什么需要两道否决：

```text
席位钱包代表治理层。
有效 NFT 代表真实使用者。
重大变更必须同时不过度伤害两边。
```

需要补充合约能力：

| 能力 | 当前是否有 |
| --- | --- |
| 重大提案类型识别 | 已有 `ProposalKind.Major` |
| 第一重席位否决 | 已有 |
| 第二重 NFT 否决 | 已有 `NftVetoRegistry` |
| 有效 NFT 资格判断 | 已有 `DealNftGovernanceActivity` 活跃判断 |
| NFT 否决比例统计 | 已有 |
| 20% 阈值 | 已有，默认 `2000 bps` |

---

## 7. 有效 NFT 定义

图里提到：

```text
由交互过的 NFT（积分 > 0）投否决
若有效治理 NFT 否决 >= 20%，提案失败
```

建议 V1 定义：

```text
有效 NFT = 官方 DealInfoNFT，且 creditScore > 0
```

但 NFT 否决比例不建议基于“全部铸造 NFT 总量”。原因是：

```text
NFT 越多，沉默用户越多；
如果分母是所有 NFT，20% 会越来越难达到；
提案几乎永远不会被 NFT 否决。
```

建议分母改成“有效治理 NFT”：

```text
有效治理 NFT = 官方 DealInfoNFT
且 creditScore > 0
且在治理统计窗口内活跃过
```

治理统计窗口可以先按人工或后续参数定，例如最近 90 天成功交易过、发起过交易、领取过分红或参与过治理。这样不会让大量沉睡 NFT 稀释否决权。

可选更严格：

```text
有效 NFT = 官方 DealInfoNFT，且历史成功完成 deal 数 > 0
```

不建议用外部 NFT。

原因：

```text
外部 NFT 无法证明真实协议贡献。
官方 DealInfoNFT 才是信用、交易、身份的载体。
```

需要补充：

| 项目 | 建议 |
| --- | --- |
| NFT 资格 | 只认官方 DealInfoNFT |
| 是否要求信用分 > 0 | 是 |
| 是否一 NFT 一票 | V1 可以一 NFT 一票 |
| 是否按信用分加权 | 不建议 V1 做，容易复杂化 |
| 是否允许转移后投票 | 按提案创建时的 owner 快照判断；已投过的 tokenId 不能重复投 |

已确认 V1 口径：

```text
一枚有效治理 NFT = 一票。
不按 owner 去重。
不按信用分加权。
按提案创建时的 NFT owner 判断投票权。
```

也就是说：

```text
提案创建后 NFT 可以正常转让；
但本次提案的投票权仍属于提案创建时的 owner；
新 owner 从之后的新提案开始拥有投票权。
```

活跃状态已单独做轻量记录合约：

```text
DealNftGovernanceActivity
```

它只负责记录：

```text
tokenId => lastActiveAt
```

设计上这些行为会刷新 `lastActiveAt`：

```text
成功完成 deal
发起 deal
参与 deal
领取分红
参与治理
```

当前已接线：

```text
发起 deal：Factory 记录 A 绑定的 InfoNFT
成功完成 deal：Factory 的 recordDealCredit 记录 A/B 的 InfoNFT
领取分红：用户使用 claimForNft 领取时记录对应 InfoNFT
参与治理：NFT castVeto 时记录对应 InfoNFT
```

待进一步细化接线：

```text
B 加入但交易未完成时的“参与 deal”活跃记录；
如果要把这种行为也计入活跃，需要各 Deal 模板 join 时回调 Factory 记录 bNftId。
```

然后 NFT 否决统计时只认：

```text
block.timestamp - lastActiveAt <= activeWindowSeconds
```

默认：

```text
activeWindowSeconds = 90 days
nftVetoThresholdBps = 2000   // 20%
```

这两个参数建议只能通过治理修改，不建议 owner 直接修改。

---

## 8. 分红体系

当前 `VoteDividendClaimer` 已经是较正确的基础模型：

```text
达到席位门槛的 D 持有人可以发起协议分红提案
无人否决后，由 executor / DAO 执行账户执行分红轮
treasury / dividendSource 先把可分红收入换成 DL
treasury / dividendSource 授权分红合约
createRound 时合约从 treasury / dividendSource 把本轮 DL 拉进来
每次分红创建一个 round
round 记录 snapshot
用户按 snapshot 时的 D 持仓领取
每个地址每轮只能领一次
```

V1 建议分红流水：

```text
1. treasury 收到非认可币种手续费、域名收入、市场收入等。
2. 多签/DAO 把可分红资产换成 DL。
3. 达到席位门槛的 D 持有人可以发起分红提案。
4. 提案无人否决后，由 executor / DAO 执行账户调用 createRound(total)。
5. 合约把 total DL 从 treasury / dividendSource 转入分红合约，并记录快照。
6. D 持有人自己 claim。
```

普通 D 席位不能绕过 DAO 直接调用 `createRound` 开“赞助分红轮”。但 D 席位可以发起协议分红提案；提案通过后，资金来源是 treasury / dividendSource，而不是某个 D 持有人自己的钱包。

这个模型可以防止：

```text
A 领取后把 D 转给 B
B 再领取同一轮
```

因为 B 在该轮 snapshot 时没有 D 持仓，领取不到。

需要补充的产品规则：

| 问题 | 建议 |
| --- | --- |
| 分红资产 | 当前是 DL，可保留 |
| 分红来源 | 国库 / 手续费池 / DAO 指定 |
| 开轮执行权限 | 仅 executor / DAO 执行账户 |
| 开轮频率 | 每周 / 每月 |
| 是否自动开轮 | V1 手动，后续自动 |
| 未领取余额 | 留在合约，可后续处理 |
| D 未 delegate 是否可分红 | 可以分红，分红不依赖 delegate |
| 开轮资金校验 | `createRound` 会真实拉取 DL，不能空开轮 |

treasury 资产兑换规则：

```text
treasury 可以接收所有资产；
但只有能被安全换成 DL 的资产才进入分红；
没有交易对、流动性太差、疑似垃圾币的资产先不换。
```

如果部署在 ETH 主网或其他成熟 EVM 链，可以通过外部协议兑换，例如 Uniswap / 1inch / Curve 等。但 V1 不建议合约自动接入外部路由，建议先由多签或 DAO 执行人手动兑换，并且每次兑换都设置 `minOut`。

重点：

```text
分红按 getPastBalanceOf / getPastTotalBalance。
用户不需要理解 delegate，也不需要提前 delegate。
```

当前代码用的是：

```solidity
votesToken.getPastBalanceOf(account, snapshot)
votesToken.getPastTotalBalance(snapshot)
```

这意味着：

```text
只要快照时持有 D，就能按比例领取该轮分红。
```

这点必须决定。

---

## 9. 当前 Governor 与目标 DAO 的差距

历史版本里的 `DealGovernor` 是标准 OpenZeppelin Governor：

```text
votingDelay = 1 block
votingPeriod = 50400 blocks
quorum = 20%
proposalThreshold = 2.5 D
投票方式 = For / Against / Abstain
通过后走 Timelock
```

它适合标准 DAO 投票，但不等于图里的“席位否决制”。

目标规则更像：

```text
否决型 DAO
不是多数赞成型 DAO
```

当前产品规则已经确定走 `DealSeatVetoGovernor`，也就是“席位否决 + NFT 二次否决”的路线。`DealGovernor` 不再作为前端、部署和运营主路径。

---

## 10. 需要补充的合约模块

建议新增或重构为：

| 模块 | 作用 |
| --- | --- |
| `D` | 固定总量 100 的治理/分红代币 |
| `DealSeatVetoGovernor` | 常规提案、重大提案第一重席位否决流程 |
| `VoteDividendClaimer` | 分红轮次、快照、领取 |
| `DealNftGovernanceActivity` | NFT 治理活跃记录 |
| `NftVetoRegistry` | 重大提案第二重 NFT 否决 |

也可以合并一部分，避免合约过多。

V1 最小实现：

```text
D
DealSeatVetoGovernor
VoteDividendClaimer
DealNftGovernanceActivity
NftVetoRegistry
```

---

## 11. 需要补充的参数表

治理系统必须先定义参数边界。

示例：

| 参数 | 最小 | 最大 | 说明 |
| --- | --- | --- | --- |
| LP 手续费 | 0 | 2% | swap / LP 相关 |
| 合约手续费 | 0 | 1% | deal 手续费 |
| DC 奖励比例 | 0 | 不高于合约手续费 | 防止奖励超发 |
| NFT 铸造费 | 待定 | 待定 | 需要按 DL/U 口径确认 |
| 消息费 | 0 | 待定 | 可开关 |
| 域名注册费 | 待定 | 待定 | 按字符长度或固定价 |
| 域名广告费 | 0 | 待定 | 按时间或余额比例 |
| OpenTT 顶替时间 | 60 秒 | 24 小时 | 已有边界 |
| Locked force 时间 | 当前 Factory 最小值 | 100 年 | A 已确认、B 未投票时可强制完成；A 已拒绝、B 未投票时不能由 A 强制取消 |

每个参数都要明确：

```text
谁能改
走常规提案还是重大提案
链上在哪个合约落地
是否有最大值
是否有事件
前端在哪里读
```

---

## 12. 前端需要的页面

### 12.1 D 代币页面

需要展示：

```text
当前 D 余额
当前投票权
是否已 delegate
是否达到席位资格 2.5 D
本地址是否为席位钱包
```

### 12.2 DAO 提案页面

需要展示：

```text
常规提案列表
重大提案列表
提案状态
剩余否决时间
是否可否决
是否可执行
参数修改前后对比
```

### 12.3 分红页面

需要展示：

```text
分红轮次
snapshot
本轮总额
我的快照票权
预计可领
是否已领取
领取按钮
```

---

## 13. 事件需求

建议事件：

```solidity
event SeatThresholdUpdated(uint256 oldValue, uint256 newValue);
event RegularProposalCreated(uint256 indexed proposalId, address indexed proposer);
event MajorProposalCreated(uint256 indexed proposalId, address indexed proposer);
event SeatVetoCast(uint256 indexed proposalId, address indexed voter);
event NftVetoCast(uint256 indexed proposalId, uint256 indexed tokenId);
event ProposalPassed(uint256 indexed proposalId);
event ProposalFailed(uint256 indexed proposalId, string reason);
event ProposalExecuted(uint256 indexed proposalId);
event DividendRoundCreated(uint256 indexed roundId, uint48 snapshot, uint256 total);
event DividendClaimed(uint256 indexed roundId, address indexed account, uint256 amount);
```

---

## 14. 今天需要确认的问题

必须确认：

| 问题 | 建议默认 |
| --- | --- |
| D 是否固定 100 枚 | 是 |
| D 是否可转让 | 是 |
| D 是否可小数持有 | 技术可小数，产品按 D 展示 |
| 席位门槛是否 2.5 D | 是 |
| 未 delegate 的 D 是否有分红 | 有分红；标准 Governor 投票才需要 delegate |
| 常规提案是否任意席位一票否决 | 是 |
| 重大提案是否双重否决 | 是 |
| NFT 否决是否只认官方 DealInfoNFT | 是 |
| NFT 否决是否按一 NFT 一票 | V1 是 |
| NFT 有效条件 | 官方 DealInfoNFT，且最近 90 天有治理活跃记录 |
| NFT 否决阈值 | >= 20% |
| 分红资产 | DL |
| 分红频率 | 手动开轮，后续再自动 |
| 执行者 | Timelock / DAO Executor |

---

## 15. 建议落地顺序

### 第一步：定规则

确认：

```text
D 总量
席位门槛
常规提案流程
重大提案流程
分红按 D 持仓快照
有效 NFT 定义
```

### 第二步：改合约

已新增：

```text
DealSeatVetoGovernor
DealNftGovernanceActivity
NftVetoRegistry
```

### 第三步：接入业务参数

把可调参数收口到：

```text
ParameterRegistry / Factory owner / Timelock controlled setters
```

### 第四步：前端页面

先做：

```text
D 余额和席位资格
提案列表
否决按钮
分红领取
```

---

## 16. 一句话总结

当前项目的 DAO 主路径已经从标准 Governor 调整为席位否决治理。

领导图里的目标更像：

```text
D 是最多 100 枚的席位/分红代币；
2.5 D 以上成为席位；
常规参数走席位一票否决；
重大合约变更走席位否决 + 官方 NFT 用户否决；
分红按 D 的快照权益领取，防止转让后重复领取。
```

这套规则由 `DealSeatVetoGovernor`、`NftVetoRegistry`、`DealNftGovernanceActivity` 和 `VoteDividendClaimer` 共同承载。
