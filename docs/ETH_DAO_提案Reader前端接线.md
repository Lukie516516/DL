# ETH DAO 提案 Reader 前端接线

更新时间：2026-07-27

## 0. ETH 主网部署

| 项目 | 值 |
| --- | --- |
| DealGovernanceReader V2（前端推荐） | `0xc7Df737304d57595C0a0e690F2AE3400B7225CE6` |
| DealGovernanceReader V1（旧版，只保留兼容） | `0xD9470399Ac26152CF81F0EcE72E3FD3a9a907DBD` |
| DealGovernance | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| V2 部署交易 | [`0x63023a...ffad`](https://etherscan.io/tx/0x63023a36bd6dbcf983413cd763297d45b7b33ba4a23aeaab98039cfb6aebffad) |
| V2 部署区块 | `25622898` |
| receipt | `success` |
| V2 runtime code hash | `0x27ace99bc2793f88befef69d8d3a7978716a54f1fe87d0c4402eb6ef5f7445e1` |

部署后只读核验：

- `governance()` 精确指向现有 DealGovernance proxy；
- `MAX_PAGE_SIZE = 50`，`MAX_STATE_BATCH_SIZE = 100`；
- `getGovernanceStats().proposalCount = 18`；
- `getProposalPage(address(0), 0, 18, false)` 一次返回提案 `1..18`；
- 提案 `1..17` 的 `createdAt` 与 DAO storage 及原始 `ProposalCreated` 区块时间逐条一致；
- 提案 `18` 由 Reader constructor 固化历史返回 `1785128315`；
- Reader V2 无 owner、无写函数、无资产权限，也未接入 DAO 写路径。

前端应把 Reader 地址和 ABI一起切换到 V2。V1 地址仍可读旧字段，但不返回 `createdAt`。

## 1. 结论

当前 `DealGovernance` 已经提供 `proposalCount()` 和 `getProposals(offset, limit)`，所以提案列表**不需要从创世区块扫描事件**。

前端如果感觉慢，主要原因通常是：

1. 先请求一次 `getProposals()`；
2. 再对每条提案逐个请求 `state(proposalId)`；
3. 再逐个请求 `getActions()`、`stakeOf()`、`vetoStakeOf()`；
4. 最终形成 N+1 RPC 请求和大量网络往返。

`DealGovernanceReader` 是纯只读聚合层。它不改变 DAO、不持有 D/DC、不拥有管理员权限，也不能创建、质押或执行提案。它只把多次链上读取合并为一次 `eth_call`。

## 2. 推荐接法

列表页调用：

```solidity
getProposalPage(
    address account,
    uint256 offset,
    uint256 limit,
    bool newestFirst
) returns (ProposalView[] page, uint256 total)
```

- 已连接钱包：`account` 传当前用户地址，同时返回该用户在每条提案中的支持质押和否决质押。
- 未连接钱包：`account` 传 `address(0)`，Reader 会跳过两项用户仓位查询。
- 推荐 `newestFirst = true`。
- 推荐每页 `limit = 10` 或 `20`；合约硬上限为 `50`。
- `offset` 表示按当前排序已跳过多少条，不是 proposalId。

Viem 示例：

```ts
const [page, total] = await publicClient.readContract({
  address: readerAddress,
  abi: dealGovernanceReaderAbi,
  functionName: "getProposalPage",
  args: [account ?? zeroAddress, 0n, 20n, true],
});
```

V2 ABI 从以下 Hardhat artifact 取得：

```text
artifacts/contracts/DealGovernanceReader.sol/DealGovernanceReader.json
```

主网前端使用本文件第 0 节的 V2 地址。

详情页调用：

```solidity
getProposalDetail(uint256 proposalId, address account)
```

一次返回：

- 提案完整摘要和 `state()` 权威状态；
- 当前用户支持/否决质押；
- `targets`、`values`、`calldatas` 完整 actions。

轮询卡片状态调用：

```solidity
getProposalStates(uint256[] proposalIds) returns (uint8[] states)
```

这比重新拉取所有描述和详情更轻，单批最多 `100` 个 proposalId。

DAO 面板调用：

```solidity
getGovernanceStats() returns (GovernanceStats)
```

一次返回提案计数、执行计数、各类门槛、窗口时长、Major 创建费和 NFT 否决阈值。Reader 会把跨 UTC 日期但 DAO 尚未写入重置的 `todayProposalCount` 规范化为 `0`。

## 3. ProposalView 字段

```text
proposalId
createdAt
proposer
kind
currentState
totalStaked
totalVetoStaked
accountStake
accountVetoStake
windowEndsAt
vetoed
canceled
executed
nftRegistered
satoshiSucceeded
activationReturnable
vetoer
actionsHash
description
```

`createdAt` 为 Unix 秒级时间戳。Reader V2 在 DAO implementation 尚未升级时保持可调用，
并优先使用构造时固化的已核验历史时间；DAO 升级并回填后优先返回 DAO storage 中的时间。
这使升级提案本身也能在同一次 `eth_call` 中返回精确创建时间。

枚举沿用 DAO：

- `kind`: `0 Parameter / 1 Treasury / 2 Major / 3 Satoshi`
- `currentState`: `0 Missing / 1 Pending / 2 Active / 3 Succeeded / 4 Vetoed / 5 Canceled / 6 Executed`

前端必须以 `currentState` 为准，不要只根据时间或 `totalStaked` 自行推导状态。

## 4. 什么时候仍需要事件或索引器

现网 DAO implementation 已保存 `createdAt`。在升级和 Reader V2 部署前，旧时间只存在于
`ProposalCreated` 事件；该历史兼容问题现已通过 DAO 回填和 Reader 不可变历史解决：

- 展示列表、描述、状态、质押、actions 和创建时间：均不需要事件扫描；
- 前端通过一次 Reader V2 `eth_call` 取得精确创建时间；
- 提案量达到数百/数千后：建议后端索引事件做搜索、筛选和全文检索，但执行按钮前仍以 DAO/Reader 实时 `eth_call` 为准。

事件同步不应每次从创世区块重扫。记录上次已同步区块，只处理新增区块即可。

DAO 在创建新提案时直接写入 `Proposal.createdAt`，Reader V2 的
`getProposalPage` / `getProposalDetail` 会在同一次 `eth_call` 中返回时间；历史提案通过
治理升级回填或 Reader 不可变历史兜底，不再要求前端扫描历史日志。

## 5. 不部署 Reader 的更轻方案

如果不想新增主网合约，前端可以直接使用链上已有的 `Multicall3`：

1. `proposalCount()` 确定最新 proposalId；
2. 一次批量调用多个 `getProposal(id)`、`state(id)` 和 `totalVetoStaked(id)`；
3. 打开详情页时再取 `getActions(id)`。

Multicall3 无需部署，网络提速效果与 Reader 类似。Reader 的优势是 ABI 更稳定、返回结构更适合页面、前端代码更少；Multicall3 的优势是无需额外部署。

## 6. 安全和部署边界

- Reader 是不可升级、无 owner、无写函数、无资产托管的只读合约。
- constructor 只固定现有 `DealGovernance` proxy 地址；DAO implementation 后续升级时 proxy 地址不变，Reader 仍可用，但 ABI 若不兼容需重新评估。
- Reader 部署不需要 DAO 提案，因为它没有权限，也不会接入 DAO 的写路径。
- 现网 Reader V1 继续保留；它没有接入 DAO 写路径，也没有获得任何协议权限。
- Reader V2 已部署且仍是无 owner、无写函数、无资产托管的辅助合约；部署 Reader V2 本身不需要提案。
- Reader V2 constructor 接收严格递增的历史 proposalId/createdAt；部署完成后没有修改函数。
- `Proposal.createdAt` 属于 DAO implementation 变更，必须经过 Major 提案和 UUPS 治理升级。
- 截至 2026-07-27，createdAt 的新 DAO implementation
  `0x23Bc252571BC446FDbbf466E5C35C38cc6F6e8A5` 已由 Major 提案 `#18` 完成升级；
  提案 `1..17` 已回填，Reader V2 已部署并逐条验证，前端应使用 V2。

## 7. 本地验证命令

专项单元测试：

```bash
node node_modules/hardhat/dist/src/cli.js test test/DealGovernanceReader.ts --network hardhatMainnet
```

DAO 存储布局检查：

```bash
npm run dao:v2:storage
```

ETH mainnet fork 对照测试：

```bash
npm run test:dao-created-at:fork
```

该专项测试固定在升级前主网区块 `25621896`，用于长期复现 implementation 切换、历史
回填和 Reader V2 兼容性；Node 25 的 Hardhat reporter 存在 `grey/gray` 兼容问题，推荐
使用 Node 22。
