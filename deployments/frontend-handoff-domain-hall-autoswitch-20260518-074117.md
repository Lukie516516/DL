# 域名大厅自动身份切换部署交接

部署时间：2026-05-18T07:41:17.098Z

部署钱包：`0xE88c63D29ECE76E3336B0Db747E10876c3bf9893`

链：Agiking `31415926`

## 本次新部署地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DCDomainRank | `0x5A7ff0bdb55df5094c28944f0843e20860783323` | 域名身份、访客/商家状态、排行榜；新增 `leaveVisitorFor` |
| DCDomainSwap | `0xbD4d73075F82B94E1F24090BB393536BdF0C1252` | 域名下创建币币 deal，支持身份 NFT 参数 |
| DCDomainHall | `0x264b548d3cc9266db4FE5D663431db89b29d2bc4` | 域名大厅单；创建/确认时自动 visitor -> merchant |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DCDomain | `0xea6d563afe03142e8b9a0996b7f03c35b8ed45a3` |
| DCDomainMarket | `0x10f393c7e7544c29eb6a768de4b1bb5e8a507fdd` |
| DealFactory | `0xafe8feb98ff13d9637e64fdfd1297e1a9f68e8b5` |
| DealReader | `0x578478b5c294aaa51b09dca3dbdb79f2ea3c8e76` |
| DealMessageHub | `0xff6b941ab43a7795b693282a98086c7b0c7fdaae` |
| DealInfoNFT | `0xdba1efb9d7ce36e8ba3f51a857e5364bd98502f3` |
| DL Token | `0xf9606500fbbea6d220bb65fc5cea9641c6e436d3` |

## 前端接线

1. 域名身份/排行榜查询切到新的 `DCDomainRank`。
2. 域名普通币币入口切到新的 `DCDomainSwap`。
3. 域名大厅入口切到新的 `DCDomainHall`。
4. ABI 使用 `deployments/agiking-31415926.json` 里的 `DCDomainRank`、`DCDomainSwap`、`DCDomainHall`。
5. 大厅创建/选人/确认时，用户如果当前是 visitor，合约会自动退出 visitor 并按 merchant 继续执行；前端不需要再要求用户手动 leaveVisitor。

## 链上接线

- `DealFactory.setAllowedCreateFor(DCDomainSwap, true)` 已完成。
- `DealFactory.setAllowedCreateFor(DCDomainHall, true)` 已完成。
- `DCDomainRank.setDealReporter(DCDomainSwap, true)` 已完成。
- `DCDomainRank.setDealReporter(DCDomainHall, true)` 已完成。
- `DCDomainSwap.replaceTimeoutSeconds()` 校验为 `120` 秒。

## 注意

这次重部署了 `DCDomainRank`，所以新的域名访客状态、排行榜、广告充值状态从新 Rank 开始记录。域名 NFT、域名 Market、DealFactory、DealReader、MessageHub、InfoNFT 没有重部署。
