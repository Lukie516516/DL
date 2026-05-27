# InfoNFT DC 本位 burn 与 D 18 位精度部署交接

部署时间：2026-05-27T10:07:26.399Z

部署钱包：`0xE88c63D29ECE76E3336B0Db747E10876c3bf9893`

链：Agiking `31415926`

## 本次新部署地址

| 模块 | 地址 | 说明 |
| --- | --- | --- |
| DealInfoNFT | `0x7F83827b65AB95196e8466b8578B621Dac4Af841` | 官方身份 NFT；`mintByBurn()` 直接 burn `mintPriceDL` 个 DealCoin（DC） |
| DealCreditGraph | `0xf721d35A5ae6DaB2576080061dF082E82f6cB697` | 绑定新版 DealInfoNFT 的信用图 |
| D | `0xF8fd2b61F96CE461015A8c84F5E5688460BD9B15` | 100 D 总量，18 位精度，2.5 D 席位门槛 |
| DealNftGovernanceActivity | `0x9d2860d6c8B63Bc1530D28163BCE53494a94aC28` | 绑定新版 DealInfoNFT 的治理活跃记录 |
| NftVetoRegistry | `0xF0edCbca262df9409c3a147322fbe1e59070Fa56` | 绑定新版 DealInfoNFT / 活跃记录 |
| DealSeatVetoGovernor | `0x4EDb8fff6c3D5F75B475d60a9C062C205428fee1` | 绑定新版 D |
| VoteDividendClaimer | `0x6bfC3E42ef340B540dF728828E4825042Ada4C4d` | 绑定新版 D，用 DealCoin（DC）分红 |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | `0x5ac67e8b3600a9493db46201d96aa1e4494a1066` |
| DealCoin/DC | `0x0688c9148d968bf4c2422caa8739112a04ddb5a5` |
| DealPairManager | `0x4d29f1d346966870076af986020d280ab2cc23b2` |
| DCDomain | `0x4c2Ba367Ad95363E7551188B17c94DC3c986c644` |
| DCDomainRank | `0xc3Eff481D58b449278d2b31e3152fE99301F12a6` |
| DCDomainSwap | `0x2A997Ac097D818436798Da79e42473a5Dc423C2d` |
| DCDomainHall | `0x8b3FFc32FA1f9cEa21dFC400bCE7E4d5D5e09B97` |

## 前端接线

1. 官方身份 NFT 地址切到新版 `DealInfoNFT`。
2. 身份 NFT 铸造价格读 `DealInfoNFT.mintPriceDL()`，当前是 `88e18`，表示直接 burn 88 DC。
3. `pair()` 仅为旧 ABI 兼容字段，身份 NFT 铸造不再用 pair 报价。
4. D 代币地址切到新版 `D`，`decimals() = 18`，`MAX_SUPPLY() = 100e18`，`SEAT_THRESHOLD() = 2.5e18`。
5. 信用读取切到新版 `DealCreditGraph`。
6. DAO / 分红读取切到新版 `DealSeatVetoGovernor`、`NftVetoRegistry`、`DealNftGovernanceActivity`、`VoteDividendClaimer`。

## 重部署范围

只重部署身份 NFT、信用图、D 与 D 依赖的治理/分红合约。

`DealFactory` 未重部署，但已重新接线到新版 `DealInfoNFT`、`DealCreditGraph`、`DealNftGovernanceActivity`。

域名、Swap、Pair、已有 deal 模板和 DealCoin（DC）均未重部署。

完整地址和 ABI 已写入：

```text
deployments/agiking-31415926.json
```
