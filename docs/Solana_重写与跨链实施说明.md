# Solana 重写与跨链实施说明

## 1. 当前结论

Solana 版本采用 Anchor/Rust 原生重写，不修改现有 ETH/BSC Solidity 源码。当前已实现 28 个独立 Program，覆盖 Deal 生命周期、资产托管、身份、信用、奖励、DEX、域名、国库、DAO 和分红。

当前可以定义为：

- 协议业务能力已实现并通过本地运行时测试。
- 还不能定义为主网 100% 迁移验收完成。
- 资产不跨链；跨链只传治理命令、参数和升级动作。
- 真实 LayerZero、Wormhole、Axelar 适配器属于下一阶段。
- 依据已确认的产品边界，中本聪账户和分红只在 ETH；Solana 不部署中本聪模块，`deal_dividend` 只保留为参考实现和测试资产，不进入生产初始化。
- ETH DealGovernance V2 是唯一提案和 D 质押权威；Solana 生产侧只运行跨链 Executor，不启用本地 `deal_governance` 作为第二套 DAO。

## 2. 架构原则

| 原则 | Solana 实现 |
| --- | --- |
| 不机械翻译 Solidity | 按状态机和用户可观察结果重写为 PDA、CPI 和 SPL Token 账户模型 |
| 资产不跨链 | DC、稳定币、SOL、NFT 均使用 Solana 本地资产；不映射 ETH/BSC 余额 |
| 功能拆分 | 每个权限和状态边界由独立 Program 管理，避免单一 Program 过大 |
| 原子性 | 资金结算、手续费、奖励和信用写入必须位于同一经济核心交易；派生索引与身份解锁位于紧随其后的权限开放补写交易，两笔各自原子且补写可重试 |
| 可查询性 | 活跃、完成、奖励、信用、时间线、域名排行使用账户索引，不要求前端扫描全部历史交易 |
| 治理跨链 | ETH DAO 生成同一消息，三桥中任意两桥确认后由 Solana Executor CPI 执行白名单指令 |
| 身份控制 | `AssetController` config PDA 同时作为 Core 和 Identity 的受信 controller；前端只签自己的交易，不存在身份控制热私钥 |

### 2.1 多链国库标准化收款约束

以后每条生产链的协议国库必须提供等价、可审计的标准化收款行为；不同虚拟机
不要求 ABI 完全相同，但业务语义、事件和验收结果必须一致：

- 每条链只能有一个由部署清单和治理共同确认的规范国库本体；所有协议模块的
  `treasury`、`feeRecipient` 和同类收费地址必须指向该规范国库或其规范资产金库。
- 国库必须分别支持本链原生 gas 资产和本链可识别同质化 Token 入金。原生资产
  使用显式 `fund_native`；Token 使用显式 `fund_token` 或语义等价入口，并记录
  付款人、资产 mint/address、数量和规范金库的可索引事件。
- Solana 每个 SPL Token/Token-2022 mint 使用由国库 PDA 控制的规范 Token
  Account；EVM 每个 ERC-20 直接由国库合约持有。跨链同名资产仍是不同链的独立
  资产，除非治理明确执行桥接，不得把跨链治理消息误认为资产已经跨链。
- 网络 gas 手续费不属于协议收入。只有业务程序按已审计收费规则显式转入国库的
  协议费才记为收入；用户误转、空投和垃圾 Token 必须与白名单收入分离展示，
  不得自动计入可分配余额。
- 任意非白名单资产即使被直接转入国库控制账户，也只能进入“待识别/救援”口径；
  治理可以通过标准化付款/救援动作处置兼容资产，但不得因此获得绕过白名单执行
  任意 Token hook 或外部程序的权限。
- 所有出金必须继续受治理 controller/Executor 控制；收款不得引入热私钥提款
  路径。部署验收必须逐项验证原生入金、至少一种标准 Token 入金、事件、余额、
  非 controller 出金拒绝以及治理出金成功。

当前 Solana `deal_protocol_treasury` 已有 `fund_native`、`pay_native` 和
`pay_token`，并能控制不同 mint 的规范 Token Account；在 Devnet 生产部署前，
还需按本节补齐显式 `fund_token`、标准入金事件、资产白名单/待识别分类及对应
运行时测试，完成后才能把“多资产标准化收款”标记为发布验收通过。

## 3. Program 清单

| # | Program | 作用 |
| --- | --- | --- |
| 1 | `deal_core` | Deal Registry、模板参数和生命周期状态机 |
| 2 | `deal_asset_controller` | SPL、SOL、NFT 托管、退款、交割和 DC/DC 的 C/销毁手续费路由 |
| 3 | `deal_message_hub` | 留言、长度限制和可选 DC burn |
| 4 | `deal_history_index` | 活跃、完成和时间线索引 |
| 5 | `deal_identity` | 官方身份 NFT、资料、锁定和解锁 |
| 6 | `deal_credit_graph` | 信用分、top5 和同 owner 防刷 |
| 7 | `deal_finalizer` | 终局验证、receipt 和防重复 |
| 8 | `deal_dex_pair` | Pair、真实/虚拟储备、TWAP 和 swap |
| 9 | `deal_dex_router` | 单跳/双跳、exact-in/out 和原生 SOL wrap/unwrap |
| 10 | `deal_dex_quoter` | 只读报价 |
| 11 | `deal_swap_asset_registry` | 官方资产和规范 Pair 注册 |
| 12 | `deal_swap_orderbook` | 挂单、撮合和撤单 |
| 13 | `deal_credit_valuator` | 实际手续费到 U18 的可信估值 |
| 14 | `deal_dc_controller` | DC mint/burn 权限控制 |
| 15 | `deal_reward_engine` | DC 奖励、C 位和信用增量计算 |
| 16 | `deal_result_index` | 奖励和信用结果分页读取 |
| 17 | `deal_governance_executor` | 三桥 2/3 确认、防重放和治理 CPI |
| 18 | `deal_parameter_registry` | 治理参数存储和跨链执行样例目标 |
| 19 | `deal_domain_registry` | 域名注册、持有人和解析资料 |
| 20 | `deal_domain_market` | 域名市场交易 |
| 21 | `deal_domain_rank` | 广告余额、收益、Completed 成交量和排行 |
| 22 | `deal_domain_entry` | 域名下创建 Deal 的业务入口 |
| 23 | `deal_domain_hall` | 域名大厅和聚合读取 |
| 24 | `deal_protocol_treasury` | 无个人私钥提款路径的协议国库 PDA |
| 25 | `deal_d_token` | 本地治理参考实现：D 固定供应和快照；不替代 ETH D |
| 26 | `deal_governance_activity` | 本地治理参考实现：90 天活跃身份记录 |
| 27 | `deal_governance` | 本地 DAO 参考实现；不进入当前生产治理权威范围 |
| 28 | `deal_dividend` | 国库出资、D 快照和永久领取分红；参考实现，不进入 Solana 生产范围 |

Program ID 以 `Anchor.toml`、`declare_id!` 和 `target/deploy/*-keypair.json` 三者一致为准，不在文档中复制第二份可漂移清单。

## 4. 终局业务链路

完成态采用两笔有明确安全边界的 Solana transaction。交易 A 是经济核心：

```text
AssetController 结算资产并把 Deal 写入 Completed
  -> 如果是 DC/DC：按锁定身份和 CreditGraph 把双方手续费合计转给 C；无 C 则 burn
  -> Finalizer 生成唯一 terminal receipt
  -> Valuator 记录本次实际手续费 U18
  -> RewardEngine 生成奖励 quote
  -> RewardEngine / DCController mint DC 奖励
  -> Finalizer 按 pair / single-a / single-b / none 写信用 receipt
```

交易 B 是权限开放、可重试的终局补写：

```text
Finalizer 写双方 completed history 和唯一 history receipt
  -> 写入实际存在身份的奖励记录
  -> ResultIndex 按角色写奖励索引
  -> ResultIndex 按 A、B 写信用索引
  -> AssetController 按 AssetTerms 中记录的 A、B 身份解锁 NFT
```

取消态和废弃态走更短的规范链：

```text
AssetController 退款并写入 Canceled / Abandoned
  -> Finalizer 生成唯一 non-completed receipt
  -> AssetController 按 AssetTerms 中记录的 A、B 身份解锁 NFT
```

拆分原因不是业务变化，而是 Solana 当前 64 account-lock 上限：原单笔最大
终局会锁定 74 个账户，ALT 只能压缩地址字节，不能减少 account locks。
资金交割、手续费、奖励和信用仍在交易 A 内原子完成；交易 B 失败时不会丢失
资产或重复记账，只会让索引暂未出现、身份继续保持锁定，任意执行者可重试。
history receipt、identity reward receipt 和 result marker 共同防止重复写入。

官方 `solana/sdk/terminal-flow.mjs` 已完成第一阶段严格编排：

- 分别强制传入经济核心和补写交易的完整性清单；
- 按 `pair`、`single-a`、`single-b`、`none` 四种模式处理双方有身份、仅单边有身份和双方无身份；
- 精确校验身份奖励角色、奖励索引角色、信用索引双方和身份解锁 mint；
- 少一条、多一条、重复、Program/discriminator 错误、Deal/receipt 不衔接或身份角色连错都会在签名前拒绝；
- 对角色和双方固定排序，身份解锁严格遵循 `AssetTerms` 记录的 A 后 B 顺序，调用方传入顺序不影响最终规范顺序。

协议级共享 crate `solana/crates/deal-terminal-guard` 已接入
`deal_asset_controller`、`deal_finalizer`、`deal_credit_valuator` 和
`deal_reward_engine` 的经济核心检查点。守卫读取 Instructions sysvar，校验
当前顶层 Program/discriminator 和紧随其后的规范经济指令，并逐项核对
Program、Deal、receipt 和信用模式。补写交易不依赖热权限，由各规范 PDA
receipt/marker 直接执行防重和数据归属校验。

守卫由 `AssetController` 的 `terminal_guard_enabled` 单一开关控制，初始化默认关闭，便于整套 Program 在暂停态分阶段初始化；这不是生产放行值。上线时必须在所有终态 Program、权限和账户配置完成后，由 ETH DAO 跨链治理启用守卫，随后只读确认 `terminal_guard_enabled = true`，才能解除业务暂停。本地真实 SBF 已验证最大经济核心 `58` 个账户、`619` 字节和 20 次采样最高 `425,706` CU，补写为 `39` 个账户、`474` 字节和最高 `220,564` CU；保守 SDK 模型三类交易为 `59/59/58` 个账户。Devnet 钱包当前为 0 SOL、24 个生产 Program 未部署，因此仍需取得真实集群 signature、slot 和日志。

2026-07-24 对照 ETH `_recordDealCredit` 时修正了一处真实业务差异：

- ETH 允许双方有身份、仅 A 有身份、仅 B 有身份和双方无身份；
- Solana Finalizer 原先只提供双方身份的 `record_completed_credit`；
- 现已新增 `record_completed_credit_single` 与 `record_completed_credit_none`，单边身份走 CreditGraph `record_single`，无身份只生成零增量审计 receipt；
- 只有本次 Deal 的 `binding.lock_count` 和 `identity.lock_count` 都大于零时，身份才能参与信用和 C 位候选，历史 binding 不能冒充本次锁定身份。

身份控制路径也完成了生产化修正：

- `DealCore.registry.identity_controller` 与 `DealIdentity.config.trusted_controller` 必须同时设置为 `AssetController` config PDA；
- NFT gated 加入、身份锁定和身份解锁都由 `AssetController` CPI，并由其 PDA 签名，不依赖普通 controller 私钥；
- 同一身份可以同时被不同 Deal 锁定，但同一个 Deal 不能对同一身份重复加锁；
- 锁定时把 A/B 实际身份 mint 写入 `AssetTerms`；奖励、信用和解锁均以这份链上记录为准，客户端不能省略或替换身份；
- Identity Program 和 AssetController 都拒绝非终态提前解锁；终态后允许任意执行者代付解锁，但只能解锁 `AssetTerms` 中对应的身份，成功后清空该侧记录；
- 终态 SDK 只接受 AssetController 的解锁包装指令，并固定按 A 后 B 编排；
- `reward_controller` 单独设置为 RewardEngine minter PDA，不与身份锁 controller 混用。

2026-07-24 使用 ETH 主网 Factory 和生产 implementation 做本地分叉时，发现并修正了另一处真实业务差异：

- ETH 普通 Deal 模板与 OpenTokenToken Fast 不是同一状态机分支；
- 普通 Deal 中，只有 B 单方 Reject 时仍保持 `Locked`，A 也 Reject 后才 `Canceled`；
- OpenTokenToken Fast 中，B 单方 Reject 会被清退并退回 `Ready`，同时保留 A 已注资和 preAccept 的状态；
- Ready 阶段注资/提现、preAccept、Active/Locked 超时替换 B 都是 Fast 专属能力，普通模板不得调用；
- Solana `DealAccount` 现以 `open_token_token_fast` 显式记录模式，创建校验、Core 状态机、AssetController 结算和 DomainEntry 创建入口共同执行相同边界。

同一次分叉还确认了创建时限边界：

- ETH 生产 Factory 当前 `minTimeoutSeconds = 3600`，最大时限为 100 年；
- ETH 治理入口允许把最短时限调低到 `1800` 秒，但不能更低；
- Solana Core Registry 现默认 `3600` 秒，治理可调范围为 `1800..3,153,600,000` 秒；
- 创建指令会在写入 Deal 前拒绝低于 Registry 最短时限的参数；运行时测试覆盖 `3599` 秒拒绝、`3600` 秒通过、`1799` 秒治理配置拒绝和 `1800` 秒配置通过。

模板形状和实现路由使用同一份 `solana/fixtures/deal-template-shapes.json` 做双端验证：

- 9 个合法方向覆盖普通/Fast TokenToToken、TokenToNft 的 A/B 交付方向、TokenToEmpty 的 A/B 交付方向、EmptyToEmpty 和 NftToEmpty 的 A/B 交付方向；
- 6 个非法形状分别覆盖缺边、双 Token、Empty 携带 Token、双 NFT 和 Fast 非 TokenToToken；
- ETH 主网 fork 对所有合法向量创建真实本地 clone，并逐个确认 clone bytecode 指向生产 `DealImplementationRegistry` 中对应 implementation；
- 同一份 JSON 由 Solana Rust 测试读取，合法/非法结果与 ETH Factory 完全一致；
- 9 个合法模板还分别在 ETH fork 和 Solana LiteSVM 完成真实 DC/NFT 结算，逐项核对完成态、托管归零、双方 DC 余额变化、NFT 最终持有人、国库变化和 DC 总供应量。

Fast 替换也已直接对 ETH 生产 implementation 实跑：

- Active 阶段到达 `bJoinedAt + replaceTimeoutSeconds` 前拒绝替换，边界时允许新 B 原子替换未注资 B；
- Locked 阶段只有 A 已 Accept、B 未投票且到达 `max(aAt, lockedAt) + replaceTimeoutSeconds` 时允许替换；
- 被替换 B 的 DC 全额退回，A 的托管和 preAccept 保留；新 B 注资后重新进入 Locked，A 的 Accept 状态恢复。

奖励对照中发现并修正了一处增发差异：

- ETH 允许 DC 与稳定币成交，但 DC 侧本身不产生手续费奖励，只有 WNATIVE/认可稳定币侧产生奖励；
- Solana 原实现只对“双边 DC”整体归零，混合 `DC + stable` 时错误奖励 DC 侧；
- 现已改为任意 DC 侧奖励恒为 0，并以运行时用例固定 `DC + stable = (0, stableReward)`。

完整模板结算又发现一处手续费去向差异：

- ETH 的 `DC ↔ DC` 双边手续费不是进入国库：有合法 C 身份时合计转给 C 持有人，没有 C 时销毁；
- fork 的无身份 9 模板验证确认双方各收取 0.1%、国库增量为 0、DC 总供应量精确减少手续费合计；
- Solana 原实现错误把手续费发往国库；现改为两阶段原子结算：先把净额交给 A/B，手续费留在 controller vault，紧随其后的 `route_dc_fees` 再完成 C 转账或 burn；
- C 判定与 ETH CreditGraph 一致：双方零分、同分、同一 owner 或没有有效身份时不选 C；严格高分方获胜，top peer 只有在快照严格高于本人分数时替代本人；
- A/B 身份、当前持有人 token account、Deal binding、规范 CreditScore PDA、C IdentityRecord 和 C 的 DC 收款账户全部在链上验证；有身份时 CreditScore PDA 必传，不能省略账户把真实分数伪装为 0；
- Finalizer 额外要求 `resolved=true` 且 `dc_fees_routed=true`；终局守卫强制 `resolution -> route_dc_fees -> finalization` 连续出现，少路由、错 Deal、错 C、错 binding、漏 Finalizer 或重复路由都会整笔回滚；
- ETH 主网 fork 已实跑两个连续场景：无 C 时供应量精确减少双方手续费；Alice 已有严格更高信用时，Alice 收到双方手续费合计且供应量不变。

域名创建权限也与 ETH Factory 的普通入口/授权入口分离：

- 普通 `deal_core::create_deal` 明确拒绝 `is_domain_deal=true`，用户不能伪造域名 Deal；
- Core Registry 由治理登记唯一 `domain_entry_controller`；
- `deal_domain_entry` 使用自身 config PDA 对专用 `deal_core::create_domain_deal` CPI 签名；
- Core 校验 controller、域名标记、全局序号和最短时限后才创建账户；
- 运行时测试覆盖普通入口伪造域名 Deal 拒绝以及授权 DomainEntry 原子创建成功。

## 5. 跨链治理消息

生产治理权威边界必须固定：

```text
ETH DealGovernance V2
  -> 4 类提案、D 实物质押、veto、claimBack
  -> GovernancePolicyRegistry 52 条策略校验
  -> 三桥广播同一治理消息
  -> Solana GovernanceExecutor 2/3 确认
  -> 白名单 CPI 执行
```

Solana 当前的 `deal_governance` 是另一种余额快照投票模型，没有 ETH V2 的 Satoshi 类别、D 实物质押与退回、2.5 D 激活门槛、集体 veto 和 52 条策略注册，不能称为 ETH DAO V2 的同构实现。当前产品架构并不需要第二套本地 DAO，因此生产初始化清单必须排除 `deal_governance`、`deal_d_token` 和 `deal_governance_activity` 的治理权威配置。如果以后改变为“Solana 可独立发起治理”，这三者必须按 ETH V2 重新设计并重新审计。

跨链消息必须使用固定编码，包含：

| 字段 | 说明 |
| --- | --- |
| `version` | 消息格式版本 |
| `source_chain` | 治理来源链 |
| `source_broadcaster` | ETH 广播器 32-byte 身份 |
| `bridge_set_version` | 桥集合版本，桥轮换后递增 |
| `nonce` | 严格递增治理序号 |
| `action_type` | 参数、调用或升级动作 |
| `target_program` | Solana Program ID |
| `valid_after` / `expires_at` | 生效和过期时间 |
| `accounts` | CPI 账户、公私和 signer 属性 |
| `payload` | Anchor discriminator 与参数 |

哈希使用 Keccak-256 和固定大端编码，Node/EVM 与 Rust 测试向量已经一致。

## 6. 三桥 2/3 模型

```text
ETH DAO
  -> LayerZero adapter
  -> Wormhole adapter
  -> Axelar adapter

Solana bridge adapters
  -> 各自验证官方桥消息
  -> 向 GovernanceExecutor 提交同一 messageHash
  -> 两个不同 adapter 确认后 ready
  -> 任意人支付 SOL 调用 execute_message
  -> Executor PDA CPI 到白名单 Program
```

执行内核已实现：桥身份非零且互异、单桥不可重复计票、阈值只能 2 或 3、桥集合版本隔离、来源校验、目标白名单、账户去重、PDA signer 约束、时间窗、严格递增 nonce、防重放、失败重试、暂停和取消。运行时故障测试已证明目标暂停时执行失败但原消息可重试、桥轮换会使旧集合的部分确认失效、被移除桥不能确认新集合消息、管理员取消不会推进 nonce 且后续更高 nonce 仍可执行。

尚未实现的是三个桥各自的官方接收和验签适配器，不是 Executor 的 2/3 逻辑。

## 7. 验证结果

截至 2026-07-20：

```bash
cd solana
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
anchor build --ignore-keys
node tools/verify-governance-hash.mjs
```

结果：

- 28 个 Program 全量 SBF 构建通过。
- 28 个 `.so`、28 个 JSON IDL、28 个 TypeScript IDL 已生成。
- 123 项非文档测试通过，0 失败；金额手续费和 timeout 各覆盖 512 组确定性向量。
- 严格 Clippy 通过，0 warning。
- 格式检查通过。
- 治理消息哈希跨语言一致。

2026-07-24 续作复核：

- `anchor build --ignore-keys` 完整构建 28 个 Program 成功，退出码为 0。
- `cargo test --workspace --all-targets` 当前为 123 项非文档测试通过，0 失败。
- `cargo clippy --workspace --all-targets -- -D warnings` 与 `cargo fmt --all -- --check` 通过。
- 终局 SDK 测试由 6 项扩展到 21 项，新增 DC/DC 强制手续费路由、经济
  核心/权限开放补写拆分、完整性清单、缺失索引、固定排序、AssetTerms
  A/B 身份解锁顺序、四种信用模式和真实 IDL 账户索引防漂移检查。
- 共享终态守卫验证内核 10 项测试通过，覆盖 wrapper CPI、缺失/插入指令、错误 Program/discriminator、错误 Deal/receipt 和错误 role byte。
- 终态守卫已接入 AssetController、Finalizer、Valuator 和 RewardEngine：
  完成态经济核心强制执行“结算 → receipt → 估值 → 奖励 quote/mint →
  信用 receipt”；历史、奖励/信用索引和 A/B 身份解锁由权限开放补写交易
  完成并由规范 PDA 防重；非完成态仍强制“退款 → receipt → A/B 身份解锁”。
- 四个终态 Program 的运行时用例分别证明：守卫开启时单独调用会回滚且不产生 receipt、不改变托管资产或 DC 余额；关闭守卫后原有模块用例继续通过。
- Finalizer 新增 3 条运行时路径测试，覆盖仅 A 身份、仅 B 身份、双方无身份和失效 binding 拒绝；原双边身份路径继续通过。
- AssetController 新增 PDA 身份控制运行时测试，覆盖 NFT gated 加入、身份 mint 写入 AssetTerms、非终态第三方解锁拒绝、终态第三方代付解锁成功及记录清空；Identity 测试覆盖同 Deal 重复锁拒绝及跨 Deal 嵌套锁。
- 修正 `finalize_non_completed` 的 Deal 账户位置：真实 IDL 为索引 `2`；旧 SDK/测试夹具错误使用索引 `3`。
- ETH 主网分叉最新基线快照为区块 `25,602,224`（哈希 `0x0e1a7e57d34801686ee517a27a358a13003370973d29f8869f0191a0a7ac63d0`）：54 个部署地址、5 个代理实现槽、32 个可读生产组件和 17 个提案全部核验通过。
- 生产 GovernancePolicyRegistry 的 48 条 DAO V2 基线策略和 4 条国库模块策略共 52 条，已逐条读取并与仓库规则生成器比对通过。
- D 账本闭合：总供应量 `100 D`，DAO 代理托管 `70 D` 质押，外部钱包合计 `30 D`；此前只读取某钱包 `27.5 D` 的测试口径已修正为同时识别可领取治理质押。
- 普通 Deal 与 OpenTokenToken Fast 的 Reject 分支已直接对生产 implementation 实跑；Solana 新增对应模式和拒绝用例。
- 共享模板向量覆盖 9 个合法方向和 6 个非法形状；ETH fork 的 9 个真实 clone 全部指向预期生产 implementation，且 9 个合法模板已在 ETH fork 与 Solana LiteSVM 双端完成 DC/NFT 最终状态结算。
- Fast 的 Active 未注资替换和 Locked 未投票替换已直接对 ETH 生产 implementation 实跑，超时边界、旧 B 退款、A 托管/preAccept 保留和新 B 重锁结果均与 Solana 状态机一致。
- 修正 Solana 混合 `DC + stable` 时错误给 DC 侧奖励的问题；当前运行时断言 DC 侧为 0、stable 侧正常计奖。
- 修正 Solana `DC ↔ DC` 手续费错误进入国库的问题；无 C 时与 ETH 一致销毁，有 C 时按规范身份、binding 和 CreditGraph 严格高分结果把双方手续费合计转给 C。省略 CreditScore、错误 C 收款账户、错误 binding、重复路由和不完整终局均已覆盖回滚测试。
- GovernanceExecutor 增加桥轮换、旧集合失效、被移除桥拒绝、取消消息和更高 nonce 恢复执行的 CPI 运行时覆盖。
- ETH Factory 当前最短/最大时限和 Fast 替换时限由 fork 基线直接断言；Solana Registry 增加相同默认值、治理范围和创建时拒绝路径。
- 普通创建入口与域名专用入口已经权限隔离，DomainEntry config PDA 必须同时得到 Core Registry 授权。
- DAO V2 升级兼容与国库模块分叉测试分别在区块 `25,601,795`、`25,601,803` 通过；所有变更仅发生在本地 fork，没有发送主网交易。

### Anchor 1.0.2 单 Program 构建注意

Anchor CLI 1.0.2 使用 `anchor build --program-name <name>` 时，会先进入 Program 子目录，再从子目录的 `target/deploy` 读取或新建 keypair，可能误报随机 Program ID 与源码不一致。这不是工作区正式 keypair 损坏。

安全口径：

```bash
# 严格校验全部工作区 keypair 与 declare_id
anchor build

# 只构建一个 Program 时跳过 Anchor 的错误子目录 key 检查
anchor build --ignore-keys --program-name deal_swap_asset_registry
```

部署前必须再次核对：

```bash
anchor keys list
solana-keygen pubkey target/deploy/<program>-keypair.json
```

不得对这个误报直接执行 `anchor keys sync`，否则可能把临时随机地址写进源码。

## 8. 上线前剩余工作

1. SDK 完整性清单、四种身份信用模式、经济核心/补写拆分和共享
   Instructions sysvar 守卫已经完成；本地 v0+ALT、账户数、字节、CU 和补写
   重放已通过。下一步必须在 Devnet 持久部署后实发两笔交易并证明生产初始化
   后守卫已开启。没有集群证据不得解除暂停。
2. 已完成生产部署基线、全部模板创建/implementation 路由、9/9 模板 DC/NFT 完整交割、普通/Fast Reject 和两种 Fast 超时替换分支；继续完成奖励、信用、域名和治理的 EVM 最终状态差分；金额手续费和 timeout 的 512 组向量已覆盖。
3. 在 Devnet 部署生产范围内的 24 个 Program，初始化全部 PDA、mint、权限和暂停状态，并完成前端 IDL 实跑；排除本地 DAO/D/治理活跃、ETH 专属中本聪/分红业务，并核验 Core/Identity 的 controller 都是 AssetController PDA，且不存在 controller EOA。
4. 当前 Devnet 钱包余额为 0，24 个生产 Program 为 `0/24`；最低持久租金
   `60.13601472 SOL`，含最大临时 buffer 与 1 SOL 费用预留建议准备
   `65.25564568 SOL`。资金到位后实测 C 收款 ATA、ALT、字节和 CU；本地
   LiteSVM 不能替代真实集群 signature。
5. 实现 LayerZero、Wormhole、Axelar Solana 官方适配器。
6. 执行内核已覆盖重复、过期、旧 nonce、目标失败重试、桥轮换和消息取消；待真实适配器完成后，继续做桥网络延迟/乱序、单桥失效、伪造桥证明、错误账户和升级失败等端到端故障注入。
7. 完成独立安全审计后，再执行主网暂停态部署和小额灰度。

完整逐模块状态见 `docs/Solana_ETH业务一致性矩阵.md`。
