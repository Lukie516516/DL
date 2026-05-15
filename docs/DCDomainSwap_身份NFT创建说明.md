# DCDomainSwap 身份 NFT 创建说明

本文说明域名下创建币币合同时，如何带上发起方 A 的官方 `DealInfoNFT` 身份。

## 1. 背景

`DCDomainSwap` 是域名场景下的快捷创建入口。

它内部会检查：

```text
域名存在
发起人在域名内 active
```

然后通过：

```solidity
DealFactory.createDealFor(...)
```

创建 `DealOpenTokenToken`。

老入口创建时不带身份 NFT：

```solidity
createDeal(
    domainName,
    aSwapToken,
    aSwapAmount,
    bSwapToken,
    bSwapAmount,
    title,
    description,
    expectedB
)
```

这个入口仍然保留，内部等价于：

```text
aNftId = 0
```

## 2. 新入口

如果前端要让 A 用自己的官方身份 NFT 创建域名币币合同，调用：

```solidity
createDealWithInfoNft(
    string domainName,
    address aSwapToken,
    uint256 aSwapAmount,
    address bSwapToken,
    uint256 bSwapAmount,
    string title,
    string description,
    address expectedB,
    uint256 aNftId
)
```

最后一个参数：

```text
aNftId = A 自己持有的 DealInfoNFT tokenId
```

不想绑定身份 NFT 时，可以继续用旧 `createDeal`，或传 `aNftId = 0`。

## 3. 合约校验

`DCDomainSwap` 只负责把 `aNftId` 传给 `DealOpenTokenToken`。

真正校验发生在 `DealOpenTokenToken`：

```text
如果 aNftId != 0
则要求 DealInfoNFT.ownerOf(aNftId) == 发起人 A
并锁定该 NFT
```

所以前端不需要自己完全信任输入，但应该提前用 `ownerOf(aNftId)` 做提示，避免用户发交易后失败。

## 4. 创建后的效果

创建成功后：

```text
deal.aNftId() = 传入的 aNftId
deal.aNftLocked() = true
DealInfoNFT.lockCount(aNftId) 增加
```

后续成交时，信用分会按该官方 `DealInfoNFT` 记账。

## 5. B 方身份 NFT

B 方不是在创建时传。

B 加入 OpenTokenToken 时传：

```solidity
join(optId, trackMe)
```

其中：

```text
optId = B 自己的 DealInfoNFT tokenId
```

## 6. Open / 指定钱包

`expectedB` 仍然按原逻辑：

| expectedB | joinMode |
| --- | --- |
| `address(0)` | Open，任何人可接单 |
| 非零地址 | ExactAddress，只允许该钱包加入 |

注意：

```text
当前 DCDomainSwap 只支持指定 B 钱包地址，不支持创建时指定 B 的身份 NFT。
B 的身份 NFT 由 B 加入时自己传 optId。
```

## 7. 前端推荐

创建域名币币合同时：

```text
如果用户选择了身份 NFT：调用 createDealWithInfoNft(..., aNftId)
如果用户没有选择身份 NFT：调用 createDeal(...)
```

展示身份时：

```text
读取 deal.aNftId()
如果不为 0，再读 DealInfoNFT.imageOf(aNftId)、username(aNftId)、DealCreditGraph.creditScore(aNftId)
```

## 8. 部署注意

本变更只影响：

```text
DCDomainSwap
```

需要：

```text
重新部署 DCDomainSwap
DealFactory.setAllowedCreateFor(newDCDomainSwap, true)
DCDomainRank.setDealReporter(newDCDomainSwap, true)
更新前端 DCDomainSwap 地址和 ABI
```
