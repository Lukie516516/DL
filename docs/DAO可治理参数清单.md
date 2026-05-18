# DAO 可治理参数清单

本文把当前合约里适合交给 DAO/席位治理的内容先拉出来，方便后续逐项确认。

## 1. 治理分层

建议先分两类：

| 类型 | 含义 | 建议流程 |
| --- | --- | --- |
| 常规参数 | 费率、价格、开关、时间窗口、白名单等日常运营参数 | 席位提案，48 小时内任意席位可否决，无人否决后执行 |
| 重大变更 | 合约升级、模板替换、核心权限迁移、分红规则重写 | 至少走 120 小时席位否决；后续再接 NFT 第二重否决 |

人话：

```text
常规参数是日常旋钮。
重大变更是换合约、换权限、换规则。
```

## 2. 常规参数候选

### 2.1 DealFactory

| 参数/方法 | 当前含义 | 建议治理方式 |
| --- | --- | --- |
| `setMinTimeoutSeconds` / `setMinTimeoutSecondsByAdmin` | Deal 最小等待窗口 | 常规参数，需范围限制 |
| `setMinWindowSec` / `setMinWindowSecByAdmin` | 展示/时间窗口最小值 | 常规参数，需范围限制 |
| `setRecognizedTokens` | 官方认可交易币种 | 常规参数，但新增币种需谨慎 |
| `setAllowedMarginToken` | 保证金币种白名单 | 常规参数 |
| `setAllowedCreateFor` | 允许第三方代创建 deal | 常规参数/权限开关 |
| `setFeesAndMintOnFees` / `setFeesAndMintOnFeesByAdmin` | 协议手续费、DL 奖励相关参数 | 常规参数，必须有上限 |
| `setSpecialNoFeeTokenByAdmin` | 特殊免手续费 token | 常规参数，但需要记录原因 |
| `setTreasuryByAdmin` | 国库地址 | 建议按重大变更处理，至少多签确认 |
| `setMessagePriceRule` / `setMessagePriceRuleByAdmin` | 留言 burn/付费规则 | 常规参数，默认可关闭 |
| `setCreateBurnRule` / `setCreateBurnRuleByAdmin` | 创建 deal burn 规则 | 常规参数，默认可关闭 |
| `createPair` | 新建 DL 交易对 | 常规参数偏高风险 |
| `initPair` | 初始化交易对流动性 | 常规参数偏高风险 |
| `setPairFee` / `setPairFeeByAdmin` | 交易对手续费 | 常规参数，必须有上限 |
| `setPairVirtualReserves` / `setPairVirtualReservesByBps` | 虚拟流动性参数 | 常规参数偏高风险 |
| `mapExistingPair` | 映射已有交易对 | 常规参数偏高风险 |

### 2.2 DealOpenTokenToken / DCDomainSwap

| 参数/方法 | 当前含义 | 建议治理方式 |
| --- | --- | --- |
| `replaceTimeoutSeconds` | B 占坑/未完成时可被 C 顶替的等待时间 | 常规参数 |
| 默认值 | 120 秒 | 可由 DAO 固定或调整 |
| 范围 | 60 秒 - 86400 秒 | 建议合约层限制 |

### 2.3 DealInfoNFT

| 参数/方法 | 当前含义 | 建议治理方式 |
| --- | --- | --- |
| `setMintPriceU` / `setMintPriceUByAdmin` | 身份 NFT 铸造价格 | 常规参数 |
| `setMaxImageDataBytes` | NFT 图片链上数据上限 | 常规参数 |
| `setCurrentSeason` | 当前赛季 | 常规参数 |
| `setFactory` / `addFactory` / `removeFactory` | 授权工厂 | 重大变更 |
| `setAdmin` | 管理员迁移 | 重大变更 |

### 2.4 CreditGraph

| 参数/方法 | 当前含义 | 建议治理方式 |
| --- | --- | --- |
| `setRecorder` | 授权写信用分的记录器 | 重大变更 |
| `importCredit` | 迁移/导入信用分 | 重大变更，仅迁移期使用 |
| `lockMigration` | 锁定迁移 | 重大变更 |

### 2.5 域名模块

| 合约 | 参数/方法 | 当前含义 | 建议治理方式 |
| --- | --- | --- | --- |
| `DCDomain` | base price / treasury / payment token / market | 域名注册与收款配置 | 常规参数到重大变更之间，按具体字段区分 |
| `DCDomainMarket` | fee recipient / fee bps | 域名市场手续费和收款地址 | 费率常规；收款地址重大 |
| `DCDomainRank` | `kickInactivitySeconds` | 榜单/广告踢出时间 | 常规参数 |
| `DCDomainRank` | `minDeposit` / `baseHourlyRate` / `depositRateBps` | 域名广告与押金相关参数 | 常规参数 |
| `DCDomainRank` | `dealReporter` / treasury | 上报者和国库 | 重大变更 |

### 2.6 Swap / OrderBook

| 参数/方法 | 当前含义 | 建议治理方式 |
| --- | --- | --- |
| `DealSwapOrderBook.setRouter` | 设置路由合约 | 重大变更 |
| `DealSwapTemplate.setFee` | Pair 手续费 | 常规参数 |
| `DealSwapTemplate.setVirtualReserves` | 虚拟储备 | 常规参数偏高风险 |

### 2.7 DL / D 权限

| 参数/方法 | 当前含义 | 建议治理方式 |
| --- | --- | --- |
| `D.constructor(initialHolder)` | D 初始 100 枚一次性接收地址 | 部署前确认，建议多签/分配钱包 |
| `DL.grantRole(MINTER_ROLE, ...)` | 授权增发 DL | 重大变更 |
| `DL.revokeRole(MINTER_ROLE, ...)` | 移除增发权限 | 重大变更 |
| `DL.grantRole(PAUSER_ROLE, ...)` | 授权暂停 | 重大变更 |
| `D` 总量、精度、席位门槛 | 100 枚、8 位、2.5 D | 不建议上线后改；需要新合约或重大变更 |

## 3. 重大变更候选

这些建议不要走普通 48 小时常规参数流程：

| 类型 | 包含内容 |
| --- | --- |
| 模板替换 | `setDealImplementation`、`setPairImplementation`、`DealImplementationRegistry.setDealImplementations` |
| 核心地址迁移 | Factory、InfoNFT、CreditGraph、MessageHub、Router、Treasury |
| 权限变更 | Minter、Recorder、Reporter、Admin、Owner |
| 分红规则变更 | 分红资产、开轮权限、领取公式、未领取余额处理 |
| D 规则变更 | 总量、精度、席位门槛、转让限制 |
| 信用规则变更 | 信用分公式、C 位奖励规则、CreditGraph 写入权限 |

## 4. 分红运营参数

分红不建议由合约自动扫所有 treasury 资产后自动兑换，V1 先走人工/多签/DAO 执行：

```text
treasury 收资产
多签/DAO 挑选可兑换资产
换成 DL
treasury / dividendSource approve VoteDividendClaimer
D 席位发起分红提案
无人否决后 executor / DAO 执行 createRound
D 持有人自行领取
```

`createRound` 只允许分红 executor / DAO 执行账户调用。达到 2.5 D 的席位可以发起分红提案，但不能绕过 DAO 直接开轮；分红资金来自 treasury / dividendSource，避免把个人赞助误认为协议 treasury 分红。

需要治理或运营确认：

| 参数 | 建议默认 |
| --- | --- |
| 分红资产 | DL |
| 分红来源 | treasury 中可分红收入 |
| 可兑换资产 | treasury 可接收全部资产；只有有安全兑换路径的资产进入分红 |
| 无交易对资产 | 先不换，留在 treasury |
| 换 DL 方式 | 先多签/DAO 手动，后续再做路由合约 |
| 滑点保护 | 必须有 `minOut` |
| 开轮执行权限 | 多签 / DAO Executor；D 席位只能发起分红提案，不能直接开轮 |
| 分红频率 | 先手动，后续可每周或每月 |
| 未领取 DL | 留在合约，后续单独定回收规则 |
| 用户领取方式 | 前端展示可领取额度，用户自己 `claim` |

## 5. 还需要你们定的点

| 问题 | 建议默认 |
| --- | --- |
| 常规参数否决窗口 | 48 小时 |
| 重大提案席位否决窗口 | 120 小时 |
| 常规参数执行者 | 任意当前 D 席位 |
| 常规参数是否都必须有范围 | 是 |
| 国库地址变更算不算重大 | 建议算重大 |
| 新交易对创建算不算重大 | 建议先按常规偏高风险处理；上线后可升级为重大 |
| NFT 第二重否决怎么计票 | 已按 V1 落地：只认官方 DealInfoNFT，按有效治理 NFT 分母，一 NFT 一票，否决阈值 `>= 20%` |
| NFT 活跃记录 | 已新增 `DealNftGovernanceActivity`，记录 `lastActiveAt(tokenId)` |
