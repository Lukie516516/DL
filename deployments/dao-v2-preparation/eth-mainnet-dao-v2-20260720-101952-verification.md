# ETH Mainnet DAO V2 两合约部署与只读验证

## 部署结果

| 合约 | 地址 | 交易 | Block |
| --- | --- | --- | ---: |
| GovernancePolicyRegistry | `0xBFF01F91291476e671f0F310846D5dDb460e2382` | `0x2e892dafdb928888b4454b68679541b93c89505cb8e6990579745b80e317223e` | 25573284 |
| DealGovernance V2 implementation | `0xAAB065B8FDB3c09C207273eA53B2E0DF0EafD1e5` | `0x09124c6921c4881ac580a1f87611c9593499e4b7ec5b9de5a0a29c20d8d867e8` | 25573285 |

两笔交易均为 ETH mainnet `chainId = 1` 的成功合约创建交易，部署者为 `0xE88c63D29ECE76E3336B0Db747E10876c3bf9893`，nonce 依次为 103 和 104。

## 只读验证

- Registry runtime code：2,476 bytes。
- Registry `governance` = 现有 DAO proxy `0x9a41a9A85C16F590789C846Fb933fF8C715407F7`。
- Registry 部署 creation bytecode 与当前本地 artifact 一致。
- Registry 构造参数解码为精确 48 条生产策略。
- 48 条链上 `getRule()` 结果逐条与构造参数及本地生产策略一致。
- 规则数量：Parameter 15、Treasury 4、Major 29、Satoshi 0。
- Implementation runtime code：16,569 bytes。
- Implementation 部署 creation bytecode与当前本地 artifact 完全一致。
- Implementation `proxiableUUID()` = EIP-1967 implementation slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`。
- 部署后重跑纯只读生产 dry-run，无阻断项。

## 当前治理状态

- 现有 proxy 仍运行 V1 implementation `0xECB7A086Aa87B9e2BcBbc6573fA9D0FEF7b7D1D6`。
- proxy slot 29 仍为零。
- `proposalCount = 6`。
- 没有创建 DAO V2 Major 升级提案。
- 没有 stake，没有执行升级。

下一步必须再次获得用户明确授权，才能创建 Major 升级提案。该授权不自动包含 stake 或执行升级。
