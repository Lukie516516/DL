# Agiking 前端交付信息

部署时间：2026-05-13
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
| `dlToken` | `0xf9606500fbbea6d220bb65fc5cea9641c6e436d3` |
| `ausd` | `0x61b625206675c95a93a9dd45e386ab2801f4d96c` |
| `usdt` | `0x7677a9c80622b395a52754c14379eb48febdbba0` |
| `wrappedNative` | `0x631b09c6905ce136074be938c82a1df16443e676` |
| `dealFactory` | `0x6de82c8432b5a15555f60d52b0717781d770a565` |
| `dealReader` | `0xa316012d76045e5dd97fb9bed176e63590325d30` |
| `dealMessageHub` | `0x18bc613d8ce4c7e0117aeaf52c0910317e30b7d3` |
| `dealCreditGraph` | `0x96a8547929ae75afc344522575f0dd59c222650d` |
| `dealInfoNFT` | `0xdba1efb9d7ce36e8ba3f51a857e5364bd98502f3` |
| `dealSwapOrderBook` | `0x1d293938b5f8335142aabf4cc9545dafcfc5816f` |
| `dealRouter` | `0x52d02e04813f66a36b96ff9f3fb63f7ad7a695e0` |
| `pairDlAusd` | `0x314DA00dE1f773cB6abb3F8c213D17e19F56D44b` |
| `pairDlUsdt` | `0x9321D09a931c6eF44EAD872d01774F0C34891842` |
| `dcDomain` | `0xea6d563afe03142e8b9a0996b7f03c35b8ed45a3` |
| `dcDomainRank` | `0xf1bb9e705f5366febcd15a14e785fb26228fcd8c` |
| `dcDomainMarket` | `0x10f393c7e7544c29eb6a768de4b1bb5e8a507fdd` |
| `dcDomainSwap` | `0x22e4daf9266eebd906d38a7b419b8e4e550481d9` |
| `dcDomainHall` | `0x94e68093fcf7f7010ca69ce3e4fca1eb444a9c73` |

## Deal 模板实现地址

这些主要给部署/排查使用，前端一般不直接调用：

| 名称 | 地址 |
| --- | --- |
| `dealImplementation` | `0x1af470654ba3c066eeeac438a3aed1eb70741fd9` |
| `dealNoAssetImplementation` | `0x619ae6c8b4b61f9d20c17ce89847fec1a12bed69` |
| `dealAAssetNftImplementation` | `0xdfac97fc62e5da6e4ad85583c1d8a7b6d5476d6b` |
| `dealBAssetNftImplementation` | `0x9c572863fb6d6fdd27ae369e861024eafd7f74a3` |
| `dealAAssetNftOnlyImplementation` | `0x897ff8d33295eaedb0b5dfb3c5fea2cf1277ef38` |
| `dealBAssetNftOnlyImplementation` | `0x60ed13ced49b623da62d6009758896f2b29bfae2` |
| `dealOpenTokenTokenImplementation` | `0x91da4dff98897558fa907f0a5cc8d37fa79d02eb` |
| `dealImplementationRegistry` | `0x8c5a021fc6def078b5dc7c71651d9d02a7605c26` |
| `dealActivityIndex` | `0x8083e05c228bc085fa9d6c58b409ba5b2bfe7a77` |

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
DealCreditGraph = 0x96a8547929ae75afc344522575f0dd59c222650d
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

`deal description` 是创建时上链描述字段，请使用本次更新后的 ABI 和新部署地址；不填时传空字符串。

## 部署后自检

已完成链上自检：

```text
34 个部署地址均有 code
Factory globals OK
ImplementationRegistry OK
CreditGraph recorder OK
InfoNFT factory OK
OrderBook router OK
带 description 的 createDeal 静态调用 OK
```

部署钱包当前测试币余额：

```text
DL: 8,000,000
AUSD: 9,000,000
USDT: 9,000,000
WNATIVE: 10,000,000
```

前端测试钱包：

```text
0x5CcB69B2Ba6dcC61C4be40a0B06D79Ddcb445aC5
```

已补发新版测试币：

```text
DL: 500,000
AUSD: 500,000
USDT: 500,000
WNATIVE: 500,000
```

mint 交易：

```text
DL: 0xd33fc0291bd9b1807f8bd450779df47dc0f66d9c1ae730df21f04bdf35f0f916
AUSD: 0xc24a137dc48d772bbc0dde957af757484ba86ef5415d5b3f4e35e106922016a0
USDT: 0x682cb2438b3c50dcbff3f70f1256f73c5060f77a1a0ea367bc1757ea33a6f9b7
WNATIVE: 0xbf4571357e303d9e6b3a357a63234ddebb7a0fd34f69458ea3734560c14dad20
```

## 重要提醒
