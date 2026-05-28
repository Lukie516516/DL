# DAO 可治理参数清单

> 说明：本文按 **计划改造版治理模型** 整理。当前链上主路径仍是旧否决制；这里列的是后续文档、前端和合约改造要对齐的目标口径。

## 1. 治理分层

| 类型 | 参与方 | 通过条件 | 投票期 | 通过后流程 |
| --- | --- | --- | --- | --- |
| 参数调整 | 只有 D | `赞成 D >= 70 D` | `48 小时` | 进入 `48 小时` 席位否决窗口 |
| treasury 指定打款 | 只有 D | `赞成 D >= 70 D` | `120 小时` | 进入 `48 小时` 席位否决窗口 |
| 升级 / 重大提案 | D + 当前活跃 NFT | `赞成 D >= 70 D` 且 `赞成 NFT >= 当前活跃 NFT 快照的 70%` | `120 小时` | 进入 `48 小时` 席位否决窗口 |

补充规则：

```text
发起提案的席位门槛 = 2.5 D。
一票否决权的席位门槛 = 2.5 D。
不单独设置 quorum，直接按绝对赞成门槛判断。
```

## 2. 参数调整（D-only）

这类提案只由 D 投票，适合日常运营旋钮。

### 2.1 DealFactory

| 参数/方法 | 当前含义 | 计划治理方式 |
| --- | --- | --- |
| `setMinTimeoutSeconds` / `setMinTimeoutSecondsByAdmin` | Deal 最小等待窗口 | 参数调整（D-only） |
| `setMinWindowSec` / `setMinWindowSecByAdmin` | 展示 / 时间窗口最小值 | 参数调整（D-only） |
| `setRecognizedTokens` | 官方认可交易币种 | 参数调整（D-only），新增币种需谨慎 |
| `setAllowedMarginToken` | 保证金币种白名单 | 参数调整（D-only） |
| `setAllowedCreateFor` | 允许第三方代创建 deal | 参数调整（D-only） |
| `setFeesAndMintOnFees` / `setFeesAndMintOnFeesByAdmin` | 协议手续费、DC 奖励参数 | 参数调整（D-only），需范围限制 |
| `setSpecialNoFeeTokenByAdmin` | 特殊免手续费 token | 参数调整（D-only） |
| `setMessagePriceRule` / `setMessagePriceRuleByAdmin` | 留言 burn / 付费规则 | 参数调整（D-only） |
| `setCreateBurnRule` / `setCreateBurnRuleByAdmin` | 创建 deal burn 规则 | 参数调整（D-only） |
| `createPair` | 新建 DC 交易对 | 参数调整（D-only，高风险） |
| `initPair` | 初始化交易对流动性 | 参数调整（D-only，高风险） |
| `setPairFee` / `setPairFeeByAdmin` | 交易对手续费 | 参数调整（D-only） |
| `setPairVirtualReserves` / `setPairVirtualReservesByBps` | 虚拟流动性参数 | 参数调整（D-only，高风险） |
| `mapExistingPair` | 映射已有交易对 | 参数调整（D-only，高风险） |

### 2.2 DealOpenTokenToken / DCDomainSwap

| 参数/方法 | 当前含义 | 计划治理方式 |
| --- | --- | --- |
| `replaceTimeoutSeconds` | B 占坑/未完成时可被 C 顶替的等待时间 | 参数调整（D-only） |

### 2.3 DealInfoNFT

| 参数/方法 | 当前含义 | 计划治理方式 |
| --- | --- | --- |
| `setMintPriceU` / `setMintPriceUByAdmin` | 身份 NFT 铸造价格，按 DC 本位直接 burn | 参数调整（D-only） |
| `setMaxImageDataBytes` | NFT 图片链上数据上限 | 参数调整（D-only） |
| `setCurrentSeason` | 当前赛季 | 参数调整（D-only） |

### 2.4 域名模块

| 合约 | 参数/方法 | 当前含义 | 计划治理方式 |
| --- | --- | --- | --- |
| `DCDomain` | base price / payment token | 域名注册与收款配置 | 参数调整（D-only） |
| `DCDomainMarket` | fee bps | 域名市场手续费比例 | 参数调整（D-only） |
| `DCDomainRank` | `kickInactivitySeconds` | 榜单/广告踢出时间 | 参数调整（D-only） |
| `DCDomainRank` | `minDeposit` / `baseHourlyRate` / `depositRateBps` | 域名广告与押金参数 | 参数调整（D-only） |

### 2.5 Swap / OrderBook

| 参数/方法 | 当前含义 | 计划治理方式 |
| --- | --- | --- |
| `DealSwapTemplate.setFee` | Pair 手续费 | 参数调整（D-only） |
| `DealSwapTemplate.setVirtualReserves` | 虚拟储备 | 参数调整（D-only，高风险） |

## 3. treasury 指定打款（D-only）

这类提案也只由 D 决定，但比普通调参更重，所以投票期更长。

提案至少要写清楚：

- 打什么资产
- 打多少
- 打给谁
- 用途 / 备注

适用场景：

- 投资款
- 合作拨款
- 运营支出
- 外包 / 审计 / 法务 / 基础设施支出

当前仓库里没有成熟的 treasury payout 合约，这部分后续需要新做或重构。

## 4. 升级 / 重大提案（D + 当前活跃 NFT）

这些不走普通参数流程，必须走双院通过。

| 类型 | 包含内容 |
| --- | --- |
| 核心合约升级 | 新 Factory、新模板、新 Router、新 Reader、新 Treasury |
| 治理规则修改 | 投票模型、席位否决模型、执行路径 |
| 分红规则修改 | 分红资产、开轮权限、领取公式、未领取余额处理 |
| D 规则变更 | 总量、精度、席位门槛、转让限制 |
| 核心权限迁移 | treasury、owner、admin、minter、recorder、reporter |
| 信用体系迁移 | 更换 CreditGraph、迁移信用分 |

NFT 侧口径：

```text
只认官方 DealInfoNFT。
1 个 tokenId = 1 票。
按当前活跃 NFT 快照计票。
70% 赞成才算 NFT 侧通过。
```

## 5. 分红运营规则

主网分红统一使用 DC，按 D 历史快照发放。

建议流程：

```text
主网 treasury 收资产
挑选可分配资产
换成主网 DC
treasury / dividendSource approve VoteDividendClaimer
D-only 提案通过并过席位否决窗口
executor 创建分红轮
D 持有人领取
```

边界说明：

| 项目 | 口径 |
| --- | --- |
| 分红链 | 只在 ETH 主链 |
| 分红资产 | 主网 DC |
| recognized 资产 | 继续按当前逻辑进 pair，不算 treasury 分红来源 |
| 无安全兑换路径资产 | 留在 treasury，不自动进分红 |
| 开轮权限 | executor / DAO 执行账户 |
| 普通席位权限 | 可发起提案，不可绕过 DAO 直接开轮 |

## 6. 当前代码可复用部分

| 模块 | 当前合约 | 备注 |
| --- | --- | --- |
| D 快照分红 | `VoteDividendClaimer.sol` | 可继续作为主网分红承载 |
| 活跃 NFT 统计 | `DealNftGovernanceActivity.sol` | 已有活跃窗口和活跃供应量 |
| 活跃 NFT 快照 | `NftVetoRegistry.sol` | 已有 proposal register + active supply snapshot 基础 |
| D 席位门槛 | `D.sol` | 已固定 2.5 D |

## 7. 需要改造的地方

| 当前合约 | 当前逻辑 | 计划方向 |
| --- | --- | --- |
| `DealSeatVetoGovernor.sol` | 否决制 | 改为投票制 + 通过后席位否决窗口 |
| `NftVetoRegistry.sol` | 活跃 NFT 20% 否决阈值 | 改为活跃 NFT 70% 赞成通过 |
| `DealDao.sol` | OZ Governor 试验路径 | 视最终方案决定复用与否 |
| treasury payout | 当前缺失 | 新增 D-only 打款模块 |

## 8. 当前默认值

| 项目 | 默认值 |
| --- | --- |
| 席位门槛 | 2.5 D |
| 参数调整投票期 | 48 小时 |
| treasury 打款投票期 | 120 小时 |
| 重大提案投票期 | 120 小时 |
| D 席位否决窗口 | 48 小时 |
| D 通过门槛 | 70 D 赞成 |
| NFT 通过门槛 | 当前活跃 NFT 快照的 70% 赞成 |
| NFT 活跃窗口 | 90 天 |
