# CCIP 第三桥替换开发与迁移预案

## 当前结论

已完成代码审计、攻击面测试、ETH/BSC 主网 fork 预演、主网阶段 1 部署、阶段 2 精确接线、阶段 3 Major 提案 `#13` 创建与执行，以及阶段 4A 可回滚切换。ETH `CrossChainBroadcasterV2` 与 BSC `DualBridgeExecutorV2` 已部署并接线；V2 Parameter/Major DAO 规则已生效，V1 两条规则仍保留；BSC route 当前 `active=true`，BSC DealFactory `crossChainGovernance` 已从 V1 Executor 切换为 V2 Executor。

阶段 4A 只发送了两笔明确授权的配置交易：激活 V2 route，以及切换 BSC Factory controller。阶段 4B 已创建 Major 零业务变化 canary 提案 `#14`，当前为 `Pending`、`totalStaked=0`、未执行；`broadcastNonce=0`，说明 V2 尚未广播过跨链消息。线上 V1 合约和 V1 DAO 规则仍保留，必要时可暂停 V2 route 并把 Factory controller 切回 V1 Executor。

新架构是：

```text
ETH DealGovernance
        |
        v
CrossChainBroadcasterV2
   | LayerZero
   | Chainlink CCIP
   | Axelar
        v
BSC DualBridgeExecutorV2 -- 2-of-3 --> BSC allowed target
```

替换的只是第三条桥：

| 版本 | 三条路径 | 阈值 |
|---|---|---:|
| 线上 V1 | LayerZero + Wormhole Standard Relayer + Axelar | 2-of-3 |
| 已部署、已接线、已切换、待 canary 的 V2 | LayerZero + Chainlink CCIP + Axelar | 2-of-3 |

Wormhole 旧合约不是 proxy，且 relayer 地址是 immutable，所以不能对线上合约原地换桥。正确方式是部署一对 V2 合约，验证后再切换 DAO 策略和 BSC Factory 的跨链执行器。

## 新代码

| 文件 | 用途 |
|---|---|
| `contracts/lib/CCIP.sol` | 与 Chainlink CCIP v1.6.x ABI 一致的最小消息结构和 Router 接口 |
| `contracts/bridge/CrossChainBroadcasterV2.sol` | ETH 发送端，向 LZ / CCIP / Axelar 发送同一 payload |
| `contracts/bridge/DualBridgeExecutorV2.sol` | BSC 接收和聚合端，任意两条真实桥确认后只执行一次 |
| `contracts/test/CCIPBridgeMocks.sol` | 三桥本地模拟环境 |
| `test/CCIPBridgeMigration.ts` | 发送、来源校验、2-of-3、晚到桥、重放、失败重试、重入、费用、退款和 DAO 策略兼容测试 |
| `test/CCIPBridgeMainnetFork.ts` | 在 ETH/BSC 主网 fork 上调用真实 LZ、CCIP、Axelar 合约并验证接收执行 |
| `scripts/prepare-mainnet-ccip-migration.ts` | 纯只读主网预检和未来 calldata 生成，不包含 wallet client 或发送交易分支 |
| `scripts/deploy-mainnet-ccip-v2-stage1.ts` | 带显式写入门、nonce/owner 检查和可恢复状态文件的双链“只部署不接线”脚本 |
| `deployments/ccip-v2-mainnet-stage1.json` | 两笔部署交易、区块、地址和部署后只读验证结果 |
| `scripts/wire-mainnet-ccip-v2-stage2.ts` | 只包含四个接线动作、显式写入门、逐笔确认和可恢复状态的阶段 2 脚本 |
| `deployments/ccip-v2-mainnet-stage2.json` | 四笔接线交易、区块和 `active=false` 最终验证结果 |
| `scripts/propose-mainnet-ccip-v2-stage3.ts` | 默认只读；精确复制 V1 两条广播规则，写模式最多授权一次 Major 费并创建提案；无 stake/execute/activate/switch/mint 路径 |
| `scripts/fund-mainnet-ccip-v2-stage3-fee.ts` | 只为阶段 3 提案账户精确 mint 当前一次 Major 费；无 approve/propose/stake/execute 路径 |
| `scripts/verify-mainnet-ccip-v2-stage3.ts` | 独立只读复核三笔 receipt、提案 action/state、DC 余额、V1/V2 规则、route 和 Factory controller |
| `deployments/ccip-v2-mainnet-stage3-fee.json` | 精确 `1000 DC` fee funding 交易及供应量增量记录 |
| `deployments/ccip-v2-mainnet-stage3.json` | 提案 `#13` 的描述、两条规则、完整 calldata、交易和创建后验证结果 |

## 与现有 DAO 的兼容性

DAO 外层调用方式不变：

```solidity
broadcast(uint32[] targetChainIds, address[] targets, bytes data, uint128 lzGas)
```

- selector 仍为 `0xfd9c0ab9`；
- 跨链 payload 仍为 `abi.encode(nonce, target, data)`；
- BSC 业务目标的 `nestedOnly` 策略无需改变；
- 因 Broadcaster 合约地址会变，Registry 仍需要一次 Major 策略提案，先开新地址，验证成功后再关旧地址。

CCIP 路径只发消息，不传任何 token。手续费使用原生 ETH，默认目标 gas 为 `500,000`。`allowOutOfOrderExecution=true` 与现有 LayerZero OApp 的 unordered 设计一致，每个 DAO 动作不应依赖前一条跨链消息的到达顺序。

## 安全不变量

1. Broadcaster 只接受现有 DealGovernance proxy 调用。
2. LayerZero 必须同时匹配 endpoint、source EID 和 peer Broadcaster。
3. CCIP 必须同时匹配 Router、Ethereum chain selector 和精确 Broadcaster 地址。
4. CCIP 若夹带任何 token，Executor 直接 revert。
5. Axelar 必须通过 Gateway `validateContractCall`，并精确匹配 source chain/address。
6. 每条桥对每个 `msgHash` 只能确认一次，同一条桥重放不能充当第二票。
7. 达到 `2-of-3` 后进入同一消息的执行锁；只有业务目标调用真实成功后才写入 `executed=true`，因此失败不会永久消费已经获得两桥授权的动作。
8. 已达阈值但目标尚未白名单或目标临时 revert 时，任何地址只能对链上保存的**原始已授权 payload**调用 `retryExecution(msgHash)`；不能替换 target 或 calldata。同一消息的执行期重入会被拒绝。
9. 第三条桥晚到时会补记为已确认，但不会重复执行业务。这修正了 V1 中执行后第三桥只能 revert、无法观测最终健康状态的问题。
10. Executor 只能调用 `allowedTargets` 白名单。
11. Broadcaster 限制最多 32 条目标链，阻止配置无界数组导致永久 gas DoS。
12. 费用退回只退当次多余资金，不会把合约中原有 ETH 当作 excess 转出。

## 审计发现与修复

本轮人工审计发现并修复了 1 个中等风险可用性问题：本轮尚未部署的 V2 初稿无论目标是否在白名单、目标调用是否成功，都会把消息永久标记为已执行。结果是一次配置顺序错误或目标临时 revert 就可能永久损失一笔已获 2-of-3 授权的治理动作。该问题从未进入线上 V1。

修复后：

- `executed` 只代表目标调用真实成功；
- 失败原因和尝试次数可观测；
- 达阈值前不能 retry，成功后不能 retry；
- retry 是 permissionless，但只能重放链上已由两座桥确认的精确 payload；
- 同一消息重入 retry 被执行锁阻断；
- 第三桥晚到不会触发第二次成功执行。

## 2026-07-22 只读主网预检

执行：

```bash
node --import tsx/esm scripts/prepare-mainnet-ccip-migration.ts
```

快照结果：

| 项目 | 结果 |
|---|---|
| ETH snapshot block | `25587553` |
| BSC snapshot block | `111455496` |
| 旧 Broadcaster owner | `0xE88c63D29ECE76E3336B0Db747E10876c3bf9893` |
| 旧 Broadcaster governance | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| 旧 Executor owner | `0xE88c63D29ECE76E3336B0Db747E10876c3bf9893` |
| 旧 Executor threshold | `2` |
| BSC Factory crossChainGovernance | 旧 Executor `0x46839754B2dF96E887e41E688880be6aa0A9bF98` |
| ETH CCIP Router | `0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D` |
| BSC CCIP Router | `0x34B03Cb9086d7D758AC55af71584F81A598759FE` |
| ETH selector | `5009297550715157269` |
| BSC selector | `11344663589394136015` |
| ETH Router 支持 BSC | `true` |
| BSC Router 支持 ETH | `true` |
| CCIP 实时样例报价 | `286136579498405 wei` |
| LayerZero 实时样例报价 | `40841558286156 wei` |
| 三桥样例总费用（含 Axelar 预付） | `1326978137784561 wei` |
| DAO proxy ETH 余额 | `4907347014149212 wei` |
| Broadcaster runtime | `11,691 bytes` |
| Executor runtime | `8,788 bytes` |
| 阻断项 | `0` |

费用是快照，不是保证值。当前 DAO 余额高于样例三桥费用，但创建 canary 提案前仍必须重新 `quoteFees` 并在 `0.01 ETH` 策略上限内留出合理缓冲；执行时费用上涨超过固定 action value 会使动作 revert，不会静默降级成少发一座桥。

脚本基于两条链 deployer 的 pending nonce 预测地址。阶段 1 部署前再次确认 ETH nonce `131`、BSC nonce `94`，最终 CREATE 地址与预测完全一致。

Chainlink 官方目录：

- Ethereum: <https://docs.chain.link/ccip/directory/mainnet/chain/mainnet>
- BNB Chain: <https://docs.chain.link/ccip/directory/mainnet/chain/bsc-mainnet>

## 2026-07-22 主网阶段 1 部署结果

| 链 | 合约 | 地址 | 部署交易 | 区块 | receipt |
|---|---|---|---|---:|---|
| Ethereum | `CrossChainBroadcasterV2` | `0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6` | [Etherscan](https://etherscan.io/tx/0x2b585c5358ed4b94319f003bcebbe34108289319493488f7610dc8fce04faaa1) | `25587290` | success |
| BSC | `DualBridgeExecutorV2` | `0x407381d841DD48bBBd40Bd37f9dB268CE75950A8` | [BscScan](https://bscscan.com/tx/0x2772a388400b893b2ea64684868b14fe82ed12e74eafef9d013ab80acd4e6f20) | `111448525` | success |

部署后独立回读：

- 两笔交易均为合约创建，`from=0xE88c...9893`，nonce 分别为 `131` 和 `94`；
- ETH runtime `11,691 bytes`，BSC runtime `8,788 bytes`，与已审计 artifact 在 immutable 位置之外完全一致；
- Broadcaster owner 为部署者、governance 为 DAO proxy，`broadcastNonce=0`、`getChainIds()=[]`；
- Executor owner 为部署者、threshold=`2`，CCIP/Axelar source 均精确指向新 Broadcaster；
- Executor 的 ETH LZ peer 仍为 `bytes32(0)`，BSC Factory allowlist 为 `false`；
- BSC Factory `crossChainGovernance` 仍是 V1 Executor `0x4683...bF98`；
- 新 Broadcaster 的 Parameter/Major `broadcast` 规则均为关闭；V1 两条规则保持开启且未变化。

因此“合约已存在”不等于“跨链路径已经启用”。当前 V2 无法被 DAO 调用，也无法在 BSC 执行业务目标。

## 2026-07-22 主网阶段 2 接线结果

| 顺序 | 链 | 动作 | 交易 | 区块 | receipt |
|---:|---|---|---|---:|---|
| 1 | BSC | Executor 设置 ETH LayerZero peer | [BscScan](https://bscscan.com/tx/0xcd11fabd2e6dbdd02822201224fc2933b9c3656e4810f50d782c54260b399bc7) | `111454945` | success |
| 2 | BSC | Executor 只 allow BSC DealFactory | [BscScan](https://bscscan.com/tx/0x96e5778c9d985c89cb39eeb3afa874b8541b9165640bbcdcb4356e71c0f4c23b) | `111454955` | success |
| 3 | Ethereum | Broadcaster 设置 BSC LayerZero peer | [Etherscan](https://etherscan.io/tx/0x0a944b103eefa15ff29f5e27ec92d2becf5327b3f43724bdf0e2b56b97efe142) | `25587534` | success |
| 4 | Ethereum | 添加 BSC 三桥 config，`active=false` | [Etherscan](https://etherscan.io/tx/0x0fc15290141e3729b396bb20ce446c611461be2915e783109d7c93ca97db3dc7) | `25587538` | success |

最终只读结果：

- Broadcaster → BSC peer 精确指向新 Executor；Executor → ETH peer 精确指向新 Broadcaster；
- CCIP selector、receiver、Axelar chain/address、预付费和 LayerZero EID 全部与计划一致；
- BSC chain config 只有一条，`chainId=30102` 且 `active=false`；
- inactive 状态下 `quoteFees` 按设计 revert，证明当前不能广播；
- Executor 只新增 BSC DealFactory allowlist，threshold 仍为 `2`；
- BSC Factory controller 仍为 V1 Executor；
- 新 Broadcaster 的 Parameter/Major 规则仍关闭，V1 两条规则保持开启；
- 最新只读预检：阻断项 `0`。

## 2026-07-22 主网阶段 3 提案结果

阶段 3 已在主网精确完成 fee funding、approve 和 Major 提案创建：

| 顺序 | 动作 | 交易 | 区块 | receipt |
|---:|---|---|---:|---|
| 1 | 向提案账户精确 mint `1000 DC` | [Etherscan](https://etherscan.io/tx/0xe77458c685ad2594fa241645b28534da834dd305c7c9bdf549b80acd2fe25b3a) | `25587806` | success |
| 2 | 向 DAO 精确 approve `1000 DC` | [Etherscan](https://etherscan.io/tx/0x06829e918275a742bd88821e5e5475abbc2e69160565c99399014a8856122577) | `25587812` | success |
| 3 | 创建阶段 3 Major 提案 `#13` | [Etherscan](https://etherscan.io/tx/0xe14556cfafdd94433ce17c9cea292baa953652c17eb3dab0ff5201ffe607c2bf) | `25587813` | success |

| 项目 | 结果 |
|---|---|
| 当前 `proposalCount` | `13` |
| proposalId | `13` |
| Proposal kind | `Major (2)` |
| Proposal state | `Pending` |
| `totalStaked` / `windowEndsAt` | `0 / 0` |
| `executed` | `false` |
| Action target | `GovernancePolicyRegistry` `0xBFF0...2382` |
| Action value | `0` |
| Registry action | 一次 `setRules`，仅含 Parameter/Major 两条规则 |
| 新 Broadcaster | `0xCF4D...d1e6` |
| selector | `0xfd9c0ab9` |
| 每条复制值 | `allowed=true`、`validateNestedBroadcast=true`、`nestedOnly=false`、`maxValue=0.01 ETH` |
| V1 规则 | 保留，不关闭 |
| BSC route | `active=false` |
| BSC Factory controller | 仍为 V1 Executor `0x4683...bF98` |
| Major fee | `1000 DC` |
| 提案账户创建后 DC / allowance | `0 DC / 0 DC`，精确费用已转入 Treasury |
| DC 总供应量增量 | 仅本次授权的 `1000 DC` |

提案描述明确写明：仅为新 Broadcaster 复制现有 DAO 权限，保留 V1；不激活 BSC route、不切换 BSC Factory、不发送跨链消息、不关闭 V1，目的只是为后续零业务变化 canary 做准备，立即业务影响为零。

独立只读复核确认三笔 receipt、from/to/nonce、提案完整 calldata 和链上 action 全部匹配。创建提案不等于执行 Registry：当前 V2 两条规则仍关闭、V1 两条规则保持开启、BSC route 仍为 inactive、BSC Factory 仍由 V1 Executor 控制。

本次授权已经用完。下一步 stake 需要再次明确授权；stake 授权不自动包含等待提案通过、执行 Registry、激活 V2 route 或切换 BSC Factory。

创建后的治理参数只读回读：激活门槛为 `2.5 D`，fast-pass 门槛为 `70 D`，Major 默认否决窗口为 `432000` 秒（5 天）。提案账户 `0xE88c...9893` 当前 D 余额和对 DAO allowance 均为 `0`，因此后续 stake 还需要确定实际持有 D 且可签名的账户；本轮没有 mint、转移或 approve D。

## 建议的主网迁移顺序

### 阶段 1：部署但不切换

已于 2026-07-22 完成：

1. 已部署 ETH `CrossChainBroadcasterV2`。
2. 已部署 BSC `DualBridgeExecutorV2`。
3. 已核验 receipt、runtime bytecode、constructor immutable、owner、governance 和未接线状态。

此阶段旧系统仍是唯一正式路径，不受影响。

### 阶段 2：接线但保持暂停

已于 2026-07-22 完成：

1. 已双向设置 LayerZero peer。
2. Broadcaster 已注册 BSC config，且 `active=false`。
3. Executor 只 allow BSC DealFactory。
4. 已逐字段回读，并确认 Router lane、inactive quote、DAO 策略和 V1 controller 状态。

### 阶段 3：DAO 先开新路径，不关旧路径

已完成。Major 策略提案 `#13` 已执行，把旧 Broadcaster 的 Parameter/Major 两条精确规则复制到新 Broadcaster；实时只读结果为 `state=Executed (6)`、`executed=true`。V1 两条规则仍保留。

### 阶段 4：可回滚切换与零业务变化 canary

1. **已完成：** owner 激活 V2 BSC route。
2. **已完成：** BSC Factory owner 把 `crossChainGovernance` 从旧 Executor 改为新 Executor。
3. **已创建、待单独授权 stake：** Major 提案 `#14` 通过 DAO 对 BSC Factory 调用 `setDealImplementation(当前值)`。创建时和当前值均为 `0x591625...608D`，所以这笔 canary 只验证 Major 权限、三桥发送、2-of-3 聚合和执行，不改变实现地址，也不是 proxy 升级。
4. **待 canary 执行后核验：** 检查 LZ / CCIP / Axelar 三条状态、`confirmStatus`、BSC receipt 和 `CrossChainExecuted(success=true)`。

canary 失败时的回滚：

1. 立即暂停 V2 BSC route。
2. BSC Factory owner 把 `crossChainGovernance` 改回旧 Executor。
3. 保留 V1 DAO 策略，恢复旧 2-of-3 路径。

### 阶段 5：验证成功后退出 V1

再创建一个 Major 策略提案，把旧 Broadcaster 的 Parameter/Major `broadcast` 规则设为 `allowed=false`。旧合约不删除，只从 DAO 可执行策略中退出，便于事后追溯。

## 测试与静态检查

已完成：

- Hardhat 全量回归：`196 passing`；
- CCIP 定向测试：`5 passing`；
- ETH/BSC 主网 fork：`4 passing`；ETH 发送端真实调用正式 LayerZero Endpoint、CCIP Router、Axelar Gateway/Gas Service，BSC 接收端按正式 Router/Endpoint 身份完成 2-of-3，并使用已部署主网地址完整演练阶段 2 四个动作和阶段 3 精确 Major 提案，始终保持 inactive；
- 覆盖 LZ+CCIP、Axelar+CCIP 两种达阈值组合、第三桥晚到、同桥重放、伪造 LZ endpoint/peer、伪造 CCIP router/chain/sender、异常 sender 编码、CCIP 夹带 token、Axelar validation/source、未授权发送、无效 chain config、三桥 payload 一致、失败可重试、同消息重入、超额退款、原有 ETH 隔离，以及新 Broadcaster 地址的 DAO 嵌套策略；
- Slither 97-detector 全扫描并人工复核结构性提示；排除协议必需的外部桥调用、低级 DAO target call、有限链循环和相应事件顺序提示后，两个生产合约的其余 detector 均为 `0 findings`。

Slither 的两类预期结构性告警已单独复核：

- Broadcaster 必须在目标链循环内调用各桥；合约已设 `MAX_CHAINS=32`，且 chain config 只能 owner 管理。
- Executor 必须使用 low-level `target.call(data)` 执行 DAO calldata；同消息执行锁在外部调用前写入，成功后才写入 `executed=true`，并受 2-of-3 与目标白名单限制。专门的重入目标测试证明重复执行被阻断。

主网 fork 使用的 BSC 公共节点必须支持按区块读取状态；不具备历史状态的节点会返回 `missing trie node`，这是 RPC 能力问题，不是合约执行失败。本轮最终 fork 使用可按区块读取状态的 BSC endpoint，两条 fork 用例均通过。

仓库全局 `tsc --noEmit` 仍有大量既有 Hardhat 3 类型声明错误；本次新增只读脚本已在 Node 22 下真实执行成功，该基线问题不是 CCIP 逻辑回归。

## 可用性判定与剩余风险

当前代码可以进入受控部署和 canary，但必须同时满足：

1. 部署前重跑只读预检，pending nonce、owner、DAO、Registry、旧桥控制权和 CCIP lane 任一变化都中止。
2. 两个新合约部署后先保持 BSC route `active=false`，逐字段回读 bytecode、immutable、peer、source、threshold=`2`、allowlist 和 chain config。
3. 旧 V1 路径与旧 DAO 策略必须保留到新路径 canary 成功，失败即可暂停 V2 并把 BSC Factory 切回 V1 Executor。
4. V2 owner 仍是部署 EOA，可修改 peer/source/threshold/allowlist；这是现有架构中的管理信任，不是无管理员系统。所有配置交易必须逐笔核对并留存 receipt。
5. 本结果是项目内工程审计，不宣称代替独立第三方审计、形式化验证或真实跨链主网 canary。

## 2026-07-23 主网阶段 4A 切换结果

写入前完成双链实时只读核验和两笔交易模拟：

- Ethereum / BSC RPC chain id 分别为 `1 / 56`；
- 双链签名地址均为预期 owner `0xE88c...9893`，且没有 pending nonce；
- 提案 `#13` 为 `Executed (6)`；
- V2 Parameter/Major 规则精确启用，V1 两条规则保持启用；
- V2 peer、CCIP source、Axelar source、threshold=`2`、Factory allowlist 均与阶段 2 记录一致；
- 切换前 route 为 `false`，Factory controller 为 V1 Executor；
- `setChainActive(30102,true)` 和 `setCrossChainGovernance(V2 Executor)` 均模拟成功。

| 顺序 | 链 | 动作 | 交易 | 区块 | receipt |
|---:|---|---|---|---:|---|
| 1 | Ethereum | 激活 V2 BSC route | [Etherscan](https://etherscan.io/tx/0x020ef03d649ce97b8e0097458c0a8de3ba6dc8136df26618b7970734a2d118f0) | `25593491` | success |
| 2 | BSC | Factory controller 从 V1 Executor 切换到 V2 Executor | [BscScan](https://bscscan.com/tx/0x44252f8a4715085abd665893277804111011ff3e98e810a2d75316dc97e7bc62) | `111614755` | success |

独立复核确认两笔交易的 `from`、`to`、nonce、value=`0` 和完整 calldata 均与计划完全一致，receipt 均为 `success`。最终链上状态：

- V2 BSC route：`active=true`；
- BSC Factory controller：V2 Executor `0x407381d841DD48bBBd40Bd37f9dB268CE75950A8`；
- BSC `minWindowSec`：仍为 `1800`，业务参数未改变；
- V2 `broadcastNonce`：`0`，尚未广播；
- 实时 canary 报价：`1324779048966630 wei`（约 `0.00132477904896663 ETH`），低于 DAO action 的 `0.01 ETH` 上限；
- 本阶段没有创建提案、stake、执行 DAO action、发送跨链消息或关闭 V1。

阶段 4A 的可恢复记录为 `deployments/ccip-v2-mainnet-stage4-cutover.json`。

## 2026-07-23 主网阶段 4B Major canary 提案结果

原计划的 `setMinWindowSec(1800)` 只具备 Parameter 嵌套策略，不能伪装成 Major；改用生产策略中已存在的 Major 嵌套动作 `setDealImplementation(address)`，参数精确写回 BSC Factory 当前同一实现地址，达到零业务变化测试目的，未新增或扩大任何 Registry 权限。

写入前核验：

- BSC Factory 当前 `dealImplementation=0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D`；
- V2 Broadcaster Major 外层规则和 BSC Factory `setDealImplementation(address)` Major 嵌套规则均精确启用；
- 完整 Major action 的 `isActionAllowed=true`；
- route 为 active，Factory controller 为 V2 Executor，`broadcastNonce=0`；
- 实时三桥报价为 `1324779048966630 wei`，action 最大预算为 `0.002 ETH`，未使用部分由 Broadcaster 退回 DAO；
- DAO ETH 余额高于 action 最大预算；
- 提案账户初始 DC 和 allowance 均为 `0`，Major fee 为 `1000 DC`。

| 顺序 | 动作 | 交易 | 区块 | receipt |
|---:|---|---|---:|---|
| 1 | 向提案账户精确 mint `1000 DC` | [Etherscan](https://etherscan.io/tx/0xcc487351ed3f870da5c7c9bac8a70997b612c816cbafbe0db46a5dbc4f8b5ffb) | `25593565` | success |
| 2 | 向 DAO 精确 approve `1000 DC` | [Etherscan](https://etherscan.io/tx/0x28dc749fec2c4ef6618be5b170b6225e06c3e65bf95282ff7da48424e957d28d) | `25593567` | success |
| 3 | 创建 Major 零变化 canary 提案 `#14` | [Etherscan](https://etherscan.io/tx/0x81868a6e4b13e91ca2ead4377dff4588bde6aa48da5f1ccbd1c3f9ae16ddd497) | `25593571` | success |

链上提案描述以 `TEST ONLY` 开头，并明确列出测试目的和零影响边界：只验证 LayerZero、Chainlink CCIP、Axelar、2-of-3 聚合、Major 嵌套策略、来源/目标授权与 BSC 单次执行；不改变实现地址、不执行 proxy upgrade、不转币、不由提案 action mint、不移动 Treasury、不改业务参数、不关闭 V1，也不调用其他目标。

独立复核结果：

- `proposalCount=14`，提案 `#14` 为 `Pending (1)`、`Major (2)`；
- `totalStaked=0`、`windowEndsAt=0`、`executed=false`；
- 唯一 action target 为 V2 Broadcaster，value 为 `0.002 ETH`；
- inner target 只有 BSC Factory，inner calldata 为当前同值 `setDealImplementation(0x591625...608D)`；
- BSC 实现地址创建前后相同；
- `1000 DC` 创建费已精确进入 Treasury，提案账户 DC 和 allowance 均回到 `0`；
- DC 总供应量只增加本次明确授权的 `1000 DC`；
- route 仍 active、Factory controller 仍为 V2 Executor、`broadcastNonce` 仍为 `0`；
- 没有 stake、execute 或 broadcast。

阶段 4B 的可恢复记录为 `deployments/ccip-v2-mainnet-stage4-canary-proposal.json`。

## 尚未完成且需要再次明确授权的事项

1. 对 canary 提案 `#14` stake；stake 不自动包含执行。
2. 提案通过后执行 canary，并持续核验三桥、2-of-3 聚合和 BSC receipt。
3. canary 成功后，另行决定是否创建关闭 V1 DAO 策略的 Major 提案。

当前主网停留在“V2 已切换、V1 仍保留、Major canary #14 已创建但未 stake/执行”的状态。
