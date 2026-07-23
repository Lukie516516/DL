# ETH DAO 提案 Reader 前端接线

更新时间：2026-07-23

## 0. ETH 主网部署

| 项目 | 值 |
| --- | --- |
| DealGovernanceReader | `0xD9470399Ac26152CF81F0EcE72E3FD3a9a907DBD` |
| DealGovernance | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| 部署交易 | [`0x3f6504...2d5a2`](https://etherscan.io/tx/0x3f6504f7bfb6435b95783aa7fe468ace7d951ae5d6dfe1785c8cd5a4a3c2d5a2) |
| 区块 | `25591769` |
| receipt | `success` |
| runtime code | `5585 bytes` |
| runtime code hash | `0x3dc10f724c02eac2cf185e1870b3cdd7d2050ea4bfbf23d764c37a6eb332386e` |
| 源码验证 | [Blockscout verified](https://eth.blockscout.com/address/0xD9470399Ac26152CF81F0EcE72E3FD3a9a907DBD#code) |

部署后只读核验：

- `governance()` 精确指向现有 DealGovernance proxy；
- `MAX_PAGE_SIZE = 50`，`MAX_STATE_BATCH_SIZE = 100`；
- `getGovernanceStats().proposalCount = 13`；
- `getProposalDetail(13, address(0))` 返回 `proposalId = 13`、`state = Pending`，描述和 actionsHash 与 DAO 直接读取一致。

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

部署前 ABI 可从以下 Hardhat artifact 取得：

```text
artifacts/contracts/DealGovernanceReader.sol/DealGovernanceReader.json
```

主网前端使用本文件第 0 节的已验证 Reader 地址。

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

枚举沿用 DAO：

- `kind`: `0 Parameter / 1 Treasury / 2 Major / 3 Satoshi`
- `currentState`: `0 Missing / 1 Pending / 2 Active / 3 Succeeded / 4 Vetoed / 5 Canceled / 6 Executed`

前端必须以 `currentState` 为准，不要只根据时间或 `totalStaked` 自行推导状态。

## 4. 什么时候仍需要事件或索引器

DAO 的 Proposal storage 没有保存 `createdAt`，该时间只存在于 `ProposalCreated` 事件。因此：

- 只展示列表、描述、状态、质押和 actions：不需要事件扫描；
- 必须显示精确创建时间：需增量读取 `ProposalCreated`，或由后端索引器保存；
- 提案量达到数百/数千后：建议后端索引事件做搜索、筛选和全文检索，但执行按钮前仍以 DAO/Reader 实时 `eth_call` 为准。

事件同步不应每次从创世区块重扫。记录上次已同步区块，只处理新增区块即可。

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
- Reader 已部署 ETH 主网；它没有接入 DAO 写路径，也没有获得任何协议权限。

## 7. 本地验证命令

专项单元测试：

```bash
node node_modules/hardhat/dist/src/cli.js test test/DealGovernanceReader.ts --network hardhatMainnet
```

ETH mainnet fork 对照测试：

```bash
DAO_READER_MAINNET_FORK=1 node node_modules/hardhat/dist/src/cli.js test test/DealGovernanceReaderMainnetFork.ts --network hardhatEthFork
```
