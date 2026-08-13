# Solana Compact V2 紧凑架构测试与内部安全审计

日期：2026-07-31；2026-08-01 增补隔离 Localnet 全链路验证

## 1. 结论

已完成 24 → 10 的 Compact V2 本地实现、优化 SBF 构建、隔离 Localnet 真实部署、生产拓扑初始化、业务回归、治理升级/回滚、路由审计和内部代码审计。

当前可以确认：

- 原 24 个 Solana 业务模块全部进入 10 个根程序，没有遗漏或重复；10/10 根程序已部署到全新 loopback validator；
- 249 条旧 Anchor 指令均可继续使用原 calldata，未要求前端统一改成新信封；
- 原 24 程序 124/124、Compact 153/153、SDK 23/23 均通过；
- 严格 `cargo fmt`、`cargo clippy -D warnings` 通过；
- 10 个最终优化 `.so` 合计 6,174,656 bytes，比原版减少 21.55%；
- 隔离 Localnet 完成 10/10 Loader 部署、链上 dump hash、24/24 路由、完整接线、真实资产烟测和治理升级→回滚；
- 未部署 Devnet/Mainnet，未发送任何外部网络治理或资金交易，未提交或推送 Git。

这不是第三方审计报告，也不能承诺“绝对安全”。在 Devnet 持久验证、固定区块 ETH fork 重跑、跨桥故障注入和独立审计完成前，不建议部署 Solana 主网。

## 2. 实现范围

| Compact 根程序 | 原模块 | 最终 bytes |
|---|---|---:|
| Governance Ingress | Governance Executor | 280,824 |
| Treasury | Protocol Treasury | 211,864 |
| Lifecycle | Core、Asset Controller | 772,184 |
| Settlement | Finalizer、Credit Valuator、Reward Engine | 854,560 |
| Identity Credit | Identity、Credit Graph | 603,392 |
| Monetary Policy | DC Controller、Parameter Registry | 270,424 |
| Exchange | Pair、Router、Quoter、Asset Registry、Orderbook | 931,464 |
| Domain Assets | Domain Registry、Domain Market | 625,864 |
| Domain Network | Domain Rank、Domain Entry、Domain Hall | 902,224 |
| Data Services | History Index、Result Index、Message Hub | 721,856 |

原 `solana/programs` 保持为业务真源。`solana/compact-v2/tools/generate-composed-programs.mjs` 读取原源码、原 IDL 和 `layout.json`，确定性生成独立工作区，不修改原生产 Program ID 或部署清单。

## 3. 兼容设计

### 3.1 指令兼容

根入口支持两种调用：

1. 原 Anchor calldata：8-byte discriminator + 原参数；
2. 显式信封：`DLV2` + 1-byte module tag + 原 calldata。

静态审计结果：

- 路由总数：249；
- 原 calldata 可直接路由：249；
- 只能使用前缀的路由：0；
- 需要规范 PDA 消歧的路由：66；
- 动态账户路由：1，仅 `deal_governance_executor:execute_message`。

重名 discriminator 不按调用者自报模块盲信，而是按账户数和 IDL 常量 seed 推导出的规范 PDA 决定；不匹配时返回 `InvalidInstructionData`。

### 3.2 状态和权限兼容

- 原 PDA seed 文本、账户字段、空间、事件、数学、超时和拒绝条件保持不变；Program ID 改变，因此地址会整体迁移。
- 每个模块的 authority、pending authority、paused、minter/recorder/writer 授权仍由原模块代码校验。
- Treasury 与 Governance Ingress 保持独立根程序，未并入普通业务升级事故范围。
- 经济核心与可重试索引仍是两阶段，未把全部派生写入塞回同一笔交易。
- 中本聪账户和分红仍只属于 ETH；Solana Compact 没有新增本地 D DAO 或分红程序。

### 3.3 源码等价性

32 个 Rust 业务源文件在忽略 Program ID 和错误码段后 hash 一致。生成器只允许并记录以下拓扑 plumbing：

- 22 处同 Program CPI 后 `Account<T>::reload()`；
- 4 处 Instructions Sysvar 终局守卫的旧 Program ID → Settlement 根 ID 映射；
- 2 处仅供组合拓扑使用的 Exchange Pair/Router 同根身份例外及其防回归测试。

任何未登记的业务源码差异都会使生成器失败。详细逐文件 hash 和改动见：

- `solana/compact-v2/generated/source-equivalence.json`
- `solana/compact-v2/generated/router-manifest.json`

## 4. 审计中发现并修复的问题

### C-01：同 Program CPI 后外层 Anchor 缓存覆盖新状态

严重性：高；状态：已修复并回归。

压缩后 Core 与 Asset Controller 等模块共享 Program ID。内层 CPI 已修改账户，但外层 `Account<T>` 仍保留旧缓存；若不 reload，外层退出序列化可能把旧值写回。首次真实 SBF 测试表现为双方入金后 Deal 未保持 `Locked`。

修复：仅在实际“内层写、外层继续持有/读取”的 22 条路径增加 `reload()`，覆盖 DealAccount、PairState 和 DomainRecord。资产、DEX、Orderbook、域名市场和完整终局回归全部通过。

### C-02：治理动态目标账户被根路由误判

严重性：高；状态：已修复并回归。

Anchor IDL 只列出 `execute_message` 的 5 个固定账户，但该指令合法使用 `remaining_accounts` 传入目标调用账户。最初路由要求账户数严格等于 5，使交易在治理逻辑执行前失败。

修复：只有该指令使用 `accounts.len() >= 5`；其他 248 条保持精确账户数。双桥确认后参数执行和执行器自身 authority 交接两条真实 SBF 测试通过。

### C-03：终局守卫仍要求旧独立 Program ID

严重性：高；状态：已修复并回归。

Asset Controller、Finalizer、Reward Engine 和 Credit Valuator 会读取 Instructions Sysvar，检查下一条顶层指令的 Program ID。压缩后顶层调用来自 Compact 根，旧硬编码 ID 会导致 `WrongProgram(7004)`。

修复：生成器从原 IDL address 建立旧 ID → Compact 根 ID 映射，自动替换 4 个显式 `pubkey!` 常量。最大 DC/DC 终局链路随后通过。

### C-04：构建 LTO 方案并未降低部署成本

严重性：信息；状态：已评估并否决。

将根 crate 改为仅 `cdylib` 以启用 LTO 后，Exchange 从约 0.93 MB 增到约 1.02 MB。该方案测试通过但部署更贵，因此未纳入生成器。

### C-05：Exchange 合并后 Pair 与 Router 同 ID 触发 DuplicateCore

严重性：高；状态：已修复并在全新 Localnet 重置后回归。

原 Asset Registry 要求 `pair_program != router_program`。Compact Exchange 把 Pair、Router、Quoter、Asset Registry 和 Orderbook 合并到同一根，因此生产拓扑初始化在 `SwapAssetRegistry.initialize` 正确触发 `DuplicateCore`。此前 LiteSVM 模块测试没有覆盖“完整 24 模块生产接线”，所以只在本轮真实 bootstrap 被发现。

修复只存在于生成后的 Compact plumbing：仅当两个地址分别等于编译期 Pair ID 与当前根 ID 时允许相等；任意外部相同地址仍被拒绝。原 24 程序源码和原版校验未修改。新增单测验证“只接受编译期组合身份、拒绝任意重复地址”，全新 Localnet 随后完成 22 个配置初始化和 3 个官方 Pair 创建。

### C-06：ProgramData 未预留扩容空间

严重性：发布阻断/配置风险；状态：已识别并加入主网前置条件，未通过改业务逻辑规避。

本地首次升级候选比原 Monetary Policy 二进制大 80 bytes，Upgradeable Loader 返回 `ProgramData account not large enough`。失败交易没有改写程序代码；遗留 Buffer 已由治理关闭并回收。随后使用“同尺寸、仅改变非执行 ELF section 名称”的候选完成：部署钱包直升拒绝、DAO 升级、状态 hash 不变、DAO 回滚、最终链上 hash 恢复。

这证明治理升级通道本身有效，也证明正式部署必须显式预留 `ProgramData` 扩容空间；否则未来只能升级到不大于初始二进制的版本。该约束不能靠普通业务提案补救，必须在正式部署参数中解决。

## 5. 测试证据

### 5.1 Compact V2 静态与 LiteSVM

- `cargo test --workspace`：153/153。
- `cargo fmt --all -- --check`：通过。
- `cargo clippy --workspace --all-targets --locked --offline -- -D warnings`：通过。
- 10/10 根程序 `cargo build-sbf`：成功。
- 运行时覆盖 Core、托管、身份、信用、DC 权限、参数、DEX、Orderbook、域名、消息、国库、治理、奖励、估值、索引和最大终局容量。
- 根路由额外覆盖稳定信封、短数据、未知 module、未知 discriminator 和错误 PDA 拒绝。

最大 DC/DC 真实 SBF：

| 阶段 | accounts | instructions | bytes | CU |
|---|---:|---:|---:|---:|
| 经济核心 | 55 | 9 | 554 | 416,589 |
| 后置索引 | 38 | 7 | 473 | 213,151 |

### 5.2 隔离 Localnet 全链路

- 新 genesis：`EfExfE32qJypwFj7Z5WDyucKMZfbw2pwqnz88hM85prU`，RPC 仅监听 `127.0.0.1:8799`。
- 10/10 根程序通过 Upgradeable Loader 部署；每个链上 `program dump` SHA-256 与本地候选一致。
- 24/24 显式模块路由到达；249 条原 calldata 路由、66 条 PDA 消歧、0 条必须前缀；畸形/未知路由拒绝。
- 生产拓扑完成 22 个独立配置初始化、3 个官方 Pair、三桥 2/3、21 次治理交权、Treasury bootstrap 永久锁定。
- Core 生命周期、DEX、域名注册/交易、域名 Deal/排行、Domain Hall、Treasury 原生 SOL 与 SPL Token 治理付款全部通过；各自越权、重放、错误顺序、滑点和身份负向分支均拒绝。
- Monetary Policy 完成不同 hash 的治理升级和回滚；参数状态 hash 前后均为 `cbf85dcddb47d50b8ed46fd15ddb69688cf07ed2cd8847ca746f8566e4111374`。
- 10 个根最终 upgrade authority 全部为治理执行器 PDA `ET9DoKHThabtx8ati62jM8bV93oP1qrgtrcHxqcJX8cr`；部署钱包直接升级返回 `IncorrectAuthority`。

本地证据保存在 `solana/.local/compact-v2/`，该目录含测试私钥，只用于本机、不得提交或复用到任何外部网络。

### 5.3 原版防回归

- 原 24 程序 Rust/LiteSVM：124/124。
- 原工作区格式与严格 Clippy：通过。
- 终局 SDK、v0/ALT、IDL/preflight：23/23。

这证明本轮没有通过改坏原版来让 Compact 测试通过。

### 5.4 ETH mainnet fork

既有审计基线在区块 25,653,286 为 6/6。2026-07-31 本轮重跑未能形成新的通过结论：

1. 默认 RPC `ethereum-rpc.publicnode.com` 对固定历史区块返回 403；
2. 备用免费 archive RPC 可读区块但持续限流，完整用例无法在合理时间内完成；
3. 默认最新 fork 区块 25,653,780 上，现网 Broadcaster 没有 active chain，旧 DAO V2 测试调用 `quoteFees` 按设计返回 `NoActiveChains()`。

因此这部分标记为“外部 RPC/现网状态阻断”，不是 Compact 合约失败，也不能当成已通过。后续必须用稳定 archive RPC 重跑；若要让旧 DAO V2 测试兼容无 active chain，需要单独评审测试语义，不能在本轮静默跳过。

## 6. 成本

| 指标 | 原 24 程序 | Compact 10 程序 | 节省 |
|---|---:|---:|---:|
| SBF 总字节 | 7,870,608 | 6,174,656 | 1,695,952（21.55%） |
| 永久租金 | 54.83572416 SOL | 42.99906096 SOL | 11.83666320 SOL |
| 建议钱包 | 60.47099480 SOL | 51.48319880 SOL | 8.98779600 SOL |

建议钱包 = 永久租金 + 最大单程序可复用部署 Buffer + 2 SOL 余量。Compact 最大 Buffer 约 6.48413784 SOL，关闭后可回收。隔离 Localnet 真实 10 根部署支出为 43.02980096 SOL，与 42.99906096 SOL 永久租金模型的差额约 0.03074 SOL，属于部署交易/账户操作开销。这里不含业务 PDA 初始化租金、交易费和优先费。

## 7. 仍然存在的风险

1. **未上 Devnet**：已有 loopback signature、slot、Loader 部署/升级证据，但尚无共享真实集群的持久性、RPC 和网络拥堵证据。
2. **正式 Program ID 未生成**：`layout.json` 的 ID 仍只用于编译/LiteSVM；本轮 Localnet ID/私钥在 `.local`，不得作为正式地址。正式部署必须重新生成并锁定 ID、keypair 保管和 upgrade authority 流程。
3. **升级事故范围扩大**：单根包含多个模块；虽然权限状态独立，但一次根程序升级会同时改变该根全部模块代码。
4. **客户端迁移**：旧 calldata 可复用，但所有 Program ID/PDA 会变化，IDL 地址和错误码数字也需切换。
5. **跨链外部依赖**：三桥 2/3 的桥可用性、消息延迟和源身份仍需要 Devnet/主网级故障注入。
6. **依赖告警**：SDK `npm audit` 为 3 个 moderate，链路为 `@solana/web3.js -> jayson -> uuid`；0 high、0 critical。自动建议的 `web3.js@0.0.3` 是错误的主版本回退，不能直接采用。
7. **RustSec 未执行**：本机未安装 `cargo-audit`，不能声称 Rust 依赖漏洞扫描已通过。
8. **外部审计缺失**：当前属于内部工程审计。
9. **升级空间**：本轮精确尺寸 ProgramData 已证明无法容纳更大的后续二进制；正式部署必须评审并锁定 `max_len` 预留和对应租金。

## 8. 下一步

1. 先让独立审计人员复核生成器、28 处 plumbing、路由冲突、Exchange 同根身份例外和升级边界。
2. 确定正式 `max_len` 扩容余量及额外租金，再生成 10 个正式候选 Program ID，制作可恢复密钥与 upgrade authority 交接方案。
3. Devnet 持久部署并记录所有地址、hash、signature、slot 和日志，重复本轮全链路和治理升级/回滚。
4. 获取稳定 ETH archive RPC，重跑固定区块 6 组 fork；再做三桥停机、重复、乱序、错误目标和 2-of-3 故障注入。
5. 上述全部通过后，才讨论 Solana 主网部署授权和治理接线。
