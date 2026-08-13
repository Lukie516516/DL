# Solana Compact V2 本地部署、全链路与升级回滚审计

日期：2026-08-01

## 结论

Compact V2 的 24 → 10 紧凑架构已在全新的隔离 loopback validator 上完成真实 Upgradeable Loader 部署、生产拓扑初始化、业务全链路、权限负测、治理升级和回滚。

本轮结论为“本地工程验收通过”，不是第三方审计结论，也不是 Devnet/Mainnet 部署批准。未向任何外部网络发送交易，未使用用户主网钱包或资产。

核心结果：

- 10/10 根程序部署成功，链上 dump SHA-256 与本地构建逐一一致；
- 24/24 原模块路由到达，249 条原 calldata 可用，0 条必须使用新前缀；
- 完整生产拓扑、三桥 2/3、Treasury bootstrap 锁定和 21 次治理交权完成；
- Core、DEX、域名、排行、Hall、国库 SOL/SPL 付款及负向分支通过；
- 部署钱包不能直接升级；DAO 完成不同 hash 升级，再回滚到原始 hash；状态 hash 未改变；
- Compact Rust/LiteSVM 153/153、格式检查、严格 Clippy、10/10 SBF 构建通过；
- 最终体积 6,174,656 bytes，比原 24 程序减少 1,695,952 bytes（21.55%）。

## 隔离环境

- RPC：`http://127.0.0.1:8799`
- Genesis：`EfExfE32qJypwFj7Z5WDyucKMZfbw2pwqnz88hM85prU`
- 本地部署钱包：`7A4MWC4U14qNjsdpqWtbLvU26PuuteBRz48z4DdighEu`
- 治理执行器 PDA：`ET9DoKHThabtx8ati62jM8bV93oP1qrgtrcHxqcJX8cr`
- 本地状态目录：`solana/.local/compact-v2/`

`.local` 内包含测试私钥、ledger 和本地报告，只能作为本机证据，不得提交 Git，不得复用到 Devnet/Mainnet。

## 部署与成本

| 根程序 | 本地地址 | bytes |
|---|---|---:|
| Governance Ingress | `Gk6mG5DDQ6tLgnDC7uYquyLDhJ21bURwXDucs8jnpaki` | 280,824 |
| Treasury | `68mb547YripUXfReaDg332xvvx8Kte57nTCYC8uGdN1F` | 211,864 |
| Lifecycle | `9GAky65hVTVSxQ3KfSXwpLdH67r6cdVvHXh8kqdEmv53` | 772,184 |
| Settlement | `3a2xotfLN59E72BYSgJY2ugo1fkEqWCnmG1ABQeyPkbU` | 854,560 |
| Identity Credit | `HesJdFAbLmrFifrYmbsNy24QHsBwLzzfL1SCRKn4QPBs` | 603,392 |
| Monetary Policy | `ESEdFyK4F9qBUHi3A2BFYZjrfcqxC5woEB9gg7s21B4W` | 270,424 |
| Exchange | `JCoWN8RHFHskbJw3dCkvtFYFzTXgLC5zwLnwqus5TfmQ` | 931,464 |
| Domain Assets | `9T86C2T8jD5ZfGAYy87x2tDvRVZkusKxhq7XM15CSUk8` | 625,864 |
| Domain Network | `938zJG8xDo5mQqCwU31TDRvD3KuMco7iCwRnCtdAnLNY` | 902,224 |
| Data Services | `7o3JpS4c9xVq1yZiMoSppK4dmgjoLbcdJxq18vEdVnsf` | 721,856 |

部署前余额减部署后余额为 43.02980096 SOL。模型永久租金为 42.99906096 SOL，差额约 0.03074 SOL，属于部署交易和账户操作开销。建议正式部署钱包模型为 51.48319880 SOL，其中包含最大可复用 Buffer 6.48413784 SOL 和 2 SOL 重试余量，不含业务 PDA 初始化、优先费和未来 `max_len` 扩容租金。

## 全链路结果

### 路由与初始化

- 10 个根均为可执行 Upgradeable Loader 程序；
- 24 个显式 module route 全部到达对应模块入口；
- 249 条 raw route、66 条规范 PDA 消歧、0 条 prefixed-only；
- 未知 module 和畸形 envelope 返回 `InvalidInstructionData`；
- 22 个独立配置初始化、3 个官方 Pair 创建；
- 三个 bridge signer、阈值 2、错误 bridge/重复确认/未达阈值/重放全部拒绝；
- Treasury controller、参数 authority 和全部模块业务 authority 已交给治理执行器；Treasury bootstrap 永久锁定。

### 业务烟测

| 领域 | 正向行为 | 关键负向行为 |
|---|---|---|
| Core Lifecycle | ordinary、exact-address、OpenTokenToken Fast 创建与状态推进 | 错序、重复创建、自加入、错误 preaccept、越权 join/vote 拒绝 |
| DEX | 临时 minter、初始化流动性、真实 SPL swap、撤销 minter | 不可能滑点、已撤销 minter 拒绝 |
| Domain Assets | 注册、元数据、解析、转移、上架、下架、购买、primary | 重复 label、越权元数据、escrow 中转移、越权下架、超价拒绝 |
| Domain Entry/Rank | 域名 Deal、黑名单、选人、策略、排行质押与取回 | 非创建者确认、自选、黑名单、重复确认、低于门槛和二次取回拒绝 |
| Domain Hall | 消息真实烧 DC、pick signal | 黑名单、非参与者、空消息、旧 index、消息/信号重放拒绝 |
| Treasury | 治理支付 0.25 SOL 和 100 SPL base units | 普通钱包直接付款拒绝 |

## 治理升级与回滚

测试对象是 Monetary Policy 根，状态对象是 Parameter Registry。

1. 将 10 个根的 upgrade authority 全部交给治理执行器 PDA；
2. 部署钱包尝试直接调用 Loader Upgrade，返回 `IncorrectAuthority`；
3. 使用与原二进制同尺寸、只改变非执行 ELF section 名称的候选，得到不同 SHA-256；
4. 两个不同 bridge 确认后由治理执行升级；链上 dump hash 等于候选 hash；
5. Parameter Registry 状态 hash 升级前后保持 `cbf85dcddb47d50b8ed46fd15ddb69688cf07ed2cd8847ca746f8566e4111374`；
6. 再由治理升级回原始二进制；最终 dump hash 恢复为 `e87464c31f67bcc5e9f11e13fc2663b067c9e82166858f9caba2761c9108c7c5`；
7. 两次成功升级的 Buffer 均自动关闭；首次尺寸失败留下的 Buffer 也已由治理关闭并回收。

## 本轮发现与修复

### 1. Exchange `DuplicateCore`

完整 bootstrap 首次发现：Pair 和 Router 在 Compact Exchange 中共享同一个根 Program ID，但原 Asset Registry 禁止二者相同。

修复为生成后 Compact 专用条件：只有“编译期 Pair ID == 当前 Exchange 根 ID”的精确组合身份可以相同；任意外部重复地址仍拒绝。原 24 程序源文件未修改。修复增加 360 bytes，Exchange 从 931,104 变为 931,464 bytes；全新 validator 重置后完整接线和业务测试通过。

对原逻辑的影响：原版无影响；Compact 中只解决必然发生的同根拓扑冲突，不放宽任意地址配置。

### 2. ProgramData 没有扩容余量

首次升级候选比已部署程序大 80 bytes，Loader 返回 `ProgramData account not large enough`。这是部署空间配置约束，不是治理或业务代码故障；失败交易没有改写程序。

处理：改用同尺寸不同 hash 候选验证升级/回滚通道，并把正式 `max_len` 预留列为发布阻断项。

对原逻辑的影响：无；没有修改任何业务入口或状态，只新增本地升级测试能力和发布约束。

### 3. 生成、SDK 与本地工具

- 生成器现在对生成工作区自动执行 `cargo fmt`；
- SDK 通过显式 `SOLANA_COMPACT_LAYOUT_PATH` 才启用 24→10 映射，默认 24 程序逻辑不变；
- 新增 Localnet prepare/build/deploy/router audit 工具，部署脚本强制 loopback RPC 和确认字符串；
- 升级烟测支持指定候选二进制、验证部署钱包直升失败和治理清理失败 Buffer。

对原逻辑的影响：均为生成/测试/可选 SDK 接线工具；不修改原 24 程序默认路径，也不产生外部网络交易。

## 尚未通过的发布门槛

1. 正式部署必须确定每个根的 `max_len` 扩容比例和额外租金；
2. 必须生成新的正式 Program ID 和密钥保管/恢复方案，本地地址不得复用；
3. Devnet 持久部署并重复本报告全部交易、故障注入和升级回滚；
4. 使用稳定 ETH archive RPC 重跑固定区块一致性基线；
5. 三桥在真实测试网络做停机、乱序、延迟、重复和错误源故障注入；
6. 独立第三方审计。

在这些条件完成并获得单独授权前，不应部署 Solana Mainnet。
