# Base CrossChain V2 阶段一/二部署与 Canary 预演记录

时间：2026-08-07（Asia/Singapore）

## 结论

Base 的 CrossChain V2 接收端已经部署并完成隔离配置；ETH `CrossChainBroadcasterV2` 已登记 Base 路由和 LayerZero peer，但 Base 路由保持 `active=false`。

因此当前生产广播行为没有变化：BSC 仍是唯一 active 副链，Base 尚不会收到生产跨链消息。未给 Base Factory、Treasury、DC 或资金池移交权限，未锁定 Treasury bootstrap，未初始化资金池，也未创建治理提案。

## Base 部署地址

| 合约 | 地址 | 当前权限/用途 |
|---|---|---|
| `DualBridgeExecutorV2` | `0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218` | 2-of-3 接收端，owner 暂为 `0xE88c...9893` |
| `GovernanceProbe` implementation | `0xf0c56777f3B73bbDb153767D5c1C2727B6aE867C` | 无资产测试实现 |
| `GovernanceProbe` proxy | `0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f` | controller 为 Base Executor，仅用于 Canary marker |

Executor 当前仅 allowlist 自身与上述 Base Probe；threshold 为 2。Ethereum peer 为 ETH Broadcaster V2，delegate 为 Executor 自身。

## 阶段一交易（Base）

| 行为 | 交易哈希 | 区块 | Gas used |
|---|---|---:|---:|
| 部署 Executor | `0xc9c4c1cb220a0b443c27e7b5733a67738a2cff07fd0dc5bdc6b0593d239537da` | 49664127 | 2165964 |
| 部署 Probe implementation | `0x11a3da1875b1fb09f8a93446b640d908b8dbfbc3bd936d176171042a3c767323` | 49664131 | 476130 |
| 部署 Probe proxy | `0x01fc0d94526bde85634c5f95f4d6b324966cbcb8386f0005103e93155e0e3759` | 49664135 | 155391 |
| 配置 Ethereum peer | `0x1dd1bf2c99ce60cd660f7561f565b34835fb5f53e8bb24b96189b93e83be48bd` | 49664139 | 47708 |
| allowlist Executor 自身 | `0xb7f163d8f176a44181081c320d113bea0900df9b9bffd5ababd81c6708e13638` | 49664143 | 48287 |
| allowlist Base Probe | `0xf317851b8640d10b47177e9b60a874d619f4c3adb563f43b8bee99db2635e90a` | 49664148 | 48287 |
| delegate 改为 Executor 自身 | `0x3f91ed9570b2470c8c03a9d394e936c54569abaf7a2e7c3ca4a9979e57190492` | 49664152 | 34359 |

七笔 receipt 均为 success；部署脚本在三个 Base RPC 上复核了相同的 owner、threshold、controller 与实现槽。

## 阶段二交易（Ethereum）

| 行为 | 交易哈希 | 区块 | Gas used |
|---|---|---:|---:|
| 登记 Base route，`active=false` | `0xc97d8f708692eb16b800abcd09c8a124233c5b81f41f18c1c8ecbe947fe803ae` | 25704113 | 204858 |
| 设置 Base LayerZero peer | `0x0f76b217ace68b782914d86ab94edaa5b374bddb277de3ef091c6435642c7a75` | 25704115 | 47652 |

两笔 receipt 已用独立公开 RPC 再次确认 `status=1`。

Base 路由精确参数：

- chain key / LayerZero EID：`30184`
- CCIP selector：`15971525489660198786`
- CCIP receiver：Base Executor
- Axelar chain：`base`
- Axelar address：Base Executor 小写地址
- Axelar minimum fee：`0.001 ETH`
- active：`false`

BSC 原路由 `30102` 的七个字段逐项保持不变；登记 Base 前后的 BSC 单链 quote 一致。

## 主网只读状态（规划快照）

- ETH block：25704145
- BSC block：114573295
- Base block：49664554
- Broadcaster chain ids：`[30102, 30184]`
- BSC active：true
- Base active：false
- Broadcaster nonce：2
- DAO proposal count：19
- Major fee：1000 DC
- Broadcaster Major 最大 value：0.01 ETH
- 当前 BSC 单链测试 quote：`0.001329265421137577 ETH`
- Base Probe：version 1、marker 0、updateCount 0、已 allowlist
- BSC 无资产业务外 Probe：version 2、marker 0、updateCount 0、当前未 allowlist

## Canary 策略与描述

Canary 使用两个无资产 Probe：

- BSC：`0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3`
- Base：`0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f`

策略提案只新增两条 Major、nested-only、maxValue=0 的 `recordMarker(bytes32)` 权限。标题与正文为：

```text
Base跨链测试授权

仅为BSC和Base无资产测试合约开放测试标记权限，不涉及代币、国库、分红或业务合约。
```

Canary 提案标题与正文为：

```text
Base跨链测试

向BSC和Base无资产测试合约写入同一测试标记，只验证跨链链路，不影响业务。
```

测试 marker：`0xe735d9f79dc7413699af00ad995b58e853e30e3881bc5e72aff1ae13cab8ef3b`。

精确 `setRules`、`broadcast` 与两份 `createProposal` calldata 已写入 `deployments/base-cross-chain-v2-canary-plan.json`。该文件是只读生成结果，`transactionSent=false`。

## 测试结果

| 测试 | 结果 | 覆盖内容 |
|---|---|---|
| `BaseCrossChainV2Stage1LiveFork.ts` | 1 passing | Base 最新主网 fork 部署隔离 Executor/Probe；LZ+CCIP 达到 2-of-3 后 marker 只执行一次；Factory/Treasury/DC/三池状态完全不变 |
| `BaseCrossChainV2RouteStage2EthFork.ts` | 1 passing | Base inactive 登记可重复验证；BSC 路由与报价不变 |
| `BaseCrossChainV2CanaryEthFork.ts` | 1 passing | 精确两条 nested-only 策略、Base 激活、BSC+Base 三桥真实发送预演；nonce 只增加一次 |
| `CrossChainV2FeatureTooling.ts` | 4 passing | 提案 action、消息哈希、nonce、配置输入校验 |

本轮没有修改任何生产 Solidity 业务合约。测试中两处修正仅让 fork 测试同时兼容“阶段二之前/之后”的快照，并增加底层错误输出；没有删除或放宽任何安全断言。

## 下一步顺序与权限边界

1. 重新只读核验 proposal count，防止预期编号变化。
2. 经用户明确确认后，才精确 mint/approve 1000 DC 并创建策略 Major 提案；当前预期编号为 20。
3. 等 leader 质押/投票并执行策略提案。
4. 再次只读核验两条策略后，恢复 BSC 测试 Probe allowlist，并激活 Base route。
5. 激活后立即读取 BSC+Base 合并实时 quote，必须不超过预留 `0.005 ETH`；否则停止。
6. 经再次确认后创建 Canary Major 提案；不得自动 stake 或执行。
7. 提案通过并经再次确认执行后，监控 LayerZero、CCIP、Axelar，确认 BSC/Base 均达到 2-of-3，两个 marker 相同且各只更新一次。
8. Canary 完全成功后，才讨论 Factory/Treasury/DC 等生产权限移交和 bootstrap 锁定；这些不包含在当前授权内。

截至 2026-08-07 阶段二完成时，尚未创建提案、未 stake、未执行 Canary、未提交或推送 Git；后续进展见下节。

## 2026-08-10：策略提案已创建

经用户明确授权后，已严格执行“精确 mint 1000 DC、approve 1000 DC、创建 Major 策略提案”三步；没有 stake、没有执行提案、没有改 allowlist、没有激活 Base 路由。

| 行为 | 交易哈希 | 区块 | Gas used |
|---|---|---:|---:|
| 精确 mint 1000 DC | `0x0d02a49b4c00479b884ba775309523e5f13230f779ce5e4b1dc66b03c0ef7dcc` | 25721396 | 55517 |
| 精确 approve 1000 DC | `0x8e8d1f7e880d76771d6c78182f7e115636490552c12943862fd0156ffd9e2fae` | 25721398 | 46038 |
| 创建 Major 提案 20 | `0xf844d6a66fb4474f1435c53ccd0fd5564c9f55679aa9527c7b401441869407a5` | 25721401 | 659311 |

独立公开 RPC 复核结果：

- 三笔 receipt 均为 `status=1`；sender、target、calldata 与授权内容一致；
- proposal count = 20，proposal 20 state = Pending；
- kind = Major，totalStaked = 0，executed = false；
- 唯一 action 是 Registry 的精确两条 `setRules(...)`，value = 0；
- 1000 DC 已作为提案费进入 DAO Treasury；创建人 DC balance = 0、allowance = 0；
- BSC/Base 两条 `recordMarker` 策略仍未生效；
- Base route 仍为 `active=false`；
- BSC 测试 Probe 仍未 allowlist，Base 测试 Probe 仍已 allowlist；
- Broadcaster nonce 仍为 2。

本次提案描述：

```text
Base跨链测试授权

仅为BSC和Base无资产测试合约开放测试标记权限，不涉及代币、国库、分红或业务合约。
```

提案创建完成时，后续 stake、执行提案、恢复 BSC allowlist、激活 Base 路由或创建 Canary 提案均未包含在该次授权中；其后的实际进展见下节。

## 2026-08-10：Canary 路由准备完成

提案 20 已由外部质押 70 D 并执行后，经用户授权完成以下两笔配置：

| 行为 | 交易哈希 | 链/区块 | Gas used |
|---|---|---:|---:|
| BSC Executor 恢复无资产 Probe allowlist | `0x0d496f375eaaead757c6a21486b46778d516571b1b9bc6cc5ca967a577c3adc8` | BSC / 115042342 | 48287 |
| ETH Broadcaster 激活 Base route `30184` | `0x702575ccbbaf3bf0790b57542442868fe011ca13b2e09443b9e851e51694a258` | ETH / 25721662 | 69948 |

独立 RPC 复核结果：

- 两笔 receipt 均为 success，sender、target、calldata 与授权一致；
- BSC route 七个字段保持原值且仍为 active；
- Base route 七个字段保持登记值并变为 active；
- BSC Probe allowlist = true，Base Probe allowlist = true；
- BSC/Base Probe marker 均为 0，updateCount 均为 0；
- Broadcaster nonce 仍为 2，说明没有发送跨链消息；
- 两条 Major `recordMarker(bytes32)` 策略均为 allowed=true、nestedOnly=true、maxValue=0；
- BSC+Base 合并三桥实时 quote = `0.002626636492547261 ETH`，低于 `0.005 ETH` 预算。

当前只是 Canary 路由已就绪。尚未创建 Canary 提案、未为 Canary mint/approve DC、未 stake、未执行广播，也未移交 Base Factory/Treasury/DC 的生产权限。

## 2026-08-10：Canary Major 提案已创建

经用户明确授权后，已严格执行“精确 mint 1000 DC、approve 1000 DC、创建 BSC + Base 无资产 Canary Major 提案”三步；没有 stake、没有执行提案、没有发送跨链消息。

| 行为 | 交易哈希 | 区块 | Gas used |
|---|---|---:|---:|
| 精确 mint 1000 DC | `0x743184c946be1b7dda509cbbafb838761f0e1999854c5d5e0c9c6190b3817d16` | 25721738 | 55517 |
| 精确 approve 1000 DC | `0x9338d0f0623b07b21eb842d6d99a7d35625d1f25e115dfd51b2df2e3f2d5377b` | 25721740 | 46038 |
| 创建 Major 提案 21 | `0xe9af3314a42dd87ebf1b9058a7789a8a7a934eae7369cb99e57a7d2fb6f698fa` | 25721742 | 701272 |

创建前最新 ETH 主网 fork 测试 `BaseCrossChainV2CanaryProposalEthFork.ts` 为 1 passing，证明精确创建流程只产生一个 Pending 提案，不会质押、执行或广播。创建后又通过独立 ETH/BSC/Base 公开 RPC 完成只读复核：

- 三笔 receipt 均为 success，sender、target、value 和 calldata 全部匹配；
- proposal count = 21，proposal 21 state = Pending，kind = Major；
- totalStaked = 0，executed = false；
- 唯一 action 是向 ETH Broadcaster V2 提供 `0.005 ETH` 上限并调用精确 BSC + Base `broadcast(...)` calldata；
- 创建前实时报价为 `0.002626680946179368 ETH`，低于 `0.005 ETH` 执行预算；
- 1000 DC 已作为提案费进入 DAO Treasury，创建人 DC balance = 0、allowance = 0；
- Broadcaster nonce 仍为 2；BSC/Base Probe marker 均为 0、updateCount 均为 0；
- BSC/Base 路由仍为 active，但尚未发送任何 Canary 消息。

提案描述为：

```text
Base跨链测试

向BSC和Base无资产测试合约写入同一测试标记，只验证跨链链路，不影响业务。
```

下一步必须另行明确授权才能 stake；stake 授权不自动包含执行 Canary 广播。

## 2026-08-10：提案 21 已执行，BSC/Base 2-of-3 闭环成功

经用户再次明确授权后，先后完成实时报价、`execute(21)` 主网模拟和最新 ETH fork 真实执行预演，然后发送唯一一笔执行交易：

| 行为 | 交易哈希 | 区块 | Gas used | Value |
|---|---|---:|---:|---:|
| 执行 Major 提案 21 | `0x728fc2e5bee5b86b381cabc820a91729cffb6e9c6298af6d4ae0e66e468d35c6` | 25722271 | 1315800 | 0.005 ETH |

执行前合并报价为 `0.002626627719932648 ETH`，低于 `0.005 ETH` 上限。receipt 为 success，sender、target、value、`execute(21)` calldata 和所有 `Broadcast` / `BroadcastToChain` 事件均已匹配。提案 21 变为 Executed，Broadcaster nonce 从 2 精确增加到 3。

目标链最终结果：

| 链 | LayerZero | CCIP | Axelar | 执行结果 |
|---|---|---|---|---|
| BSC | 成功 | 成功（晚到） | 成功（第二确认） | 3/3，marker 精确匹配，updateCount=1，executionAttempts=1 |
| Base | 成功 | 成功（第二确认） | 配置大小写错误 | 2/3，marker 精确匹配，updateCount=1，executionAttempts=1 |

BSC 三条目标链交易：

- LayerZero：`0xa9b0ae4154e753ebb05095c323df922302bc9734ddef47cad6dd058aebcabbe7`
- Axelar：`0x8fb196743934834ebce37862bfd0e992d02982db9fcc80b92b71526a87f9a6ba`
- CCIP：`0xc4dd8c2b1625c38c9edcece7be6bd99a240639729f5998c9bd81afc86d8dd1aa`

Base 两条成功的目标链交易：

- LayerZero：`0xae8b63143327a4f477926f9c67ef64fe895c4c629ab6edaa1e821de041e7055d`
- CCIP：`0x6fd9426149e5d245fec644cb1a744e0ac1e7cc9189c67196342fcd88f8503688`

### Base Axelar 第三路修正结果

Base Executor 初始化时保存的 ETH Broadcaster 字符串为全小写：

```text
0xcf4d1b59c43f0e19f7e0e0416067e999f12cd1e6
```

Axelar Gateway 实际批准并回传的是 checksum 字符串：

```text
0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6
```

`DualBridgeExecutorV2` 对该字符串做精确哈希比较，因此 Base Axelar 路径触发 `WrongAxSrcAddress()`（selector `0x7977c504`）。Gateway 只读证据为 checksum approval=true、lowercase approval=false，与根因一致。

最小修正“仅把 Base Executor `axSrcAddress` 改为 checksum 字符串”已在固定 Base 主网区块 fork 上 1 passing；随后接受 Axelar 晚到确认时，marker 仍为原值、updateCount 仍为 1、executionAttempts 仍为 1，证明不会重复执行。

2026-08-10 已完成主网最小修正和晚到确认：

- `Executor.setAxSrc("Ethereum", checksum Broadcaster)`：`0xf27d3345e69de46accbb22bd7036720d275a0a1ebde6bfee12f0d49f9ce7982b`
- Axelar 晚到确认：`0x6d11309571d2225fe501c81050f38a12b82554791c69488ed5c394926e0c8de9`

两笔 receipt 均为 success。Base 最终为 LayerZero + CCIP + Axelar `3-of-3`；`executed=true`、`executionAttempts=1`、marker 不变、`updateCount=1`，未重复执行业务。修正只改变 Executor 的 Axelar 来源地址字符串大小写，没有升级合约、修改阈值、移动资产或改变任何生产业务参数。
