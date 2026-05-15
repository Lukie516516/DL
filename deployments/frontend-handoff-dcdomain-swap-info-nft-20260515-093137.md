# DCDomainSwap 身份 NFT 入口部署交接

部署时间：2026-05-15T09:31:37.210Z

部署钱包：`0xe88c63d29ece76e3336b0db747e10876c3bf9893`

链：Agiking `31415926`

## 本次更新地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DCDomainSwap | `0xce1a37712e686a933eafb82bdfbda511c1a46eda` | 域名下创建币币 deal；新增 `createDealWithInfoNft(..., aNftId)` |
| DealFactory | `0xafe8feb98ff13d9637e64fdfd1297e1a9f68e8b5` | 当前 DCDomainSwap 指向的工厂 |
| DCDomainRank | `0xf1bb9e705f5366febcd15a14e785fb26228fcd8c` | 已授权新 DCDomainSwap reporter |
| DCDomain | `0xea6d563afe03142e8b9a0996b7f03c35b8ed45a3` | 域名 NFT，复用旧地址 |

## 前端改动

- 不绑定身份 NFT：继续调用旧 `createDeal(...)`。
- 绑定 A 的官方身份 NFT：调用 `createDealWithInfoNft(..., aNftId)`。
- 完整 ABI 见 `deployments/agiking-31415926.json`。
- 说明文档见 `docs/DCDomainSwap_身份NFT创建说明.md`。

## 链上接线

- `DealFactory.setAllowedCreateFor(newDCDomainSwap, true)` 已完成。
- `DCDomainRank.setDealReporter(newDCDomainSwap, true)` 已完成。
- `DCDomainSwap.replaceTimeoutSeconds()` 默认仍为 `120` 秒。
