# ETH DAO V2 前端交接

> 历史快照：本文记录 proposal `7` 刚执行后的 48 条基础策略状态。其后 proposal `8` 已开放 Satoshi/分红四条规则，proposal `9` 已创建首轮分红。当前接入请使用 `docs/ETH_DAO_V2_国库中本聪分红前端交接.md`。

生成时间：2026-07-21T03:44:39.551Z

## 地址

| 合约 | 地址 | 前端处理 |
| --- | --- | --- |
| DealGovernance 代理 | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` | 地址不变，继续使用该地址 |
| DealGovernance V2 implementation | `0xAAB065B8FDB3c09C207273eA53B2E0DF0EafD1e5` | 只用于审计展示，不作为业务调用地址 |
| GovernancePolicyRegistry | `0xBFF01F91291476e671f0F310846D5dDb460e2382` | 可读取治理动作白名单 |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` | DAO 控制的协议国库 |

## 升级结果

- 升级提案：`7`，状态为 Executed。
- 升级交易：`0x7ce0d235e82c946f0974640acc6c41eb4aa23d2628a20e0f5e95f089e92ccb64`，区块：`25578119`。
- 治理代理地址未变化，历史提案和质押数据保留。
- V2 新增 `policyRegistry()`，当前为 `0xBFF01F91291476e671f0F310846D5dDb460e2382`。
- 生产策略共 48 条；Satoshi 动作当前仍是 deny-all，等待 SatoshiVault 部署后再由重大提案精确开放。
- Satoshi 的“达到 90 D 后永久成功”仅作用于达到阈值的那一条提案，不影响其他提案。

## ABI

完整 ABI 已写入 `deployments/eth-mainnet-1.json`：

- `abi.DealGovernance`
- `abi.GovernancePolicyRegistry`
