# DAO V2 前置：ProtocolTreasury 权限交接确认

> 本文主体记录的是 2026-07-20 权限交接当时的历史状态。其后 DAO V2 已通过 Major 提案 7 完成升级；当前 implementation 为 `0xAAB065B8FDB3c09C207273eA53B2E0DF0EafD1e5`，PolicyRegistry 为 `0xBFF01F91291476e671f0F310846D5dDb460e2382`。

## 2026-07-20 主网执行与复核结果

结论：**Treasury 权限交接正确完成**。

```text
ETH chainId：1
最终复核 block number：25573119

ProtocolTreasury：
0x19CC1320DcF7e1396404599209D7c9a844A21b8a

controller：
0x9a41a9A85C16F590789C846Fb933fF8C715407F7

bootstrapAdmin：
0xE88c63D29ECE76E3336B0Db747E10876c3bf9893

bootstrapLocked：true

bootstrapSetController tx hash：
0x6a032022dced63ace241e54f51721307f03c411a060a598565188a2e72445c0c
block：25573112
实际 from：0xE88c63D29ECE76E3336B0Db747E10876c3bf9893
解码后的 newController：0x9a41a9A85C16F590789C846Fb933fF8C715407F7
ControllerUpdated：oldController=0xE88c...9893，newController=0x9a41...07F7

lockBootstrap tx hash：
0x25ce67495a2a58e95b52136921318548dfde8218fdbc3d03c11cceb2ce4b643a
block：25573118
实际 from：0xE88c63D29ECE76E3336B0Db747E10876c3bf9893
BootstrapLocked：admin=0xE88c63D29ECE76E3336B0Db747E10876c3bf9893

是否部署 DAO V2 registry：否
是否部署 DAO V2 implementation：否
是否创建 DAO V2 升级提案：否
```

锁定后已用 `eth_call` 验证 bootstrap 路径会按预期 revert，部署钱包无法再通过 bootstrap 修改 controller。

权限交接完成后重新运行 `npm run dao:v2:dry-run`，结果通过：

- ETH `chainId = 1`。
- V1 的 29 个存储字段全部保留，`policyRegistry` 追加在 slot 29。
- 190 个 artifacts 体积检查通过。
- ETH/BSC 治理接线检查通过。
- 48 条初始策略生成正常。
- 跨链报价 `0.001040836170195005 ETH`，低于 `0.01 ETH` 策略上限。
- 阻断列表为空。
- 本次 dry-run 没有发送交易，也没有修改部署文件。

下一步仍需独立获得用户明确确认，才允许：

1. 部署 DAO V2 `GovernancePolicyRegistry` 和新 implementation。
2. 对两个新地址执行纯只读复核。
3. 再次获得确认后创建 Major UUPS 升级提案。

不得把本次 Treasury 权限授权解释为 DAO V2 部署或升级授权。

## 给上一个对话框的任务

请核验 ETH 主网 `ProtocolTreasury` 的权限交接是否已经正确完成。

这一步不是给 DAO V1 新增 UUPS 升级权限。现有 DAO 本来就可以通过 Major 提案调用自身 `upgradeToAndCall()`。本步只是把协议国库的 controller 正式交给现有 DAO proxy，并永久关闭 bootstrap 权限。

## 固定对象

| 对象 | ETH 主网地址 |
| --- | --- |
| DealGovernance proxy | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` |
| 当前记录的部署者 | `0xE88c63D29ECE76E3336B0Db747E10876c3bf9893` |

必须在 `chainId = 1` 上核验，不能用 fork、测试网或部署 JSON 代替主网实时读取。

## 先只读检查

请直接读取 `ProtocolTreasury` 的：

```text
controller()
bootstrapAdmin()
bootstrapLocked()
```

如果权限交接已经执行，请同时查找并解码对应主网交易和事件，不要只根据交易 `status = success` 下结论。

## 正确的两个操作

权限交接应由链上实际 `bootstrapAdmin` 依次调用：

```text
1. bootstrapSetController(0x9a41a9A85C16F590789C846Fb933fF8C715407F7)
2. lockBootstrap()
```

如果这两笔主网交易还没有执行，请只报告“尚未完成”和当前链上状态。未经用户对主网写入的明确确认，不要擅自发送这两笔交易。

## 最终验收条件

只有以下条件全部满足，才能回复“Treasury 权限交接正确完成”：

```text
chainId = 1

ProtocolTreasury.controller()
= 0x9a41a9A85C16F590789C846Fb933fF8C715407F7

ProtocolTreasury.bootstrapLocked()
= true
```

同时必须确认：

1. `bootstrapSetController` 的实际参数是上述 DealGovernance proxy，不是 implementation、EOA 或其他新地址。
2. 调用者是调用当时链上实际的 `bootstrapAdmin`。
3. `ControllerUpdated(oldController, newController)` 事件中 `newController` 是 DealGovernance proxy。
4. `BootstrapLocked(admin)` 事件已经发出。
5. 两笔交易都在 ETH 主网成功确认，且最终链上 getter 与上述状态一致。

`bootstrapAdmin()` 的地址可以继续保留在存储中；安全性关键是 `bootstrapLocked = true`，锁定后 bootstrap admin 不能再使用 bootstrap 路径更改 controller。

## 请按这个格式回传

```text
结论：正确完成 / 尚未完成 / 执行错误

ETH chainId：
读取 block number：

ProtocolTreasury：
controller：
bootstrapAdmin：
bootstrapLocked：

bootstrapSetController tx hash：
实际 from：
解码后的 newController：
ControllerUpdated 事件：

lockBootstrap tx hash：
实际 from：
BootstrapLocked 事件：

是否部署 DAO V2 registry：否
是否部署 DAO V2 implementation：否
是否创建 DAO V2 升级提案：否

异常或风险：
```

## 本步确认后的下一步

把上述回传结果交回当前 DAO V2 续作对话。当前对话将先重跑纯只读生产 dry-run，确认阻断项为空；之后仍需用户单独明确确认，才能部署 DAO V2 registry 和 implementation。

本任务不授权部署 DAO V2、创建升级提案、stake、执行升级、Git 提交或推送。
