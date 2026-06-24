# DealResultIndexV2 升级说明

**升级日期**：2026-06-24  
**网络**：Agiking（chainId 31415926）  
**操作人**：0xe88c63d29ece76e3336b0db747e10876c3bf9893

---

## 一、本次做了什么

将 DealFactory 的链上结果索引合约从 **DealResultIndex（V1）** 切换到 **DealResultIndexV2（V2）**。

| 合约 | 地址 | 状态 |
|---|---|---|
| DealResultIndex V1 | `0x7D3f79D24972d6B7A9f5D9358d550895Ed612278` | 保留在链上（只读，历史数据） |
| DealResultIndexV2 | `0x27Acf92bcF76A40f55b134E5Ab45F6c298907A59` | **当前生效** |
| DealFactory | `0xd0Fc2685945790df25bDdeaA69426a348D05775B` | 无改动，已指向 V2 |

**切换区块**：`3,078,036`  
**接线交易**：`0xe20b70998dfd68ed5f9db33f6e1320a039e0660dd08cab3c1cd511f3e710fc9f`

---

## 二、为什么要升级

V1 将每笔 deal 的所有数据（奖励记录、信用记录、时间线）全部写入链上 storage，Gas 消耗极高：

| 操作 | V1 gas | V2 gas | 节省 |
|---|---|---|---|
| 每次 recordTimeline（7次/deal） | ~15,000 gas × 7 | ~2,000 gas × 7 | ~91,000 gas |
| recordReward | ~210,000 gas | ~50,000 gas | ~160,000 gas |
| recordCredit | ~200,000 gas | ~50,000 gas | ~150,000 gas |
| **合计（每笔完整 deal）** | **~1,010,000 gas** | **~243,000 gas** | **~777,000 gas** |

V2 的做法：
- **时间线（Timeline）**：不写 storage，改为 emit `DealTimeline` event
- **奖励记录（Reward）**：只保留"用户 → deal 列表"索引，详细数据改为 emit `DealReward` event
- **信用记录（Credit）**：只保留"tokenId → deal 列表"索引，详细数据改为 emit `DealCredit` event

DealFactory 代码**零改动**，对正在进行的业务无任何影响。

---

## 三、链上行为变化

### 3.1 切换点（区块 3,078,036）前后

| 区块 | 数据去哪里 |
|---|---|
| < 3,078,036（历史） | V1 合约 storage，用 V1 的 view 函数查询 |
| ≥ 3,078,036（当前） | V2 events + V2 的 view 函数查询列表 |

### 3.2 跨越切换点的进行中 deal

如果一笔 deal 在切换前创建、切换后完成，它的数据会分布在两个地方：

- 切换前的 `recordTimeline` 调用 → **V1 storage**
- 切换后的 `recordTimeline` 调用 → **V2 `DealTimeline` events**
- `recordReward` / `recordCredit`（deal 完成时调用）→ **V2**（因为完成在切换后）

前端需要在展示 timeline 时，以切换区块为界，分别从 V1 和 V2 取数据并拼接。

---

## 四、前端需要做什么

### 4.1 新增的 V2 合约 ABI 和地址

```
V2 合约地址：0x27Acf92bcF76A40f55b134E5Ab45F6c298907A59
切换区块：    3,078,036
V1 合约地址：0x7D3f79D24972d6B7A9f5D9358d550895Ed612278（只读历史）
```

### 4.2 查询方式对照表

#### 用户 Deal 列表

| | V1 | V2（当前） |
|---|---|---|
| 调用 | `v1.getRewardDeals(user, offset, limit, newestFirst)` | `v2.getDealsByUser(user, offset, limit, newestFirst)` |
| 数量 | `v1.rewardDealCount(user)` | `v2.dealCountByUser(user)` |
| 说明 | 包含所有历史 deal | 只包含 V2 切换后完成的 deal |

> **注意**：V2 的列表从切换后开始累积，历史数据还在 V1。展示用户完整历史需要合并两个列表（先查 V1 全量，再追加 V2 列表，去重）。

#### Deal 时间线（Timeline）

| | V1 | V2（当前） |
|---|---|---|
| 调用 | `v1.getTimeline(deal, offset, limit, newestFirst)` | 查询 `DealTimeline` events |
| Event 过滤 | — | `{ address: v2Address, event: 'DealTimeline', args: { deal: dealAddress } }` |
| Event 签名 | — | `DealTimeline(address indexed deal, uint8 action, address actor, bool isPartyA, uint256 value, uint64 timestamp)` |

```typescript
// 查 V2 的 timeline（切换后）
const logs = await publicClient.getContractEvents({
  address: V2_ADDRESS,
  abi: V2_ABI,
  eventName: 'DealTimeline',
  args: { deal: dealAddress },
  fromBlock: 3078036n,
});

// 查 V1 的 timeline（切换前，用于历史 deal 或跨越切换点的 deal）
const v1Timeline = await v1Contract.read.getTimeline([dealAddress, 0n, 100n, false]);
```

#### 奖励记录（Reward）

| | V1 | V2（当前） |
|---|---|---|
| 单笔 deal 详情 | `v1.rewardOfDeal(deal)` 返回 `RewardRecord` struct | 查 `DealReward` event |
| 用户所有奖励 | `v1.getRewards(user, offset, limit, newestFirst)` | 先用 `v2.getDealsByUser()` 获取 deal 列表，再批量查 `DealReward` events |
| Event 签名 | — | `DealReward(address indexed deal, address indexed partyA, address indexed partyB, uint256 toA, uint256 toB, address cAddr, uint256 toC, uint64 timestamp)` |

```typescript
// 查 V2 的 DealReward event（可以按 deal 地址过滤）
const rewardLogs = await publicClient.getContractEvents({
  address: V2_ADDRESS,
  abi: V2_ABI,
  eventName: 'DealReward',
  args: { deal: dealAddress },
});
```

#### NFT 信用记录（Credit）

| | V1 | V2（当前） |
|---|---|---|
| NFT deal 列表 | `v1.getCreditDeals(tokenId, offset, limit, newestFirst)` | `v2.getDealsByToken(tokenId, offset, limit, newestFirst)` |
| 数量 | `v1.creditDealCount(tokenId)` | `v2.dealCountByToken(tokenId)` |
| 单笔 deal 详情 | `v1.creditOfDeal(deal)` | 查 `DealCredit` event |
| Event 签名 | — | `DealCredit(address indexed deal, uint256 indexed aTokenId, uint256 indexed bTokenId, uint256 aDelta, uint256 bDelta, uint64 timestamp)` |

### 4.3 推荐的兼容实现思路

```typescript
const CUTOFF_BLOCK = 3078036n;

// 获取用户完整 deal 列表（跨 V1 + V2）
async function getUserDeals(user: string) {
  const [v1List, v2List] = await Promise.all([
    v1Contract.read.getRewardDeals([user, 0n, 100n, false]),
    v2Contract.read.getDealsByUser([user, 0n, 100n, false]),
  ]);
  // v1 包含历史，v2 只包含切换后的，直接合并（无重叠）
  return [...v1List, ...v2List];
}

// 获取 deal 完整 timeline（跨 V1 + V2）
async function getDealTimeline(dealAddress: string) {
  const [v1Records, v2Logs] = await Promise.all([
    // V1：storage 里的历史记录
    v1Contract.read.getTimeline([dealAddress, 0n, 100n, false]),
    // V2：切换后的 events
    publicClient.getContractEvents({
      address: V2_ADDRESS,
      abi: V2_ABI,
      eventName: 'DealTimeline',
      args: { deal: dealAddress },
      fromBlock: CUTOFF_BLOCK,
    }),
  ]);
  // 拼接，V1 在前（时间更早），V2 在后
  return [...v1Records, ...v2Logs.map(log => log.args)];
}
```

### 4.4 不需要改动的部分

以下功能不受影响，前端无需修改：

- 创建 deal（`createDeal`）
- 参与 deal（`join`、`pay`、`vote` 等）
- Deal 状态查询（直接读 Deal 合约）
- 信用分查询（`dealCreditGraph.creditScore(tokenId)`）
- 治理、DAO 相关功能

---

## 五、V2 合约 ABI（关键函数）

```json
[
  {
    "name": "getDealsByUser",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      { "name": "user", "type": "address" },
      { "name": "offset", "type": "uint256" },
      { "name": "limit", "type": "uint256" },
      { "name": "newestFirst", "type": "bool" }
    ],
    "outputs": [{ "name": "list", "type": "address[]" }]
  },
  {
    "name": "dealCountByUser",
    "type": "function",
    "stateMutability": "view",
    "inputs": [{ "name": "user", "type": "address" }],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  {
    "name": "getDealsByToken",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      { "name": "tokenId", "type": "uint256" },
      { "name": "offset", "type": "uint256" },
      { "name": "limit", "type": "uint256" },
      { "name": "newestFirst", "type": "bool" }
    ],
    "outputs": [{ "name": "list", "type": "address[]" }]
  },
  {
    "name": "dealCountByToken",
    "type": "function",
    "stateMutability": "view",
    "inputs": [{ "name": "tokenId", "type": "uint256" }],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  {
    "name": "DealTimeline",
    "type": "event",
    "inputs": [
      { "name": "deal",      "type": "address", "indexed": true },
      { "name": "action",    "type": "uint8",   "indexed": false },
      { "name": "actor",     "type": "address", "indexed": false },
      { "name": "isPartyA",  "type": "bool",    "indexed": false },
      { "name": "value",     "type": "uint256", "indexed": false },
      { "name": "timestamp", "type": "uint64",  "indexed": false }
    ]
  },
  {
    "name": "DealReward",
    "type": "event",
    "inputs": [
      { "name": "deal",      "type": "address", "indexed": true },
      { "name": "partyA",    "type": "address", "indexed": true },
      { "name": "partyB",    "type": "address", "indexed": true },
      { "name": "toA",       "type": "uint256", "indexed": false },
      { "name": "toB",       "type": "uint256", "indexed": false },
      { "name": "cAddr",     "type": "address", "indexed": false },
      { "name": "toC",       "type": "uint256", "indexed": false },
      { "name": "timestamp", "type": "uint64",  "indexed": false }
    ]
  },
  {
    "name": "DealCredit",
    "type": "event",
    "inputs": [
      { "name": "deal",       "type": "address", "indexed": true },
      { "name": "aTokenId",   "type": "uint256", "indexed": true },
      { "name": "bTokenId",   "type": "uint256", "indexed": true },
      { "name": "aDelta",     "type": "uint256", "indexed": false },
      { "name": "bDelta",     "type": "uint256", "indexed": false },
      { "name": "timestamp",  "type": "uint64",  "indexed": false }
    ]
  }
]
```

---

## 六、测试覆盖

本次变更附带完整测试套件 `test/DealResultIndexV2.ts`，共 **34 个测试**，全部通过：

- recordTimeline：event 正确发出，边界条件跳过（deal=0, action=0）
- recordReward：event 正确，用户列表写入正确，去重
- recordCredit：event 正确，tokenId 列表写入正确，去重
- 分页：offset / limit / newestFirst 全覆盖
- 权限控制：非 factory 调用全部 revert
- **V1 vs V2 对比**：同样调用序列，用户列表和 token 列表与 V1 完全一致
