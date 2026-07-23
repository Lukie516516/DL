# CCIP V2 主网 Canary 执行验证

验证时间：2026-07-23

## 结论

DAO Major 提案 `#15` 已执行成功，ETH 到 BSC 的 CCIP V2 三桥链路已走通。

- LayerZero：已确认
- Chainlink CCIP：已确认
- Axelar：已确认
- 最终确认数：`3 / 3`
- 执行阈值：`2 / 3`
- BSC 实际执行次数：`1`
- 目标调用：成功
- BSC `dealImplementation`：执行前后都是 `0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D`
- 业务影响：`0`

本次只把实现地址设置为它当前已有的同一个地址，没有发生代理升级、参数变化、代币转移、铸币或国库操作。

## ETH

| 项目 | 值 |
| --- | --- |
| Proposal | `#15` |
| 状态 | `Executed (6)` |
| 总支持质押 | `70 D` |
| DealGovernance | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| CrossChainBroadcasterV2 | `0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6` |
| 执行交易 | [`0x4bbb...2fb7`](https://etherscan.io/tx/0x4bbb1898cf6190284570f805a97786ede50ac5533989abd0999903c6a0572fb7) |
| 区块 | `25594224` |
| 交易附带跨链预算 | `0.002 ETH` |
| Broadcast nonce | `1` |

跨链消息哈希：

```text
0x96f280742490feb4ff2a8411e143f960144d2e113bd25290bd3dfebc7077dae0
```

## BSC

| 项目 | 值 |
| --- | --- |
| DualBridgeExecutorV2 | `0x407381d841DD48bBBd40Bd37f9dB268CE75950A8` |
| 目标 BSC DealFactory | `0x1Ca748Feb347d0d177E844E7D4CDCA908957c256` |
| 阈值执行交易 | [`0x14c8...8647`](https://bscscan.com/tx/0x14c80cb4991cb31283690a739a199ac39e93fc07df6fdd13de84c0e4a3748647) |
| 阈值执行区块 | `111636632` |
| 触发第 2 个确认的桥 | Axelar |
| 第 3 个确认交易 | [`0x1855...219c`](https://bscscan.com/tx/0x1855da07d7ecec0bc98373a22e77c1e43e3dd2fabd285e334d737e021ace219c) |
| 第 3 个确认区块 | `111636651` |
| 第 3 个确认的桥 | Chainlink CCIP |

`confirmStatus(messageHash)` 的最终结果：

```text
LayerZero = true
Chainlink CCIP = true
Axelar = true
count = 3
executed = true
```

机器可读记录：

```text
deployments/ccip-v2-mainnet-stage4-canary-execution.json
```
