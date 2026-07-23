# DAO V2 生产升级与 ETH Mainnet Fork 验证

> 状态：DAO V2 已通过 Major 提案 7 在 ETH 主网完成 UUPS 原地升级。
> 准备日期：2026-07-20；主网执行与最终复核：2026-07-21。
> 治理 proxy 地址不变，生产策略 registry 已原子接入，ProtocolTreasury 已由 DAO 控制并永久锁定 bootstrap。

## 1. 结论

DAO V2 可以通过现有 ETH `DealGovernance` UUPS proxy 原地升级，无需更换 proxy。正确的 Major 提案只包含一个 action：

```text
target = DealGovernance proxy
value  = 0
data   = upgradeToAndCall(
           newImplementation,
           abi.encodeCall(setPolicyRegistry, policyRegistry)
         )
```

升级与注册表初始化在同一次治理执行中完成，不会出现“V2 已升级但策略为空”的中间状态。

`ProtocolTreasury` 已完成 controller 交接并永久锁定 bootstrap。DAO V2 registry 和 implementation 已部署；Major 提案 7 已执行，当前 DAO proxy 正在运行 V2。

## 2. 完整初始策略

策略入口：`scripts/dao-v2-policy.ts`。默认为 deny-by-default，共 48 条允许规则。

| 提案类型 | 数量 | 初始权限 |
| --- | ---: | --- |
| Parameter | 15 | ETH DealFactory 7 个普通 setter；CrossChainBroadcaster 1 个带嵌套校验的广播；BSC DealFactory 7 个 `nestedOnly` setter |
| Treasury | 4 | `payNative`、`payToken`、`approveToken`、`approveAndCreateDividendRound` |
| Major | 29 | 治理升级/权限/阈值、registry 变更、ETH/BSC Factory 高风险配置、treasury controller 迁移、Major 跨链广播 |
| Satoshi | 0 | 默认全部拒绝；只有同时配置未来 SatoshiVault 地址和唯一函数签名时才生成 1 条规则 |

关键限制：

- BSC target/selector 规则带有链上 `nestedOnly=true`，只能在已批准的 `broadcast()` 内部出现，不能被当作 ETH 直接 action。
- `broadcast()` 同时校验外层 selector、每个远程 target、内层 selector 和 action value。
- 广播 action value 上限为 `0.01 ETH`。升级后最终复核时实时 quote 为 `0.001039512128686156 ETH`。
- `ProtocolTreasury.execute(address,uint256,bytes)` 没有进入初始白名单，避免绕过 Treasury 动作边界。
- `bootstrapSetController`、`lockBootstrap` 等 bootstrap/admin-only 函数没有进入治理策略。
- 策略在创建提案时和执行提案时各校验一次；后续 Major 提案禁用规则后，旧的 pending 提案也无法绕过新策略执行。

## 3. 生产准备脚本

脚本：`scripts/prepare-eth-dao-v2.ts`。

默认运行模式是纯只读 dry-run，会检查：

1. ETH `chainId = 1`。
2. 部署 JSON 与链上 governance proxy、EIP-1967 implementation、D、DC、NftVetoRegistry、ProtocolTreasury、CrossChainBroadcaster、ETH/BSC DealFactory 及 BSC executor。
3. Factory/broadcaster 的实际治理指针。
4. DealGovernance V1 的 29 个存储字段原样保留，`policyRegistry` 仅追加在 slot 29。
5. EIP-170 runtime 和 EIP-3860 initcode 体积上限。
6. 当前跨链 quote 不超过策略上限。
7. CREATE 预测地址；显式部署时如果 `latest nonce != pending nonce` 会直接拒绝。
8. 如果传入已部署 registry/implementation，则纯只读校验 registry 治理归属、全部规则和 implementation `proxiableUUID()`。
9. 生成完整 `upgradeToAndCall` calldata 供人工复核。

两个写入阶段必须分别使用精确确认字符，部署不会隐式创建提案：

```bash
# 仅部署 registry + implementation（未经用户确认不得执行）
DAO_V2_MAINNET_DEPLOY_CONFIRM=DEPLOY_DAO_V2_ON_ETHEREUM_MAINNET \
  npm run dao:v2:dry-run

# 仅创建 Major 升级提案（未经用户确认不得执行）
DAO_V2_POLICY_REGISTRY_ADDRESS=0x... \
DAO_V2_IMPLEMENTATION_ADDRESS=0x... \
DAO_V2_MAINNET_PROPOSE_CONFIRM=CREATE_DAO_V2_UPGRADE_PROPOSAL \
  npm run dao:v2:dry-run
```

脚本不会自动 stake、投票或执行升级提案。

升级完成后的只读验收脚本：`scripts/verify-eth-dao-v2-upgrade.ts`。

```bash
npm run dao:v2:verify
```

该命令不读取私钥、不签名、不发送交易，会校验 implementation slot、提案 7、48 条策略、治理参数、Treasury、ETH/BSC 跨链接线和当前广播报价。

## 4. ETH Mainnet Fork 完整预演

测试：`test/DealGovernanceV2MainnetFork.ts`。

在 ETH mainnet fork 上已完成：

1. 读取真实 proxy、当前 implementation、治理参数、历史提案及 actions。
2. 仅在 fork 中模拟 treasury controller 交接和 DC 提案费条件。
3. 部署含 48 条生产规则的 registry 及新 implementation。
4. 创建 Major 提案、70 D fast-pass、执行原子 UUPS 升级。
5. 校验 implementation slot、`policyRegistry`、所有升级前治理字段、历史 proposal 5 及 actions 不变。
6. 执行真实 ETH DealFactory Parameter 提案和 ProtocolTreasury 原生币付款。
7. 验证合法广播，以及错误 target、错误 selector、超 value 上限、BSC target 直接调用均被拒绝。
8. 验证不同 proposal kind 不能交叉使用 action。
9. 通过 Major 提案禁用一条规则，证明旧 pending 提案在执行时被新策略拒绝。

最终结果：`1 passing`。

## 5. 全量验证结果

| 检查 | 结果 |
| --- | --- |
| Hardhat 强制编译 | 70 Solidity files 编译成功 |
| DAO V2 生产策略/专项测试 | 6 passing |
| ETH mainnet fork | 1 passing |
| Hardhat 全量 | 179 passing |
| Foundry 全量 | 31 passed, 0 failed |
| 存储布局 | V1 29 个字段保留，`policyRegistry` = slot 29 |
| 合约体积 | 190 artifacts 全部符合 EIP-170/EIP-3860 |
| DealGovernance runtime/initcode | 16,569 / 16,883 bytes |
| GovernancePolicyRegistry runtime | 2,476 bytes |
| `git diff --check` | 通过 |

可重复的验证命令：

```bash
node node_modules/hardhat/dist/src/cli.js compile --force
npm run dao:v2:storage
npm run check:contract-sizes
npm run dao:v2:dry-run
npm run test:dao-v2:fork
node node_modules/hardhat/dist/src/cli.js test
forge test
git diff --check
```

## 6. 主网实施结果

1. 已完成：由 `ProtocolTreasury.bootstrapAdmin` 在主网依次执行：
   - `bootstrapSetController(0x9a41a9A85C16F590789C846Fb933fF8C715407F7)`
   - `lockBootstrap()`
2. 已完成：重跑 dry-run，确认 `controller = governance`、`bootstrapLocked = true` 且阻断列表为空。
3. 已完成：确认部署钱包没有 pending nonce，使用独立部署授权仅部署 registry 和 implementation。
4. 已完成：保存 `deployments/dao-v2-preparation/eth-mainnet-dao-v2-20260720-101952.json`。
5. 已完成：关闭全部写入确认，复核 code、creation bytecode、UUPS UUID、registry governance、构造参数和 48 条链上规则。
6. 已完成：Major 提案 7 的 target、value、implementation、registry 和 calldata 逐项核对。
7. 已完成：提案 7 达到执行条件并执行 UUPS `upgradeToAndCall`。
8. 已完成：链上重新解码 proposal actions，与批准的升级动作完全一致。
9. 已完成：执行后校验 EIP-1967 implementation slot、`policyRegistry`、48 条策略、治理参数、treasury controller 和跨链指针。

## 7. 当前主网状态

升级后纯只读验收结果：

| 项目 | 当前值 |
| --- | --- |
| DealGovernance proxy | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| 当前 implementation | `0xAAB065B8FDB3c09C207273eA53B2E0DF0EafD1e5` |
| GovernancePolicyRegistry | `0xBFF01F91291476e671f0F310846D5dDb460e2382` |
| 升级提案 | `7`，`Executed` |
| 升级交易 | `0x7ce0d235e82c946f0974640acc6c41eb4aa23d2628a20e0f5e95f089e92ccb64` |
| 升级区块 | `25578119` |
| 生产策略 | `48/48` 逐条匹配 |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` |
| ProtocolTreasury.controller | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| ProtocolTreasury.bootstrapLocked | `true` |

当前 proxy 已升级，`policyRegistry` slot 29 指向上述 registry。其后 SatoshiVault 与 DealDividendVault 已部署，proposal `8` 已追加四条精确策略，总策略数为 52；proposal `9` 已创建首轮 100 DC 分红。前端当前接入见 `docs/ETH_DAO_V2_国库中本聪分红前端交接.md`。

Satoshi 提案的 `satoshiSucceeded` 是逐 proposal 存储：某条提案达到 90 D 后永久成功，只保证该条提案不因支持者取回 D 而失效，不会让其他 Satoshi 提案自动通过。
