# Agiking 前端交付信息

部署时间：2026-05-12  
链 ID：31415926  
RPC：https://rpc.agikingrpc.shop  
部署钱包：0xe88c63d29ece76e3336b0db747e10876c3bf9893  
地址与 ABI 总表：`deployments/agiking-31415926.json`

## 前端主要读取文件

前端优先使用：

```text
deployments/agiking-31415926.json
```

其中：

```text
addresses = 最新合约地址
abi = 最新 ABI
```

## 核心地址

| 名称 | 地址 |
| --- | --- |
| `dlToken` | `0x9f61795163127c9e22256c79a455b792f572757e` |
| `ausd` | `0x1813b638e9019a99f21afb5d669ba4b92255e890` |
| `usdt` | `0x20a354476a7aff3ca222397be9d772c206a9c555` |
| `wrappedNative` | `0x6e20de6be74ec17618a9a3c5288c29b80b14ffb1` |
| `dealFactory` | `0xbce6ad11cac8fda4d35133833fcf840cf853d860` |
| `dealReader` | `0xc7c825ba5128e5ebf9f662db07f77ad06c0ef447` |
| `dealMessageHub` | `0x15300673487d74a0a79db19c625d082664a03a68` |
| `dealCreditGraph` | `0x7cf62026ce199d7c7188ae50a34522fa325c2fd5` |
| `dealInfoNFT` | `0xf235ca219e3a25edaf164214a1a9863f8c080681` |
| `dealSwapOrderBook` | `0x049d0f811d50b052a3cf65bf5f19421d3902773b` |
| `dealRouter` | `0x9a71f32922147872b6db68f98f083ab3fa102820` |
| `pairDlAusd` | `0x48d9c1fEc7b1fD85CEE883B27bf3e3cBD1eeb13C` |
| `pairDlUsdt` | `0x40831F34422df51A67B3a9c5933753dCccBCDD50` |
| `dcDomain` | `0x1afbbb63ee49f687355a5dfb32d48f68e8699303` |
| `dcDomainRank` | `0xf405b4006af3d959fd2766f45dc8f668e72e2f5d` |
| `dcDomainMarket` | `0x5a1492101d94b27403128ef7c9a5baddf4082daa` |
| `dcDomainSwap` | `0x02903d74bc6c1e8b5f205cbdec54f46529eb8b10` |
| `dcDomainHall` | `0x6e22e612ee4b12f6f1a00b9f5606ab15c5da152c` |

## Deal 模板实现地址

这些主要给部署/排查使用，前端一般不直接调用：

| 名称 | 地址 |
| --- | --- |
| `dealImplementation` | `0xc31b883019785b984840f9dc8a0096248d00fd54` |
| `dealNoAssetImplementation` | `0x283604b05a56d195fb90384314940c1682f13c22` |
| `dealAAssetNftImplementation` | `0x0eff53b6a418091566f65f3a772cafe28223ed57` |
| `dealBAssetNftImplementation` | `0xa306bea20205293f5d1c1137e1bbf571c64d669a` |
| `dealAAssetNftOnlyImplementation` | `0x708b3b3cb2ef802902232c098fc8e4846bc4db59` |
| `dealBAssetNftOnlyImplementation` | `0xb4fbaea390b1734879c50a30094604eece0f9f01` |
| `dealOpenTokenTokenImplementation` | `0x29caf64f489276d589fe8ba6f2699b8d682c13d6` |
| `dealImplementationRegistry` | `0xee012562426a6fca0dd74875637fd81405a4aa11` |
| `dealActivityIndex` | `0xe2fee660bd1caa4c672b07367e96e1d64fe36a85` |

## 前端创建 deal

普通 deal 仍然调用：

```text
DealFactory.createDeal(CreateParams)
```

币币快速模板：

```text
init.templateType = TokenToToken
init.joinMode = Open
init.openTokenTokenFast = true
```

域名入口：

```text
DCDomainSwap
DCDomainHall
```

域名入口内部会通过 `DealFactory.createDealFor` 创建 deal。

## 信用分读取

信用分合约：

```text
DealCreditGraph = 0x7cf62026ce199d7c7188ae50a34522fa325c2fd5
```

常用读接口：

```text
creditScore(tokenId)
topCreditPeers(tokenId)
bestCandidateOf(tokenId)
```

规则：

```text
信用只绑定官方 DealInfoNFT tokenId
外部 NFT 不参与信用分
信用分只由成功完成 deal 产生
swap/orderbook 不产信用分
```

## 前端限制

| 项目 | 限制 |
| --- | --- |
| deal title | 最大 96 bytes |
| deal description | 最大 1500 bytes，可为空 |
| message | 最大 1500 bytes |
| DealReader batch | 最大 100 个 deal |
| message page limit | 最大 100 |
| DomainMarket page limit | 最大 100 |
| OrderBook queue page limit | 最大 100 |
| timeoutSeconds | 最大 1 day |

注意：限制是 bytes，不是字符数。中文和 emoji 会占多个 bytes。

`deal description` 是创建时上链描述字段，需要使用更新后的 ABI 和重新部署后的合约地址；当前旧部署地址不支持这个字段。

## 部署后自检

已完成链上自检：

```text
Factory globals OK
ImplementationRegistry OK
CreditGraph recorder OK
InfoNFT factory OK
OrderBook router OK
```

部署钱包当前测试币余额：

```text
DL: 8,000,000
AUSD: 9,000,000
USDT: 9,000,000
WNATIVE: 10,000,000
```

## 重要提醒
