# DCDomainListReader 当前持有人查询部署交接

部署时间：2026-05-27T08:50:11.221Z

部署钱包：`0x6807Ed8c44AE2a89DDB7706fA22A5b274EcD8785`

链：Agiking `31415926`

## 本次新部署地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DCDomainListReader | `0x3aA2D217c81d19fD447fbb478Aa026034Dfb14Ab` | 域名列表分页、默认成交额排序、域名搜索、当前持有人“我的域名” |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DCDomain | `0x4c2Ba367Ad95363E7551188B17c94DC3c986c644` |
| DCDomainRank | `0xc3Eff481D58b449278d2b31e3152fE99301F12a6` |
| DCDomainSwap | `0x2A997Ac097D818436798Da79e42473a5Dc423C2d` |
| DCDomainHall | `0x8b3FFc32FA1f9cEa21dFC400bCE7E4d5D5e09B97` |

## 前端接线

1. “我的域名”改调用 `DCDomainListReader.getDomainsByOwner(owner, offset, limit)`。
2. `owner` 传当前钱包地址，返回该地址当前持有的域名 NFT。
3. `getDomainsByCreator(creator, offset, limit)` 继续保留，但它是首次注册创建者历史口径，不适合“我的域名”。
4. 默认域名列表仍调用 `getDomainsByVolume(offset, limit)`。
5. 名称/ID/解析地址搜索仍调用 `getDomainByName`、`getDomainById`、`getDomainsByResolve`。
6. 单次 `limit` 范围仍是 `1..50`。

## ABI

完整地址和 ABI 已写入：

```text
deployments/agiking-31415926.json
```

## 重部署范围

只重部署 `DCDomainListReader`。

`DCDomain`、`DCDomainRank`、`DCDomainSwap`、`DCDomainHall`、`DealFactory` 均未重部署，链上域名和排行榜状态不迁移、不丢失。
