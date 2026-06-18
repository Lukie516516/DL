# 前端交接文档 — 审计修复部署 2026-06-17

链：Agiking / AISO，chainId `31415926`  
原生代币：AGI（18位精度）  
部署者 / Treasury：`0xe88c63d29ece76e3336b0db747e10876c3bf9893`  
健康检查：**66/66 通过**

---

## 一、全量合约地址

### 本次新部署（前端必须更新）

| 合约 | 地址 | 说明 |
|------|------|------|
| **DCdomain** | `0x481Fc5092485df2eDc549e69C9F1aC4F99239009` | DC域名NFT主合约 |
| **DCdomainrank proxy** | `0x64939D6Badff45eE73B936fd4F5cEAE6cbCb4a3B` | 域名排名（UUPS代理，用proxy地址） |
| DCdomainrank impl | `0x020fE913D93ccD9b91722C83932cE69efE76F9db` | 仅升级时用，业务不直接调用 |
| **DCdomainswap** | `0x3BddfeC5bAcAC7cfF2dbB7Ae896CBEEdc7374250` | 域名交换创建Deal |
| **DCDomainListReader** | `0x1c9BB38aE595D7F16CECf1d7EDaCDD051A8Ac86F` | 域名列表查询（只读） |
| **DCDomainRankReader** | `0x9a70B45342e7056Dd912F035b2f3275b55AE74c2` | 排名数据查询（只读） |
| **DCDomainHall** | `0x1849e96CAB80B672357bAeab165A670a1638F0bf` | 域名大厅创建Deal |
| **DCDomainMarket** | `0x79A708bCc27e942d35D83C6933aD506000b369D8` | 域名NFT二级市场 |
| **DealGovernance proxy** | `0xd74b24e657ed9a93fBd9774bB75324cb5FDc660e` | 治理合约（UUPS代理，用proxy地址） |
| DealGovernance impl | `0x20790CE2C362c6D3a6Ba788a9c02e2f21a460562` | 仅升级时用 |
| **DealSeatVetoGovernor** | `0xdB1A242d0A7f47A2Ccd84550963516413092957E` | Seat席位否决治理 |
| **NftApprovalRegistry** | `0xdc2dD233Cb033bB6fC1728016C9326331B00bc0A` | NFT否决投票注册（供DealGovernance） |
| **NftVetoRegistry** | `0x2343dbEA14EE94C6eB4C79ECF999365938727D52` | NFT否决注册（供DealSeatVetoGovernor） |
| **DealNftGovernanceActivity** | `0x309a8d8cF2BE2CBF6A0371D8642423e276af8Cb7` | NFT治理活跃度追踪 |
| **DealSwapOrderBook** | `0x8FfBC5Edc77697E6d35C7ad0C842BBCCc983883b` | 兑换订单簿 |
| **DealSwapRouter** | `0x6F8E1d0d80E034Ef470C399Ab8761a12A30C698F` | 兑换路由 |
| **DealMessageHub** | `0xf2C6C565D74340B6cD9EDb0C233ccBC960737ab4` | Deal内消息系统 |
| **VoteDividendClaimer** | `0x19a6d70CDF58070963EE34392a615F906685b065` | 投票分红领取 |
| **CrossChainExecutor** | `0x0F1AEb5E625e0aea83b141794aE5115aF807F33a` | 跨链执行（桥接占位符） |

### 不变合约（地址不变，前端无需修改）

| 合约 | 地址 | 说明 |
|------|------|------|
| **D Token** | `0xA57b99E48f2fc24282E8F263D24468a51C5242DB` | 治理代币 |
| **DL Token** | `0x802C43662C38aAd9b4299c2f723A6B16f228217A` | 流动性代币 |
| **DealFactory** | `0xd0Fc2685945790df25bDdeaA69426a348D05775B` | Deal工厂 |
| **DealInfoNFT** | `0x7E4eD273FAc90A87Ea4C2205B7c37d4A31B08844` | Deal信息NFT |
| **DealPairManager** | `0x66Ae5a605a566B59cFB33dbCf1DDC0cFB853A8a5` | 兑换对管理 |
| **WrappedAGI** | `0x391747E54d24AA8Cef1388FE1C13f8fD57051153` | 包装AGI |
| **CrossChainDispatcher** | `0x42A59a08f7Ec25c75Ab97815981333F18395805b` | 跨链分发 |
| **AUSD** | `0x8fc6dB736Dce11233078EA6f6EBa4c9F44E4C123` | 稳定币 |

---

## 二、前端必须改的接口变更

### 1. DCDomainHall — `createHallDealTemplate23` / `createTteHallDeal` 新增参数

**变更前：**
```solidity
createHallDealTemplate23(string memory title, string memory description, string memory domain)
```

**变更后（新增 `expectedB`）：**
```solidity
createHallDealTemplate23(
    string memory title,
    string memory description,
    string memory domain,
    address expectedB   // address(0) = 公开接单；非零 = 仅该地址可加入
)

createTteHallDeal(
    string memory title,
    string memory description,
    string memory domain,
    address expectedB   // 同上
)
```

**前端调用示例：**
```typescript
// 公开挂单（任何人可接）
await hall.write.createHallDealTemplate23([title, desc, domain, "0x0000000000000000000000000000000000000000"])

// 指定对手方
await hall.write.createHallDealTemplate23([title, desc, domain, counterpartyAddress])
```

---

### 2. DCDomainMarket — `buy` 新增 `maxPrice` 滑点保护

**变更前：**
```solidity
buy(uint256 tokenId)
```

**变更后：**
```solidity
buy(uint256 tokenId, uint256 maxPrice)
```

前端调用时传入用户期望的最高价格（通常取当前挂单价 × 1.005 做5‰缓冲）：
```typescript
const listing = await market.read.listings([tokenId])
const maxPrice = listing.price  // 或 listing.price * 1005n / 1000n
await market.write.buy([tokenId, maxPrice])
```

---

### 3. DealMessageHub — `postFromDeal` 限制

`postFromDeal(address sender, string content)` 只能由 **Deal合约自身** 调用（`msg.sender` 必须是一个合法Deal），且 `sender` 必须是该Deal的A或B。前端不会直接调用此函数，由Deal合约内部触发，无需改动。

---

## 三、旧合约弃用说明

以下旧地址已从 DealFactory 中移除，**不得继续使用**：

| 废弃合约 | 旧地址 |
|---------|--------|
| DCdomain | `0x0a18a23B7B709Ae063d9dFF397008029f2b07EB7` |
| DCdomainrank proxy | `0x347F39116BDfca98788EBD60841e14226f63c761` |
| DCdomainswap | `0x79D16213e4AcdF1Fb9Cf471ffB8B812169095D34` |
| DealGovernance proxy | `0xa56dEC8Ec251dF5Dc9E1E8f35B38827FF0DaF190` |
| DealSeatVetoGovernor | `0x17406e466443da378817A8d69f212B4FC359e48C` |
| DealSwapOrderBook | `0x71d8a47AD749aB8aAf5e184b428B2e2B6b891606` |
| DealSwapRouter | `0x624324B79ca78d0eB45f804fA5a076bA285A5F35` |
| DCDomainHall | `0x3fE565C12fB8080d946BBC56D57641f9272D472C` |
| DealMessageHub | `0x84E1940E1a5Ad8100f41248254881fb6015926df` |
| DCDomainMarket | `0x85CaC6b96FC473f4C57A26068500514D092fe48e` |
| CrossChainExecutor | `0x1ABC100Ca6eaB03Ca9a0a75f65239ca9e3FE9A7e` |

> ⚠️ 旧 DCDomainMarket 的历史挂单已丢失，需通知卖家在新合约重新挂单。  
> ⚠️ 旧 DealMessageHub 的历史消息已不可通过新合约读取（区块历史仍在链上，可通过事件扫描）。

---

## 四、DCDomainMarket 业务参数

| 参数 | 值 |
|------|-----|
| 支付代币 | DL Token (`0x802C43662C38aAd9b4299c2f723A6B16f228217A`) |
| 手续费率 | 1% (100 BPS) |
| 手续费接收地址 | `0xe88c63d29ece76e3336b0db747e10876c3bf9893`（Treasury） |
| 最高允许费率 | 25% (2500 BPS，合约上限，当前未用到） |

---

## 五、事件变更说明（后端 / 索引器）

以下合约事件新增了 `when` 字段（参见上次事件时间升级文档）：
- `Deal.Completed(when)` 
- `Deal.Canceled(when)`

本次审计部署**未改变事件签名**，事件扫描逻辑无需变动。

提案枚举无需扫描事件：`DealGovernance.proposalCount()` + `getProposals(offset, limit)` 可做分页轮询，复杂度 O(1)。

---

## 六、ABI 获取

所有新合约 ABI 已更新至：

```
deployments/agiking-31415926.json  →  .abi 字段
```

各 ABI key 名称：
`DCdomain`, `DCDomainRank`, `DCdomainswap`, `DCDomainListReader`, `DCDomainRankReader`,
`DealNftGovernanceActivity`, `NftApprovalRegistry`, `NftVetoRegistry`, `DealGovernance`,
`DealSeatVetoGovernor`, `DealSwapOrderBook`, `DealSwapRouter`, `DCDomainHall`,
`DealMessageHub`, `VoteDividendClaimer`, `DCDomainMarket`, `CrossChainExecutor`

---

## 七、上线注意事项

1. **VoteDividendClaimer** — 每次 `createRound` 前，需由 `dividendSource`（Treasury）预先 `approve` 足够 DL 给 VoteDividendClaimer 合约。
2. **DCDomainMarket** — 卖家挂单前需先 `approve` DCdomain NFT 给新市场合约（`0x79A708bCc27e942d35D83C6933aD506000b369D8`）。
3. **CrossChainExecutor** — 跨链功能目前为占位符，`setBridgeAdapter()` 未调用，跨链消息不会实际传递，不影响主业务。
4. 旧 DCDomainHall 已从工厂白名单移除，通过旧地址创建 Deal 的 tx 会 revert。
