# CCIP V2 无业务 UUPS 升级演练

## 目标

用一对完全独立、无资产、无业务依赖的 `GovernanceProbe` proxy，验证当前生产跨链 V2 能否完成：

1. ETH DAO 在同一个 Major 提案中直接升级 ETH Probe；
2. `CrossChainBroadcasterV2` 把同一类升级动作发送到 BSC；
3. BSC `DualBridgeExecutorV2` 在 LayerZero、Chainlink CCIP、Axelar 任意两路确认后，只执行一次 UUPS 升级；
4. 升级前后的 controller、marker、updateCount 不丢失。

本演练不调用代币、国库、中本聪账户、分红、DealFactory 或其他业务合约。

## Probe 行为

V1：`GovernanceProbe`

- 保存 `controller`、`marker`、`updateCount`；
- 只有 controller 可以写 marker 或升级；
- 不接收或转移 ERC20；
- 不包含对业务合约的外部调用；
- `version()` 返回 `1`。

V2：`GovernanceProbeUpgradeMock`

- 继承 V1 的完整存储布局；
- 只把 `version()` 改为 `2`；
- 只新增只读函数 `upgradedFeatureAvailable()`；
- 不新增资产或业务操作。

## 已完成验证

### 本地端到端

执行：

```bash
node node_modules/hardhat/dist/src/cli.js test \
  test/GovernanceProbe.ts \
  test/CrossChainNewFeatureUpgradeFlow.ts \
  test/CCIPBridgeMigration.ts \
  test/CrossChainV2FeatureTooling.ts \
  test/CrossChainV2UpgradeProbe.ts \
  --network hardhatMainnet
```

结果：`12 passing`。

覆盖：

- implementation 初始化锁；
- 非 controller 写入和升级失败；
- DAO Registry 精确区分 ETH direct 与 BSC nested-only；
- ETH 与 BSC 升级 calldata 都是 `upgradeToAndCall(address,bytes)`；
- BSC 任意两桥达到阈值才升级；
- 第三桥迟到不会重复执行；
- 错误 CCIP 来源被拒绝；
- 相同桥重放被拒绝；
- `executionAttempts == 1`；
- V1 到 V2 的状态和 controller 保留。

### ETH mainnet fork

- fork block：`25594743`
- 使用当前生产：
  - DAO：`0x9a41a9A85C16F590789C846Fb933fF8C715407F7`
  - Registry：`0xBFF01F91291476e671f0F310846D5dDb460e2382`
  - Broadcaster V2：`0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6`
- 结果：`1 passing`
- 验证当前 Major broadcaster 规则可承载该 nested upgrade；
- 验证实时三桥 quote 小于 `0.002 ETH`；
- 验证 DAO controller 下 UUPS 升级后状态不丢失。

### BSC mainnet fork

- fork block：`111649376`
- 使用当前生产 Executor V2：
  - `0x407381d841DD48bBBd40Bd37f9dB268CE75950A8`
- 结果：`1 passing`
- 直接读取当前生产 threshold、peer、CCIP source；
- 在 fork 中新部署 BSC Probe；
- 模拟真实 LayerZero endpoint 和 CCIP router 两路确认；
- 第二路确认后升级成功，执行次数为 `1`。

### 静态检查

Slither 0.11.4 分别分析 V1 和 V2：

- High：`0`
- Medium：`0`
- Low：`0`
- Informational：
  - OpenZeppelin `IERC1967.AdminChanged` 参数未 indexed；
  - V1 的 `__gap` 未直接使用，这是升级合约预留存储槽。

两项均不是 Probe 漏洞，不需要修改。

## 生产只读预检

运行：

```bash
node --import tsx/esm scripts/prepare-cross-chain-v2-upgrade-probe.ts
```

脚本没有私钥、签名和写交易分支，只输出：

- 当前 ETH/BSC 区块；
- 当前 DAO、Registry、Broadcaster V2、Executor V2 接线；
- 两条链各三个部署地址预测；
- 精确 policy rules、allowlist calldata；
- 两个 Major 提案的完整 calldata；
- 实时三桥费用；
- blocker 列表。

2026-07-23 本次快照结果：

- `safeToStartDeployment = true`
- `blockers = []`
- Executor threshold：`2`
- BSC route：active
- Broadcaster nonce：`1`
- 实时 quote：`0.001326377501230266 ETH`
- 预留执行 value：`0.002 ETH`

预测地址依赖部署钱包 nonce。任何其他交易都会改变预测地址，真正部署前必须重新运行预检，不能把本文地址当作永久地址。

## 生产步骤与授权边界

以下每一阶段都需要单独确认。

### 阶段 A：只部署

ETH 部署：

1. V1 implementation；
2. ERC1967 proxy，controller = ETH DAO；
3. V2 implementation。

BSC 部署：

1. V1 implementation；
2. ERC1967 proxy，controller = Executor V2；
3. V2 implementation。

此阶段不设策略、不 allowlist、不提案、不 stake、不执行升级。

阶段 A 已于 2026-07-23 完成，共六笔成功交易。

| 链 | 合约 | 地址 | controller / 当前状态 |
| --- | --- | --- | --- |
| ETH | V1 implementation | `0x84CEBcA724a32Cf82739233A79D7b04F116030cc` | implementation |
| ETH | proxy | `0xacD12B3B3067f8D489bC7c5832E85C104fB2A054` | DAO `0x9a41...07F7`，当前 V1 |
| ETH | V2 implementation | `0x7DBF60d7Bfb9Dc3Cd26b8055e94B7601D6DDF0b6` | `version() = 2` |
| BSC | V1 implementation | `0x0b014b826a22b4bea24d2B5643116C75CF82263d` | implementation |
| BSC | proxy | `0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3` | Executor V2 `0x4073...50A8`，当前 V1 |
| BSC | V2 implementation | `0x14D0F49A72038FD745241109c5bA5059FFFbf156` | `version() = 2` |

部署成本：

- ETH 三笔：`0.000295015231626927 ETH`；
- BSC 三笔：`0.0000557934 BNB`。

独立只读复核确认六笔 receipt、CREATE calldata、runtime bytecode、proxy implementation slot 和 controller 全部匹配。

### 阶段 B：只接入测试权限

1. BSC Executor owner 只 allowlist 新 BSC Probe proxy；
2. 创建一个 Major 策略提案，只增加两条规则：
   - ETH Probe `upgradeToAndCall`：direct，`maxValue=0`；
   - BSC Probe `upgradeToAndCall`：nested-only，`maxValue=0`。

策略提案费：`1000 DC`。创建不等于通过，不自动 stake 或执行。

阶段 B 已于 2026-07-24 完成“加入 BSC allowlist + 创建提案”，提案尚未质押或执行。

- 提案 ID：`16`
- 类型：Major
- 标题：`跨链升级功能测试授权`
- 给 leader 展示的正文：

> 这是一次无业务影响的跨链升级测试。本提案只给 ETH 和 BSC 上两个独立测试合约开放升级权限，不涉及代币、国库、分红或任何业务合约；本提案通过后也不会立即升级，真正执行测试还需要另一个提案。

- BSC allowlist：`0xbcad10c6b3ba03fe8ed39cb4b88db71d0e320507148df6d4c5ef063a15c28830`
- 精确 mint 1000 DC：`0x8a828886aafb70f79463bf7ec1f4313cdb162f114792da5b4af6055a0baf19c6`
- 精确 approve 1000 DC：`0x512754e08dc845e3acf4e5607a62e5366a4750185ad730680c400c8d81e6cfdd`
- 创建提案：`0x63e4a17c718da4f398210c76f15b1bfb48353bbdb3bf5e715170539876f7f53e`

独立只读复核确认：

- 四笔 receipt、发送方、目标、nonce、value 和 calldata 全部匹配；
- 提案类型、标题、正文和唯一 action 全部匹配；
- 提案状态为 Pending，`totalStaked = 0`，`executed = false`；
- 两条 Registry 规则仍未生效；
- 两条 Probe proxy 仍指向各自 V1 implementation；
- Broadcaster nonce 仍为 `1`，本阶段没有跨链广播。

链上记录：

- `deployments/cross-chain-v2-upgrade-probe-stage2.json`
- `deployments/cross-chain-v2-upgrade-probe-stage2-verification.json`

### 阶段 C：升级演练提案

策略提案执行并只读复核后，再创建第二个 Major 提案：

1. ETH Probe V1 → V2；
2. Broadcaster V2 向 BSC Probe 广播 V1 → V2；
3. BSC 任意 2/3 桥确认后执行。

升级提案费：`1000 DC`；跨链执行预留：`0.002 ETH`。

创建提案不自动 stake，也不自动执行。

阶段 C 的升级演练提案已于 2026-07-24 创建，尚未质押或执行。

- 提案 ID：`17`
- 类型：Major
- 标题：`跨链升级测试`
- 给 leader 展示的正文：

> 将 ETH 和 BSC 上两个无资产测试合约从 V1 升级到 V2，只验证 DAO 跨链升级流程，不影响任何业务。

- action 1：ETH Probe proxy 直接执行 `upgradeToAndCall(ETH V2 implementation, 0x)`，value 为 `0`；
- action 2：Broadcaster V2 广播 BSC Probe 的 `upgradeToAndCall(BSC V2 implementation, 0x)`，预留 `0.002 ETH`；
- 创建时三桥实时报价：`0.001332626773845132 ETH`，低于预留值；
- 精确 mint 1000 DC：`0x3a84e7b3ff17c9a2f34e1b3faf3d85c1fa22fd1e9dfafce5cfd81dae7a72fb81`；
- 精确 approve 1000 DC：`0xfe34ebe535a9cc256f4d4e58a2f4c9f66e7bf8b2f901e5e6b773acd490749f77`；
- 创建提案：`0x166ad04fb525d28814472b43e493bb03e9f73850509b1ca4de23b6d3ad3cc70f`。

独立只读复核确认三笔交易和两条 action 完全匹配；提案状态为 Pending，`totalStaked = 0`、`executed = false`，两条 Probe proxy 仍是 V1，Broadcaster nonce 仍为 `1`。

链上记录：

- `deployments/cross-chain-v2-upgrade-probe-stage3-proposal.json`
- `deployments/cross-chain-v2-upgrade-probe-stage3-proposal-verification.json`

### 阶段 D：验证

- 两条链 proxy implementation slot 都指向各自 V2 implementation；
- 两条链 `version() == 2`；
- `upgradedFeatureAvailable() == true`；
- controller 不变；
- marker、updateCount 不变；
- BSC `confirmStatus.count >= 2`；
- BSC `executed == true`；
- BSC `executionAttempts == 1`；
- 无代币、国库、分红、Factory 状态变化。

2026-07-24 已执行提案 `#17`：

- ETH 执行交易：`0x8f0b072a869f1d1a7d6330742c0305c135d50cb732796328eb9f78ad3a339a62`；
- receipt：success，调用 `execute(17)`，附带精确 `0.002 ETH`；
- ETH Probe 已升级至 V2，implementation、controller、marker 和 updateCount 复核通过；
- Broadcaster nonce：`1 -> 2`；
- BSC payload hash：`0xdf6b639a74bbbc4ad818da864aca19c8f8734dc40739e770fd17f9964ca24a26`；
- 执行后的即时检查中 LayerZero 先到达 BSC，当时确认数为 `1/3`；
- 执行记录：`deployments/cross-chain-v2-upgrade-probe-stage4-execution.json`。

2026-07-27 再次进行生产只读核验，最终结果已经完整到达：

- LayerZero、Chainlink CCIP、Axelar：`3/3` 全部确认；
- Executor 阈值：`2`；
- `executed = true`；
- `executionAttempts = 1`，没有重复执行；
- ETH Probe 与 BSC Probe 均为 `version() = 2`；
- 两条 proxy implementation slot 均精确指向各自预部署的 V2 implementation；
- 两条链 `upgradedFeatureAvailable() = true`；
- ETH controller 仍为 DAO，BSC controller 仍为 Executor V2；
- 两条链 marker 仍为 `0`，updateCount 仍为 `0`，升级状态完整保留；
- BSC 检查区块：`112372845`，综合判定 `healthy = true`。

因此本次生产 V2 跨链 UUPS 升级演练已经完整走通，而不只是完成了源链广播或 fork 测试。

### 可选清理

测试结束后可另行确认：

- BSC `setAllowedTarget(probe, false)`；
- 通过 Major 策略提案把两条 Probe 规则设为 `allowed=false`。

合约本身会留在链上，但不持有资产，也不会连接业务模块。

## 当前状态

- 代码、测试、静态检查、ETH fork、BSC fork、生产只读预检：已完成；
- ETH/BSC 新 Probe：六个合约已部署并独立只读复核；
- 两条 Probe proxy 当前均已是 V2；
- BSC allowlist：仅新增 BSC Probe，已完成并复核；
- DAO Major 策略提案：`#16` 已质押 `70 D` 并执行成功；
- ETH/BSC `upgradeToAndCall` 策略：已按 direct / nested-only 精确开启；
- DAO 升级演练提案：`#17` 已质押 `70 D` 并执行成功；
- 阶段 B、C 各为提案费精确 mint/approve `1000 DC`，提案创建后钱包余额和 allowance 均回到 `0`；
- ETH Probe 与 BSC Probe 均已是 V2，Broadcaster nonce 为 `2`；
- BSC 三桥确认 `3/3`、`executed = true`、`executionAttempts = 1`，跨链升级链路健康；
- 未提交、未推送 Git。
