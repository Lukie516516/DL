# ETH 主网 DealGovernance 补全部署

部署时间：2026-07-07T03:30:05.146Z

链：Ethereum Mainnet (1)

部署钱包：`0xE88c63D29ECE76E3336B0Db747E10876c3bf9893`

## 新增 / 更新地址

| 模块 | 地址 |
| --- | --- |
| DealGovernance proxy | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| DealGovernance implementation | `0xECB7A086Aa87B9e2BcBbc6573fA9D0FEF7b7D1D6` |
| CrossChainBroadcaster | `0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf` |
| D | `0x61921ecb954ffaaf8cd3fd2e71eecb14b3ed529f` |
| DealCoin/DC | `0x591625be924b98accab7e2c8af698c858aa2608d` |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` |
| NftVetoRegistry | `0xd8de3603d341584e0aef843ee8f4c00288179177` |
| VoteDividendClaimer | `0xc42afc0a57e90c41ec3dd29a6b6794a81737f9f3` |

## 接线结果

- `NftVetoRegistry.isGovernor(DealGovernance) = true`
- `VoteDividendClaimer.governanceContract = DealGovernance`
- `CrossChainBroadcaster.governance = DealGovernance`

## 前端对接

- 完整 DAO 页面使用 `DealGovernance` ABI + `dealGovernance` 地址。
- 旧 `DealSeatVetoGovernor` 仍在部署文件中，但只作为旧席位否决制入口，不作为完整 DAO 主入口。
- 跨链参数广播入口仍是 `CrossChainBroadcaster`，但现在只能由 `DealGovernance.execute()` 调用。
