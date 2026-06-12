# 前端交接文档 — v2 完整 UUPS 部署

**链**：Agiking（chainId: 31415926）  
**RPC**：`https://rpc.agikingrpc.shop`  
**部署时间**：2026-06-12T10:31:26Z  
**部署者**：`0xe88c63d29ece76e3336b0db747e10876c3bf9893`

---

## 一、全部合约地址

### 代币（地址不变）
| 合约 | 地址 |
|---|---|
| DL Token | `0x802C43662C38aAd9b4299c2f723A6B16f228217A` |
| AUSD | `0x8fc6dB736Dce11233078EA6f6EBa4c9F44E4C123` |
| USDT | `0x1035F65fc63342F9878C4D03e4372718Dbb33d32` |
| Wrapped AGI | `0x391747E54d24AA8Cef1388FE1C13f8fD57051153` |
| **D Token（新·治理席位代币）** | `0xA57b99E48f2fc24282E8F263D24468a51C5242DB` |

### Swap 池（地址不变，流动性保留）
| 合约 | 地址 |
|---|---|
| DL/AUSD 池 | `0xEb92069fDDbD0435F194E3608D37B3D2E81286c9` |
| DL/USDT 池 | `0x88b399d8E41D392Db6A56ADAAdcFb18f37c9DDFc` |
| DL/AGI 池 | `0x16FD32B9f1060392272F1145b28110C3A18fc7C5` |

### Deal 核心（新地址）
| 合约 | 地址 | 备注 |
|---|---|---|
| **DealFactory（代理）** | `0xd0Fc2685945790df25bDdeaA69426a348D05775B` | UUPS 代理，用这个 |
| DealFactory impl | `0x9c0e10155bdFE97451fcD1D159fA4B89bC8E669C` | 实现合约，不要直接用 |
| DealImplementationRegistry | `0x8bB59bb5269EE46F56fddD7BDbCC498c17B84DE3` | 新增 |
| DealPairManager | `0x66Ae5a605a566B59cFB33dbCf1DDC0cFB853A8a5` | |
| DealMessageHub | `0x84E1940E1a5Ad8100f41248254881fb6015926df` | |
| DealActivityIndex | `0x1E0b2Ba7572Df0338be4edAe63aF67C0BDdb222a` | |
| DealResultIndex | `0x7D3f79D24972d6B7A9f5D9358d550895Ed612278` | |

### Swap 层（新地址）
| 合约 | 地址 |
|---|---|
| DealSwapOrderBook | `0x71d8a47AD749aB8aAf5e184b428B2e2B6b891606` |
| DealRouter | `0x624324B79ca78d0eB45f804fA5a076bA285A5F35` |
| DealRouterQuoter | `0x0171E0445BA759bED1Dcd3AA39d5b9A9c297b56F` |
| DealSwapAssetRegistry | `0x77eA130D6b7F293579b0bcd5D19B3F22ECa45528` |

### 信息 / 读取层（新地址）
| 合约 | 地址 |
|---|---|
| DealInfoNFT | `0x7E4eD273FAc90A87Ea4C2205B7c37d4A31B08844`（不变） |
| DealInfoNFTRenderer | `0x2f678Cd7ff82f1828621718eEfb67b514F9a0C16` |
| DealCreditGraph | `0x186312887782596fbE83c964b734b485110DA4AD`（不变） |
| DealReader | `0x10340C8138c29F6772061a0aae34982e74D3780E` |

### DC Domain 层（新地址）
| 合约 | 地址 | 备注 |
|---|---|---|
| DCDomain | `0x0a18a23B7B709Ae063d9dFF397008029f2b07EB7` | |
| **DCDomainRank（代理）** | `0x347F39116BDfca98788EBD60841e14226f63c761` | UUPS 代理，用这个 |
| DCDomainRank impl | `0x4bf05220e5190cFC8A178A2Bb8b3f45049Dc103D` | 实现合约，不要直接用 |
| DCDomainRankReader | `0x3160026ffcDa4481D5601c1b2563Dde0ADf78bc7` | |
| DCDomainListReader | `0xeeCF3206152E6ca3D1938b6191e4284e15D89c75` | |
| DCDomainMarket | `0x85CaC6b96FC473f4C57A26068500514D092fe48e` | |
| DCDomainSwap | `0x79D16213e4AcdF1Fb9Cf471ffB8B812169095D34` | |
| DCDomainHall | `0x3fE565C12fB8080d946BBC56D57641f9272D472C` | |

### 治理层（全新）
| 合约 | 地址 | 备注 |
|---|---|---|
| **DealGovernance（代理）** | `0x281B18d6755869A0552088ef190ED9BBcceAfA1C` | UUPS 代理，用这个 |
| DealGovernance impl | `0xC909b5752BaA0d8eBab511eF10bdd15Ad8fa564B` | 实现合约，不要直接用 |
| DealNftGovernanceActivity | `0x9FDA424449e52D2C38Fe19080a8D681A085D536a` | 新增 |
| NftVetoRegistry | `0xD8Ed220604Fbf0F861D64CaEe2cAE88c1a7258a8` | |
| DealSeatVetoGovernor | `0x17406e466443da378817A8d69f212B4FC359e48C` | 新增 |
| VoteDividendClaimer | `0xEfe550dF7BD394c7791AA56f64efC2D938C576f9` | 新增 |

### 跨链桥（占位，未正式接入）
| 合约 | 地址 |
|---|---|
| CrossChainDispatcher | `0x42A59a08f7Ec25c75Ab97815981333F18395805b` |
| CrossChainExecutor | `0x1ABC100Ca6eaB03Ca9a0a75f65239ca9e3FE9A7e` |

---

## 二、ABI 变更清单

ABI 权威来源：`deployments/agiking-31415926.json` → `abi` 字段。

### 必须同步替换（地址+ABI 均变）

| 合约 | 新地址 | ABI 变更原因 |
|---|---|---|
| `DealFactory` | `0xd0Fc...5B` | UUPS 代理，新增 `initialize`、`upgradeTo`、`upgradeToAndCall`、`owner`、`transferOwnership`、`proxiableUUID`。原有读写函数不变。 |
| `DealImplementationRegistry` | `0x8bB5...E3` | **新合约**，用于查询可用 deal 类型。 |
| `DealPairManager` | `0x66Ae...5` | 仅地址变，ABI 不变。 |
| `DealMessageHub` | `0x84E1...f` | 仅地址变。 |
| `DealActivityIndex` | `0x1E0b...a` | 仅地址变。 |
| `DealResultIndex` | `0x7D3f...8` | 仅地址变。 |
| `DealSwapOrderBook` | `0x71d8...6` | 仅地址变。 |
| `DealRouter` | `0x624324...5` | 构造函数变为 3 个参数（WNATIVE、ORDER_BOOK、PAIR_MANAGER）。**新增 Pair 白名单校验**——未注册的交易对调用会 revert。 |
| `DealRouterQuoter` | `0x0171...F` | 仅地址变。 |
| `DealSwapAssetRegistry` | `0x77eA...8` | 仅地址变。 |
| `DealInfoNFTRenderer` | `0x2f67...6` | 仅地址变。 |
| `DealReader` | `0x1034...E` | 仅地址变。 |
| `DCDomain` | `0x0a18...7` | `tokenURI` 返回的 metadata JSON 新增 `chainId` 和 `contractAddress` 两个 attributes 字段。 |
| `DCDomainRank` | `0x347F...1` | UUPS 代理，新增 `initialize`、`upgradeTo`、`owner`。核心排名/评分函数不变。 |
| `DCDomainRankReader` | `0x3160...7` | 仅地址变。 |
| `DCDomainListReader` | `0xeeCF...5` | 仅地址变。 |
| `DCDomainMarket` | `0x85Ca...e` | 仅地址变。 |
| `DCDomainSwap` | `0x79D1...4` | 仅地址变。 |
| `DCDomainHall` | `0x3fE5...C` | 仅地址变。 |
| `DealGovernance` | `0x281B...C` | UUPS 代理，新增 `initialize`、`upgradeTo`。**质押窗口 BUG 已修复**（HIGH）。 |
| `D`（治理席位代币） | `0xA57b...B` | **新合约**，ERC-20，`burn`/`burnFrom` 已禁用（revert BurnDisabled）。ABI 与 DL Token 不同。 |
| `DealNftGovernanceActivity` | `0x9FDA...a` | **新合约**，记录治理参与行为。 |
| `NftVetoRegistry` | `0xD8Ed...8` | 新地址。 |
| `DealSeatVetoGovernor` | `0x1740...C` | **新合约**，NFT 席位否决治理。 |
| `VoteDividendClaimer` | `0xEfe5...9` | **新合约**，按治理投票比例领取分红。 |
| `CrossChainDispatcher` | `0x42A5...b` | **新合约**，跨链派发器。正式上线前需调用 `setBridgeAdapter`。 |
| `CrossChainExecutor` | `0x1ABC...e` | **新合约**，跨链执行器。正式上线前需调用 `setBridgeAdapter` + `addAuthorizedCaller`。 |

### 地址不变、ABI 不变（无需改动）

| 合约 | 地址 |
|---|---|
| `dlToken` | `0x802C...A` |
| `ausd` | `0x8fc6...3` |
| `usdt` | `0x1035...2` |
| `wrappedNative` | `0x3917...3` |
| `dealInfoNFT` | `0x7E4e...4` |
| `dealCreditGraph` | `0x1863...D` |
| `pairDlAusd` | `0xEb92...9` |
| `pairDlUsdt` | `0x88b3...c` |
| `pairDlAgi` | `0x16FD...5` |

---

## 三、功能变更与新增说明

### 3.1 UUPS 可升级代理
**涉及合约**：`DealFactory`、`DCDomainRank`、`DealGovernance`

- 前端始终指向**代理地址**（非 `*Impl` 地址）
- 后续合约升级时代理地址不变，前端不需要改地址
- 这三个合约的 ABI 新增了 `proxiableUUID()`、`upgradeToAndCall()`、`owner()`、`transferOwnership()`，非管理后台可忽略

### 3.2 DealRouter — Pair 白名单校验（C-2 修复）
- `DealRouter` 现在在执行前校验交易对是否在 `DealPairManager` 中已注册，未注册的对子会 revert
- 现有三个池子（DL/AUSD、DL/USDT、DL/AGI）都已注册，**现有 Swap UI 不受影响**
- 如需接入新交易对，需先调用 `DealPairManager.mapPair`

### 3.3 DealGovernance — 质押窗口 BUG 修复（HIGH 级别）
- 原来每次调用 `stake()` 都会把质押窗口重置为新的 1 小时，已修复
- 现在窗口只在已过期时才重新计时
- **前端 UX 影响**：多次质押的用户会看到正确的窗口状态，不再错误重置

### 3.4 DealGovernance — 质押者去重
- 内部新增 `_inStakerList` 映射，防止同一地址被重复加入列表
- 前端无感知，内部一致性修复

### 3.5 D Token — 治理席位代币（新增）
- 合约地址：`0xA57b99E48f2fc24282E8F263D24468a51C5242DB`
- ERC-20 代币，持有者可通过 `DealSeatVetoGovernor` 对提案投票或否决
- **与 DL Token 的区别**：`burn()` 和 `burnFrom()` 已禁用（调用会 revert BurnDisabled），转账正常
- 初始状态：100 枚 D 已铸造给部署者，待分配给治理席位持有人

### 3.6 DealGovernance — NFT 否决集成（新增）
- 涉及合约：`DealSeatVetoGovernor`、`NftVetoRegistry`、`DealNftGovernanceActivity`
- D Token 持有者可通过 `DealSeatVetoGovernor` 对提案行使否决权
- **注意**：`DealGovernance.nftVetoRegistry` 当前为 `address(0)`（未激活），需通过治理提案调用 `setNftVetoRegistry` 才能开启 NFT 否决功能。**未激活前不要显示 NFT 否决相关 UI**

### 3.7 VoteDividendClaimer — 投票分红（新增）
- 合约地址：`0xEfe550dF7BD394c7791AA56f64efC2D938C576f9`
- 治理参与者可按投票比例领取分红
- **前端**：在治理 UI 增加"领取分红"按钮，调用 `VoteDividendClaimer.claim()`；分红资金需由分红来源钱包提前存入

### 3.8 跨链桥（占位，新增）
- 合约：`CrossChainDispatcher`、`CrossChainExecutor`
- 当前 `bridgeAdapter` 为 `address(0)`，尚未接入真实桥
- **前端**：在管理员调用 `setBridgeAdapter` 正式接入桥之前，不要暴露跨链相关 UI

### 3.9 DCDomain + DealInfoNFT — NFT Metadata 新增字段
- `tokenURI` 返回的 JSON attributes 数组新增两个字段：
```json
{ "trait_type": "Chain ID", "value": "31415926" },
{ "trait_type": "Contract", "value": "0x..." }
```
- 如果前端有解析或展示 NFT 属性的逻辑，需兼容这两个新字段

### 3.10 DealImplementationRegistry — Deal 类型注册表（新增）
- 合约地址：`0x8bB59bb5269EE46F56fddD7BDbCC498c17B84DE3`
- 维护 deal 类型 ID → 实现合约地址的映射，取代 `DealFactory` 内的硬编码查找
- **前端**：需要展示 deal 类型时，调用 `DealImplementationRegistry.getImplementation(typeId)` 获取实现地址

### 3.11 CrossChainExecutor — 调用者鉴权修复
- `_checkCaller()` 现在强制校验授权，新增 `setBridgeAdapter()` 和 `addAuthorizedCaller()` 管理函数
- 前端无感知，管理员正式接入桥前需调用 `setBridgeAdapter`

---

## 四、需要阅读的合约文件

| 文件 | 用途 |
|---|---|
| `deployments/agiking-31415926.json` | **权威地址+ABI 来源**，所有合约都在这里 |
| `contracts/DealFactory.sol` | UUPS 代理工厂——`createDeal`、`setOpsGlobals`、`setCoreGlobals` |
| `contracts/DealGovernance.sol` | 治理——`stake`、`propose`、`vote`、`execute`；重点看质押窗口注释 |
| `contracts/DCdomainrank.sol` | 域名排名——`record`、`getScore`；`joinedAt` 对非活跃用户的修复 |
| `contracts/DealSwapRouter.sol` | Swap 路由——`swapExactTokensForTokens`、`swapTokensForExactTokens`（Pair 白名单） |
| `contracts/D.sol` | 治理席位代币——ERC-20，burn 已禁用 |
| `contracts/CrossChainDispatcher.sol` | 跨链派发器——`dispatch`、`setExecutor`、`setBridgeAdapter` |
| `contracts/CrossChainExecutor.sol` | 跨链执行器——`execute`、`setBridgeAdapter`、`addAuthorizedCaller` |
| `contracts/DealImplementationRegistry.sol` | Deal 类型注册表 |
| `contracts/VoteDividendClaimer.sol` | 投票分红领取 |

---

## 五、前端迁移 Checklist

- [ ] 替换所有有变化的合约地址（见第一节）
- [ ] 从 `deployments/agiking-31415926.json → abi` 更新所有 ABI
- [ ] **DealFactory**：指向代理地址 `0xd0Fc...5B`，不要用 Impl 地址
- [ ] **DCDomainRank**：指向代理地址 `0x347F...1`，不要用 Impl 地址
- [ ] **DealGovernance**：指向代理地址 `0x281B...C`，不要用 Impl 地址
- [ ] 新增 D Token 余额展示（注意：D Token ≠ DL Token，是两个不同合约）
- [ ] 更新 NFT metadata 解析，兼容新增的 `chainId` 和 `contractAddress` 字段
- [ ] 接入 `DealImplementationRegistry`，用于 deal 类型查询
- [ ] 治理 UI 新增 `VoteDividendClaimer.claim()` 领取分红入口
- [ ] 跨链 UI 和 NFT 否决 UI 先隐藏，等管理员配置完成后再开放
- [ ] 验证 Swap 流程正常——三个交易对均已注册白名单，预期无回归

---

## 六、接线验证（已全部上链）

29 笔接线交易全部确认：

| 操作 | 说明 |
|---|---|
| `DealFactory.setCoreGlobals` | 核心全局变量 |
| `DealFactory.setServiceGlobals` | 服务全局变量 |
| `DealFactory.setOpsGlobals` | 运营全局变量 |
| `DealFactory.setRecognizedTokens` | 认可代币列表 |
| `DealFactory.setTreasuryByAdmin` | 国库地址 |
| `DealFactory.setCrossChainGovernance` | 跨链治理地址 |
| `DealImplementationRegistry.setDealImplementations` | 6 种 deal 实现全部注册 |
| `DealPairManager.mapExistingPair` × 3 | AUSD/USDT/AGI 三个池子映射 |
| `DealSwapOrderBook.setRouter` | 路由器地址 |
| `DealInfoNFT.addFactory` / `setFactory` / `setRenderer` | NFT 工厂和渲染器 |
| `DealCreditGraph.setRecorder` | 工厂记录权限 |
| `DL Token.grantRole(MINTER)` | 工厂铸币权限 |
| `DCDomainRank.setAutoCloser` | 自动关闭者 |
| `DCDomainRank.setReporter` × 2 | DCDomainSwap + DCDomainHall 上报权限 |
| `DCDomain.setDomainMarket` | 市场地址 |
| `DealFactory.allow` × 2 | DCDomainSwap + DCDomainHall 白名单 |
| `DealNftGovernanceActivity.setRecorder` × 3 | 工厂 / NftVetoReg / VoteClaimer 记录权限 |
| `NftVetoRegistry.setGovernor` | DealSeatVetoGovernor |
| `VoteDividendClaimer.setGovernanceActivity` | 治理活动合约 |
| `VoteDividendClaimer.setGovernanceContract` | 治理主合约 |
| `CrossChainDispatcher.setExecutor` | Agiking chainId 31415926 执行器 |
