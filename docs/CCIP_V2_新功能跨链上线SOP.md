# CCIP V2 新功能跨链上线 SOP

更新时间：2026-07-23

## 1. 当前结论

ETH DAO → BSC 的跨链 V2 底座已经完成生产 canary：

- ETH `CrossChainBroadcasterV2`：
  `0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6`
- BSC `DualBridgeExecutorV2`：
  `0x407381d841DD48bBBd40Bd37f9dB268CE75950A8`
- 当前活跃副链：BSC，chain key `30102`
- 执行阈值：LayerZero、Chainlink CCIP、Axelar 任意 `2-of-3`
- 提案 `#15` 已执行，三桥最终 `3/3` 确认，BSC 只执行一次

本 SOP 解决的是后续重复需求：

> 一个已经开发和审计完成的新功能，如何安全地在 ETH 与 BSC 接入，并由 ETH DAO 统一治理。

## 2. 新增工具

### 2.1 新功能 manifest

示例：

```text
config/cross-chain-v2-existing-canary.json
```

字段：

| 字段 | 含义 |
| --- | --- |
| `featureId` | 本次功能的稳定标识 |
| `proposalKind` | `0 = Parameter`，`2 = Major` |
| `title` | 前端展示的第一行短标题，最多 32 个字符 |
| `body` | 详细说明意义、实际行为和不影响的范围 |
| `localActions` | ETH 本地直接执行的 actions |
| `broadcasts` | 经 V2 Broadcaster 发往所有活跃副链的 actions |
| `calldata` | 已审计目标方法的完整 calldata |
| `lzGas` | LayerZero 目标执行 gas，当前通常使用 `500000` |
| `feeBudgetWei` | DAO 执行时给 Broadcaster 的最大原生币预算 |

示例 manifest 复现的是已经执行过的零变化 canary，仅用于测试工具，**不得重新创建提案**。

### 2.2 只读规划器

```bash
node --import tsx/esm scripts/prepare-cross-chain-v2-feature.ts \
  --config config/cross-chain-v2-existing-canary.json
```

可选写出机器可读规划文件：

```bash
node --import tsx/esm scripts/prepare-cross-chain-v2-feature.ts \
  --config config/your-feature.json \
  --out deployments/your-feature-plan.json
```

规划器：

- 不读取私钥；
- 没有 wallet client；
- 没有发送交易分支；
- 不部署、不 mint、不 approve、不建提案、不 stake、不 execute；
- 实时检查 ETH/BSC chain ID 和区块；
- 检查 V2 Broadcaster、Executor、DAO、Registry 接线；
- 检查所有活跃副链是否都在每个 broadcast 中出现且只出现一次；
- 检查 BSC target 是否有 runtime code；
- 检查 BSC Executor allowlist；
- 检查 DAO direct/nested policy；
- 实时报价三桥费用并与 `feeBudgetWei` 比较；
- 生成精确 `broadcast(...)` 和 `createProposal(...)` calldata；
- 列出缺失的 allowlist calldata 和 Registry `setRules(...)` calldata；
- 只有所有阻断项为空时才返回 `readyToCreateProposal = true`。

### 2.3 消息监控器

监控已经执行的 canary：

```bash
node --import tsx/esm scripts/monitor-cross-chain-v2-message.ts \
  --record deployments/ccip-v2-mainnet-stage4-canary-execution.json \
  --require-executed
```

监控任意消息：

```bash
node --import tsx/esm scripts/monitor-cross-chain-v2-message.ts \
  --message-hash 0x...
```

也可以根据真实执行后的 nonce、target、calldata 重新计算并交叉核对：

```bash
node --import tsx/esm scripts/monitor-cross-chain-v2-message.ts \
  --nonce 2 \
  --target 0x... \
  --calldata 0x... \
  --message-hash 0x...
```

输出：

- LayerZero 是否确认；
- Chainlink CCIP 是否确认；
- Axelar 是否确认；
- 当前确认数；
- 是否达到 Executor 阈值；
- 是否执行成功；
- 实际执行尝试次数；
- `healthy` 总判定。

## 3. 每个真实新功能的完整流程

### 阶段 A：开发、审计、部署目标模块

1. 明确 ETH 与 BSC 是否使用相同接口和 calldata。
2. 完成单元测试、攻击面测试、权限检查和存储布局检查。
3. 在 ETH/BSC 部署实现或 proxy。
4. 只读核验 runtime、owner/controller、initializer 和 UUPS slot。

本阶段不得顺带创建 DAO 提案。

### 阶段 B：生成 manifest 并只读预检

1. 写短标题和详细正文。
2. 写入 ETH local actions。
3. 写入 BSC remote target 和 calldata。
4. 运行规划器。
5. 保存 `blockers`、实时 quote、actions 和完整提案 calldata。

如果 `blockers` 不为空，不得创建功能提案。

### 阶段 C：补 BSC allowlist

若规划器返回：

```text
requiredSetup.bscAllowlist
```

由当前 BSC Executor owner 精确调用：

```solidity
setAllowedTarget(target, true)
```

部署授权与 allowlist 授权必须分开确认。交易后重新运行规划器。

### 阶段 D：先开策略

若规划器返回：

```text
requiredSetup.registryRules
requiredSetup.registrySetRulesCalldata
```

先单独创建一个 Major 策略提案，只调用 Registry `setRules(...)`。

- ETH 本地方法：`nestedOnly = false`
- BSC 远程方法：`nestedOnly = true`
- 远程 action 不携带原生币，`maxValue = 0`
- Broadcaster 外层规则继续使用嵌套验证

新 target 默认没有策略，因此“开策略”和“调用新功能”不能放进同一个提案。

策略提案的创建、stake 和 execute 是三个独立授权阶段。

### 阶段 E：创建功能提案

策略执行后再次运行规划器，必须满足：

```text
readyToCreateProposal = true
blockers = []
```

再使用规划器生成的：

```text
proposal.createProposalCalldata
```

创建功能提案。

创建授权不自动包括：

- mint/approve 以外的资产操作；
- stake；
- 等待通过；
- execute；
- 重试远程执行；
- 关闭 V1 回滚策略。

### 阶段 F：通过、执行和监控

1. 单独授权 stake。
2. 提案达到 Succeeded 后单独授权 execute。
3. 从 ETH `Broadcast` 事件取得真实 nonce。
4. 计算实际 message hash。
5. 运行消息监控器直到达到 `2-of-3` 并执行。
6. 第三桥晚到后应变为 `3/3`，但业务调用仍只能成功一次。
7. 最后读取目标合约的业务状态，不只看桥的 `executed` 标志。

## 4. 重要限制

### 4.1 每次 broadcast 必须覆盖所有活跃链

当前 V2 Broadcaster 会遍历全部 `active=true` 的链，并要求 target 数量与活跃链数量完全一致。

当前只有 BSC，所以每个 broadcast 必须且只能包含：

```text
chain key = 30102
```

以后增加 C/D 链后，每个 broadcast 必须同时给出 BSC/C/D 的 target。

### 4.2 一个 broadcast 的所有链使用同一份 calldata

如果不同链需要调用不同方法或参数，必须拆成多个设计一致、可独立审计的 action，不能假设一个 broadcast 可以为不同链携带不同 calldata。

### 4.3 规划阶段的 message hash 只是预测

message hash 包含 Broadcaster 的实际 nonce。如果提案创建后、执行前有其他 broadcast，预测 nonce 会变化。

必须以执行交易发出的真实 `Broadcast(nonce, ...)` 事件为准重新计算，不能只使用规划器的预测值。

### 4.4 `eth_call` 不消耗用户钱包 Gas，但有 RPC 计算限制

规划器和监控器都是只读调用。它们不会让钱包支付 Gas，但 RPC 节点仍会限制请求频率和单次计算量。

## 5. 本次工具验收

2026-07-23 使用已执行的提案 `#15` 配置进行只读回放：

- ETH block：`25594701`
- BSC block：`111647085`
- 活跃链：`[30102]`
- V2 Executor 阈值：`2`
- 当前 broadcast nonce：`1`
- 当前 DAO proposalCount：`15`
- 实时三桥 quote：`1326328872769999 wei`
- manifest 费用预算：`2000000000000000 wei`
- allowlist 阻断项：`0`
- Registry 策略阻断项：`0`
- 总阻断项：`0`
- `readyToCreateProposal = true`

消息监控在 BSC block `111647131` 的结果：

- LayerZero：确认
- Chainlink CCIP：确认
- Axelar：确认
- 确认数：`3`
- executed：`true`
- executionAttempts：`1`
- healthy：`true`

该回放没有签名或发送任何交易。

## 6. 下一次开始真实功能前需要确定的内容

必须先确定：

1. 第一个真实功能的合约和业务行为；
2. ETH/BSC 是否都部署；
3. controller/owner 应当分别是谁；
4. 需要开放的精确 selector；
5. 是 Parameter 还是 Major；
6. 执行是否携带 ETH；
7. 成功后的可读验收状态；
8. 失败后的暂停、重试或回滚方式。

在这些业务内容确定前，不应创建空白生产提案。
