# 域名 Completed 成交额部署交接

部署时间：2026-05-28T10:31:08.165Z

部署钱包：`0xe88c63d29ece76e3336b0db747e10876c3bf9893`

链：Agiking `31415926`

## 本次目的

域名累计成交额 `tradeVolume` 改为只统计已 `Completed` 的域名 deal。

`Ready / Active / Locked / Canceled / Abandoned` 不计入域名成交额，也不参与按成交额排序的域名排名。

## 新前端接入地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | `0xEd83f77e98c3243D46559a37f0bA6Fdf6D58B2F5` |
| DealPairManager | `0x16129b0e5dC57e8a87842f95d817C3DC4a713CC4` |
| DealMessageHub | `0x37cad1d448b6cCDB3bBa84186c64a15212b04E9B` |
| DealActivityIndex | `0x1A8298AFFecd39306DCA52a25D5661D914e3DEce` |
| DealResultIndex | `0x2aCD153280AA4f18e28491255C6FC4e26a6F6951` |
| DealImplementationRegistry | `0x127611E70B2FC2Ceb4edB3421a488197D5951422` |
| DealReader | `0xa3468253D82C8Ff607eFB8fccd8d53C8552E28f7` |
| DCDomainRank | `0xe5508dd72041b41Dd773fad156E99c7398C8a993` |
| DCDomainRankReader | `0xA942ec4A1b76438511a5047E268bE3D77E65f626` |
| DCDomainListReader | `0x924e902601eD768D5E6714509035Ad42A16A355b` |
| DCDomainSwap | `0xa0aBfBCd1a4705268067ff0e894b1e7B2CB625c9` |
| DCDomainHall | `0xBAa77b8fA614c1B20C9252dd166F9abe39a39FB8` |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DCDomain | `0x4c2Ba367Ad95363E7551188B17c94DC3c986c644` |
| DCDomainMarket | `0x494309b589d5578dE60a7095Cb66cB0191758749` |
| DealInfoNFT | `0x7F83827b65AB95196e8466b8578B621Dac4Af841` |
| DealCreditGraph | `0xf721d35A5ae6DaB2576080061dF082E82f6cB697` |
| DealCoin/DC | `0x0688c9148d968bf4c2422caa8739112a04ddb5a5` |
| AUSD | `0xb91cf0c6edd1b9ec971343237fd8a119f77c7abf` |
| USDT | `0x21e6f21aa27ae519a6b7272611a1f2fd3b82dcda` |
| WrappedAGI | `0xc6ac293de4a720b689e1afbfb4658cda8c44052a` |
| DealRouter | `0x9d4c1eeb9b6d3e9dfa86af31ea817863227ab80d` |
| DealSwapOrderBook | `0xec83bfdc0b684642e409a29d6673ae03bd31ee67` |

## 接线结果

- 新 `DealFactory` 已设置 `dcDomainRank = DCDomainRank`。
- 新 `DCDomainRank` 已设置 `autoCloser = DealFactory`。
- 新 `DCDomainSwap / DCDomainHall` 已获得新 `DealFactory.createDealFor` 权限。
- 新 `DCDomainSwap / DCDomainHall` 已获得新 `DCDomainRank.reportDealWithVolume` reporter 权限。
- 新 `DCDomainListReader` 指向旧 `DCDomain` 和新 `DCDomainRank`。

## 前端注意

- 域名列表 / 搜索 / 我的域名改用新的 `DCDomainListReader`。
- 域名排行榜、广告费充值和收益读取改用新的 `DCDomainRank / DCDomainRankReader`。
- 旧的进行中域名 deal 不会迁移到新 `DCDomainRank`；新地址生效后创建的域名 deal 才按新成交额规则累计。

完整 ABI 和地址已更新：

```text
deployments/agiking-31415926.json
```
