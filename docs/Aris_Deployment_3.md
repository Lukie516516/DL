# Aris 部署说明 3

这份文档专门说明这次 **DEX / 虚拟流动性 / 默认 hybrid 路径** 改动上线时怎么部署。

适用对象：
- 合约负责人
- 部署同学
- 前端 / 后端切地址同学

---

## 1. 这次部署和以前最大的不同

这次不是只换 Router 或只换脚本。

因为这轮核心逻辑改到了：

- [`DealSwapTemplate.sol`](../contracts/DealSwapTemplate.sol)
- [`DealSwapOrderBook.sol`](../contracts/DealSwapOrderBook.sol)
- [`DealSwapRouter.sol`](../contracts/DealSwapRouter.sol)
- [`DealFactory.sol`](../contracts/DealFactory.sol)
- [`Deal.sol`](../contracts/Deal.sol)
- [`DealMessageHub.sol`](../contracts/DealMessageHub.sol)

尤其要注意：

**Pair 是 clone 出来的。**

也就是说：

- 老 Pair 是旧逻辑副本
- 改了 `pairImplementation` 不会自动升级老 Pair
- 如果要让新逻辑生效，必须让前端切到**新 Pair**

这是这次部署最关键的点。

---

## 2. 先讲清楚：为什么我说 TWAP 之前不一致

这次我修的那个 `TWAP` 问题，本质上是：

### 2.1 Pair 报价已经看“真实 + 虚拟”

现在 Pair 的报价和价格曲线，已经按：

- `effective reserve = real reserve + virtual reserve`

在算。

也就是说，如果：

- 真实 `DL = 1000`
- 真实 `OTHER = 100`
- 虚拟 `OTHER = 900`

那么对价格来说，系统看到的是：

- `DL = 1000`
- `OTHER = 1000`

所以现货价格会被虚拟储备一起影响。

### 2.2 但旧的 Factory TWAP spot 还只看真实 reserve

之前 `DealFactory._currentP1CumulativeWithSpot()` 在推当前 spot 时，拿的是：

- `getReserves()`

也就是真实储备：

- `DL = 1000`
- `OTHER = 100`

于是它推出来的 spot 还是旧价格。

这样就会出现一个不一致：

- Pair 的报价 / preview / swap 曲线看到的是 `1000 : 1000`
- Factory 的 TWAP spot 看到的是 `1000 : 100`

这时任何通过 Factory 做估值的逻辑，比如：

- `updateAndQuoteToDL()`
- 某些烧币 / 留言费 / 估值逻辑

就可能和真实 Pair 报价不一致。

### 2.3 还有第二层问题：改虚拟储备会“污染历史窗口”

旧逻辑下，假设：

1. 池子已经跑了 1 小时
2. 这 1 小时一直是旧价格
3. 你现在突然把虚拟储备调大

如果不先把这 1 小时的旧价格累计进 TWAP，
下一次更新 cumulative 时，合约就会把“过去这一整小时”都按**新虚拟储备价格**累计。

这就等于：

- 你刚改参数
- 但历史价格也被重写了

这是错的。

### 2.4 现在怎么修的

这次我做了两件事：

1. Pair 在累计价格时，用 effective reserve
2. Factory 在推当前 spot 时，也用 effective reserve

并且：

3. 在修改虚拟储备前，先把旧时间窗口滚进 cumulative

这样现在 `TWAP` 才是完整一致的。

---

## 3. 这次上线最少要换哪些

### 3.1 必须换

最少需要处理：

- `DealSwapTemplate` 新实现
- `DealSwapOrderBook` 新合约
- `DealSwapRouter` 新合约

### 3.2 强烈建议一起处理

- `DealFactory`
- `DealMessageHub`

原因是：

- 这次 `DealFactory` 补了虚拟储备配置入口
- 也修了 `TWAP` spot 读取口径
- `Deal` 的聊天存储已经拆到 `DealMessageHub`

如果你不换 `DealFactory` / `DealMessageHub`，本次 `TWAP` 修复、虚拟储备配置能力、以及 `Deal` 聊天读取链路都不完整。

### 3.3 新增一个必须配置的全局地址

这次 `DealFactory` 新增了：

- `dealMessageHub`

部署完成后必须执行：

- `setGlobal("dealMessageHub", <DealMessageHub 地址>)`

否则：

- `DealMessageHub.postMessage(deal, content)` 会因为找不到消息中心而失败
- 聊天功能不会正常工作

### 3.4 老 Pair 怎么办

老 Pair 不会自动升级。

所以如果你想真正使用这次逻辑：

- 要么建新的 Pair
- 要么前端继续打老 Pair，那这次升级对用户就等于没生效

一句话：

**Router / OrderBook / Pair implementation 可以重部署，但真正决定效果的是：前端必须切到新 Pair。**

---

## 4. 推荐部署方案

我推荐两种。

### 方案 A：整套新部署

这是最干净的。

部署：

1. 新 `DealSwapTemplate`
2. 新 `DealFactory`
3. 新 `DealMessageHub`
4. 新 `DealSwapOrderBook`
5. 新 `DealRouter`

然后：

6. 给新 Factory 配置全局参数
7. 创建新 Pair
8. 初始化新 Pair
9. 配虚拟储备
10. 前端切新 Router / 新 Pair / 新 Factory

优点：

- 地址关系最清晰
- 历史逻辑和新逻辑不混
- 不容易把旧线上配置搞乱

缺点：

- 需要切的地址更多

### 方案 B：保留旧 Factory，升级 Pair implementation

如果你们现在线上 Factory 还在 owner 控制下，也可以：

1. 部署新 `DealSwapTemplate`
2. 部署新 `DealMessageHub`
3. 在旧 Factory 上调用 `setPairImplementation(newPairImpl)`
4. 在旧 Factory 上调用 `setGlobal("dealMessageHub", newHub)`
5. 部署新 `DealSwapOrderBook`
6. 部署新 `DealRouter`
7. 在新 OrderBook 上调用 `setRouter(newRouter)`
8. 用旧 Factory 重新 `createPair`
9. 重新初始化新 Pair
10. 配虚拟储备
11. 前端切到新 Pair / 新 Router

优点：

- 可以不换 Factory 地址

缺点：

- 旧 Pair 和新 Pair 会同时存在
- 前端 / 后端 / 索引如果切不干净，容易混淆

---

## 5. 推荐部署顺序

下面按“建议上线顺序”写。

### 补仓自动结算补充

如果这次也要带上“补 `OTHER` 后顺手结算排单”的运营入口，需要同步部署带新函数的 `DealFactory`。

新增入口是：

- `mintPairOtherAndSettle(pair)`

执行顺序是：

1. 先把 `OTHER` 转进目标 Pair
2. 再调用 `DealFactory.mintPairOtherAndSettle(pair)`
3. Factory 内部会先做 `mintOtherOnly()`
4. 然后尝试 `settlePair(pair, 1, 8)`

注意：

- `settlePair` 失败不会回滚本次补仓
- 所以这条入口更偏“补仓优先，顺手推进队列”
- 如果要继续清更多挂单，可以后续再单独调 `settlePair`

### 第一步：部署新 Pair implementation

部署：

- `DealSwapTemplate`

如果走方案 B：

- 调 `DealFactory.setPairImplementation(newPairImpl)`

如果走方案 A：

- 直接把新 `pairImplementation` 传给新 Factory 构造函数

### 第二步：部署新 OrderBook

部署：

- `DealSwapOrderBook(treasury)`

注意：

- `treasury` 还是你们原来想收取消订单手续费的地址

### 第三步：部署新 Router

部署：

- `DealRouter(wrappedNative, orderBook)`

然后：

- `DealSwapOrderBook.setRouter(router)`

### 第四步：配置 Factory

如果是新 Factory，至少要重新设置这些：

- `dlToken`
- `infoNft`
- `wrappedNative`
- `recognizedToken0`
- `recognizedToken1`
- `treasury`
- `swapOrderBook`

如果是旧 Factory：

- 至少检查并更新 `swapOrderBook`
- 确认 `pairImplementation` 已经切到新实现

### 第五步：创建新 Pair

对每个要上线的新交易对：

1. `createPair(tokenOther, feeNum, feeDen)`
2. 给 Pair 打入初始 `DL`
3. 给 Pair 打入初始 `OTHER`
4. `initPair(pair, 0)`

注意：

- 现在不再建议靠 `initPair(_b1)` 去做旧版“虚拟垫高”
- 初始虚拟储备建议走下面单独配置

### 第六步：配置虚拟储备

有两种方式：

#### 方式 1：直接设置绝对值

- `setPairVirtualReserves(pair, virtual0, enable0, virtual1, enable1)`

适合：

- 你们已经明确知道虚拟储备具体数值

#### 方式 2：按真实储备比例生成

- `setPairVirtualReservesByBps(pair, bps0, enable0, bps1, enable1)`

适合：

- 这次你们想先用类似“按真实储备百分比生成一版虚拟储备”的方式

比如：

- token0 侧 0%
- token1 侧 500 bps

就表示：

- token1 虚拟储备 = 当前真实 token1 的 5%

### 第七步：前端切地址

前端至少要切：

- `dealRouter`
- `dealSwapOrderBook`
- 新 `pair` 地址

如果 Factory 也换了，还要切：

- `dealFactory`

### 第八步：后端 / 索引 / deployment json 更新

需要同步更新：

- 部署 JSON
- Pair 地址映射
- Router 地址
- OrderBook 地址
- Factory 地址（如果换了）

---

## 6. 这次和旧脚本相比，部署思路上要注意什么

你们现有 `scripts/deploy-agiking.ts` 的主流程是：

1. 部署 `Deal`
2. 部署 `DealSwapTemplate`
3. 部署 `DL / AUSD / USDT / WNATIVE`
4. 部署 `DealFactory`
5. `createPair`
6. 给 Pair 打初始流动性
7. `initPair(pair, 0n)`
8. 部署 `DealSwapOrderBook`
9. 部署 `DealRouter`
10. `orderBook.setRouter(router)`

这次如果沿用这个思路，新增要注意的就是：

### 6.1 Pair 初始化后，再配虚拟储备

推荐流程：

- 先 `initPair(pair, 0n)`
- 再 `setPairVirtualReserves(...)`

不要再把 `_b1` 当主配置方式去用。

### 6.2 先配 OrderBook，再让前端切 Router

因为默认 `exact-in` 现在已经是 hybrid 语义。

如果：

- Router 已切
- 但 OrderBook 没配好

那默认 `exact-in` 会直接因为 `NO_ORDER_BOOK` 失败。

所以正确顺序是：

1. 部署 OrderBook
2. 部署 Router
3. `orderBook.setRouter(router)`
4. `factory.setGlobal("swapOrderBook", orderBook)`
5. 再让前端切 Router

### 6.3 新 Pair 建好后，前端必须显式切 Pair

这次最容易漏掉的不是 Router，
而是：

**前端还在用老 Pair 地址。**

如果不切 Pair：

- 虚拟储备逻辑不会生效
- 新 TWAP 逻辑也不会体现在老 Pair 上
- 默认 hybrid 入口的即时边界行为也和你预期不一致

---

## 7. 推荐上线检查清单

上线前建议至少确认这些：

### 合约配置

- `DealFactory.pairImplementation` 已指向新 `DealSwapTemplate`
- `DealFactory.swapOrderBook` 已指向新 `DealSwapOrderBook`
- `DealSwapOrderBook.router` 已指向新 `DealRouter`
- 新 Pair 已创建并初始化
- 新 Pair 已配置虚拟储备

### 前端

- 已切到新 Router
- 已切到新 Pair
- `exact-in` 默认走 `swapExact...`
- 下单前已接 `previewExact0For1 / previewExact1For0`

### 文案 / 产品

- 前端已明确显示：
  - 预计即时成交
  - 预计挂单输入
- 不再把 `minOut` 文案写成“整笔最终最少收到”

### 后端 / 索引

- 已同时索引：
  - `SwapExact...`
  - `SwapQueuedRemainder`
- 已更新 deployment json

---

## 8. 这次不需要重部署什么

这轮改动不需要你重部署：

- `Deal`
- `DL / DCToken`
- `DealInfoNFT`
- `DCDomain`
- `DCDomainMarket`
- `DCDomainRank`
- `DCDomainSwap`
- `DCDomainHall`
- `Governor / Timelock`

除非你们自己顺手想做一次整套换代，不然这些不是这次 DEX 更新的必要部署项。

---

## 9. 最简版部署结论

如果只记一句话：

**这次上线最关键的是：换新 `DealSwapTemplate`、换新 `DealSwapOrderBook`、换新 `DealSwapRouter`、重建新 Pair、前端切新 Pair 和新 Router；`DealFactory` 最好也一起升级，至少要更新 `pairImplementation` 和 `swapOrderBook`。**
