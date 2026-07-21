# 跨链治理架构

主网脚本和参数清单见：`docs/ETH_BSC主网脚本与参数清单.md`。

## 一、链的角色

| 链 | 角色 |
|----|------|
| ETH 主网 | 治理链：DealGovernance（DAO）+ CrossChainBroadcaster 部署在这里 |
| BSC 主网 | 执行链：DualBridgeExecutor + 协议合约（DealFactory 等） |
| Polygon | 执行链：DualBridgeExecutor + 协议合约（同 BSC 模式） |
| Tron | 执行链：DualBridgeExecutor（当前仅 WH；LZ/Axelar 不支持 Tron，若要双桥需另接 deBridge 等通道） |
| Agiking | 独立链，有自己的 DealFactory，不接入跨链治理层 |

---

## 二、多链扇出架构（CrossChainBroadcaster v2）

```
ETH 主网
  DealGovernance（提案通过）
    └→ CrossChainBroadcaster.broadcast(chainIds[], targets[], calldata, gasLimit)
         │
         ├── [BSC] ───────────────────────────────────────────────
         │    ├──[LayerZero]──→ DualBridgeExecutor.lzReceive()
         │    ├──[Wormhole]───→ DualBridgeExecutor.receiveWormholeMessages()
         │    └──[Axelar]─────→ DualBridgeExecutor.execute()
         │    threshold = 2（任意 2 条桥到达即执行）
         │
         ├── [Polygon] ───────────────────────────────────────────
         │    ├──[LayerZero]──→ DualBridgeExecutor.lzReceive()
         │    ├──[Wormhole]───→ DualBridgeExecutor.receiveWormholeMessages()
         │    └──[Axelar]─────→ DualBridgeExecutor.execute()
         │    threshold = 2
         │
         └── [Tron] ──────────────────────────────────────────────
              └──[Wormhole]───→ DualBridgeExecutor.receiveWormholeMessages()
              threshold = 1（LZ 不支持 Tron TVM；Axelar 亦不支持 Tron；WH 是唯一通路）
              ⚠️ 单桥无拜占庭容错：WH 被攻击 = Tron 治理被绕过
              可选方案：接入 deBridge（支持 Tron）作为第二桥，threshold 提升至 2
```

---

## 三、每链独立配置（ChainConfig）

Broadcaster 维护一个 `chainId → ChainConfig` 映射，每条链独立注册：

| 字段 | 含义 |
|------|------|
| `lzDstEid` | LZ endpoint ID（0 = 该链不用 LZ，如 Tron） |
| `whDstChain` | WH chain ID（0 = 该链不用 WH） |
| `whDstAddress` | 目标链的 DualBridgeExecutor 地址 |
| `axDstChain` | Axelar 链名（"" = 该链不用 AX） |
| `axDstAddress` | 目标链 DualBridgeExecutor 地址字符串。当前主网配置使用全小写，已被 Axelar 接受。 |
| `axMinFee` | Axelar 预付 gas（wei），手动配置 |
| `active` | false = 暂停该链但保留配置 |

**广播逻辑**：`broadcast()` 遍历所有 `active=true` 的链，按链的配置分别调用 LZ / WH / AX，每条链花费的费用分开计算和扣除。由于 ETH / BSC / Polygon 上同一业务合约地址通常不同，调用方必须传入 `chainIds[]` 和 `targets[]`，为每条目标链指定自己的被调用合约地址。

**费用预估**：`quoteFees(chainIds, targets, data, lzGas)` 返回所有活跃链的总费用，调用方在发起 broadcast 前先查询。`chainIds` 必须覆盖所有 active 链，否则对应链会因为缺少 target 直接 revert。

---

## 四、Tron 特殊处理

**经确认：LZ 和 Axelar 均不支持 Tron TVM。**

- LZ V2：不支持 Tron（EID 不存在）
- Axelar：官方支持链列表中无 Tron，无 Gateway 部署，GMP 无法使用
- WH：✅ 支持 Tron（chain ID = 1）

Tron ChainConfig 配置：
```
lzDstEid  = 0    // skip LZ
whDstChain = 1   // WH Tron chain ID
axDstChain = ""  // skip AX（Axelar 不支持 Tron）
axMinFee   = 0
```

Tron 的 DualBridgeExecutor 部署时：
- `threshold = 1`（WH 唯一通路，1-of-1）
- `whSrcChain = 2`（WH Ethereum 主网 chainId）

**安全警告：** threshold=1 + 单桥 = 无拜占庭容错。WH relayer 被攻击时 Tron 端可接受任意治理消息。

**推荐升级路径：** 接入 deBridge（支持 Tron，WH + deBridge = 2-of-2），将 threshold 提升至 2。需要定制 DualBridgeExecutor 增加 deBridge 接收逻辑。

---

## 五、安全模型

| 保护层 | 机制 |
|--------|------|
| 防重放 | 每条目标链单独使用 `msgHash = keccak256(nonce, target, calldata)`，`executed[msgHash]=true` 先于 call |
| 多数确认 | threshold=2（BSC/Polygon）任意 2 桥，Tron threshold=1 |
| LZ 来源 | OAppBase peer 注册，只接受 CrossChainBroadcaster |
| WH 来源 | `msg.sender == wormholeRelayer` + `srcChain` + `srcAddress` |
| AX 来源 | `gateway.validateContractCall()` + srcChain + srcAddress 字符串匹配 |
| AX 来源地址格式 | `axSrcAddress` 必须与 Axelar 传入的 `sourceAddress` 完全一致。ETH 主网实测为 checksum 格式，强行转全小写会导致 AX 来源验证失败 |
| WH 地址格式 | `bytes32(uint256(uint160(addr)))` 左补零；右补零格式会导致 WH 消息全部被拒 |
| 执行目标 | `allowedTargets[target]` 白名单，未注册地址调用被 emit+skip |

---

## 六、主网部署顺序

### 阶段 1：ETH 主网
1. 部署 ETH 侧协议合约、D、DAO / Governor。
2. 部署 `CrossChainBroadcaster`（endpoint, delegate, governance, WH relayer, AX gateway, AX gasService）。
3. 此时可以先不注册 BSC 链，或注册为 `active=false`。因为 BSC executor 地址还没出来，不能正式广播。

### 阶段 2：BSC 主网
4. 部署 BSC 侧协议目标合约（DealFactory 等）。
5. 部署 `DualBridgeExecutor`（threshold=2），构造参数中写入 ETH `CrossChainBroadcaster` 作为 WH / AX source。
6. 在 BSC executor 上 `setAllowedTarget(factory, true)` 等，只允许 DAO 要控制的目标合约。
7. 在 BSC executor 上 `setPeer(ETH_EID, bytes32(broadcasterAddr))`。
8. 在 BSC executor 上 `setWhSrc(2, bytes32(uint256(uint160(broadcasterAddr))))`。
9. 在 BSC executor 上 `setAxSrc("Ethereum", broadcasterAddr)`。这里的 `broadcasterAddr` 要与 Axelar 传入的 `sourceAddress` 完全一致，主网实际为 checksum 格式；不要强行转全小写。Axelar 链名大小写敏感，ETH 主网官方链名是 `Ethereum`，BSC 主网官方链名是 `binance`。

### 阶段 3：ETH 回填 BSC 配置
10. 在 ETH broadcaster 上 `addChain` / `setChain` 注册 BSC 链配置，写入 BSC executor 地址。
11. 在 ETH broadcaster 上 `setPeer(BSC_EID, bytes32(executorAddr))`。
12. 确认 LZ / WH / AX 地址和 chain id 都是主网值后，再 `setChainActive(bscKey, true)`。

### 阶段 4：冒烟测试
13. 发一条低风险参数 broadcast，确认 BSC 端正常执行。
14. 验证：`executor.confirmStatus(msgHash)` — count >= 2, executed=true。

### 阶段 5：正式交接
15. 推荐先使用 `DealFactory.setCrossChainGovernance(executorAddr)` 接入跨链治理，而不是立刻转移 owner。
16. 灰度稳定后，再决定是否把 owner 迁移到 Timelock / Executor / 多签。
17. `broadcaster.setGovernance(dealGovernanceAddr)` — 只有 DAO 才能广播。

### Polygon / Tron
- Polygon 重复 BSC 流程，使用三桥 `threshold=2`。
- Tron 当前只能走 WH 单桥，使用 `threshold=1` + `lzDstEid=0` + `axDstChain=""`。
- 如果后续接入 deBridge 等第二条支持 Tron 的通道，再把 Tron 提升为双桥确认模式。

---

## 七、合约状态说明

| 合约 | 状态 | 链 |
|------|------|----|
| `CrossChainBroadcaster.sol` | **生产** | ETH 主网，多链扇出 |
| `DualBridgeExecutor.sol` | **生产** | 各副链，2-of-3（Tron 1-of-1 或 1-of-2） |
| `LZGovernanceDispatcher.sol` | 保留 | 单桥降级备用 |
| `LZGovernanceExecutor.sol` | 保留 | 单桥降级备用 |
| `CrossChainDispatcher.sol` | 占位 | Agiking，`_sendMessage` 为空，不会真的跨链发送 |
| `CrossChainExecutor.sol` | 占位 | Agiking，`bridgeAdapter` 未设置，仅 owner 紧急手动模式 |

---

## 八、已验证

测试网端到端（Sepolia → BSC testnet）：
- `CrossChainBroadcaster.broadcast([BSC], [MockTarget], setParam(42))` 发出
- LZ 约 60s 到达，WH 手动 deliver（0.01 BNB）到达，2 条确认满足 threshold=2
- `MockTarget.param = 42`，callCount = 1，无重复执行 ✅
