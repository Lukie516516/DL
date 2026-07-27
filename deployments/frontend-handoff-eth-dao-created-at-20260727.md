# ETH DAO createdAt 前端交接

更新时间：2026-07-27

## 前端必须更新的两项

1. Reader 地址切换为：
   `0xc7Df737304d57595C0a0e690F2AE3400B7225CE6`
2. Reader ABI 切换为：
   `deployments/eth-mainnet-1.json` 中的 `abi.DealGovernanceReader`

旧 Reader `0xD9470399Ac26152CF81F0EcE72E3FD3a9a907DBD` 仍可读取原字段，但没有
`createdAt`，不再作为前端推荐地址。

## 前端调用

列表页：

```text
getProposalPage(account, offset, limit, newestFirst)
```

详情页：

```text
getProposalDetail(proposalId, account)
```

两个接口返回的 `ProposalView` 均新增：

```text
createdAt: uint48
```

它是 Unix 秒级时间戳，前端按用户本地时区格式化即可。列表推荐
`newestFirst = true`、`limit = 10` 或 `20`；未连接钱包时 `account` 传零地址。

## 主网状态

| 项目 | 值 |
| --- | --- |
| DealGovernance proxy | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| 当前 implementation | `0x23Bc252571BC446FDbbf466E5C35C38cc6F6e8A5` |
| createdAt 升级提案 | `18`，状态 `Executed` |
| 升级执行交易 | `0x9682fe9201b5f55943a6259696b78bd0ea7eff6be5482bdfb990c7993eeec93d` |
| Reader V2 | `0xc7Df737304d57595C0a0e690F2AE3400B7225CE6` |
| Reader 部署交易 | `0x63023a36bd6dbcf983413cd763297d45b7b33ba4a23aeaab98039cfb6aebffad` |

提案 `1..17` 的创建时间已回填 DAO storage。提案 `18` 因为由旧 implementation
创建，其精确时间 `1785128315` 固化在 Reader V2 constructor 中。Reader 对提案
`1..18` 均返回非零且已逐条核验的 `createdAt`。

## 不变的部分

- DAO proxy 地址不变；
- 创建、质押、否决、执行、退款函数不变；
- `kind` 和 `currentState` 枚举不变；
- Reader 只有只读函数，没有 owner、升级权、资产或 DAO 写权限；
- 前端不再需要为了显示创建时间扫描 `ProposalCreated` 历史日志。

完整字段说明与 Viem 示例见：

`docs/ETH_DAO_提案Reader前端接线.md`
