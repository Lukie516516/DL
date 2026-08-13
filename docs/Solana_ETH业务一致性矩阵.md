# Solana 与 ETH Deal 业务一致性矩阵

## 1. 验收口径

“业务对齐”指用户可观察结果一致，不要求 Solidity 与 Rust 的合约拆分方式一致。每项业务必须同时满足：

1. 相同输入通过或拒绝。
2. 相同生命周期状态变化。
3. 相同资产余额、退款、手续费和终局归属。
4. 相同奖励、信用分、top5、域名统计和治理结果。
5. 相同时间边界、替换规则、权限边界和防重放约束。
6. 前端可通过账户或分页索引读取，不依赖扫描全部历史交易。

产品范围同时遵守已经确认的链级边界：

- 中本聪账户只存在于 ETH；
- 分红只在 ETH 执行，其他链不部署、不初始化分红业务；
- DAO 提案、D 质押和 52 条执行策略仍以 ETH DealGovernance V2 为唯一治理源；Solana 生产侧只通过三桥 2/3 `deal_governance_executor` 接收并执行 ETH DAO 命令，不启用第二套本地 DAO；
- 因此本文所称“Solana 与 ETH 协议层一致”，不把上述两个 ETH 专属模块计入 Solana 生产发布范围。仓库中的 `deal_dividend` 仅保留为已完成的参考实现和测试资产，除非产品范围再次明确变更，否则不得部署。

当前结论分为三档：

| 状态 | 含义 |
| --- | --- |
| 已实现并测试 | Solana Program、权限、账户变化和运行时测试已经存在 |
| 已实现，待差分验收 | 功能已实现，但还没有用同一组 EVM/Solana 测试向量证明逐项等价 |
| 未完成 | 上线所需能力尚未实现 |

## 2. 协议能力矩阵

| ETH/BSC 业务 | Solana Program | 当前状态 | 说明 |
| --- | --- | --- | --- |
| Deal 创建、模板参数、生命周期 | `deal_core` | 已实现并测试 | 覆盖创建、更新、指定/开放加入、注入标记、Locked、投票、退出、踢出、替换、废弃、超时和终局；普通模板与 OpenTokenToken Fast 使用显式模式位，禁止串用 Fast 专属操作；Registry 默认最短时限 3600 秒、治理可调下限 1800 秒，与 ETH Factory 边界一致 |
| SPL Token、原生 SOL、NFT 托管 | `deal_asset_controller` | 已实现并测试 | 覆盖托管、提现、退款、手续费、SPL/NFT 交割和原生 SOL；DC/DC 按锁定身份和官方 CreditGraph 选择 C，严格高分方或其更高分 top peer 收取双方合计手续费，无 C 时 burn；接收方失败会使同笔交易回滚 |
| 终局防重与历史写入 | `deal_finalizer`、`deal_history_index`、`deal_result_index` | 已实现并测试 | 终局 receipt 防重复；经济核心原子完成后由权限开放、可重试的第二笔交易写 completed history、结果索引并解锁身份；各 receipt/marker 防止重复，前端无需扫描全部日志 |
| 留言与可选 DC burn | `deal_message_hub` | 已实现并测试 | 参与方权限、1500 bytes 上限、逐条 PDA 和可选 DC burn 已覆盖 |
| 官方身份 NFT | `deal_identity`、`deal_asset_controller` | 已实现并测试 | 身份资料、DC burn 铸造、PDA 控制的 gated 加入/锁定/终态解锁和两步管理权限已覆盖；A/B 身份 mint 会写入 AssetTerms，终态后任意执行者可代付解锁但不能替换目标；不依赖 controller 热私钥，同 Deal 重复锁被拒绝 |
| 信用分、top5 与同 owner 防刷 | `deal_credit_graph`、`deal_finalizer` | 已实现并测试 | 信用公式、快照 top5、写入权限和迁移锁已覆盖；完成路径支持双方身份、仅 A、仅 B 和双方无身份，失效 binding 不计入本次信用 |
| 手续费 U 价值换算 | `deal_credit_valuator` | 已实现并测试 | 支持稳定币、DC、封装原生币和官方 Pair；每笔 Deal 只生成一次估值凭证 |
| DC 奖励、C 位与信用写入 | `deal_reward_engine`、`deal_dc_controller` | 已实现并测试 | 覆盖费率上限、DC 铸造权限、C 位候选和四种信用分支；quote、mint 和信用写入保留在经济核心原子交易，身份奖励累计与结果索引在可重试补写交易；混合 DC/稳定币只奖励稳定币侧，与 ETH DealLib 一致 |
| Pair、真实/虚拟储备和 TWAP | `deal_dex_pair` | 已实现并测试 | exact-in/out、滑点、真实出金限制、虚拟定价、DC fee burn、sync 和 TWAP 已覆盖 |
| Router 与原生 SOL 入口 | `deal_dex_router` | 已实现并测试 | 单跳、经 DC 双跳、exact-in/out、deadline、wrap/unwrap SOL 和失败回滚已覆盖 |
| 报价 | `deal_dex_quoter` | 已实现并测试 | 只读报价与 Router/Pair 公式对齐 |
| 官方资产和规范 Pair | `deal_swap_asset_registry` | 已实现并测试 | 官方资产、Pair/Router Program、规范 Pair PDA、revision 和两步权限移交已覆盖 |
| 挂单 | `deal_swap_orderbook` | 已实现并测试 | 创建、撮合、撤单、余额和状态边界已覆盖 |
| 域名注册与资料 | `deal_domain_registry` | 已实现并测试 | 域名 PDA、持有人、解析地址和状态管理已覆盖 |
| 域名市场 | `deal_domain_market` | 已实现并测试 | 上架、购买、转移和费用路径已覆盖 |
| 域名广告、成交量和排行榜 | `deal_domain_rank` | 已实现并测试 | 充值、消耗、终局退款、域名收益、Completed 成交量和排行账户已覆盖 |
| 域名交易入口与大厅 | `deal_domain_entry`、`deal_domain_hall` | 已实现并测试 | 域名下创建 Deal、开放币币入口和大厅数据已覆盖；普通 Core 入口拒绝伪造域名 Deal，只有 Registry 登记的 DomainEntry config PDA 可通过专用 CPI 创建 |
| 协议国库 | `deal_protocol_treasury` | 已实现并测试 | PDA 托管、治理授权转账、SPL approve 和无个人私钥提款路径已覆盖 |
| D 治理代币（本地 DAO 参考） | `deal_d_token` | 参考实现已测试 | 100 D、2.5 D 席位、余额快照和受控转账已覆盖；Solana 原始单位为 9 decimals，业务值按 D 单位归一化；生产治理仍使用 ETH D |
| 治理活跃 NFT（本地 DAO 参考） | `deal_governance_activity` | 参考实现已测试 | 90 天活跃窗口和 recorder 权限已覆盖；不作为 ETH DAO 的替代权威 |
| 本地 DAO（非生产权威） | `deal_governance` | 已实现但不等价 | 当前是余额快照投票模型，不具备 ETH V2 的四类别、D 实物质押/claimBack、2.5 D 激活、集体 veto、Satoshi 永久通过和 52 条策略；不得作为生产治理入口 |
| 分红（ETH 专属，不进 Solana 生产范围） | `deal_dividend` | 参考实现已测试 | 仅国库出资、D 持仓快照、永久领取、重复领取阻断和转账后快照不变已覆盖；依据产品边界不得部署或初始化 |
| Solana 参数注册 | `deal_parameter_registry` | 已实现并测试 | 作为 ETH DAO 跨链动作的 CPI 目标；ETH 侧 52 条 GovernancePolicyRegistry 仍负责提案创建和执行前的动作白名单 |
| 三桥 2/3 接收与执行 | `deal_governance_executor` | 执行内核已实现 | 白名单、防重放、时效、严格递增 nonce、桥集合版本和 2/3 确认已覆盖；运行时已验证目标失败重试、桥轮换隔离、移除旧桥、消息取消和后续 nonce 恢复；官方桥适配器未完成 |

## 3. 普通 Deal 与 OpenTokenToken Fast 关键分支

| 行为 | Solana 状态 |
| --- | --- |
| 模式选择 | `open_token_token_fast` 在创建时写入 Deal；Fast 仅允许 TokenToToken，且加入模式与 ETH OpenTokenToken 一致 |
| 普通 Deal：B 单方 Reject | 保持 `Locked`，不会清退 B；A 随后也 Reject 才进入 `Canceled` |
| Fast：B 单方 Reject | 清退 B、退还 B 资产并回 `Ready`，保留 A 的注资和 preAccept 状态 |
| 普通 Deal：Ready 注资、preAccept、超时替换 | 全部拒绝；这些是 ETH OpenTokenToken Fast 专属能力 |
| Fast：preAccept、加入、双方注入、双方确认 | 已实现并有状态/资产运行时测试 |
| B 不带身份 NFT 加入并完成 | 已实现；单边信用只写 A，无身份侧不伪造信用或索引 |
| Fast：Ready 阶段提现 | 已实现 |
| Fast：Active 阶段超时替换 B | 已实现 |
| Fast：Locked 阶段不投票后替换 B | 已实现 |
| 被清退 B 不可立即重进，A 可重新指定 | 已实现 |
| A 或 B 已 Accept、另一方超时不投票后强制完成 | 已实现 |
| SPL、SOL、NFT 交割失败整笔回滚 | 已实现并测试 |
| 重复终局、重复估值、重复信用和重复分红 | 已阻断并测试 |

## 4. 自动化结果

截至 2026-07-24：

- Anchor 工作区包含 28 个 Program。
- `anchor build --ignore-keys` 生成 28 个 SBF `.so`、28 个 JSON IDL 和 28 个 TypeScript IDL。
- `cargo test --workspace --all-targets`：123 项非文档测试通过，0 失败；其中金额和 timeout 差分口径各覆盖 512 组确定性向量。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过，0 warning。
- `cargo fmt --all -- --check`：通过。
- EVM/Node 与 Rust 的治理消息 Keccak-256 哈希向量一致。
- 终局 SDK 现有 21 项测试通过，并对 DC/DC 强制手续费路由、经济核心/
  权限开放补写拆分、四种身份信用模式、AssetTerms A/B 身份解锁顺序、
  AssetController PDA 解锁路径及全部硬编码 Program/discriminator/关键账户
  索引与生成 IDL 做防漂移校验。
- 共享 Instructions sysvar 守卫内核 10 项故障测试通过，且已接入 AssetController、Finalizer、Valuator 和 RewardEngine 的全部终态检查点；本地运行时证明遗漏下一阶段会整笔回滚，不产生部分 receipt、资产结算或 DC 奖励。
- ETH fork 和 Rust 读取同一份模板向量：9 个合法方向、6 个非法形状结果一致；9 个真实 fork clone 均指向生产 Registry 中预期 implementation；9 个合法模板又分别在 ETH fork 与 Solana LiteSVM 完成真实 DC/NFT 结算，余额、NFT 归属、托管归零和完成态断言全部通过。
- GovernanceExecutor CPI 运行时覆盖桥集合轮换、旧确认失效、移除桥拒绝、取消消息以及更高 nonce 恢复执行。

ETH 主网分叉作业答案：

- 最新基线快照为区块 `25,602,224`，区块哈希 `0x0e1a7e57d34801686ee517a27a358a13003370973d29f8869f0191a0a7ac63d0`。
- 54 个生产部署地址全部有代码；5 个代理的 EIP-1967 implementation slot 非零且可读；32 个生产组件的零参数 view/pure 接口通过。
- 17 个治理提案的质押账本与治理代理实际 D 余额完全闭合：D 总供应量 `100 D`，DAO 托管质押 `70 D`，外部钱包合计 `30 D`。
- 48 条 DAO V2 基线策略和 4 条国库模块策略共 `52` 条，已从生产 GovernancePolicyRegistry 逐条读取并与仓库生成器比对，`allowed`、nested 校验、nested-only 和 `maxValue` 全部一致。
- 直接调用 ETH 主网 Factory 和生产 implementation 创建本地 fork Deal，证明普通模板的 B 单方 Reject 保持 `Locked`，OpenTokenToken Fast 的 B 单方 Reject 回 `Ready` 并保留 A 状态。
- Fast 的 Active 未注资替换与 Locked 未投票替换已实跑：超时前拒绝，边界时成功；旧 B 的 DC 全额退回，A 的托管/preAccept 保留，新 B 注资后重新 Locked 且 A 自动恢复 Accept。
- 奖励公式对照发现并修正混合 `DC + stable` 的 Solana 过度奖励：当前 DC 侧奖励固定为 0，稳定币侧正常按生产比例换算。
- 完整模板结算对照发现并修正 `DC ↔ DC` 手续费去向差异：ETH 在没有 C 身份时销毁双方各 0.1% 手续费，国库增量为 0；有 C 时把双方手续费合计转给 C 当前持有人。Solana 已实现同样的严格高分、同分不选、零分不选、同 owner 不选及 top peer 规则，并强制携带规范 CreditScore PDA，不能通过省略信用账户伪装零分。
- 新增 ETH 主网 fork C 手续费参照：第一笔仅 Alice 有零分身份时销毁双方手续费并在完成后建立信用；第二笔 Alice 分数严格高于 Bob 时，预结算 C 解析为 Alice，结算后 Alice 收到双方手续费合计，DC 总供应量不变。
- ETH 生产 Factory 的时限边界已锁定为：当前最短 `3600` 秒、最大 `3,153,600,000` 秒，Fast 替换时限 `60..86,400` 秒；Solana Registry 与创建运行时已覆盖相同生产默认值和治理下限。
- ETH `createDeal` 与授权 `createDealFor` 的域名权限分界已映射到 Solana：普通 `create_deal` 拒绝 `is_domain_deal=true`，DomainEntry 必须用 Registry 登记的 config PDA 签名调用 `create_domain_deal`。
- DAO V2 原子升级兼容场景和国库/Satoshi/分红/UUPS 场景分别在区块 `25,601,795`、`25,601,803` 的本地分叉通过；这些测试没有向主网发送交易。

## 5. 尚未达到发布验收的部分

| 缺口 | 影响 |
| --- | --- |
| 治理权威边界 | ETH DAO V2 与 Solana 本地 `deal_governance` 不是同一模型。当前生产设计必须保持 ETH DAO 单一权威，本地 DAO 不部署/不初始化；如果未来要求 Solana 独立发起治理，则必须另行重写四类提案、D 质押/退回、veto 和策略注册，不能复用当前参考实现冒充等价 |
| 终局统一编排的 Devnet 验收 | Solana 当前 64 account-lock 上限不允许把全部派生索引塞进同一笔最大交易；现已固定为“经济核心原子 + 权限开放补写”。保守 SDK 上限为 `59/59/58` 个账户，真实 DC/DC SBF 为 `58/39` 个账户，两笔 v0+ALT 的字节和 CU 均通过且补写重放不会重复；仍缺 Devnet 持久部署后的真实 signature、slot 和集群日志 |
| EVM/Solana 完整差分 | 已新增主网部署基线、9/6 共享模板、生产 clone 路由、9/9 模板真实 DC/NFT 交割、普通/Fast Reject 和两种 Fast 超时替换的分叉答案；金额手续费和 timeout 已各覆盖 512 组确定性向量；仍需完成奖励、信用、域名和治理最终状态差分 |
| Devnet 持久部署验收 | 尚未完成生产范围 24 个 Program 的 Devnet 初始化、升级权限、业务账户和前端 IDL 实跑；`deal_d_token`、`deal_governance_activity`、`deal_governance`、`deal_dividend` 四个参考 Program 不进入当前生产初始化 |
| 真实三桥适配器 | 目前只有通用 2/3 执行内核，LayerZero、Wormhole、Axelar 的官方接收/验签适配器尚未实现 |
| 跨链故障注入和第三方审计 | 执行内核已覆盖重复、过期、旧 nonce、目标失败重试、桥轮换和取消；真实适配器尚未完成，因此桥网络延迟/乱序、单桥失效、伪造证明和升级失败仍待端到端测试，也未经过独立审计 |

## 6. 发布结论

Solana 协议业务模块已经完成代码覆盖和本地运行时测试，并已用 ETH 主网分叉/源码差分发现和修正普通/Fast 状态机、混合 DC/稳定币奖励以及 DC/DC 的 C/销毁手续费语义差异；但“模块已实现”不等于“已获得主网 100% 等价证明”。本地终局容量已经通过，Devnet 测试钱包当前为 0 SOL、24 个生产 Program 尚未部署；奖励/信用/域名 EVM-Solana 全面差分、Devnet 实发、真实桥适配器和独立第三方审计完成之前，不应解除主网暂停或对外宣称完全迁移验收完成。
