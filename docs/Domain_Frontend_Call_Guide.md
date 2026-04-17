# 域名相关前端调用文档

这份文档是给前端 / 测试同学用的。

目标：
- 说明每个域名相关合约是干什么的
- 说明常用方法要传什么参数
- 说明参数格式
- 说明哪些地方容易传错
- 说明大厅模式下哪些单子不能直接点 `join`

适用网络：
- `agiking`
- `chainId = 31415926`
- `rpc = https://rpc.agikingrpc.shop`

---

## 1. 当前测试网地址

来源：
- `deployments/agiking-31415926.json`

当前域名相关地址：

- `DL / DC`: `0x39f27267184d3ff8522d5ed209fbf32fc7cbf3bb`
- `DCDomain`: `0x23b5249472516c358a8f517a5ca915a996c09a20`
- `DCDomainRank`: `0x59c59fb6f3100e523f741dcf6c4db7ba84ceef22`
- `DCDomainMarket`: `0xd6505d27191fc4609dbd4051d69a1c9b8a20997f`
- `DCDomainSwap`: `0x9841e4e3abad48dae5d9c80f8c53bd8ff7fc5e28`
- `DCDomainHall`: `0x43b0a8fa4313766f09f511f0b1bac7b1d9700ccc`
- `DealFactory`: `0x2ce2648c77cefb528e8e4a489764c9418cf6538d`
- `DealReader`: `0x11d1bcfa4e80969b351401d3e69329be8a69f8e1`

---

## 2. 重要概念

### 2.1 `domainName` 和 `title` 不是一回事

- `domainName`：链上真实域名，用于合约调用
- `title`：合同标题 / 展示标题，只用于展示

不要把 `title` 当成 `domainName` 传给：
- `enterDomain`
- `isVisitorActive`
- `createHallDealTemplate23`
- `createTteHallDeal`
- `createDeal`

例如：

- 正确的 `domainName`：`hall11`
- 错误的 `domainName`：`Make Friend`

### 2.2 域名格式

`domainName` 当前要求：
- 长度固定 `6`
- 只能字母和数字

例如：
- `abc123`
- `hall11`
- `rank22`

### 2.3 金额格式

所有代币金额都按 `uint256` 最小单位传：
- `1 DL = 1e18`
- `500 DL = 500000000000000000000`

前端一般按：
- `parseUnits(value, 18)`

### 2.4 当前域名相关支付币种

- 一级注册域名：`DL`
- 二级市场购买域名 NFT：`DL`
- 域名排行榜充值：`DL`

---

## 3. 合约分工

### 3.1 `DCDomain`

作用：
- 一级注册域名 NFT
- 设置主域名
- 设置解析地址
- 设置域名描述
- 设置域名背景图
- 查询域名 / tokenId / tokenURI

### 3.2 `DCDomainMarket`

作用：
- 域名 NFT 二级市场
- 公开挂单
- 点对点挂单
- 购买后自动转移 NFT
- 自动同步 `resolve`

### 3.3 `DCDomainRank`

作用：
- 访客进入 / 离开域名
- 黑名单
- 域名内交易排行榜
- 域名总榜
- 对某笔交易做 DL 充值并按小时消耗

### 3.4 `DCDomainHall`

作用：
- 大厅模式创建域名合同
- 发大厅消息
- 发某笔 deal 专属消息
- 选人
- 选人后开通加入权限

### 3.5 `DCDomainSwap`

作用：
- 非大厅模式下，直接在域名下创建 TokenToToken 合同
- 可以公开发单，也可以指定买家

---

## 4. `DCDomain` 常用方法

### 4.1 `getPrice(domainName)`

作用：
- 查询一级注册价格

参数：
- `domainName: string`

当前规则：
- 所有域名统一 `500 DL`

返回：
- `uint256`

示例：

```ts
const price = await dcDomain.getPrice("abc123");
```

### 4.2 `register(domainName)`

作用：
- 购买一级域名

前置条件：
- 先对 `DCDomain` 合约 `approve(500 DL)`

参数：
- `domainName: string`

参数格式：
- 固定 6 位
- 字母数字

示例：

```ts
await dl.approve(dcDomainAddress, price);
await dcDomain.register("abc123");
```

### 4.3 `setPrimaryDomain(domainName)`

作用：
- 设置自己的主域名

参数：
- `domainName: string`

### 4.4 `setResolve(domainName, target)`

作用：
- 修改域名解析地址

参数：
- `domainName: string`
- `target: address`

### 4.5 `setDomainDescriptionFor(domainName, desc)`

作用：
- 修改域名描述

参数：
- `domainName: string`
- `desc: string`

注意：
- 描述是链上存储
- 不要传会破坏 JSON 的特殊字符

### 4.6 `setDomainBackgroundUriFor(domainName, uri)`

作用：
- 修改域名背景图 URI

参数：
- `domainName: string`
- `uri: string`

推荐格式：
- `ipfs://...`
- `https://...`
- `ar://...`

### 4.7 查询类方法

常用：
- `domainOf(tokenId)`
- `isRegistered(domainName)`
- `tokenIdOf(domainName)`
- `totalDomains()`
- `resolve(domainName)`
- `domainDescription(tokenId)`
- `domainBackgroundUri(tokenId)`
- `tokenURI(tokenId)`

---

## 5. `DCDomainMarket` 常用方法

### 5.1 `list(tokenId, price)`

作用：
- 公开挂单卖域名

前置条件：
- 必须先 `approve(tokenId)` 给 `DCDomainMarket`

参数：
- `tokenId: uint256`
- `price: uint256`

当前支付币种：
- `DL`

### 5.2 `listP2P(tokenId, price, buyer)`

作用：
- 点对点挂单，只允许指定买家购买

参数：
- `tokenId: uint256`
- `price: uint256`
- `buyer: address`

### 5.3 `updateListing(tokenId, newPrice)`

作用：
- 修改挂单价格

参数：
- `tokenId: uint256`
- `newPrice: uint256`

### 5.4 `delist(tokenId)`

作用：
- 取消挂单

参数：
- `tokenId: uint256`

### 5.5 `buy(tokenId)`

作用：
- 买断域名 NFT

前置条件：
- 买家先对 `DCDomainMarket` `approve(price)` 的 `DL`

参数：
- `tokenId: uint256`

当前费用规则：
- 成交手续费 `feeBps = 100`
- 即 `1%`

成交后：
- NFT 转给买家
- 卖家收到 `99%`
- `feeRecipient` 收到 `1%`
- 域名 `resolve` 自动改成买家地址

### 5.6 查询类方法

常用：
- `activeListingCount()`
- `activeTokenIdAt(index)`
- `activeTokenIds(offset, limit)`
- `getActiveListings(offset, limit)`
- `getPublicListings(offset, limit)`
- `getP2PListingsForBuyer(buyer)`
- `listings(tokenId)`

---

## 6. `DCDomainRank` 常用方法

### 6.1 `enterDomain(domainName)`

作用：
- 普通用户以访客身份进入域名

参数：
- `domainName: string`

注意：
- 如果域名不存在会 revert：
  - `DCDomainRank: domain not registered`
- 这里一定要传真实 `domainName`
- 不要传标题 / 页面标题

### 6.2 `leaveVisitor(domainName)`

作用：
- 主动离开访客身份

参数：
- `domainName: string`

### 6.3 `isVisitorActive(domainName, user)`

作用：
- 查询某地址是不是这个域名下的访客

参数：
- `domainName: string`
- `user: address`

返回：
- `bool`

注意：
- 这里只是读当前访客状态
- 如果前端想做“先判断再 enter”，最好先额外调用 `dcDomain.isRegistered(domainName)`

### 6.4 `deposit(domainName, deal, amount)`

作用：
- 给某笔 deal 的排行榜充值

参数：
- `domainName: string`
- `deal: address`
- `amount: uint256`

当前充值币种：
- `DL`

注意：
- 这不是合同保证金
- 这是排行榜充值
- 目前仍有最小充值门槛 `minDeposit`

### 6.5 `withdraw(domainName, deal)`

作用：
- 取回这笔 deal 尚未消耗完的充值

参数：
- `domainName: string`
- `deal: address`

### 6.6 `settle(domainName, deal, merchantAddr)`

作用：
- 主动结算当前应扣的排行消耗

参数：
- `domainName: string`
- `deal: address`
- `merchantAddr: address`

### 6.7 排行榜查询

常用：
- `getLeaderboard(domainName, limit)`
- `domainEntryCount(domainName)`
- `getGlobalLeaderboard(limit)`
- `globalDomainCount()`

### 6.8 充值状态查询

常用：
- `myDealStatus(domainName, deal)`
- `lastDepositAt(domainName, deal, merchant)`
- `lastDepositAmount(domainName, deal, merchant)`
- `depositPercent(domainName, deal, merchant)`
- `previewHourlyRate(depositAmount)`

说明：
- `depositPercent`：当前余额相对最近一次充值基准的百分比
- `lastDepositAmount`：上一次充值了多少 `DL`

---

## 7. `DCDomainHall` 常用方法

## 7.1 模板说明

大厅这里主要有两类：

- `createTteHallDeal`
  - 域名下 TokenToToken
  - 先建单
  - 先发 deal 专属消息
  - 创建者选人
  - 选中后才能加入

- `createHallDealTemplate23`
  - `templateType = 2`：TokenToEmpty
  - `templateType = 3`：EmptyToEmpty
  - 也是先建单、先沟通、先选人

### 很重要

这两类大厅模板当前都已经修成：
- 创建后默认不能直接 `deal.join()`
- 必须先 `confirmHallDealCounterparty`
- 然后被选中的人才能 `join`

所以前端这里：
- 不要给这类单子直接显示“立即加入 deal”
- 应该跳大厅

### 7.2 `createTteHallDeal(domainName, aSwapToken, aSwapAmount, bSwapToken, bSwapAmount, title, trackCreator)`

作用：
- 创建大厅 TokenToToken 合同

参数：
- `domainName: string`
- `aSwapToken: address`
- `aSwapAmount: uint256`
- `bSwapToken: address`
- `bSwapAmount: uint256`
- `title: string`
- `trackCreator: bool`

说明：
- 创建后先锁住 join
- 需要后续 `confirmHallDealCounterparty`

### 7.3 `createHallDealTemplate23(...)`

作用：
- 创建大厅模板 2 / 3

参数顺序：
- `domainName: string`
- `templateType: uint8`
- `aSwapToken: address`
- `aSwapAmount: uint256`
- `aMarginToken: address`
- `aMarginAmount: uint256`
- `bSwapToken: address`
- `bSwapAmount: uint256`
- `bMarginToken: address`
- `bMarginAmount: uint256`
- `aNftId: uint256`
- `timeoutSeconds: uint64`
- `timeStart: uint64`
- `title: string`
- `trackCreator: bool`

其中：
- `templateType = 2` 表示 `TokenToEmpty`
- `templateType = 3` 表示 `EmptyToEmpty`

当前规则：
- 保证金可为 `0`
- 创建后默认不能直接 `join`

### 7.4 `postMessage(domainName, merchant, user, content)`

作用：
- 商户 / 访客在普通大厅线程发消息

参数：
- `domainName: string`
- `merchant: address`
- `user: address`
- `content: string`

### 7.5 `getMessages(domainName, merchant, user, offset, limit)`

作用：
- 分页获取普通大厅线程消息

参数：
- `domainName: string`
- `merchant: address`
- `user: address`
- `offset: uint256`
- `limit: uint256`

### 7.6 `signalPickUser(domainName, pickedUser, note)`

作用：
- 商户发送“我准备选你”信号

参数：
- `domainName: string`
- `pickedUser: address`
- `note: string`

### 7.7 `confirmHallDealCounterparty(domainName, deal, pickedVisitor)`

作用：
- 创建者正式指定某个访客获得加入权限

参数：
- `domainName: string`
- `deal: address`
- `pickedVisitor: address`

作用结果：
- 对 deal 调 `openJoinFor(pickedVisitor)`
- 之后只有这个地址能 `join`

### 7.8 `postMessageOnDeal(domainName, deal, content)`

作用：
- 在某笔 deal 的专属大厅发消息

参数：
- `domainName: string`
- `deal: address`
- `content: string`

### 7.9 `getMessagesOnDeal(domainName, deal, offset, limit)`

作用：
- 分页获取某笔 deal 的专属消息

参数：
- `domainName: string`
- `deal: address`
- `offset: uint256`
- `limit: uint256`

### 7.10 `pickUserAndCreateDeal(domainName, pickedUser, aSwapToken, aSwapAmount, bSwapToken, bSwapAmount, title, trackCreator)`

作用：
- 商户直接点对点创建一笔指定访客才能加入的 TokenToToken

参数：
- `domainName: string`
- `pickedUser: address`
- `aSwapToken: address`
- `aSwapAmount: uint256`
- `bSwapToken: address`
- `bSwapAmount: uint256`
- `title: string`
- `trackCreator: bool`

说明：
- 这个方法本来就是指定地址加入
- 不属于“先创建大厅再选人”的漏洞范围

---

## 8. `DCDomainSwap` 常用方法

### 8.1 `createDeal(domainName, aSwapToken, aSwapAmount, bSwapToken, bSwapAmount, title, expectedB)`

作用：
- 在域名下直接创建 TokenToToken 交易

参数：
- `domainName: string`
- `aSwapToken: address`
- `aSwapAmount: uint256`
- `bSwapToken: address`
- `bSwapAmount: uint256`
- `title: string`
- `expectedB: address`

规则：
- `expectedB = 0x000...000`
  - 公开单
- `expectedB = 某个地址`
  - 点对点单

注意：
- 这不是大厅模式
- 如果是大厅撮合，不要调这个方法

---

## 9. 通过 `DealFactory.createDeal` 卖域名 NFT

除了 `DCDomainMarket`，现在也支持通过普通 `Deal` 卖域名 NFT。

适用场景：
- 域名 NFT 作为交易资产
- 想走 Deal 状态机结算，而不是直接挂市场

关键字段：
- `aAssetNft = dcDomain 地址`
- `aAssetNftId = 域名 tokenId`

如果是指定买家：
- `joinMode = 1`
- `expectedB = 买家地址`

如果是公开出售：
- `joinMode = 0`
- `expectedB = 0`

注意：
- 这是普通 `DealFactory` 路径
- 不等于大厅模式

---

## 10. 前端最容易犯错的点

### 10.1 不要把标题当域名传

错误例子：
- `domainName = "Make Friend"`

正确例子：
- `domainName = "hall11"`

### 10.2 大厅模板不要直接给“加入 deal”按钮

以下创建方式出来的单子：
- `createTteHallDeal`
- `createHallDealTemplate23`

都应该：
- 先跳大厅
- 先发消息
- 创建者先选人
- `confirmHallDealCounterparty`
- 选中的人才点加入

### 10.3 先 `approve` 再发交易

常见前置：
- 一级注册域名前，要先 `approve(DCDomain, price)`
- 二级市场购买前，要先 `approve(DCDomainMarket, price)`
- 排行榜充值前，要先 `approve(DCDomainRank, amount)`

### 10.4 金额都用 18 位

当前域名相关的支付币：
- `DL`

前端统一按 `18 decimals` 处理。

---

## 11. 建议前端测试顺序

建议按这个顺序测：

1. 调 `getPrice("abc123")`
2. `approve + register("abc123")`
3. `tokenIdOf("abc123")`
4. `setDomainDescriptionFor`
5. `setDomainBackgroundUriFor`
6. `list / listP2P`
7. `buy`
8. `enterDomain`
9. `isVisitorActive`
10. `createTteHallDeal`
11. `postMessageOnDeal`
12. `confirmHallDealCounterparty`
13. 被选中的人再 `deal.join()`
14. `deposit / myDealStatus / getLeaderboard`

---

## 12. 前端一句话规则

- 域名调用只认真实 `domainName`
- 大厅模板先聊天选人，再允许加入
- 域名一级注册 / 二级市场 / 排行榜充值都用 `DL`

