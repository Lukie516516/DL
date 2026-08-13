# CCIP V2 / V1 退役只读审计与执行计划

## 2026-07-30 Stage 1 执行结果

已按授权完成四笔 owner 权限收口，并精确 mint/approve `1000 DC` 后创建 Major 提案 `#19`。没有 stake，没有执行提案，没有发送新的跨链消息。

| 顺序 | chain | 动作 | tx |
| ---: | ---: | --- | --- |
| 1 | BSC | V1 Executor 撤销 BSC DealFactory allowlist | `0x42f0a64d75351b54c4436d5b2d99acd54bd12df38fd0dcf6d24b81fc4ecdc48e` |
| 2 | BSC | V1 Executor 撤销旧 BSC Probe allowlist | `0xfae77f2ac33913af4423c29f47f67abfa9ec95019de4987a17216facb69425ee` |
| 3 | ETH | 暂停 V1 Broadcaster 的 BSC route | `0xb4d871f6edfc48d20f50378ddbc61454fa44b9b45fb00b6a1b2ed94237959120` |
| 4 | BSC | V2 Executor 撤销升级测试 BSC Probe allowlist | `0xde6acddeba56af77f6a9e8f4c6636c1e5035b6d6d2f84116509ffd0152dff0cc` |
| 5 | ETH | 向提案钱包精确 mint `1000 DC` | `0x5e5e0a8b6a63cbba38a9d3dcfe899b1fcf676f008d9e644d74f669d894e70555` |
| 6 | ETH | 向 DAO 精确 approve `1000 DC` | `0x4ae8b92e2b144f1ee4e094e34b50efc2386fd0ca3697e15f1411d04318ccbc50` |
| 7 | ETH | 创建 V1 与测试权限清理 Major 提案 `#19` | `0xfdc80a3cc0a511bc77cd234b6eda1afe0d9805aa1cc4a43356df0d1631a0789e` |

执行后在 Ethereum block `25644519` 及更高区块完成独立复核：

- proposal `#19`：`Pending`，`kind=Major`，`totalStaked=0`，`windowEndsAt=0`，`executed=false`；
- 提案 description 与唯一 Registry `setRules` action 均与审计 calldata 匹配；
- `1000 DC` 总供应量增量与 Treasury 余额增量一致；
- 提案钱包 DC balance 与 DAO allowance 均为 `0`；
- V1 BSC route 已关闭；
- V1 Factory、旧 Probe 与 V2 升级测试 Probe allowlist 已关闭；
- V2 BSC route、V2 Factory allowlist、Factory controller、threshold 和 V2 Parameter/Major 广播策略保持原值；
- 十条 Registry 清理规则仍为 active，只有提案以后被单独授权 stake、通过并再次授权执行后才会关闭。

逐笔 receipt 与最终验证记录：

```text
deployments/ccip-v1-retirement-stage1.json
```

## 结论

2026-07-27 生产只读审计结果：

- ETH → BSC V2 主链路健康，BSC DealFactory controller 已是 V2 Executor；
- V2 BSC route、Parameter/Major 广播策略和 Factory allowlist 均保持开启；
- V1 仍有 route、两条 DAO 广播策略和两个 BSC allowlist 未关闭；
- 两组无资产测试 Probe 共十条 DAO 策略仍开启，两个 BSC Probe 仍在对应 Executor allowlist；
- 所有待执行退役动作均已使用生产地址和当前 owner/governance 身份完成 `eth_call` 与 gas estimate；
- `blockers = []`，可以进入分阶段退役，但本轮没有发送任何交易。

只读快照：

| 项目                   | 值                                           |
| ---------------------- | -------------------------------------------- |
| checkedAt              | `2026-07-27T11:20:46.217Z`                   |
| Ethereum block         | `25623806`                                   |
| BSC block              | `112425143`                                  |
| V1 Broadcaster         | `0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf` |
| V1 Executor            | `0x46839754B2dF96E887e41E688880be6aa0A9bF98` |
| V2 Broadcaster         | `0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6` |
| V2 Executor            | `0x407381d841DD48bBBd40Bd37f9dB268CE75950A8` |
| BSC DealFactory        | `0x1Ca748Feb347d0d177E844E7D4CDCA908957c256` |
| Factory controller     | V2 Executor                                  |
| V1 / V2 route active   | `true / true`                                |
| V1 / V2 broadcastNonce | `6 / 2`                                      |
| V1 / V2 threshold      | `2 / 2`                                      |

## V1 历史消息完整审计

脚本从 Ethereum block `25300000` 扫描到当前块，取得六条 V1 `Broadcast` 事件，与链上 `broadcastNonce = 6` 精确一致，因此没有漏掉历史 V1 广播。

五条消息已经达到阈值并执行。唯一未执行记录：

| 项目                          | 值                                                                   |
| ----------------------------- | -------------------------------------------------------------------- |
| V1 nonce                      | `2`                                                                  |
| ETH tx                        | `0x2c927d6869f709d4c31437c818edcec04e1e81ed661653904db59dfb56cf2c39` |
| messageHash                   | `0xf8f150336a2e72ec5b053eb46835f19c00102484983e9fb94b468af32121012e` |
| target                        | BSC DealFactory                                                      |
| 调用                          | `setMessagePriceRule(bool,address,uint256)`                          |
| LayerZero / Wormhole / Axelar | `false / false / true`                                               |
| 当前确认数                    | `1/2`                                                                |
| executed                      | `false`                                                              |

这是陈旧未完成消息，不是仍可生效的治理动作。使用它的原始 calldata，并把 `from` 精确设为 V1 Executor 进行 BSC `eth_call`，当前返回：

```text
Execution reverted with reason: NOT_AUTHORIZED.
```

原因是 BSC DealFactory controller 已切换到 V2 Executor。即使旧消息以后意外取得第二票，旧 Executor 也不能修改 Factory。执行退役时仍应把“撤销 V1 Executor 的 Factory allowlist”放在第一步，增加独立防线。

## 必须收口的三层 V1 权限

完整退役不能只关 DAO 策略，需要同时处理：

1. BSC V1 Executor 的业务目标 allowlist；
2. ETH V1 Broadcaster 的 BSC active route；
3. Registry 中 V1 Broadcaster 的 Parameter/Major `broadcast` 策略。

合约、历史日志和 owner 保留，不销毁、不 renounce ownership。以后如需应急回滚，必须重新经过明确授权恢复 allowlist、route 和 DAO 策略，不能静默恢复。

## 精确 owner 动作

以下四条动作全部只完成了 `eth_call` dry-run，没有发送交易。

### 1. 先撤销 V1 Executor 对 BSC Factory 的白名单

- chain：BSC `56`
- target：`0x46839754B2dF96E887e41E688880be6aa0A9bF98`
- function：`setAllowedTarget(0x1Ca748Feb347d0d177E844E7D4CDCA908957c256, false)`
- estimated gas：`31315`
- calldata：

```text
0xca1dd22e0000000000000000000000001ca748feb347d0d177e844e7d4cdca908957c2560000000000000000000000000000000000000000000000000000000000000000
```

### 2. 撤销 V1 Executor 对旧测试 Probe 的白名单

- chain：BSC `56`
- target：`0x46839754B2dF96E887e41E688880be6aa0A9bF98`
- Probe：`0xECB7A086Aa87B9e2BcBbc6573fA9D0FEF7b7D1D6`
- estimated gas：`31315`
- calldata：

```text
0xca1dd22e000000000000000000000000ecb7a086aa87b9e2bcbbc6573fa9d0fef7b7d1d60000000000000000000000000000000000000000000000000000000000000000
```

### 3. 暂停 V1 Broadcaster 的 BSC route

- chain：Ethereum `1`
- target：`0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf`
- function：`setChainActive(30102, false)`
- estimated gas：`33224`
- calldata：

```text
0xce8d090000000000000000000000000000000000000000000000000000000000000075960000000000000000000000000000000000000000000000000000000000000000
```

### 4. 撤销 V2 Executor 对升级测试 Probe 的白名单

- chain：BSC `56`
- target：`0x407381d841DD48bBBd40Bd37f9dB268CE75950A8`
- Probe：`0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3`
- estimated gas：`31382`
- calldata：

```text
0xca1dd22e000000000000000000000000d31c6417ae0c267f8c5bd634b96da7590e6e6ab30000000000000000000000000000000000000000000000000000000000000000
```

四笔 owner 动作均需要新的明确授权。任何一笔授权不自动包含其他动作。

## Major 策略清理提案

当前 `proposalCount = 18`，如果没有其他提案抢先创建，预计 proposalId 为 `19`。创建前必须重新运行预检，不能把预测 ID 当成保证值。

短标题：

```text
关闭跨链V1与测试权限
```

正文：

```text
本提案只关闭旧 V1 Broadcaster 的 Parameter/Major 广播策略，并关闭 ETH/BSC 无资产测试 Probe 的 marker 和升级策略。V2 Broadcaster、V2 Executor、BSC DealFactory、代币、国库和业务参数均不改变；不发送跨链消息，不升级任何业务合约。
```

唯一 action：

- target：GovernancePolicyRegistry `0xBFF01F91291476e671f0F310846D5dDb460e2382`
- value：`0`
- function：一次 `setRules(...)`
- 规则数：`10`
- 每条新值：`allowed=false`、`validateNestedBroadcast=false`、`nestedOnly=false`、`maxValue=0`

关闭的十条规则：

1. V1 Broadcaster Parameter `broadcast`;
2. V1 Broadcaster Major `broadcast`;
3. 旧 ETH Probe Parameter `recordMarker`;
4. 旧 BSC Probe Parameter `recordMarker`;
5. 旧 ETH Probe Major `recordMarker`;
6. 旧 BSC Probe Major `recordMarker`;
7. 旧 ETH Probe Major `upgradeToAndCall`;
8. 旧 BSC Probe Major `upgradeToAndCall`;
9. V2 ETH Upgrade Probe Major `upgradeToAndCall`;
10. V2 BSC Upgrade Probe Major `upgradeToAndCall`。

精确编码验证：

| 数据                                 |         长度 | keccak256                                                            |
| ------------------------------------ | -----------: | -------------------------------------------------------------------- |
| Registry `setRules` calldata         | `2308 bytes` | `0x0c92065a29c2404cabd02b223c7d873d9b3939febaff342df7225b980de8b886` |
| Governance `createProposal` calldata | `3076 bytes` | `0xc1ab85c84f59bd716f5ded1945998a3e7f2e2eb4b397a71adc55ad1fd33d8297` |

Registry 对精确 action 的 `isActionAllowed(Major, Registry, 0, calldata)` 返回 `true`。从 DAO proxy 身份对 Registry 做 `eth_call` 成功，gas estimate 为 `157666`。

完整 calldata 不手工复制到文档，避免长字符串在更新地址或描述后失去同步。以下命令会基于当前生产地址重新生成并输出逐字节精确值：

```bash
node --import tsx/esm scripts/prepare-mainnet-ccip-v1-retirement.ts --json \
  | jq -r '.exactActions.majorPolicyProposal.setRulesCalldata'

node --import tsx/esm scripts/prepare-mainnet-ccip-v1-retirement.ts --json \
  | jq -r '.exactActions.majorPolicyProposal.createProposalCalldata'
```

## 提案费用与授权边界

- Major 提案费：`1000 DC`；
- 提案钱包：`0xE88c63D29ECE76E3336B0Db747E10876c3bf9893`；
- 当前 DC balance：`0`；
- 当前 DAO allowance：`0`；
- 钱包当前仍有 DC `MINTER_ROLE`。

因此创建提案前仍需新的明确授权：

1. 精确 mint `1000 DC`；
2. 精确 approve `1000 DC`；
3. 创建 Major 提案；
4. 另行授权 stake；
5. 达到 Succeeded 后另行授权 execute。

本轮没有执行以上任何动作。

## 执行后验收

每一步交易后都必须独立读取 receipt、calldata 和最终状态。完全闭环需要满足：

- V1 Executor `allowedTargets(BSC Factory) = false`；
- V1 Executor `allowedTargets(旧 BSC Probe) = false`；
- V1 Broadcaster BSC route `active = false`；
- V1 Parameter/Major `broadcast` 两条规则 `allowed = false`；
- 两组测试 Probe 十条规则全部 `allowed = false`；
- V2 Executor `allowedTargets(升级测试 BSC Probe) = false`；
- V2 Executor `allowedTargets(BSC Factory) = true`；
- BSC Factory controller 仍为 V2 Executor；
- V2 Broadcaster BSC route 仍为 `active = true`；
- V2 Parameter/Major `broadcast` 规则保持原值；
- V2 threshold 保持 `2`；
- 不发生 token 转移、Treasury 变更、业务 implementation 升级或新的跨链 broadcast。

## 工具

只读预检脚本：

```text
scripts/prepare-mainnet-ccip-v1-retirement.ts
```

默认运行不会创建 wallet client，也不存在交易发送分支：

```bash
node --import tsx/esm scripts/prepare-mainnet-ccip-v1-retirement.ts
```
