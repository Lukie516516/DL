# DEX Frontend Call Guide

这份文档给前端 / 测试 / 索引同学使用。

目标：
- 把当前 DEX 相关可调用接口整理到一处
- 明确这次虚拟流动性 / hybrid exact-in 后，前端应该怎么接
- 明确滑点参数到底是怎么传、保护哪一部分、什么情况下会 revert

适用范围：
- `DealSwapRouter`
- `DealSwapTemplate`
- `DealSwapOrderBook`
- `DealFactory`
- `DealSwapAssetRegistry`

---

## 1. 前端主要应该调哪些合约

### 1.1 普通用户交易

主入口看：
- `contracts/DealSwapRouter.sol`

普通 swap 前端，优先只接 `Router`，不要直接调 `Pair.swap()`

原因：
- `Router` 已经带 `deadline`
- `Router` 已经带 `minOut / maxIn`
- `Router` 已经兼容 hybrid exact-in
- `Router` 已经兼容 WNATIVE / ETH 路径

官方三资产入口：

| 资产 | Pair |
| --- | --- |
| AGI | `DC-AGI` |
| USDT | `DC-USDT` |
| AUSD | `DC-AUSD` |

前端优先通过 `DealSwapAssetRegistry.getSwapPairSet()` 读取 `pairDlAgi / pairDlUsdt / pairDlAusd / router`，避免写死地址。

### 1.2 池子展示 / 报价展示

读取看：
- `contracts/DealSwapTemplate.sol`
- `contracts/interfaces/IDealPair.sol`

这里能读到：
- 真实储备
- 虚拟储备
- 有效储备
- 基础报价
- TWAP cumulative

### 1.3 挂单 / 队列页

读取和操作看：
- `contracts/DealSwapOrderBook.sol`

这里能读到：
- 队列
- 某笔 order
- 当前最多可即时成交的输入上限

也可以做：
- 取消挂单
- 高级模式下直接下挂单

### 1.4 运营后台 / owner 面板

管理入口看：
- `contracts/DealFactory.sol`

这里能做：
- 配置 pair 虚拟储备
- 用 bps 配置虚拟储备
- 手动补 `OTHER`
- 补完顺手推进一轮结算

---

## 2. Router：普通前端最该接的入口

文件：
- `contracts/DealSwapRouter.sol`

### 2.1 exact-in 交易入口

这几组是普通兑换页最常用的：

- `swapExact0For1(pair, amount0In, minOut1, deadline)`
  - `DC -> OTHER`
- `swapExact1For0(pair, amount1In, minOut0Net, deadline)`
  - `OTHER -> DC`
- `swapExact0ForETH(pair, amount0In, minOutETH, deadline)`
  - `DC -> ETH`
- `swapExactETHFor0(pair, minOut0Net, deadline)`
  - `ETH -> DC`

当前语义：
- 这 4 个已经不是旧版“做不完就失败”
- 现在默认是 hybrid exact-in
- 能即时成交多少先成交多少
- 剩余未消耗输入自动进入队列

也就是说：
- `swapExact0For1` 现在本身就会自动排单
- 前端不需要再把 `OrQueue` 当另一套模式

### 2.2 exact-out 交易入口

- `swap0ForExact1(pair, out1Target, maxAmount0In, deadline)`
  - `DC -> OTHER`
- `swap1ForExact0Net(pair, out0NetTarget, maxAmount1In, deadline)`
  - `OTHER -> DC`
- `swap0ForExactETH(pair, outETHTarget, maxAmount0In, deadline)`
  - `DC -> ETH`
- `swapETHForExact0Net(pair, out0NetTarget, deadline)`
  - `ETH -> DC`
  - 用 `msg.value` 作为本次最大可接受输入

当前语义：
- exact-out 仍然是即时成交模式
- 不会把超出即时边界的目标输出自动排成条件单

### 2.3 双跳入口

- `swapExact1For1ViaDL(pairA, pairB, amountAIn, minOutB, deadline)`
- `swap1ForExact1ViaDL(pairA, pairB, outBTarget, maxAmountAIn, deadline)`
- `swapExactETHFor1ViaDL(pairWNATIVE, pairB, minOutB, deadline)`
- `swap1ForExactETHViaDL(pairA, pairWNATIVE, outETHTarget, maxAmountAIn, deadline)`
- `swapExact1ForETHViaDL(pairA, pairWNATIVE, amountAIn, minOutETH, deadline)`
- `swapETHForExact1ViaDL(pairWNATIVE, pairB, outBTarget, deadline)`

双跳也一样：
- exact-in 用 `minOut`
- exact-out 用 `maxIn`

### 2.4 兼容别名入口

这几个还保留着：
- `swapExact0For1OrQueue`
- `swapExact1For0OrQueue`
- `swapExactETHFor0OrQueue`
- `swapExact0ForETHOrQueue`

但现在它们只是兼容别名。

新前端建议：
- 直接统一调默认 `swapExact...`

---

## 3. Router：前端必须补的预览接口

这次新增后，前端最重要的新接口就是这 4 个：

### 3.1 exact-in 预览

- `previewExact0For1(pair, amount0In)`
- `previewExact1For0(pair, amount1In)`

返回结构：
- `immediateIn`
- `immediateOut`
- `queuedIn`
- `fullyImmediate`

前端应该这样用：
- 交易前先 preview
- 如果 `fullyImmediate = true`，按普通 swap 展示
- 如果 `fullyImmediate = false`，明确告诉用户：
  - 当前能立即成交多少
  - 有多少输入会进入队列

### 3.2 exact-out 预览

- `preview0ForExact1(pair, out1Target)`
- `preview1ForExact0Net(pair, out0NetTarget)`

返回结构：
- `fullyImmediate`
- `immediateOutCap`
- `queuedOut`
- `requiredInForTarget`
- `requiredInForImmediateCap`

要点：
- `queuedOut` 这里只是“如果超出即时边界，超出的那部分是多少”
- 它不是已经真的帮用户挂单了

### 3.3 前端建议展示文案

对于 exact-in：
- `预计即时成交`
- `预计进入排队`
- `是否全部即时完成`

对于 exact-out：
- `当前最多可即时拿到`
- `目标是否超过即时边界`
- `如果超过，当前不会自动排成目标单`

---

## 4. Pair：池子状态和价格展示读口

文件：
- `contracts/DealSwapTemplate.sol`

### 4.1 储备读取

- `getReserves()`
  - 返回真实储备
- `getVirtualReserves()`
  - 返回虚拟储备
- `getEffectiveReserves()`
  - 返回有效储备 = 真实储备 + 虚拟储备

这次前端必须补上的就是：
- `getVirtualReserves()`
- `getEffectiveReserves()`

因为虚拟流动性已经正式拆成了独立字段，不能再把 `getReserves()` 当全部深度。

### 4.2 建议展示方式

池子详情页建议分 3 组显示：
- 真实储备
- 虚拟储备
- 有效储备

不要再把“价格深度”和“真实可兑付余额”混成一个数字。

### 4.3 报价接口

- `quoteBuyGivenGross(amount0OutGross)`
- `quoteBuyGivenNet(out0NetTarget)`
- `quoteBuyGivenIn1(amount1In)`
- `quoteSell(amount0In)`
- `quoteSellGivenOut1(out1Target)`

用途：
- 做纯链上报价展示
- 做运营脚本
- 做高级模式校验

普通交易前端更建议优先用 `Router.preview...`

### 4.4 TWAP / 价格累计

- `getPriceCumulatives()`

说明：
- 现在 cumulative 已经按 effective reserves 对齐
- 所以前端/后端如果自己做 TWAP，也要理解它已经包含虚拟储备影响

---

## 5. OrderBook：队列页和挂单相关接口

文件：
- `contracts/DealSwapOrderBook.sol`

### 5.1 读取接口

- `orders(orderId)`
- `getQueue(pair, isSellDL)`
- `sellHead(pair)`
- `buyHead(pair)`
- `nextOrderId()`
- `maxImmediateSellIn(pair)`
- `maxImmediateBuyIn(pair)`

说明：
- `maxImmediateSellIn(pair)` 表示当前 `DC -> OTHER` 最多还能即时吃掉多少输入
- `maxImmediateBuyIn(pair)` 表示当前 `OTHER -> DC` 最多还能即时吃掉多少输入

### 5.2 用户操作接口

- `cancelOrder(orderId)`

如果做高级挂单页，还可以接：
- `placeSellDL(pair, amount0In)`
- `placeBuyDL(pair, amount1In)`

但普通 swap 页不要直接调它们，继续走 `Router` 即可。

### 5.3 订单字段说明

`orders(orderId)` 里常用字段含义：
- `owner`
- `pair`
- `isSellDL`
- `active`
- `remainingIn`
- `createdAt`
- `unwrapNativeOut`
- `refundNativeIn`

对 ETH/WNATIVE 路径：
- `unwrapNativeOut = true`
  - 说明后续成交时输出会解包成原生币
- `refundNativeIn = true`
  - 说明取消挂单时输入会按原生币退回

---

## 6. PairManager：运营后台要接的接口

文件：
- `contracts/DealPairManager.sol`

### 6.1 新增 / 这次需要补上的

- `setPairVirtualReserves(pair, virtualReserve0, enable0, virtualReserve1, enable1)`
- `setPairVirtualReservesByBps(pair, bps0, enable0, bps1, enable1)`
- `mintPairOtherAndSettle(pair)`

用途：

`setPairVirtualReserves`
- 直接按绝对值配置虚拟储备

`setPairVirtualReservesByBps`
- 以真实储备为基准按 bps 配置虚拟储备
- 更适合后台常规运维

`mintPairOtherAndSettle`
- owner 先往 pair 补 `OTHER`
- 调 pair 的 `mintOtherOnly()`
- 再调用 `settlePair(pair, 1, 8)`
- 如果当前配置的 order book 结算失败，本次补仓交易会回滚；运营可先修正 order book 或临时不配置 order book 后再补仓

### 6.2 其它前端可能会读的

- `DealPairManager.pairForToken(token)`
- `DealSwapAssetRegistry.getSwapPairSet()`

注意：
- `updateAndQuoteToDL` 不是普通用户前端随便调的公共报价口
- 它有调用者权限限制，更偏协议内部 / 特定合约使用

---

## 7. 前端实际接入建议

### 7.1 普通兑换页

最少接这些：

写：
- `swapExact0For1`
- `swapExact1For0`
- `swapExact0ForETH`
- `swapExactETHFor0`
- 如果需要 exact-out，再接 `swap0ForExact1` / `swap1ForExact0Net`

读：
- `previewExact0For1`
- `previewExact1For0`
- `preview0ForExact1`
- `preview1ForExact0Net`
- `getReserves`
- `getVirtualReserves`
- `getEffectiveReserves`

### 7.2 池子详情页

建议接：
- `getReserves`
- `getVirtualReserves`
- `getEffectiveReserves`
- `getPriceCumulatives`
- `maxImmediateSellIn`
- `maxImmediateBuyIn`

### 7.3 挂单 / 队列页

建议接：
- `orders(orderId)`
- `getQueue(pair, isSellDL)`
- `cancelOrder(orderId)`

### 7.4 运营后台页

建议接：
- `DealPairManager.setPairVirtualReserves`
- `DealPairManager.setPairVirtualReservesByBps`
- `DealPairManager.mintPairOtherAndSettle`

---

## 8. 滑点到底是怎么传的

结论先说：

- 现在没有“链上固定几个滑点档位”
- 没有合约里写死 `0.5% / 1% / 3%` 这种档位
- 当前滑点档位应该由前端自己提供给用户选择
- 用户每一笔交易，都是通过本次函数参数传入自己能接受的最大滑点

也就是说：
- exact-in 用 `minOut`
- exact-out 用 `maxIn`

### 8.1 exact-in

例如：
- `swapExact0For1(pair, amount0In, minOut1, deadline)`

前端逻辑一般是：

1. 先拿到预估输出
2. 用户选择本次可接受滑点，比如 `0.5%`
3. 前端计算：
   - `minOut = quoteOut * (1 - slippage)`
4. 把 `minOut` 传给 router

如果执行时即时成交部分低于这个 `minOut`：
- 交易会 `revert`

### 8.2 exact-out

例如：
- `swap0ForExact1(pair, out1Target, maxAmount0In, deadline)`

前端逻辑一般是：

1. 先拿到预估输入
2. 用户选择本次可接受滑点，比如 `0.5%`
3. 前端计算：
   - `maxIn = quoteIn * (1 + slippage)`
4. 把 `maxIn` 传给 router

如果执行时所需输入高于这个 `maxIn`：
- 交易会 `revert`

### 8.3 ETH exact-out

`swapETHForExact0Net`
和
`swapETHForExact1ViaDL`

这类路径没有单独的 `maxIn` 参数字段，
因为：
- `msg.value` 本身就充当本次最大输入上限

也就是说：
- 前端先按滑点算好本次最多愿意付多少 ETH
- 然后把这个值作为 `value` 发出去
- 如果实际需要超过它，就会失败
- 如果实际只用了更少，会退款

---

## 9. 当前滑点保护的真实语义

这一点前端必须理解清楚。

### 9.1 现在不是“没有滑点控制”

现在是：
- 有滑点控制
- 但滑点控制放在 `Router`
- 不是放在 `Pair`

因此：
- 普通前端必须走 `Router`
- 不要直接调 `Pair.swap()`

### 9.2 hybrid exact-in 下，`minOut` 保护的是哪部分

在当前版本里：
- exact-in 默认是 hybrid
- 能即时成交多少先成交多少
- 剩余输入自动排队

因此 `minOut` 保护的是：
- **即时成交部分**

不是：
- 用户整笔输入未来全部成交后的最终总输出

所以如果一笔单有一部分进入挂单：
- 当前 `minOut` 只保证“当场先成交这部分别太差”
- 不保证后续排队部分未来成交总结果

### 9.3 如果超过滑点会怎样

会直接 `revert`。

你可以把它理解成：
- exact-in：即时拿到的太少，则 `revert`
- exact-out：即时需要付的太多，则 `revert`
- deadline 过期，也 `revert`

常见回退原因：
- `SLIPPAGE`
- `SLIPPAGE_B`
- `SLIPPAGE_ETH`
- `MAX_IN_EXCEEDED`
- `MAX_IN_EXCEEDED_A`
- `ETH_NOT_ENOUGH`
- `EXPIRED`

---

## 10. 前端滑点建议

### 10.1 当前推荐做法

前端自己提供滑点档位，例如：
- `0.1%`
- `0.5%`
- `1%`
- `自定义`

这只是前端产品选择，不是链上固定规则。

### 10.2 不建议做法

不建议：
- 把滑点写死在前端代码里不可改
- 对 hybrid exact-in 继续只展示传统 DEX 文案“最少收到 xxx”

更合理的展示是：
- `预计即时收到`
- `预计进入排队的输入`
- `当前滑点只保护即时成交部分`

### 10.3 当前是否还需要再补一套链上滑点机制

结论：
- 当前普通交易不需要再补新的基础滑点机制
- 现有 `minOut / maxIn / deadline` 已经足够做标准保护

真正要不要继续做的是另一件事：
- 是否要给“排队部分”再加条件价格 / 条件成交保护

那已经不是普通滑点了，而是：
- 条件单
- 限价单
- 排队成交价格约束

这属于后续协议设计，不是这版已经具备的能力

---

## 11. 一句话接入建议

普通前端：
- 交易统一走 `Router`
- 下单前先调 `preview`
- 池子页补 `getVirtualReserves / getEffectiveReserves`
- 滑点由前端本次交易自己算成 `minOut / maxIn`
- 如果超过本次用户可接受范围，交易会 `revert`

运营后台：
- 补 `DealPairManager.setPairVirtualReserves`
- 补 `DealPairManager.setPairVirtualReservesByBps`
- 补 `DealPairManager.mintPairOtherAndSettle`
