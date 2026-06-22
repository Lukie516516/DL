# DAO 集体否决功能上线 (v4)

**部署时间**: 2026-06-22  
**链**: Agiking (chainId 31415926)  
**部署者**: `0xe88c63d29ece76e3336b0db747e10876c3bf9893`

---

## 合约地址变更

| 合约 | 旧地址 | 新地址 |
|------|--------|--------|
| DealGovernance (proxy) | `0x281B18d6755869A0552088ef190ED9BBcceAfA1C` | `0x7228B42F791e7920CF685B7f665aC85B5aaae80d` ✅ |
| DealGovernance (impl)  | `0xC909b5752BaA0d8eBab511eF10bdd15Ad8fa564B` | `0x130Cf21B8D980313425eE2C241181221931060Bf` |

> **前端只需更新 proxy 地址**，impl 地址仅供链上核查使用。

其余合约地址**不变**：DealFactory、D Token、VoteDividendClaimer 等均不受影响。

---

## ABI 变更

使用 `deployments/agiking-31415926.json` 中 `abi.DealGovernance` 字段，或重新从 `artifacts/contracts/DealGovernance.sol/DealGovernance.json` 导出。

### 新增函数

#### `vetoStake(uint256 proposalId, uint256 amount)`

任何人可将 D Token 投入集体否决池，无需一次性持有 2.5 D。

```ts
// 调用前需先 approve DealGovernance proxy 合约
await dToken.write.approve([GOV_PROXY, amount]);
await governance.write.vetoStake([proposalId, amount]);
```

**限制**：
- Treasury 类提案不支持集体否决（保持原逻辑）
- Parameter / Major 提案须在窗口期内
- amount 不能为 0

**触发条件**：当 `totalVetoStaked[proposalId] >= 2.5 D`，提案立即变为 `Vetoed` 状态

#### `claimBack(uint256 proposalId)`（已有函数，行为扩展）

提案结束后同时退还**支持票**和**否决票**，一次调用取回全部。

```ts
await governance.write.claimBack([proposalId]);
```

### 新增只读方法

```ts
// 查询某地址在某提案上的否决质押量
const myVetoStake = await governance.read.vetoStakeOf([proposalId, userAddress]);

// 查询某提案当前累计否决质押总量
const total = await governance.read.totalVetoStaked([proposalId]);
```

### 新增 Event

```ts
// 每次 vetoStake 调用触发
event VetoStaked(
  uint256 indexed proposalId,
  address indexed staker,
  uint256 amount,
  uint256 vetoTotal    // 累计总量，前端可用于显示进度条
)

// claimBack 退还否决票时触发
event VetoStakeClaimed(
  uint256 indexed proposalId,
  address indexed staker,
  uint256 amount
)
```

---

## 否决流程对比

| | 旧版 | v4 新增 |
|---|---|---|
| 直接否决 | 持有 ≥ 2.5 D，调 `veto()` | 不变 |
| 集体否决 | 不支持 | `vetoStake()` 分次投入，D 被锁定 |
| 取回 D | `claimBack()` 仅退支持票 | `claimBack()` 同时退支持票 + 否决票 |

---

## UI 建议

1. **提案详情页** 新增"集体否决进度"进度条：`totalVetoStaked / 2.5D × 100%`
2. **否决操作** 提供两个入口：
   - "直接否决"（≥2.5 D，即时生效，D 不锁定）
   - "投否决票"（任意金额，D 锁定至提案结束）
3. **我的资产** 显示用户在各提案的否决质押，提示可 `claimBack`
4. **事件监听** 订阅 `VetoStaked` 事件实时更新否决进度

---

## 接线状态确认（部署脚本已执行）

- `CrossChainDispatcher.governance` → 新 proxy ✅
- `NftVetoRegistry` governor → 新 proxy ✅（旧 proxy 权限已撤销）
- `VoteDividendClaimer.governanceContract` → 新 proxy ✅
