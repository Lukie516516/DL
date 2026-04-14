# Agiking 上线前测试报告

这份文档用于留档当前版本在 `rpc.agikingrpc.shop` / `chainId = 31415926` 上线前的测试与验收结果。

适用对象：
- 合约负责人
- 前端
- 测试
- 索引 / 后端

---

## 1. 本次结论

当前这版合约代码对应的链上部署已经完成，且围绕 `Deal`、域名交易、域名大厅撮合、域名排行榜、DEX 挂单等核心路径完成了本地自动化测试与部分测试网实操验证。

当前结果：

- 本地自动化测试：`40 passing`
- 本地新增域名专项测试：`14 passing`
- 测试网部署：已完成
- 测试网最小真实交互：已完成

当前可以确认：

- `Deal.sol` 新版已部署
- `DealFactory.sol` 新版已部署
- 域名相关新合约已部署
- 近期这轮更新后的核心功能已覆盖测试

---

## 2. 当前生效部署地址

主地址如下：

```json
{
  "dealLib": "0x38edeb51ef5a502a1c1c6829059edcbdccf3f928",
  "dealImplementation": "0x813e414f60d24e7c3eb538469474ddb9fa4a7091",
  "dealFactory": "0xf8c2dde6c7e45262f7a0556b3772791985e860e5",
  "dealReader": "0x6bf601a82d2892f7cb595afdb1489f35130c0ec8",
  "dcDomain": "0x8af0e452337e0c281f40095b72820b4bc455b263",
  "dcDomainRank": "0x925b0c80ca6952329c39f1b23dfa59061e61fb27",
  "dcDomainMarket": "0x48d439d4f24bd3acd72d3ea2a93d5f1bc591090a",
  "dcDomainSwap": "0xe84cb6ae874219d528d255bee2e5d1f4774475ad",
  "dcDomainHall": "0x17f455cd3205a90c0d629f08c4bab799aaa3dd18",
  "dealInfoNFT": "0x00fcc7f1a406ebfe6e5a1077821cc53c6752c789",
  "pairImplementation": "0x6613540b2451ced2dd8a7a48db89ca2c8414b163",
  "pairDlAusd": "0xc48b652C9c240FB18aFCf4ADac67471f28fb70e5",
  "pairDlUsdt": "0x8ca50e47b9a142bE5665E35d4697f475eC93C765",
  "dealSwapOrderBook": "0xb43ad4748459d82cf59efb56aca96fdf1d2d82f3",
  "dealRouter": "0x1e957fa8e7cf3e927398f4305b06e7c000101aea",
  "dlToken": "0x39f27267184d3ff8522d5ed209fbf32fc7cbf3bb",
  "ausd": "0xe2ba57ad85b33a3e2e09b69175974e7315264179",
  "usdt": "0xedc6e1ebc966f19a32ac58b09fe667ba59ec149a",
  "wrappedNative": "0x298d8871bfa6129a74d1ab324f4728794848c5b3"
}
```

完整 ABI 文件：

- [`deployments/agiking-31415926.json`](../deployments/agiking-31415926.json)

---

## 3. 本地自动化测试结果

当前全量测试结果：

- `DealRules.ts`: `17 passing`
- `DealSwapOrderBook.ts`: `9 passing`
- `DomainFlows.ts`: `14 passing`
- 总计：`40 passing`

执行方式：

```bash
npx hardhat test
```

### 3.1 Deal 基础规则

已验证：

- `TokenToToken`
- `TokenToNft`
- `TokenToEmpty`
- `EmptyToEmpty`
- `NftToEmpty`
- 认可币手续费路径
- 非认可币手续费路径
- `DL-DL` 手续费 / burn 规则
- margin 不参与手续费与返佣
- `timeStart / timeEnd` 元数据写入
- NFT 真交割
- 同一 NFT 被重复绑定的拦截

### 3.2 DEX / OrderBook

已验证：

- 大单部分成交 + 剩余自动挂单
- FIFO 结算
- 取消挂单收 `0.1%`
- `DL -> OTHER`
- `OTHER -> DL`
- `ETH -> DL`
- `DL -> ETH`
- `factory.initPair()` 触发自动结算

---

## 4. 域名专项测试结果

执行方式：

```bash
npx hardhat test test/DomainFlows.ts
```

当前专项结果：

- `14 passing`

### 4.1 DCDomain

已验证：

- 注册域名
- `totalDomains()`
- `resolve`
- `domainDescription`
- `domainBackgroundUri`
- `tokenURI` 会反映新的链上描述和背景图
- 描述过长会拒绝
- URI 含非法字符会拒绝

### 4.2 DCDomainMarket

已验证：

- 公开挂单 `list`
- 指定买家挂单 `listP2P`
- `buy`
- `updateListing`
- `delist`
- `activeListingCount`
- `activeTokenIdAt`
- `activeTokenIds(offset, limit)`
- `getActiveListings`
- `getPublicListings`
- `getP2PListingsForBuyer`
- 成交后 `resolve` 自动同步给新持有人
- 非指定买家无法购买 P2P 挂单

### 4.3 DCDomainSwap

已验证：

- 域名下创建币币单
- 新创建的 deal 上 `isDomainDeal = true`
- 新创建的 deal 上 `domainName = 对应域名`
- 域名总榜 `domainDealCount` 增加

### 4.4 DCDomainHall

已验证：

- `createTteHallDeal`
- `postMessageOnDeal`
- `confirmHallDealCounterparty`
- 指定访客后完成 `join / pay / vote / complete`
- `createHallDealTemplate23`
- `postMessage`
- `signalPickUser`
- `pickUserAndCreateDeal`
- 消息线程查询
- deal 专属大厅消息查询

已验证边界：

- 非访客不能在 deal 大厅留言
- 黑名单用户不能留言
- 黑名单用户不能被确认成最终对手方
- 非商家不能执行 `confirmHallDealCounterparty`
- `Template23` 错误参数会 revert
- `pickUserAndCreateDeal` 创建的 `ExactAddress` 合同会拒绝非指定地址加入

### 4.5 域名 NFT 通过 DealFactory 出售

已验证：

- 普通 `DealFactory.createDeal` 可出售域名 NFT
- 支持指定买家模式
- 支持公开模式
- 完成后域名 NFT 所有权转给买家

### 4.6 DCDomainRank

已验证：

- `deposit`
- `settle`
- `withdraw`
- `getLeaderboard`
- `getGlobalLeaderboard`
- 域名内排行榜保留 0 分条目
- 全局总榜按交易数量排序

---

## 5. 测试网真实交互验证

除本地测试外，还在 Agiking 测试网上做了最小真实交互验证。

已实操成功：

- 域名注册
- 设置域名描述
- 设置域名背景图 URI
- `DCDomainMarket.listP2P + buy`
- `DealFactory.createDeal` 出售域名 NFT
- 指定买家购买域名 NFT
- 公开挂单购买域名 NFT

结果确认：

- `resolve` 在二级成交后会同步为新持有人
- 域名 NFT 最终会转到买家地址
- `totalDomains()` 可正确反映当前注册数量

---

## 6. 当前前端对接注意事项

### 6.1 直连 DealFactory.createDeal 的 InitParams 已更新

所有直连 `DealFactory.createDeal` 的前端 / 脚本，必须按最新 ABI 传完整结构体。

新增字段包括：

- `aAssetNft`
- `aAssetNftId`
- `bAssetNft`
- `bAssetNftId`
- `isDomainDeal`
- `domainName`

普通合同必须传：

- `isDomainDeal: false`
- `domainName: ""`

域名入口合约会传：

- `isDomainDeal: true`
- `domainName: domainName`

### 6.2 普通合同和域名合同的入口区分

- 普通合同：直连 `DealFactory.createDeal`
- 域名币币单：`DCDomainSwap.createDeal`
- 域名大厅撮合：`DCDomainHall`

工厂会拒绝伪造域名单：

- 普通入口传 `isDomainDeal = true` 会被 `USE_DOMAIN_ENTRY` 拦截

### 6.3 旧 deal 不自动升级

当前新 `DealFactory` 已绑定新版 `dealImplementation`。

这表示：

- 新创建的 deal：使用新版 `Deal.sol`
- 旧 deal：不会自动升级

---

## 7. 当前可确认的上线前结论

当前可以确认：

- 合约更新代码已部署
- 测试夹具已修复
- 域名相关新功能已覆盖自动化测试
- 大厅撮合、P2P、域名 NFT 直卖、排行榜等关键路径已验证
- 当前全量测试通过

当前仍需前端 / 运维侧注意：

- 必须使用最新 `DealFactory` ABI
- 旧版 `InitParams` 顺序不能再用
- 如果前端遇到 `NOT_FACTORY`，还需要结合 `DealInfoNFT.isFactory(factory)` 排查链上授权状态

---

## 8. 推荐留档命令

```bash
npx hardhat test
npx hardhat test test/DomainFlows.ts
npx hardhat run scripts/deploy-agiking-full-upgrade.ts --network agiking
```

---

## 9. 对接文件

建议对接时优先查看：

- [`DealFactory.sol`](../contracts/DealFactory.sol)
- [`Deal.sol`](../contracts/Deal.sol)
- [`DCdomain.sol`](../contracts/DCdomain.sol)
- [`DCDomainMarket.sol`](../contracts/DCDomainMarket.sol)
- [`DCdomainswap.sol`](../contracts/DCdomainswap.sol)
- [`DCDomainHall.sol`](../contracts/DCDomainHall.sol)
- [`DCdomainrank.sol`](../contracts/DCdomainrank.sol)
- [`deployments/agiking-31415926.json`](../deployments/agiking-31415926.json)
