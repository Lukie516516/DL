# 前端交接文档 — 4 合约更新部署

**部署时间：** 2026-06-20
**链：** Agiking / AISO（chainId 31415926）
**RPC：** https://rpc.agikingrpc.shop
**部署钱包：** `0xe88c63d29ece76e3336b0db747e10876c3bf9893`

---

## 本次变更合约（需更新前端地址）

| 合约 | 旧地址 | 新地址 |
|------|--------|--------|
| DCDomainHall | `0x3fE565C12fB8080d946BBC56D57641f9272D472C` | `0x1682f3968158f34051e76f95D8B0E2Eb329Bb6ad` |
| DealSeatVetoGovernor | `0x17406e466443da378817A8d69f212B4FC359e48C` | `0x7ffadaAAA346728Af0222B8a1E8D52261F6AEBa0` |
| DCDomainListReader | `0xeeCF3206152E6ca3D1938b6191e4284e15D89c75` | `0x57DD9E0471C313Cc09B1123D384467A081DC776c` |
| DCdomainrank (实现) | `0x4bf05220e5190cFC8A178A2Bb8b3f45049Dc103D` | `0x4611F6455D4DB317378573f1825E33BBF4B32DEF` |

> DCdomainrank **代理地址不变**：`0x347F39116BDfca98788EBD60841e14226f63c761`

---

## 完整合约地址表（截至 2026-06-20）

| 模块 | 合约 | 地址 |
|------|------|------|
| 核心代币 | DL (DCToken) | `0x802C43662C38aAd9b4299c2f723A6B16f228217A` |
| 核心代币 | AUSD | `0x8fc6dB736Dce11233078EA6f6EBa4c9F44E4C123` |
| 核心代币 | USDT | `0x1035F65fc63342F9878C4D03e4372718Dbb33d32` |
| 核心代币 | WAGI (WrappedNative) | `0x391747E54d24AA8Cef1388FE1C13f8fD57051153` |
| NFT | DealInfoNFT | `0x7E4eD273FAc90A87Ea4C2205B7c37d4A31B08844` |
| NFT | DealInfoNFTRenderer | `0x2f678Cd7ff82f1828621718eEfb67b514F9a0C16` |
| 工厂 | DealFactory | `0xd0Fc2685945790df25bDdeaA69426a348D05775B` |
| 工厂 | DealImplementationRegistry | `0x8bB59bb5269EE46F56fddD7BDbCC498c17B84DE3` |
| swap | DealPairManager | `0x66Ae5a605a566B59cFB33dbCf1DDC0cFB853A8a5` |
| swap | DealRouter | `0x624324B79ca78d0eB45f804fA5a076bA285A5F35` |
| swap | DealRouterQuoter | `0x0171E0445BA759bED1Dcd3AA39d5b9A9c297b56F` |
| swap | DealSwapOrderBook | `0x71d8a47AD749aB8aAf5e184b428B2e2B6b891606` |
| swap | DealSwapAssetRegistry | `0x77eA130D6b7F293579b0bcd5D19B3F22ECa45528` |
| swap pair | DC-WAGI | `0x16FD32B9f1060392272F1145b28110C3A18fc7C5` |
| swap pair | DC-AUSD | `0xEb92069fDDbD0435F194E3608D37B3D2E81286c9` |
| swap pair | DC-USDT | `0x88b399d8E41D392Db6A56ADAAdcFb18f37c9DDFc` |
| 消息 | DealMessageHub | `0x84E1940E1a5Ad8100f41248254881fb6015926df` |
| 索引 | DealActivityIndex | `0x1E0b2Ba7572Df0338be4edAe63aF67C0BDdb222a` |
| 索引 | DealResultIndex | `0x7D3f79D24972d6B7A9f5D9358d550895Ed612278` |
| 索引 | DealCreditGraph | `0x186312887782596fbE83c964b734b485110DA4AD` |
| 阅读器 | DealReader | `0x10340C8138c29F6772061a0aae34982e74D3780E` |
| 域名 | DCDomain | `0x0a18a23B7B709Ae063d9dFF397008029f2b07EB7` |
| 域名排行 | DCdomainrank (proxy) | `0x347F39116BDfca98788EBD60841e14226f63c761` |
| 域名排行 | DCDomainRankReader | `0x3160026ffcDa4481D5601c1b2563Dde0ADf78bc7` |
| 域名列表 | **DCDomainListReader** ★新 | `0x57DD9E0471C313Cc09B1123D384467A081DC776c` |
| 域名市场 | DCDomainMarket | `0x85CaC6b96FC473f4C57A26068500514D092fe48e` |
| 域名交换 | DCDomainSwap | `0x79D16213e4AcdF1Fb9Cf471ffB8B812169095D34` |
| 域名大厅 | **DCDomainHall** ★新 | `0x1682f3968158f34051e76f95D8B0E2Eb329Bb6ad` |
| 治理代币 | D Token | `0xA57b99E48f2fc24282E8F263D24468a51C5242DB` |
| 治理 | DealGovernance (proxy) | `0x281B18d6755869A0552088ef190ED9BBcceAfA1C` |
| 治理 | NftVetoRegistry | `0xD8Ed220604Fbf0F861D64CaEe2cAE88c1a7258a8` |
| 治理 | **DealSeatVetoGovernor** ★新 | `0x7ffadaAAA346728Af0222B8a1E8D52261F6AEBa0` |
| 治理 | DealNftGovernanceActivity | `0x9FDA424449e52D2C38Fe19080a8D681A085D536a` |
| 治理 | VoteDividendClaimer | `0xEfe550dF7BD394c7791AA56f64efC2D938C576f9` |
| 跨链 | CrossChainDispatcher | `0x42A59a08f7Ec25c75Ab97815981333F18395805b` |
| 跨链 | CrossChainExecutor | `0x1ABC100Ca6eaB03Ca9a0a75f65239ca9e3FE9A7e` |

---

## 本次改动说明

### DCDomainHall（重新部署）
- 新增第 4 个构造参数 `infoNft`，支持 `requireInfoNft` 功能
- 创建 deal 时可选强制要求访客持有 InfoNFT
- 旧合约已从工厂白名单和 rank 上报者中移除

### DealSeatVetoGovernor（重新部署）
- `registerProposal` 接口从 2 参数升级为 3 参数（新增 `thresholdBps`）
- 旧合约已从 NftVetoRegistry.isGovernor 中移除

### DCDomainListReader（重新部署）
- 排行榜查询接口换用 `getTopDomainIds(limit)` 替代旧的 O(n²) 全量排序
- 主查询入口：`getDomainsByVolume(offset, limit)`

### DCdomainrank（UUPS 升级，代理地址不变）
- 排行榜从有序数组换为最小堆（O(log n) 插入，O(1) 查顶）
- 新排行榜查询入口：`getTopDomainIds(limit)` — 前端统一使用这个
- 旧 `getGlobalLeaderboard(limit)` 仍可用但已是死代码，不推荐

---

## 前端接入注意事项

1. **DCDomainHall 地址必须更新** — 旧合约已禁用，调用会失败
2. **DealSeatVetoGovernor 地址必须更新** — 旧合约已从治理注册表移除
3. **DCDomainListReader 排行榜接口**：使用 `getDomainsByVolume(0, limit)` 获取按成交量排序的域名列表
4. **DCdomainrank 代理地址不变**，前端无需改动 rank 地址，ABI 可能需要更新（新增 `getTopDomainIds`）

完整 ABI 和地址已写入：`deployments/agiking-31415926.json`
