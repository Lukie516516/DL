# Deal 合约版本更新说明 3

这份文档是我对这轮 DEX / 虚拟流动性更新的交接说明。

适用对象：
- 合约负责人回顾
- 前端
- 索引 / 后端

---

## 1. 这次我改了什么

这次主要完成了 7 块：

1. 虚拟储备和真实储备正式拆开
2. `exact-in` 默认收口成 hybrid 路径
3. 增加前端预览接口
4. 修正 `TWAP` 和虚拟储备的一致性
5. 修正 `OTHER -> DL` 队列对 fee-on-transfer token 的处理
6. 补充了“补仓后顺手结算排单”的 Factory 入口
7. 把 `Deal` 聊天存储从本体拆到独立 `DealMessageHub`

这次更新主要围绕这些合约：

- [`DealSwapTemplate.sol`](../contracts/DealSwapTemplate.sol)
- [`DealSwapRouter.sol`](../contracts/DealSwapRouter.sol)
- [`DealSwapOrderBook.sol`](../contracts/DealSwapOrderBook.sol)
- [`DealFactory.sol`](../contracts/DealFactory.sol)
- [`Deal.sol`](../contracts/Deal.sol)
- [`DealMessageHub.sol`](../contracts/DealMessageHub.sol)

新增入口：

- `DealFactory.mintPairOtherAndSettle(pair)`

它的语义是：

- 先调用 Pair 的 `mintOtherOnly()`
- 再尝试调用 `DealSwapOrderBook.settlePair(pair, 1, 8)`
- 这里结算使用 `try/catch`
- 即使结算失败，也不会把本次补充的 `OTHER` 流动性一起回滚

这适合用在：

- owner 手动往 Pair 补 `OTHER`
- 希望补仓动作顺手推进一轮挂单结算
- 但又不希望因为某一笔排单异常把补仓交易整体打回

### Deal 聊天现在怎么接

这次为了把 `Deal` 主合约体积压回安全范围，聊天能力做了“保功能、拆承载”的处理：

- `Deal.postMessage(string)` 还保留
- 聊天内容不再存在 `Deal` 本体 storage
- 聊天内容改存到独立合约 `DealMessageHub`

这意味着：

- 写消息时，前端仍然可以从 `Deal` 地址发起 `postMessage`
- 读消息时，前端/索引应改为通过 `DealMessageHub` 读取

推荐读取方式：

1. 先从 `Deal.factory()` 找到对应 `DealFactory`
2. 再从 `DealFactory.dealMessageHub()` 取到消息中心地址
3. 调 `DealMessageHub.messagesCount(deal)` / `DealMessageHub.getMessages(deal, offset, limit)`

这样做的好处是：

- 用户交互入口基本不变
- 聊天功能不丢
- `Deal` 本体字节显著减轻

---

## 2. 虚拟流动性现在怎么定义

这次最核心的变化是：

- 以前代码里有一版“虚拟深度混进 reserve”的半成品
- 现在已经改成“真实储备”和“虚拟储备”分开存

也就是说：

- `reserve0 / reserve1` 表示真实储备
- `virtualReserve0 / virtualReserve1` 表示虚拟储备
- 报价用的是 `effective reserve = real + virtual`
- 即时可兑付能力看的是**真实储备**

相关读取接口：

- `getReserves()`
- `getVirtualReserves()`
- `getEffectiveReserves()`

定义位置：

- [`IDealPair.sol`](../contracts/interfaces/IDealPair.sol)
- [`DealSwapTemplate.sol`](../contracts/DealSwapTemplate.sol)

---

## 3. exact-in 现在的最终语义

这次已经定下来的口径是：

- 不再保留 `Immediate-Only`
- `exact-in` 默认就是 hybrid

意思是：

- 能即时成交多少，先成交多少
- 剩余未消耗输入自动挂单
- 如果本来就能一次吃完，那就直接成交完

所以当前这几类入口：

- `swapExact0For1`
- `swapExact1For0`
- `swapExact0ForETH`
- `swapExactETHFor0`

都已经不是旧版那种“做不完就失败”，而是默认 hybrid 语义。

同时，旧的这些兼容入口还保留着：

- `swapExact0For1OrQueue`
- `swapExact1For0OrQueue`
- `swapExact0ForETHOrQueue`
- `swapExactETHFor0OrQueue`

但现在它们只是**兼容别名**，语义已经和默认 `swapExact...` 一样。

也就是说：

- 前端新接入时，建议直接调默认 `swapExact...`
- 不需要再把 `OrQueue` 当成另一套模式

相关位置：

- [`DealSwapRouter.sol`](../contracts/DealSwapRouter.sol)

---

## 4. exact-out 现在到哪里了

这次没有把 `exact-out` 做成自动排队。

当前状态是：

- 可以即时成交
- 可以 preview
- 但如果目标超过当前即时边界，不会自动把“剩余目标输出”继续挂单

当前 `exact-out` 相关执行入口仍然是：

- `swap0ForExact1`
- `swap1ForExact0Net`
- `swap0ForExactETH`
- `swapETHForExact0Net`

当前 `exact-out` 相关预览入口：

- `preview0ForExact1`
- `preview1ForExact0Net`

也就是说：

- `exact-in` 已经是默认 hybrid
- `exact-out` 还是“即时成交 + 预览”，不是条件订单

---

## 5. 前端现在该怎么接

### 5.1 exact-in

用户如果输入的是“我要拿多少币去换”，前端应直接调用：

- `swapExact0For1(pair, amount0In, minOut1, deadline)`  
  `DL -> OTHER`
- `swapExact1For0(pair, amount1In, minOut0Net, deadline)`  
  `OTHER -> DL`
- `swapExact0ForETH(pair, amount0In, minOutETH, deadline)`  
  `DL -> ETH`
- `swapExactETHFor0(pair, minOut0Net, deadline)`  
  `ETH -> DL`

并在下单前配合读取：

- `previewExact0For1`
- `previewExact1For0`

返回里最重要的字段是：

- `immediateIn`
- `immediateOut`
- `queuedIn`
- `fullyImmediate`

前端建议明确展示：

- 预计即时成交多少
- 预计有多少输入会进入挂单
- 这笔单是不是全部即时完成

### 5.2 exact-out

用户如果输入的是“我就要拿到多少”，前端仍然调用旧的 `exact-out` 入口。

这类下单前建议配合读取：

- `preview0ForExact1`
- `preview1ForExact0Net`

重点字段：

- `fullyImmediate`
- `immediateOutCap`
- `queuedOut`
- `requiredInForTarget`
- `requiredInForImmediateCap`

注意：

- `queuedOut` 这里只是“预览意义上的超出部分”
- 不是系统已经帮用户挂进去了

---

## 6. `minOut` 现在要怎么理解

这点一定要跟前端和产品说清楚。

在现在默认 hybrid 的 `exact-in` 里：

- `minOut` 保护的是**即时成交部分**
- 不是整笔输入未来全部成交后的总输出

例如：

- 用户输入很多资产
- 当前只能即时吃掉一部分
- 剩余输入进入挂单

这时 `minOut` 校验的是：

- “当场先成交这部分值不值”

不是：

- “未来挂单也全部成交后，最终总共至少收到多少”

所以前端文案不建议继续写成传统 DEX 那种：

- “最少收到 xxx”

更准确应该拆成：

- `预计即时收到`
- `预计进入挂单的输入`
- `最终总收到取决于后续结算`

---

## 7. 价格现在是否和虚拟流动性相关

是的。

这次改完后：

- Pair 报价
- Router preview
- 价格曲线

都已经和虚拟储备相关。

但要区分两件事：

### 7.1 报价

看的是：

- `real reserve + virtual reserve`

### 7.2 即时兑付

看的是：

- 真实储备

所以现在的模型是：

- 虚拟储备负责价格支撑 / 曲线深度
- 真实储备负责当前能实际给出去多少
- 超出真实即时边界的部分，进入挂单

---

## 8. 这次补的治理和配置能力

这次给 Pair / Factory 补了虚拟储备配置入口。

当前 owner 可以：

- 直接设置绝对虚拟储备
- 也可以按当前真实储备的 `bps` 快速生成一版虚拟储备

相关入口：

- `DealSwapTemplate.setVirtualReserves(...)`
- `DealSwapTemplate.setVirtualReservesByBps(...)`
- `DealFactory.setPairVirtualReserves(...)`
- `DealFactory.setPairVirtualReservesByBps(...)`

这意味着：

- 新 Pair 可以直接按这套规则配置
- 老 Pair 不会自动升级逻辑

---

## 9. 这次额外修的两个隐蔽问题

### 9.1 TWAP 和虚拟储备不一致

我这次把 `TWAP` 口径修正了。

修正前的问题是：

- Pair 的 cumulative 价格已经按 effective reserve 算
- 但 Factory 在推当前 spot 时还只按真实 reserve 算

结果会导致：

- `updateAndQuoteToDL()` 这类路径
- 跟 Pair 真正报价

可能不一致。

现在已经改成：

- cumulative 和当前 spot 都按 effective reserve

另外，我还补了一个细节：

- 修改虚拟储备前，会先把旧价格窗口滚进 cumulative
- 避免把整段历史错误地按新虚拟储备价格重算

相关位置：

- [`DealSwapTemplate.sol`](../contracts/DealSwapTemplate.sol)
- [`DealFactory.sol`](../contracts/DealFactory.sol)

### 9.2 fee-on-transfer 的 `OTHER -> DL` 队列结算

这次我把带税 / fee-on-transfer token 的 `OTHER -> DL` 路径修正了。

现在处理方式是：

- 用户打进 Router / OrderBook 时，按**实际到账量**记账
- OrderBook 往 Pair 结算时，也按**实际到 Pair 的量**报价

避免以前那种：

- 合约以为到了 `100`
- 实际 Pair 只收到 `90`
- 后续 quote / swap 口径不一致

相关位置：

- [`DealSwapOrderBook.sol`](../contracts/DealSwapOrderBook.sol)
- [`DealSwapRouter.sol`](../contracts/DealSwapRouter.sol)

---

## 10. 事件现在怎么读

现在默认 `exact-in` 入口在 hybrid 情况下，通常会发两类事件：

### 10.1 即时成交事件

例如：

- `SwapExact0For1`
- `SwapExact1For0`
- `SwapExact0ForETH`
- `SwapExactETHFor0`

这些现在代表的是：

- 即时成交那一段

### 10.2 挂单事件

如果还有剩余输入进入队列，还会额外发：

- `SwapQueuedRemainder`

它主要表达：

- 即时成交了多少
- 剩余挂了多少
- 对应的 `orderId`

所以索引器 / 前端如果要完整还原一次 hybrid 交易，
要把这两类事件一起看。

---

## 11. 这次需要重新部署哪些

如果要让这套逻辑真正上线生效，最低要注意：

- `DealSwapTemplate`
- `DealSwapOrderBook`
- `DealSwapRouter`

这三类必须换新。

其中最关键的是：

- 旧 Pair 是 clone 出来的
- 老 Pair 不会因为你更新 implementation 就自动升级

所以：

- 新逻辑一定要在**新 Pair** 上生效
- 前端也要切到新 Router / 新 Pair

`DealFactory` 这边分两种：

- 可以重部署新 Factory
- 也可以保留旧 Factory，但调用 `setPairImplementation(newImpl)`，之后重新建新 Pair

一句话：

- Router 要换
- OrderBook 要换
- Pair implementation 要换
- 老 Pair 需要重建

---

## 13. 测试和当前结论

这次我在结束前重新跑了：

- `./node_modules/.bin/hardhat compile`
- `./node_modules/.bin/hardhat test`

当前结果：

- `48 passing`

这轮新增覆盖的重点包括：

- 真实储备 / 虚拟储备分离
- 默认 `exact-in` hybrid 行为
- preview 输出
- `ETH/WNATIVE` 路径
- `TWAP` 和虚拟储备一致性
- 虚拟储备修改前的 cumulative 滚动
- fee-on-transfer 的 `OTHER -> DL` 路径

当前结论可以概括成一句话：

**现在 DEX 已经切成“虚拟储备参与定价、真实储备决定即时兑付、exact-in 默认部分成交加剩余挂单、exact-out 仅支持即时成交和预览”的版本。**

