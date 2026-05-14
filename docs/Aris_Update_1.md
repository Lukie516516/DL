# Deal 合约版本更新说明

这份文档是给当前版本做的交接说明。

适用对象：
- 合约负责人回顾
- 前端
- 索引/后端

---

## 1. 这版我做了什么

这次主要完成了两大块：

1. 手续费 / 返佣规则重构
2. 点对点交易模板落地，并补上 NFT 真交割

现在这套链上逻辑已经支持：

- `TokenToToken`
- `TokenToNft`
- `TokenToEmpty`
- `EmptyToEmpty`
- `NftToEmpty`

而且这些模板都走同一个 [`Deal`](../contracts/Deal.sol) 状态机，不单独开聊天合约。

---

## 2. 当前模板类型

`templateType` 已经上链，前后端可以直接读取。

当前枚举值：

- `0 = TokenToToken`
- `1 = TokenToNft`
- `2 = TokenToEmpty`
- `3 = EmptyToEmpty`
- `4 = NftToEmpty`

定义位置：
- [`IDeal.sol`](../contracts/interfaces/IDeal.sol)
- [`Deal.sol`](../contracts/Deal.sol)
- [`DealFactory.sol`](../contracts/DealFactory.sol)

---

## 3. 当前手续费和返佣规则

### 3.1 计算口径

- 只按 `swapAmount` 计算
- `marginAmount` 不参与手续费和返佣
- NFT 不做价格估值

### 3.2 认可币

Agiking（`chainId = 31415926`）当前默认认可币以 [`deployments/agiking-31415926.json`](../deployments/agiking-31415926.json) 为准，例如：

- `AUSD = 0x63b477617669c0e62914951b1a1cc61b315af9e5`
- `USDT = 0x3bb6ed33bd4453189a1d79feab6583d103d8cb08`

并且原生币会归一化到 `WNATIVE` 路径。

可后续通过 owner 调整：

- `DealFactory.setRecognizedTokens(address token0, address token1)`

### 3.3 手续费规则

#### 认可币

- 双边各收 `0.3%`
- 手续费进入对应的 `DL-token` pair
- 不是直接进 treasury

#### 不认可币

- 双边各收 `0.3%`
- 手续费进 `treasury`
- 不返佣

#### DL-DL

- 不 mint 返佣
- 双边各收 `0.1%`
- 有 `C`：给 `C`
- 没有 `C`：burn

### 3.4 返佣规则

返佣发的是 `DL`，不是原交易币种。

#### 没有 `C`

- `A = 0.1%`
- `B = 0.1%`

#### 有 `C`

- `A = 0.1%`
- `B = 0.1%`
- `C = 0.1%`

#### DL + 认可币

- 只按认可币那一侧计算返佣

#### 缺失 DL pair

- 如果交易用的是认可币，但没有配置对应 `DL` pair
- 创建 deal 时直接拒绝
- 避免“创建成功但返佣是 0”

---

## 4. NFT 现在怎么用

### 4.1 身份 NFT

当前项目里的 [`DealInfoNFT`](../contracts/DealInfoNft.sol) 仍然承担这些角色：

- 身份 NFT
- 门禁 NFT
- 社交关系节点
- 奖励统计载体

这些字段还是原来的意思：

- `aNftId`
- `bNftId`
- `gateNftId`

也就是说：

- `aNftId / bNftId` 是“这笔交易里绑定的身份 NFT”
- `gateNftId` 是“进入这笔交易需要持有的 NFT”

### 4.2 商品 NFT

这次新增了“真正用于交割的 NFT”字段：

- `aAssetNftId`
- `bAssetNftId`

它们表示：

- A 侧拿来卖/交割的 NFT
- B 侧拿来卖/交割的 NFT

### 4.3 重要规则

身份 NFT 和商品 NFT来自同一个 `DealInfoNFT` 合约，但不能冲突。

当前已经实现这些限制：

- 作为身份/门禁使用的 NFT，不能同时作为这笔交易的商品 NFT
- 已经被别的交易锁住的 NFT，不能拿来卖
- 未锁定、且不是当前交易绑定中的 NFT，可以拿来交易

---

## 5. NFT 真交割现在怎么工作

### 5.1 TokenToNft

例如：

- A 出 `USDT`
- B 出 `NFT`

流程：

1. A 创建 deal
2. B 加入
3. A 在 `pay()` 时把 token 打进 deal
4. B 在 `pay()` 时把商品 NFT 托管进 deal
5. 双方确认
6. 完成时：
   - token 转给 B
   - NFT 转给 A

### 5.2 NftToEmpty

例如：

- A 出 `NFT`
- B 不出资产

流程：

1. A 创建 deal
2. B 加入
3. A 在 `pay()` 时把 NFT 托管进 deal
4. 双方确认
5. 完成时 NFT 转给 B

### 5.3 失败 / 取消 / 退出时

如果交易没有完成：

- `withdrawInActive()`
- `exitByB()`
- `kickBByA()`
- `abandonByA()`
- `_cancel()`

这些路径下，托管的商品 NFT 会退回原 owner。

---

## 6. 身份 NFT 卖掉以后会发生什么

当前这套系统是 **token-centric**，不是 address-centric。

意思是：

- 历史和关系网挂在 `tokenId` 上
- 不是挂在地址上

所以卖掉 NFT 后，跟着 NFT 一起走的有：

- `username`
- `userdetail`
- 图片/媒体
- `totalDLMinted`
- `maxPartner`
- 以后基于这张 NFT 的社交关系收益

不会回滚的有：

- 过去已经 mint 给旧地址的钱
- 历史 deal 里已经记录下来的 A/B 地址

一句话：

- 卖掉 NFT，不是复制一份历史给新地址
- 而是新 owner 接手这张“带历史的身份卡”

---

### 7.1 创建入口

主入口：

- [`DealFactory.createDeal(...)`](../contracts/DealFactory.sol)

这个是所有模板统一入口。

前端创建任何模板，最终都调用这个函数。

#### 创建参数里最关键的字段

- `aSwapToken`
- `aSwapAmount`
- `aMarginToken`
- `aMarginAmount`
- `bSwapToken`
- `bSwapAmount`
- `bMarginToken`
- `bMarginAmount`
- `aAssetNftId`
- `bAssetNftId`
- `templateType`
- `joinMode`
- `expectedB`
- `gateNftId`
- `aNftId`
- `title`
- `timeoutSeconds`

### 7.2 交易流程入口

交易创建后，前后端需要按状态调用：

- `Deal.join(uint256 optId, bool trackMe)`
- `Deal.pay()`
- `Deal.setMyVote(Vote v)`
- `Deal.forceComplete()`
- `DealMessageHub.postMessage(address deal, string content)`

### 7.3 Reader 只读聚合

只读推荐用：

- [`DealReader.getDeal(...)`](../contracts/DealReader.sol)
- [`DealReader.getDeals(...)`](../contracts/DealReader.sol)
- [`DealReader.getDealsSlim(...)`](../contracts/DealReader.sol)
- [`DealReader.getDealPlus(...)`](../contracts/DealReader.sol)

现在 `Reader` 已经支持读取：

- `templateType`
- `aAssetNftId`
- `bAssetNftId`
- 原有状态字段
- A/B 资产信息
- A/B 身份 NFT 信息

### 7.4 身份 NFT 铸造入口

如果前端要让用户拿到身份 NFT：

- `DealInfoNFT.mintByBurn()`

它会：

1. 按配置价格折算需要多少 DL
2. burn 用户的 DL
3. mint 一张新的 `DealInfoNFT`

---

## 8. 前端怎么接

如果前端不自己做复杂索引，至少要按这个方式接。

### 8.1 创建页

前端根据 `templateType` 出不同表单：

#### TokenToToken

- A token
- A amount
- B token
- B amount

#### TokenToNft

- token 一侧的 token / amount
- NFT 一侧的 `assetNftId`
- 可选身份 NFT

#### TokenToEmpty

- 一侧 token / amount
- 另一侧为空

#### EmptyToEmpty

- 双边都不填 swap
- 只填标题、对象、说明

#### NftToEmpty

- 一侧填 `assetNftId`
- 另一侧为空

### 8.2 创建后

前端应监听：

- `DealCreated`
- `DealTemplateTagged`

拿到新 deal 地址后，再跳转详情页。

### 8.3 详情页

详情页推荐调用：

- `DealReader.getDeal(...)`
或
- `DealReader.getDealPlus(...)`

这样前端不用自己一项项拼。

---

## 9. 索引服务

索引/后端同学重点关注：

- `DealFactory` 的创建事件
- `Deal` 的状态变化事件
- `templateType`
- `DealReader`

### 适合被索引的事件

至少建议监听：

- `DealCreated`
- `DealTemplateTagged`
- `Joined`
- `Locked`
- `Completed`
- `Canceled`
- `Claimed`
- `FeesProcessed`
- `RewardsMinted`
- `DealMessageHub.MessageStored`
- `AssetNftDeposited`
- `AssetNftReleased`

---

## 10. 这版测试覆盖了什么

当前测试文件：

- [`test/DealRules.ts`](../test/DealRules.ts)

当前已通过测试覆盖：

- 认可币双边手续费进 pair
- 不认可币手续费进 treasury
- `DL-DL` 手续费 / burn
- 保证金不参与手续费和返佣
- 认可币缺 pair 时拒绝创建
- `EmptyToEmpty` 模板
- `TokenToNft` 真交割
- `NftToEmpty` 真交割
- A 的身份 NFT 不能同时当商品卖
- B 的进入 NFT 不能同时当商品卖
- 已锁定 NFT 不能卖

当前测试通过结果：

- `11 passing`

---

### 11.1 不是范围内的

- 前端页面
- 索引服务
- 后端 HTTP API

### 11.2 合约范围内还存在的风险

最大的风险是 **合约体积**。

当前：

- [`Deal.sol`](../contracts/Deal.sol) 体积超主网限制警告
- [`DealFactory.sol`](../contracts/DealFactory.sol) 也超限制警告

所以：

- 本地测试没问题
- 某些链可能也能部署
- 但如果目标链严格遵守主网合约大小限制，部署前还需要优化/拆分

---

## 12. 需求

已经完成的核心项包括：

- 模板系统
- 手续费系统
- 返佣系统
- 认可币规则
- Deal 状态机
- NFT 商品交割
- 身份 NFT / 商品 NFT 共用并加边界限制

如果看“整个产品是否全部完成”：

- 还没有

还差：

- 前端接入
- 索引/后端
- 部署级体积优化

---

## 13. 

### 给前端

- `DealFactory` ABI
- `Deal` ABI
- `DealReader` ABI
- `DealInfoNFT` ABI
- 这份版本说明

### 给索引/后端

- `DealFactory` 地址
- `DealReader` 地址
- 事件列表
- `templateType` 定义
- 认可币配置

### 给产品

- 模板支持范围
- NFT 交易限制
- 当前未完成项：主网体积优化、应用层接入

---

## 14. 

这版已经把 DealCoin 的核心链上交易底座搭起来了：

- 手续费和返佣规则完成
- 5 种模板已经定义
- 其中 5 种模板里有 5 种已经有链上语义，且 `TokenToNft / NftToEmpty` 现在是能真交割的
- NFT 身份和 NFT 商品使用同一个合约，但做了“当前绑定中的 NFT 禁售”和“已锁 NFT 禁售”
- 现在最大的未完成项不是业务逻辑，而是前后端对接和主网部署体积优化
