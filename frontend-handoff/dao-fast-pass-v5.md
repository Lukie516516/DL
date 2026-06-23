# DealGovernance v5 — Fast-Pass 机制变更交接文档

> 部署日期：2026-06-22  
> 链：Agiking (chainId 31415926)

---

## 合约地址变更

| 合约 | 旧地址（v4） | 新地址（v5） |
|------|------------|------------|
| DealGovernance Proxy | `0x7228B42F791e7920CF685B7f665aC85B5aaae80d` | **`0x6f32d6c0b8bf5ca008ce246f49be77e529b09120`** |
| DealGovernance Impl  | `0xc3e…` (v4) | `0xeb8ed7502bb4a1a48559a13f316c1948ba131771` |

**前端所有 `dealGovernance` 地址引用，必须改为新的 v5 proxy 地址。**

---

## Fast-Pass 机制变更（核心）

### v4 旧逻辑（已废弃）

- 存在两个独立池：**质押池**（stake）和**支持池**（approve）
- 质押用于投票权重，`approve()` 单独用于快速通道
- 当 `approvalVotes[proposalId] >= fastPassThreshold` 时触发快速通过

### v5 新逻辑（当前）

- **只有一个池**：质押池（stake）
- 质押既代表支持，也累计快速通道计数
- 当 `totalStaked[proposalId] >= fastPassThreshold (70 D)` 时，提案**立即可执行**，无需等待倒计时结束
- `approve()` 函数**已删除**

### 逻辑说明

```
用户 stake(proposalId, amount)
    → proposal.totalStaked += amount
    → 若 totalStaked >= 70D（fastPassThreshold）且 windowEndsAt > 0（非 Pending）
      → 提案状态变为 Succeeded，可立即 execute()
```

**提案类型**：Parameter、Major 类提案支持 fast-pass；Emergency 类另有独立逻辑。

---

## 前端需要做的修改

### 1. 移除 `approve()` 相关 UI

- 删除"快速支持"/"Approve"按钮
- 删除 `approvalVotes` 的链上查询与展示
- 删除 `AlreadyApproved` 错误提示

### 2. Fast-Pass 状态展示

在提案详情页展示 fast-pass 进度：

```ts
// 查询当前质押总量
const totalStaked = await gov.read.totalStaked([proposalId])

// 查询阈值
const threshold = await gov.read.fastPassThreshold()

// 展示进度
const pct = (Number(totalStaked) / Number(threshold)) * 100
```

推荐 UI：进度条 `totalStaked / fastPassThreshold`，达到 100% 时显示"快速通道已触发"。

### 3. 状态判断

提案状态通过 `proposalState(uint256 proposalId)` 读取：

```ts
enum ProposalState {
  Pending,    // 0 — 未激活（未达 activationThreshold）
  Active,     // 1 — 倒计时中
  Succeeded,  // 2 — 可执行（倒计时结束 或 fast-pass 触发）
  Executed,   // 3
  Vetoed,     // 4
  Canceled    // 5
}
```

`Succeeded` 状态下可以调用 `execute(proposalId)`。

### 4. ABI 变更

从 v5 ABI 中移除以下内容：

```json
// 已删除，不再存在：
{ "name": "approve", ... }
{ "name": "approvalVotes", ... }
{ "name": "AlreadyApproved", ... }
{ "name": "ProposalApproved", ... }
```

新增/变更（fast-pass 判断现在读 `totalStaked`，该 mapping 始终存在）：

```json
// 读取某提案的质押总量：
{ "name": "totalStaked", "type": "function", "inputs": [{"name": "proposalId", "type": "uint256"}], "outputs": [{"type": "uint256"}] }
```

---

## 关键参数

| 参数 | 值 | 读取方法 |
|------|-----|---------|
| fastPassThreshold | 70 D (70 × 10^18) | `gov.read.fastPassThreshold()` |
| activationThreshold | 2.5 D | `gov.read.activationThreshold()` |
| D Token | `0xA57b99E48f2fc24282E8F263D24468a51C5242DB` | — |

---

## 周边合约接线（已更新，前端无需改）

| 合约 | 地址 | 已指向 v5 |
|------|------|----------|
| CrossChainDispatcher | `0x42A59a08f7Ec25c75Ab97815981333F18395805b` | ✅ |
| VoteDividendClaimer  | `0xEfe550dF7BD394c7791AA56f64efC2D938C576f9` | ✅ |
| NftVetoRegistry      | `0xD8Ed220604Fbf0F861D64CaEe2cAE88c1a7258a8` | ✅ (v5 authorized, v4 revoked) |

---

## 向后兼容

- v4 proxy 不再接受治理调用（NftVetoRegistry 已撤销授权）
- 旧的 `approve()` 调用会在前端报 `function not found`；务必在前端彻底删除
- `stake()` / `unstake()` / `vetoStake()` / `execute()` 签名不变
