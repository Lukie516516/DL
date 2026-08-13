# DAO 可调控参数影响面清单

本文给 leader / PM / 权限后台使用，整理当前合约里 **理论上可由 DAO 控制的全部参数**。

> 这里的“DAO 可控制”指：DAO executor / timelock / 多签接管对应合约的 `owner`、`admin`、`executor` 或 `role` 之后，可以通过链上交易执行这些函数。  
> 如果某个合约权限还在个人钱包，那么它当前仍不是 DAO 自动控制，只是“未来可迁移给 DAO 控制”。

## 1. 影响面分级

| 影响面 | 含义 | 建议治理方式 |
| --- | --- | --- |
| 低 | 只影响展示、单个用户体验或非资金核心功能 | 可放权限后台，保留操作日志 |
| 中 | 影响费用、时间窗口、用户能否使用某功能 | 可放权限后台，但需要二次确认 |
| 高 | 影响协议收入、交易价格、swap、域名收益、信用写入 | 建议 DAO 提案 / 多签，不建议普通后台随意调 |
| 极高 | 影响核心合约接线、实现合约、增发权限、国库地址、暂停权限 | 只建议 DAO / 多签 / 技术执行，普通后台只读 |

## 2. Deal 交易核心参数

| 参数 / 功能 | 合约 | 函数 | 当前权限 | 影响面 | 调整后影响 |
| --- | --- | --- | --- | --- | --- |
| 最小确认超时等待时间 | `DealFactory` | `setMinTimeoutSeconds(uint64)` | owner | 中 | Locked 后一方已经投票、另一方长期不投票时，多久后可以由已投票方推进终局。不是管理员强制成交。过短会增加误操作风险，过长会卡资金。 |
| 管理员设置最小确认超时等待时间 | `DealFactory` | `setMinTimeoutSecondsByAdmin(uint64)` | admin | 中 | 同上，admin 版本范围更保守。 |
| TWAP 报价窗口 | `DealFactory` | `setMinWindowSec(uint32)` | owner | 高 | 影响非 U 资产折算 DC / U 价值时的报价稳定性。太短容易被短时价格影响，太长更新慢。 |
| 管理员设置 TWAP 窗口 | `DealFactory` | `setMinWindowSecByAdmin(uint32)` | admin | 高 | 同上，admin 版本下限更高。 |
| 官方认可交易币 | `DealFactory` | `setRecognizedTokens(address,address)` | owner | 高 | 决定哪些币按 U 价值进入信用分、手续费奖励等核心口径。 |
| 保证金币种白名单 | `DealFactory` | `setAllowedMarginToken(address,bool)` | owner | 中 | 决定哪些 token 可作为保证金。放错币会影响用户押金安全和体验。 |
| 允许第三方代创建 deal | `DealFactory` | `setAllowedCreateFor(address,bool)` | owner | 高 | 给域名模块、Hall、Swap 等入口代用户创建 deal 的权限。错误授权会产生异常 deal 入口。 |
| 非 DC 交易手续费 | `DealFactory` | `setFeesAndMintOnFees(...)` | owner | 高 | 控制交易手续费比例，直接影响用户成本和协议收入。 |
| admin 版手续费 / 奖励比例 | `DealFactory` | `setFeesAndMintOnFeesByAdmin(uint32,uint32)` | admin | 高 | 分母固定 1000，且合约限制返利合计不超过手续费。 |
| 特殊免手续费 token（治理） | `DealFactory` | `setSpecialNoFeeToken(address)` | owner / crossChainGovernance | 高 | DAO 正式入口；指定某 token 免手续费，会减少协议收入。 |
| 特殊免手续费 token（admin） | `DealFactory` | `setSpecialNoFeeTokenByAdmin(address)` | admin | 高 | 保留原 admin 日常入口。 |
| 国库地址（治理） | `DealFactory` | `setTreasury(address)` | owner / crossChainGovernance | 极高 | DAO 正式入口；改错会导致手续费进入错误地址。 |
| 国库地址（admin） | `DealFactory` | `setTreasuryByAdmin(address)` | admin | 极高 | 保留原 admin 日常入口。 |
| 留言收费开关 / token / 金额 | `DealFactory` | `setMessagePriceRule(bool,address,uint256)` | owner | 中 | 控制发消息是否收费，以及收什么币、收多少。 |
| admin 版留言收费金额 | `DealFactory` | `setMessagePriceRuleByAdmin(uint256)` | admin | 中 | 只改金额，不改开关和 token。范围 `0.01 - 100 DC`，适合运营后台。 |
| 创建 deal burn 开关 / token / 金额 | `DealFactory` | `setCreateBurnRule(bool,address,uint256)` | owner | 中 | 控制创建合约是否 burn / 收费。 |
| admin 版创建 burn 金额 | `DealFactory` | `setCreateBurnRuleByAdmin(uint256)` | admin | 中 | 只改金额，不改开关和 token。 |

## 3. Deal 核心接线和实现合约

这部分能改，但影响极大，不建议放普通控制板。

| 参数 / 功能 | 合约 | 函数 | 当前权限 | 影响面 | 调整后影响 |
| --- | --- | --- | --- | --- | --- |
| 默认 Deal 实现合约 | `DealFactory` | `setDealImplementation(address)` | owner | 极高 | 影响新创建 deal 的底层逻辑。错误地址会导致新 deal 创建失败或逻辑异常。 |
| Pair 实现合约 | `DealFactory` | `setPairImplementation(address)` | owner | 极高 | 影响新建 pair 的底层逻辑。 |
| 核心依赖地址 | `DealFactory` | `setCoreGlobals(...)` | owner | 极高 | 修改 DC、InfoNFT、WAGI、PairManager 等核心地址。 |
| 服务依赖地址 | `DealFactory` | `setServiceGlobals(...)` | owner | 极高 | 修改 MessageHub、CreditGraph、ActivityIndex、ResultIndex、ImplementationRegistry。 |
| 运营依赖地址 | `DealFactory` | `setOpsGlobals(...)` | owner | 高 | 修改 OrderBook、NFT 活跃记录、DomainRank。 |
| Deal 模板实现注册表 | `DealImplementationRegistry` | `setDealImplementations(...)` | owner | 极高 | 修改普通 deal、NFT deal、OpenTokenToken、SwapTemplate 等模板实现。 |

## 4. 留言 / 创建 burn

| 参数 / 功能 | 合约 | 函数 | 当前权限 | 影响面 | 调整后影响 |
| --- | --- | --- | --- | --- | --- |
| 留言是否收费 | `DealFactory` | `setMessagePriceRule(...)` | owner | 中 | 开启后用户每次发消息都要支付 / burn。 |
| 留言收费金额（治理） | `DealFactory` | `setMessagePriceAmount(uint256)` | owner / crossChainGovernance | 中 | 只改金额，保留各链已配置的收费 token 和开关；用于多链同 calldata 治理。 |
| 留言收费金额 | `DealFactory` | `setMessagePriceRuleByAdmin(uint256)` | admin | 中 | 例如设置为 `100 DC` 时，前端要传 `100 * 10^18`；当前 admin 范围 `0.01 - 100 DC`。 |
| 留言收费 token | `DealFactory` | `setMessagePriceRule(...)` | owner | 高 | 改成错误 token 会导致用户无法正常发消息。 |
| 创建 deal 是否收费 | `DealFactory` | `setCreateBurnRule(...)` | owner | 中 | 开启后创建合约会产生额外成本。 |
| 创建 deal 收费金额（治理） | `DealFactory` | `setCreateBurnAmount(uint256)` | owner / crossChainGovernance | 中 | 只改金额，不改本链 token/开关；关闭状态可保持和恢复为 `0`。 |
| 创建 deal 收费金额 | `DealFactory` | `setCreateBurnRuleByAdmin(uint256)` | admin | 中 | 只调金额。 |
| 创建 deal 收费 token | `DealFactory` | `setCreateBurnRule(...)` | owner | 高 | 改错会导致创建失败或收费资产错误。 |

## 5. 身份 NFT / DealInfoNFT

| 参数 / 功能 | 合约 | 函数 | 当前权限 | 影响面 | 调整后影响 |
| --- | --- | --- | --- | --- | --- |
| 身份 NFT 铸造价格 | `DealInfoNFT` | `setMintPriceU(address,uint256)` | owner | 中 | 设置铸造官方身份 NFT 需要 burn 的 DC 数量。 |
| admin 版铸造价格 | `DealInfoNFT` | `setMintPriceUByAdmin(uint256)` | admin | 中 | 只改 DC 价格，适合后台按钮。范围 `100 - 5,000,000 DC`，主网初始化建议 `100,000 DC`。 |
| 链上图片最大大小 | `DealInfoNFT` | `setMaxImageDataBytes(uint256)` | owner | 中 | 影响用户能否把图片 bytes 直接存链上。上限越大，用户 gas 成本越高。 |
| 当前赛季 | `DealInfoNFT` | `setCurrentSeason(uint16)` | owner | 低 | 影响后续新 NFT 的展示编号 / 赛季。 |
| NFT 渲染器 | `DealInfoNFT` | `setRenderer(address)` | owner | 高 | 影响 tokenURI / imageOf 的展示结果。 |
| 主 Factory | `DealInfoNFT` | `setFactory(address)` | owner | 极高 | 决定哪个 Factory 是主写入方。 |
| 授权 Factory | `DealInfoNFT` | `addFactory(address)` / `removeFactory(address)` | owner | 极高 | 决定哪些 Factory 可以写 NFT 关系、信用、交易信息。 |
| NFT admin | `DealInfoNFT` | `setAdmin(address)` | admin | 高 | 改变谁能调 admin 版价格。 |

用户自己能改的资料，不属于 DAO 参数：

| 用户功能 | 合约函数 | 谁能操作 | 备注 |
| --- | --- | --- | --- |
| 头像 URL | `setTokenImageURI(uint256,string)` | NFT owner / approved | 推荐前端上传到服务器/IPFS/OSS 后写 URL。 |
| 链上头像 bytes | `setTokenImageData(uint256,string,bytes)` | NFT owner / approved | 传原始 bytes，合约读取时转成 base64 data URI。 |
| NFT 展示名 | `setTokenUserName(uint256,string)` | NFT owner / approved | 前端“NFT 名称”对应这个字段，不是 ERC721 标准 name。 |
| 关于我 | `setTokenUserDetail(uint256,string)` | NFT owner / approved | 用户个人资料。 |

## 6. 信用分系统

| 参数 / 功能 | 合约 | 函数 | 当前权限 | 影响面 | 调整后影响 |
| --- | --- | --- | --- | --- | --- |
| 授权信用记录器 | `DealCreditGraph` | `setRecorder(address,bool)` | owner | 极高 | 决定谁能写信用分。错误授权会让非预期合约写信用。 |
| 导入旧信用 | `DealCreditGraph` | `importCredit(...)` | owner | 高 | 迁移期使用，能直接改某 NFT 信用分和 top5 快照。 |
| 锁定迁移 | `DealCreditGraph` | `lockMigration()` | owner | 高 | 锁定后不能再导入旧信用。 |

当前信用公式里的固定项不可调：

| 固定项 | 当前值 | 影响 |
| --- | --- | --- |
| top 快照数量 | `TOP_K = 5` | 每个 NFT 维护最多 5 个交易过对象的信用快照。 |
| 额外奖励最低系数 | `0.01x` | 高信用方和低信用方交易时，最低额外奖励系数。 |
| 额外奖励最高系数 | `2x` | 低信用方和高信用方交易时，最高额外奖励系数。 |

## 7. Swap / Pair / 虚拟流动性

| 参数 / 功能 | 合约 | 函数 | 当前权限 | 影响面 | 调整后影响 |
| --- | --- | --- | --- | --- | --- |
| 创建官方 pair | `DealPairManager` | `createPair(address,uint32,uint32)` | owner | 极高 | 创建新的 DC/token 交易对。 |
| 映射已有 pair | `DealPairManager` | `mapExistingPair(address,address)` | owner | 极高 | 把某 token 指向指定 pair。改错会让前端和 Router 读错池子。 |
| 初始化 pair | `DealPairManager` | `initPair(address,uint256)` | owner | 极高 | 决定初始真实流动性和价格。 |
| 给 pair 补 other token 并撮合 | `DealPairManager` | `mintPairOtherAndSettle(address)` | owner | 高 | 增加对侧流动性并触发挂单撮合。 |
| 设置 pair 手续费 | `DealPairManager` | `setPairFee(address,uint32,uint32)` | owner | 高 | 影响 swap 成本和协议收入。 |
| 设置虚拟储备绝对值 | `DealPairManager` | `setPairVirtualReserves(...)` | owner | 极高 | 直接影响报价和成交价格。 |
| 按 bps 设置虚拟储备 | `DealPairManager` | `setPairVirtualReservesByBps(...)` | owner | 极高 | 按真实储备比例设置虚拟储备。 |
| 设置 pair factory | `DealPairManager` | `setPairFactory(address,address)` | owner | 极高 | 影响 pair 管理权限。 |
| 官方 swap 资产配置 | `DealSwapAssetRegistry` | `setSwapAssets(...)` | owner | 高 | 决定前端官方 swap 展示哪些资产和 pair。 |
| OrderBook router | `DealSwapOrderBook` | `setRouter(address)` | owner | 高 | 改错会影响挂单成交。 |

## 8. 域名注册 / 域名市场

| 参数 / 功能 | 合约 | 函数 | 当前权限 | 影响面 | 调整后影响 |
| --- | --- | --- | --- | --- | --- |
| 域名注册基础价格 | `DCDomain` | `setBasePrice(uint256)` | owner | 中 | 影响新注册域名成本。 |
| 域名注册收款地址 | `DCDomain` | `setTreasury(address)` | owner | 极高 | 注册费收款地址。 |
| 域名支付 token | `DCDomain` | `setPaymentToken(address)` | owner | 高 | 改错会导致注册支付失败或收错币。 |
| 域名市场合约 | `DCDomain` | `setDomainMarket(address)` | owner | 高 | 二级市场成交后同步解析地址。 |
| 市场手续费收款地址 | `DCDomainMarket` | `setFeeRecipient(address)` | owner | 极高 | 域名市场手续费流向。 |
| 市场手续费比例 | `DCDomainMarket` | `setFeeBps(uint256)` | owner | 高 | 影响域名买卖手续费。最高 25%。 |

域名持有人自己可调的内容：

| 功能 | 合约 | 函数 | 谁能操作 | 影响面 |
| --- | --- | --- | --- | --- |
| 域名解析地址 | `DCDomain` | `setResolve(string,address)` | 域名 owner | 中 |
| 主域名 | `DCDomain` | `setPrimaryDomain(string)` | 域名 owner | 低 |
| 域名描述 | `DCDomain` | `setDomainDescription(...)` | 域名 owner | 低 |
| 域名背景图 | `DCDomain` | `setDomainBackgroundUri(...)` | 域名 owner | 低 |

## 9. 域名广告 / 排行榜

| 参数 / 功能 | 合约 | 函数 | 当前权限 | 影响面 | 调整后影响 |
| --- | --- | --- | --- | --- | --- |
| 最低广告充值 | `DCDomainRank` | `setMinDeposit(uint256)` | owner | 中 | 影响域名下 deal 广告充值门槛。 |
| 基础小时费 | `DCDomainRank` | `setBaseHourlyRate(uint256)` | owner | 高 | 影响广告费消耗速度。 |
| 充值比例费率 | `DCDomainRank` | `setDepositRateBps(uint256)` | owner | 高 | 影响广告费按充值额消耗速度，最高 100%。 |
| 未活跃踢出时间 | `DCDomainRank` | `setKickInactivitySeconds(uint256)` | owner | 中 | 影响榜单条目多久未活跃可被移除。 |
| Deal 上报者 | `DCDomainRank` | `setDealReporter(address,bool)` | owner | 极高 | 决定哪些合约能登记域名 deal 和成交额。 |
| 自动关闭器 | `DCDomainRank` | `setAutoCloser(address)` | owner | 极高 | 决定谁能在 deal 结束后关闭广告并退款未消耗部分。 |
| 域名广告 treasury | `DCDomainRank` | `setTreasury(address)` | owner | 高 | 备用运营 / 收款地址。 |
| DCDomainRank owner | `DCDomainRank` | `transferOwnership(address)` | owner | 极高 | 权限迁移。 |

域名持有人自己可调：

| 功能 | 合约 | 函数 | 谁能操作 | 影响面 |
| --- | --- | --- | --- | --- |
| 单个域名广告收费规则 | `DCDomainRank` | `setDomainAdFeePolicy(...)` | 域名 owner | 中 |
| 域名黑名单 | `DCDomainRank` | `setBlacklisted(...)` | 域名 owner | 中 |
| 提取域名广告收益 | `DCDomainRank` | `withdraw(string)` | 域名 owner | 中 |

## 10. OpenTokenToken / B 方顶替

| 参数 / 功能 | 合约 | 函数 | 当前权限 | 影响面 | 调整后影响 |
| --- | --- | --- | --- | --- | --- |
| 域名开放单默认顶替时间 | `DCDomainSwap` | `setReplaceTimeoutSeconds(uint64)` | owner | 中 | B 占坑后超过该时间仍未进入有效成交流程时，可被 C 顶替。当前范围 60 秒到 86400 秒。 |
| 普通 OpenTokenToken 单笔顶替时间 | 单个 `DealOpenTokenToken` | 创建 deal 时传入 | 创建入口 | 中 | 这是每笔 deal 创建时固定的字段，不是全局 setter。 |
