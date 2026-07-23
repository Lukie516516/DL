# DAO V2 续作交接

> 历史准备文档：DAO V2、SatoshiVault、DealDividendVault 和首轮分红现已完成。当前生产状态与前端接入请使用 `docs/ETH_DAO_V2_国库中本聪分红前端交接.md`。

## 1. 工作区

- 仓库：`/Users/a1234/Desktop/Solidity_code/deal完整 2/deal完整 2`
- 当前分支：`feat/deal-result-index-v2`
- 当前阶段：只做代码、测试、升级预演和文档。
- 禁止事项：未经用户明确确认，不部署主网、不提交、不推送。
- 工作区原本存在其他未提交修改，不得回滚或覆盖无关改动。

## 2. 业务目标

将 ETH 主网现有 `DealGovernance` UUPS proxy 升级到 DAO V2，在保留全部历史状态的前提下，为不同提案类型增加严格的动作权限边界。

现有 ETH 治理 proxy：

`0x9a41a9A85C16F590789C846Fb933fF8C715407F7`

治理规则保持不变：

| 提案类型 | 规则 |
| --- | --- |
| Parameter | 2.5 D 激活，默认窗口或 70 D 快速通过 |
| Treasury | 70 D 通过 |
| Major | 默认 120 小时窗口或 70 D 快速通过 |
| Satoshi | 90 D 永久通过，达到阈值后即使取回 D 也不失效 |

DAO V2 动作范围：

| 提案类型 | 允许动作 |
| --- | --- |
| Parameter | 普通参数 setter、经过批准的跨链参数广播 |
| Treasury | 国库拨款、做市拨款、分红资金动作 |
| Satoshi | 仅调用后续 SatoshiVault 的指定地址付款动作 |
| Major | UUPS 升级、权限变更、注册表和策略变更 |

跨链广播不能只检查外层 `CrossChainBroadcaster.broadcast()`，必须同时校验每一个远端目标地址及内部函数 selector。

## 3. 已完成代码

### `contracts/GovernancePolicyRegistry.sol`

- 按 `proposal kind + target + selector` 保存动作规则。
- 每条规则包含：是否允许、是否校验嵌套广播、最大原生币 value。
- 只有治理 proxy 可以修改规则。
- 对跨链广播逐个检查远端 target 和内部 selector。

### `contracts/DealGovernance.sol`

- 在旧存储变量之后追加 `policyRegistry`。
- 创建提案时校验动作。
- 执行提案时再次校验，防止策略变化后旧提案绕过新规则。
- 要求 `msg.value` 精确等于全部 action value 总和。
- `setPolicyRegistry()` 只能由治理合约自身通过已通过提案调用。
- UUPS `_authorizeUpgrade()` 仍只允许治理合约自身调用。

### 测试辅助

- `contracts/test/DealGovernanceHarness.sol`
- `contracts/test/GovernancePolicyMocks.sol`
- `test/DealGovernanceV2Policy.ts`
- `test/DaoRules.ts` 已适配策略注册表。

## 4. 已通过验证

执行结果：

```text
DealGovernance V2 action policy: 4 passing
DAO Rules: 18 passing
```

专项测试覆盖：

1. 四种提案动作边界互相隔离。
2. 嵌套跨链 target/selector 校验。
3. action value 精确匹配及单动作金额上限。
4. Major 提案执行 UUPS 升级，并保留现有状态和策略注册表。

存储布局：

- 旧存储最后一项 `_stakedCheckpoints` 位于 slot 28。
- 新 `policyRegistry` 位于 slot 29。
- 必须继续保持 append-only，不能调整旧字段顺序或类型。
- V1 基线：`/tmp/deal-governance-v1-storage.json`
- V2 布局：`/tmp/deal-governance-v2-storage.json`

## 5. 正确升级方式

禁止重新部署新的治理 proxy 代替现有 proxy，否则历史提案、质押和检查点状态会丢失。

正确方式：

1. 部署 `GovernancePolicyRegistry`，`governance` 指向现有治理 proxy，并写入经过审核的初始规则。
2. 部署新的 `DealGovernance` implementation。
3. 由旧治理创建 Major 提案，目标为治理 proxy 自己。
4. 提案执行：

```text
upgradeToAndCall(
  newImplementation,
  abi.encodeCall(DealGovernance.setPolicyRegistry, policyRegistry)
)
```

这样升级和策略注册表初始化在同一笔治理执行中完成，不存在升级后策略为空的中间状态。

## 6. 下一步任务

1. 对照 ETH 主网部署文件和现有合约 ABI，整理完整初始策略规则。
2. 至少确保以下 Major 动作可用：
   - 治理 proxy 的 `upgradeToAndCall`
   - 治理 proxy 的 `setPolicyRegistry`
   - 策略注册表的 `setRule` / `setRules`
3. 为普通参数 setter、CrossChainBroadcaster、ProtocolTreasury 及后续 SatoshiVault 明确 target/selector/value 上限。
4. 编写带安全门槛的 ETH 主网 V2 准备脚本：
   - 默认只做 dry-run。
   - 校验 chainId = 1。
   - 校验治理 proxy 和当前 implementation。
   - 校验 D/DC/treasury/broadcaster 等地址。
   - 校验存储布局。
   - 只有显式确认环境变量时才允许部署 implementation/registry 或创建提案。
5. 在 Ethereum mainnet fork 上完整预演：部署 registry 和 implementation、创建 Major 提案、达到通过条件、执行升级、验证旧状态和所有新限制。
6. 执行全量 Hardhat/Foundry 测试、合约体积检查和 `git diff --check`。
7. 输出审计结果和部署步骤，等待用户明确确认后才允许真实部署。

## 7. 当前已知地址

来自 `deployments/eth-mainnet-1.json`：

| 模块 | 地址 |
| --- | --- |
| DealGovernance proxy | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| 当前 DealGovernance implementation | `0xECB7A086Aa87B9e2BcBbc6573fA9D0FEF7b7D1D6` |
| D | `0x61921ecb954ffaaf8cd3fd2e71eecb14b3ed529f` |
| NftVetoRegistry | `0xd8de3603d341584e0aef843ee8f4c00288179177` |
| VoteDividendClaimer | `0xc42afc0a57e90c41ec3dd29a6b6794a81737f9f3` |
| CrossChainBroadcaster | `0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf` |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` |

## 8. 新窗口执行要求

开始时先执行：

```bash
git status --short
git diff --check
node node_modules/hardhat/dist/src/cli.js test test/DealGovernanceV2Policy.ts
node node_modules/hardhat/dist/src/cli.js test test/DaoRules.ts
```

然后读取当前 `git diff`，直接从“生产升级脚本和 fork 预演”继续。不要重复改已经通过测试的业务逻辑，也不要擅自部署、提交或推送。
