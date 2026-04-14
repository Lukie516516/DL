# Deal 合约版本更新说明 2

这份文档是我对今天这轮更新的简要交接。

适用对象：
- 合约负责人回顾
- 前端
- 索引 / 后端

---

## 1. 这次我补了什么

这次我主要补了 4 块：

1. DEX 单跳自动挂单路径补全
2. 保证金币种白名单
3. NFT 编号规则
4. 第一轮体积优化和回归测试

---

## 2. DEX 这次补到哪里

我把单跳自动挂单补完整了，当前支持：

- `DL -> OTHER`
- `OTHER -> DL`
- `ETH / 原生币 -> DL`
- `DL -> ETH / 原生币`

现在挂单逻辑是：

- 先按当前池子可成交部分立即成交
- 剩余部分自动进入挂单队列
- 队列按 FIFO 结算
- 流动性补进来后，可以手动或通过已有流程顺手推进结算
- 用户自己可以取消挂单
- 取消时收 `0.1%` 到 `treasury`

相关合约：

- [`DealSwapRouter.sol`](../contracts/DealSwapRouter.sol)
- [`DealSwapOrderBook.sol`](../contracts/DealSwapOrderBook.sol)

我这次还把一个产品体验细节补齐了：

- 如果是 `ETH -> DL` 自动挂单
- 用户取消订单时
- 现在退回的是原生币，不是 `WNATIVE`

---

## 3. 保证金币种白名单

这次我把保证金币种白名单正式加进合约了。

当前逻辑：

- 创建 Deal 时，会校验 `aMarginToken / bMarginToken`
- 默认允许：
  - `DL`
  - `wrappedNative`（链上原生币对应的包装币）
  - `recognizedToken0`
  - `recognizedToken1`
- owner 还可以额外放开新的保证金币种

所以现在这条需求已经不是“文档有、链上无”了。

相关入口：

- [`DealFactory.sol`](../contracts/DealFactory.sol)
- `allowedMarginToken`
- `setAllowedMarginToken(address token, bool allowed)`

---

## 4. NFT 编号

这次我把 NFT 展示编号做成了赛季编号风格。

当前格式：

- `S{season}-{YYYYMMDD}-{dailySerial}`

例如：

- `S1-20260329-1`

规则：

- mint 时生成
- 内部 `tokenId` 还是原本的 ERC721 唯一 ID
- 展示编号跟随 NFT 本身，不跟随地址
- 前端可以直接读取 `displayNoOf(tokenId)`

相关合约：

- [`DealInfoNft.sol`](../contracts/DealInfoNft.sol)

---

## 5. 接口和读取层

这次没有改坏原有接口分层，当前前后端可以继续按下面这几层对接：

- 创建 / 配置 / 全局管理：[`DealFactory.sol`](../contracts/DealFactory.sol)
- 单个 Deal 状态和动作：[`Deal.sol`](../contracts/Deal.sol)
- 只读聚合：[`DealReader.sol`](../contracts/DealReader.sol)
- DEX 路由：[`DealSwapRouter.sol`](../contracts/DealSwapRouter.sol)
- 挂单：[`DealSwapOrderBook.sol`](../contracts/DealSwapOrderBook.sol)
- NFT 展示编号：[`DealInfoNft.sol`](../contracts/DealInfoNft.sol)

时间相关字段目前也已经在链上和 Reader 里打通：

- `timeStart`
- `timeEnd`

前端 / 索引可以直接从 Reader 读，

相关位置：

- [`IDeal.sol`](../contracts/interfaces/IDeal.sol)
- [`Deal.sol`](../contracts/Deal.sol)
- [`DealReader.sol`](../contracts/DealReader.sol)

---

## 6. 这次我没有做的

这次我明确没有继续做这些：

- `Deal` 完整改参数 / 重配流程  //明显加重复杂度，但不是当前主流程上线阻塞项 

- 系统聊天提示上链  //与合约无关
- `description` 上链 //与合约无关

- DEX 双跳自动挂单 //明显加重复杂度，但不是当前主流程上线阻塞项

- DEX exact-out 自动挂单 //明显加重复杂度，但不是当前主流程上线阻塞项

- NFT 信誉系统 //明显加重复杂度，但不是当前主流程上线阻塞项

---

## 7. 测试和当前结论

我在这轮结束前又重新跑了全量测试。

当前结果：

- `npx hardhat test`
- `26 passing`

也就是说：

- 今天补的 DEX 自动挂单逻辑是通的
- 保证金币种白名单是通的
- NFT 编号逻辑是通的
- 之前已经做好的 Deal 主流程没有被这轮改坏

---

## 8. 当前还需要注意的风险

当前最大的剩余风险不是功能，而是部署体积。

我已经做了第一轮低风险体积优化：

- 部署 profile 开启 `viaIR`
- `Deal.sol` 部分字符串报错收敛成错误码

但标准主网限制下，`Deal.sol` 仍然偏大，后面如果要正式部署，还需要继续做第二轮体积优化。
