# DAO V2 Major 提案创建与只读验证

> 日期：2026-07-20
> 网络：Ethereum mainnet（chainId `1`）
> 状态：提案已创建；未 stake、未执行升级。

## 1. 三笔授权交易

| 步骤 | 交易 | 区块 | 结果 |
| --- | --- | ---: | --- |
| 向提案钱包精确 mint 1,000 DC | `0xb9ca1fd38b53cfa94b656ba02d87733609ccfee86910e491a454c54052310e63` | 25573333 | 成功；钱包余额变为 1,000 DC |
| 向 DAO proxy 精确 approve 1,000 DC | `0xb8628123d9f7b7e8a55ab6fb132e9d93f8c9c0e0f73bf9f999574f9db9a07eb4` | 25573335 | 成功；allowance 为 1,000 DC |
| 创建 DAO V2 Major 提案 | `0xde95295e39040961c1e23b5cb010c87b03cf3559ae7ba60f34dbbac289f6d806` | 25573338 | 成功；proposalId `7` |

提案钱包：`0xE88c63D29ECE76E3336B0Db747E10876c3bf9893`。

## 2. 提案 7

| 字段 | 链上值 |
| --- | --- |
| kind | `Major`（`2`） |
| state | `Pending`（`1`） |
| proposer | `0xE88c63D29ECE76E3336B0Db747E10876c3bf9893` |
| totalStaked | `0` |
| windowEndsAt | `0` |
| vetoed / canceled / executed | `false / false / false` |
| description | `Upgrade ETH DealGovernance proxy to DAO V2 and atomically install GovernancePolicyRegistry` |
| actionsHash | `0x8c847b1b5fb32f8a9dd2ddbe6bb57a39f6ed45714951d75a1a9e90398b84b90a` |

提案只有一个 action：

```text
target = 0x9a41a9A85C16F590789C846Fb933fF8C715407F7
value  = 0
outer  = upgradeToAndCall(
           0xAAB065B8FDB3c09C207273eA53B2E0DF0EafD1e5,
           inner
         )
inner  = setPolicyRegistry(
           0xBFF01F91291476e671f0F310846D5dDb460e2382
         )
```

完整 calldata：

```text
0x4f1ef286000000000000000000000000aab065b8fdb3c09c207273ea53b2e0df0eafd1e500000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000024e015c85d000000000000000000000000bff01f91291476e671f0f310846d5ddb460e238200000000000000000000000000000000000000000000000000000000
```

链上保存的 `actionsHash` 与按 `abi.encode(targets, values, calldatas)` 重新计算的哈希完全一致。

## 3. 创建后状态

- 1,000 DC Major 提案费已从 proposer 转入 `ProtocolTreasury`。
- proposer DC 余额为 `0`，对 DAO 的 allowance 为 `0`。
- `ProtocolTreasury` DC 余额为 `2,000 DC`。
- 本次 mint 后 DC 总供应量为 `1,005,000,996.718757177718673741 DC`。
- DAO proxy 的 EIP-1967 implementation 仍为 V1：`0xECB7A086Aa87B9e2BcBbc6573fA9D0FEF7b7D1D6`。
- `policyRegistry` 对应的 slot 29 仍为零；升级尚未发生。
- 钱包 latest nonce 与 pending nonce 均为 `108`，没有待处理交易。

下一阶段必须再次得到明确授权后才能 stake；stake 授权不自动包含执行升级。未经独立明确授权，不得执行 proposal 7。
