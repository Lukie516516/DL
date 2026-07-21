# ETH DealGovernance 前端接线说明

更新时间：2026-07-21

> DAO V2、ProtocolTreasury、SatoshiVault 和新分红入口的当前完整接法，统一以
> `docs/ETH_DAO_V2_国库中本聪分红前端交接.md` 为准。本文保留为 DAO 主入口和跨链基础说明。

## 读取文件

前端主配置使用：

```text
deployments/eth-mainnet-1.json
```

跨链配置参考：

```text
deployments/mainnet-cross-chain.json
```

本次单次 handoff：

```text
deployments/frontend-handoff-eth-governance-20260707-033005.md
```

## 核心地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DealGovernance | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` | 完整 DAO 主入口 |
| DealGovernance implementation | `0xAAB065B8FDB3c09C207273eA53B2E0DF0EafD1e5` | DAO V2 implementation，仅记录，不作为前端调用入口 |
| D | `0x61921ecb954ffaaf8cd3fd2e71eecb14b3ed529f` | DAO 席位/质押代币 |
| DealCoin/DC | `0x591625be924b98accab7e2c8af698c858aa2608d` | 提案费、分红资产 |
| NftVetoRegistry | `0xd8de3603d341584e0aef843ee8f4c00288179177` | NFT 否决注册 |
| GovernancePolicyRegistry | `0xBFF01F91291476e671f0F310846D5dDb460e2382` | DAO V2 action 策略只读校验 |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` | DAO 控制的协议国库；前端主要展示余额和提案动作 |
| SatoshiVault | `0xA2C8d5B2E440EbA62a5fd0A55978b39c3dAcFB3e` | 中本聪提案付款金库 |
| DealDividendVault | `0xc0aE5D371f4605c464493B0d056dA56357cD2850` | 当前 ETH D 持有人 DC 分红主入口 |
| VoteDividendClaimer | `0xc42afc0a57e90c41ec3dd29a6b6794a81737f9f3` | 旧分红入口，仅兼容历史，不再作为新业务主入口 |
| CrossChainBroadcaster | `0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf` | ETH -> BSC 跨链治理广播 |

## 前端配置方式

完整 DAO 页面接：

```text
address = deployments/eth-mainnet-1.json.addresses.dealGovernance
abi     = deployments/eth-mainnet-1.json.abi.DealGovernance
```

跨链广播合约接：

```text
address = deployments/eth-mainnet-1.json.addresses.crossChainBroadcaster
abi     = deployments/eth-mainnet-1.json.abi.CrossChainBroadcaster
```

旧的 `DealSeatVetoGovernor` 仍保留在部署文件中，但它只是旧席位否决制入口，不是完整 DAO 主入口。

## 已完成链上接线

| 检查项 | 结果 |
| --- | --- |
| `NftVetoRegistry.isGovernor(DealGovernance)` | `true` |
| `VoteDividendClaimer.governanceContract()` | `DealGovernance` |
| `CrossChainBroadcaster.governance()` | `DealGovernance` |
| BSC `DealFactory.crossChainGovernance()` | `DualBridgeExecutor` |
| BSC `DualBridgeExecutor.threshold()` | `2` |

## 注意

- 完整 DAO 前端不要再把 `dealGovernance` 指向 `DealSeatVetoGovernor`。
- 如果前端字段必须叫 `dealGovernance`，现在应填 `0x9a41a9A85C16F590789C846Fb933fF8C715407F7`，ABI 使用 `DealGovernance`。
- 当前 `mainnet-cross-chain.json` 里 `bscChainActiveOnWire = true`，ETH -> BSC 跨链广播已打开。建议先用低风险参数做小额测试，例如 BSC `DealFactory.setMinWindowSec(1801)`，验证后再改回 `1800`。
- ETH `DealFactory.crossChainGovernance` 已指向 `DealGovernance`，前端可以用 DAO 提案调用 ETH Factory 的 `onlyOwnerOrGovernance` 参数函数。
