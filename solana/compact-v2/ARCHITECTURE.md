# Deal Solana Compact V2 架构设计

更新时间：2026-08-01

## 1. 当前结论

Compact V2 的推荐目标是把 24 个生产程序压缩为 10 个，而不是追求 1 个或 6～7 个超大程序。

10 个程序是当前“体积、权限隔离、升级事故范围、部署 Buffer、开发可验证性”的平衡点：

- 治理跨链入口单独保留；桥或解析漏洞不能直接变成国库/业务程序漏洞。
- 协议国库单独保留；任何业务模块升级都不能顺带改变提款逻辑。
- 经济核心和可重试数据补写继续分开；不破坏已经验证的两阶段终局模型。
- 单个合并程序预计控制在约 1.12 MB 以下，避免 1.8～2 MB 域名大程序带来的升级和 Buffer 风险。
- 合并仅发生在共享状态、数学或 CPI 很强的边界内。

当前 10 程序布局已经完成确定性生成、优化 SBF 构建、全新 loopback validator 真实部署、生产拓扑初始化、业务烟测和治理升级/回滚；它仍只是本地实现候选，在 Devnet 持久部署、跨链故障注入和外部独立审计完成前不是主网部署候选。

## 2. 目标布局

| Compact 程序 | 合并的现有程序 | 主要理由 |
|---|---|---|
| Governance Ingress | Governance Executor | 三桥 2/3、nonce、重放和白名单保持独立安全边界 |
| Treasury | Protocol Treasury | 资产提款和 controller 独立于所有业务升级 |
| Lifecycle | Core、Asset Controller | Deal 状态机与托管操作高度耦合，可消除最频繁 CPI |
| Settlement | Finalizer、Credit Valuator、Reward Engine | 终局 receipt、U 估值和奖励计算共享同一终局证明 |
| Identity Credit | Identity、Credit Graph | 身份锁定、owner、防刷、信用和 top5 共享身份状态 |
| Monetary Policy | DC Controller、Parameter Registry | DAO 管理的 minter 与参数同属治理目标，但不并入普通业务 |
| Exchange | Pair、Router、Quoter、Swap Asset Registry、Orderbook | 共享 Pair 数学、官方资产、路由和交易托管 |
| Domain Assets | Domain Registry、Domain Market | 域名 NFT、解析、市场 escrow 与转移同属资产层 |
| Domain Network | Domain Rank、Domain Entry、Domain Hall | 排行、域名 Deal 入口和大厅交互共享域名业务上下文 |
| Data Services | History Index、Result Index、Message Hub | 分页、消息和终局补写均为可重试数据层 |

24 个生产程序必须在 `layout.json` 中恰好出现一次；校验脚本会拒绝遗漏、重复或非生产程序。

## 3. 为什么不继续压到 7 个

理论上可进一步把 Domain Assets 与 Domain Network 合并、把 Monetary Policy 并入 Settlement、把 Data Services 并入 Lifecycle。但这三项都会产生不合算的风险：

1. 域名五合一的现有二进制总量约 1.92 MB，合并后仍可能超过 1.3 MB；部署 Buffer、升级耗时和域名全模块同时失效的风险明显增加。
2. DC Controller 是最终铸币权限边界。并入 Reward/Settlement 会让终局计算漏洞与 DC 铸币控制共享同一升级事故范围。
3. Data Services 是允许失败后重试的第二阶段。并入经济核心容易诱导未来开发者重新塞回同一笔交易，破坏 64 account-lock 已验证边界。

因此 10 个是推荐最小值；进一步减少必须有真实 SBF 体积和新增安全证明，而不是只按程序数量决定。

## 4. 逻辑一致的硬约束

Compact V2 的“逻辑一致”按用户可观察结果判定，以下项目不允许变化：

### 4.1 状态与资产

- 同一输入必须在相同条件下成功或失败。
- Deal 普通模式与 OpenTokenToken Fast 的状态转换、超时、替换、Reject 和退款完全一致。
- SPL、SOL、NFT、DC 的托管、余额变化、销毁、国库/C 收费和终局归属完全一致。
- 域名 NFT、市场 escrow、排行质押/奖励和大厅入口结果一致。
- DEX exact-in/out、向上取整、滑点、真实/虚拟储备、TWAP 和 DC fee burn 一致。

### 4.2 权限

- 每个现有模块的 `authority`、`pending_authority`、`paused` 和 recorder/minter/writer grant 保持独立语义；合并程序不等于合并权限。
- Governance Executor 仍是生产升级权威和治理动作入口。
- Treasury controller 只能通过治理路径操作；普通钱包直接提款仍拒绝。
- DC minter、Identity controller、Credit recorder、Domain reporter 等角色仍分别校验。

### 4.3 防重与阶段

- terminal receipt、valuation receipt、reward receipt、history marker、result marker 和治理 message hash/nonce 不合并成一个可被跳过的标志。
- “经济核心原子交易 + 可重试索引补写”继续保留。
- 失败交易不得留下部分资产、奖励、信用或索引状态。
- 所有旧的重复执行、旧 nonce、过期、错误顺序和越权反向测试必须继续失败。

### 4.4 链级产品边界

- 中本聪账户和分红继续只存在于 ETH。
- Solana 不部署本地 D DAO、治理活跃模块或 Dividend 参考程序。
- ETH DAO V2 仍是唯一治理源；Compact V2 只接收经过三桥 2/3 确认的治理动作。

## 5. 已实现的组合方式

Compact V2 没有手工重写 24 份业务逻辑。生成器复制原模块源码，仅做可审计的拓扑变换：

1. 同组模块使用同一个 Compact Program ID；原 PDA seed、状态字段、整数宽度、账户空间、事件和错误条件不变。
2. 根入口先识别可选 `DLV2 + moduleTag` 显式信封；没有信封时直接识别原 Anchor 8-byte discriminator，因此旧 calldata 不需要重编码。
3. 重名 discriminator 先按账户数量分流；账户数量仍冲突时，按 IDL 中的常量 seed 推导规范 PDA，拒绝非规范 PDA，避免调用到错误模块。
4. `execute_message` 是唯一使用 `Context::remaining_accounts` 的指令，路由规则为“至少 5 个基础账户”，其余 248 条保持精确账户数。
5. 同组 CPI 仍进入原模块 Anchor `entry`，不绕过原账户约束和 signer/PDA 校验；跨组 CPI 继续调用目标 Compact 根程序。
6. 同一 Program 内 CPI 会使外层 Anchor `Account<T>` 缓存变旧。生成器只在实际写后读路径增加 22 个 `reload()`，防止外层退出时把旧值写回。
7. 终局守卫读取 Instructions Sysvar，因此 4 个硬编码旧 Program ID 必须映射到 Settlement 根 ID；映射由旧 IDL address 自动生成并记录。
8. Exchange 合并使 Pair 与 Router 编译为同一根 ID；Asset Registry 只对这个精确的编译期组合身份放宽 `pair_program != router_program`，任意外部重复地址仍拒绝。
9. 每个旧模块保留独立错误码段。错误条件和消息不变，数字段会因同 Program 合并而重排，客户端不得硬编码旧 Program 的错误数值。

`generated/source-equivalence.json` 保存原文件 hash、生成文件 hash、归一化业务 hash和所有允许的 plumbing 变化；生成器发现额外差异会直接失败。

## 6. 升级和 Program ID 策略

Compact V2 使用全新的 Program ID，不覆盖现有 24 个保留 ID。原因：

- 多程序无法原地合并成一个旧 Program ID。
- 新 ID 允许旧版本与 Compact V2 在 Localnet/Devnet 并行运行，便于差分。
- Solana 主网尚未部署这 24 个程序，不存在主网业务状态迁移负担。

所有 Compact Program 的 upgrade authority 最终仍必须交给 Governance Executor PDA。部署钱包只能完成部署和初始化，不保留业务管理权。

Upgradeable Loader 的 ProgramData 必须在首次部署时预留升级空间。本轮精确尺寸部署已实证：大 80 bytes 的候选会被 Loader 拒绝；同尺寸不同 hash 候选可由 DAO 升级并回滚。正式 `max_len`、额外租金和升级包尺寸上限必须在 Devnet 前锁定。

## 7. 差分验收与当前结果

验收采用四层证明：

1. **结构证明**：旧 IDL 指令、参数、账户、事件和错误逐项映射到 Compact IDL，不得遗漏。
2. **Rust 向量**：数学、时间边界、金额和排序规则使用同一输入向量对照。
3. **SBF/LiteSVM**：所有原运行时测试改为加载 Compact 根 `.so`，执行相同交易并断言账户、余额、mint supply、receipt、return data 与拒绝路径。
4. **外部对照**：原 24 程序、SDK 和 ETH mainnet fork 基线独立重跑，防止紧凑工程污染原实现。

当前结果：

- Compact 工作区：153/153 测试通过；新增用例覆盖 Exchange 编译期同根身份和任意重复地址拒绝。
- 严格格式与 Clippy：通过，`-D warnings`。
- 原 24 程序：124/124 测试通过，格式与严格 Clippy 通过。
- SDK：23/23 通过。
- 隔离 Localnet：10/10 Loader 部署与 dump hash、24/24 模块路由、完整生产接线、Core/DEX/域名/排行/Hall/国库业务、DAO 升级与回滚全部通过；最终 10 根 upgrade authority 均为治理执行器 PDA。
- 最大 DC/DC 终局真实 SBF：经济核心 55 accounts、9 instructions、554 bytes、416,589 CU；后置索引 38 accounts、7 instructions、473 bytes、213,151 CU。
- ETH fork：历史固定区块的默认 RPC 返回 403；可用免费 archive RPC 被限流。当前默认区块又因 Broadcaster 无 active chain 使旧 DAO V2 用例按设计返回 `NoActiveChains()`。因此本轮不能把 ETH fork 标记为重新通过；既有 6/6 基线仍是历史证据，当前重跑属于外部状态/RPC 阻断。

采用 Compact V2 的最低发布条件：

- 24→10 指令映射覆盖率 100%。
- 当前 Rust/SDK 通过，ETH fork 必须在可用 archive RPC 上重新通过。
- 新增逐分组旧版/Compact 双跑测试通过。
- 真实优化 SBF、IDL、Program ID 和链上 dump hash 锁定。
- Devnet 持久部署、三桥适配器故障注入和独立第三方审计完成。

## 8. 最终实测成本

| Compact 根程序 | 优化 SBF bytes |
|---|---:|
| Governance Ingress | 280,824 |
| Treasury | 211,864 |
| Lifecycle | 772,184 |
| Settlement | 854,560 |
| Identity Credit | 603,392 |
| Monetary Policy | 270,424 |
| Exchange | 931,464 |
| Domain Assets | 625,864 |
| Domain Network | 902,224 |
| Data Services | 721,856 |
| **合计** | **6,174,656** |

与原 24 个优化产物 7,870,608 bytes 相比减少 1,695,952 bytes（21.55%）。

- 永久程序租金：54.83572416 → 42.99906096 SOL，减少 11.83666320 SOL。
- 最大可复用部署 Buffer：约 6.48413784 SOL。
- 加 2 SOL 重试余量后的建议钱包：60.47099480 → 51.48319880 SOL，减少 8.98779600 SOL。
- 隔离 Localnet 的 10 根实际部署支出：43.02980096 SOL。

这里只计算程序部署账户，不包括业务 PDA 初始化租金、交易费、优先费和未来升级预留。Buffer 在部署结束关闭后可回收。

## 9. 剩余发布门槛

1. 确定 10 根正式 `max_len` 扩容余量和租金，并制定可恢复的密钥/Buffer/upgrade-authority 流程；本轮 `.local` 私钥不得复用。
2. 在持久 Devnet 部署 10 根，重复本轮初始化、交权、治理接线、所有业务 smoke 和升级/回滚。
3. 使用可用 archive RPC 重跑固定区块 ETH fork；按当前 Broadcaster 状态修订旧 DAO V2 测试前必须另行评审，不能静默跳过 `NoActiveChains()`。
4. 对三桥 2/3、重复/乱序消息、桥停机、错误目标和升级失败做故障注入。
5. 生成合并 IDL/SDK 地址清单、迁移和回滚方案，锁定最终 `.so` SHA-256。
6. 完成独立第三方安全审计。当前结论只属于内部工程审计，不构成“绝对安全”保证。
