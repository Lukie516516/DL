# Agiking 信用分折算与返利上限部署交接

部署时间：2026-05-30T06:05:54.788Z

部署钱包：`0xe88c63d29ece76e3336b0db747e10876c3bf9893`

链：Agiking `31415926`

## 本次目的

- DC/DC 点对点 deal：手续费可按官方 DC/稳定币 pair 折算成 U 价值，并写入信用分。
- AGI 相关点对点 deal：手续费先按 AGI/DC pair 折成 DC，再按 DC/稳定币 pair 折成 U 价值，并写入信用分。
- 返利参数增加链上保护：A、B、C 三方理论最高返利总和不得超过协议手续费，允许相等。

## 前端必须切换的新地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | `0x794a87b4D03294936B9AFCB1916a8A7885E8998F` |
| DealPairManager | `0x2ABE89F02558d5Ba2944A6310dda35b0860aC573` |
| DealMessageHub | `0x5a93fFB25642042ffF009Bb79b41Ae6e1631B1E0` |
| DealActivityIndex | `0xa348cf4B4935322eae3443FcEa59C247AcD90611` |
| DealResultIndex | `0x4De897543F3F2C2bEB319Cb3627eF59FB471D363` |
| DealImplementationRegistry | `0x9741503D47d4b20420E102A960F0812ed0Df6162` |
| DealSwapAssetRegistry | `0x3F1415e45D7b59CBAAe200d4d00fa6091758Fe60` |
| DCDomainSwap | `0x420AC597818E4A2105462Aa219502BCDb9288C6b` |
| DCDomainHall | `0xEC7B5D6FDED1Ca31Fa8416dEA004DD2fE93dF5d5` |

## 新模板实现

| 模板 | 地址 |
| --- | --- |
| DealLib | `0xD033FD14Feb2213a5E62BBeEd3Df19FcA990BDf9` |
| DealNoAsset | `0x4cd82fC578F0cAEC9cf266753E7338D0ec13B4f0` |
| DealAAssetNft | `0x7916c39Ada4dB13f03fD954D805cC8870869b97c` |
| DealBAssetNft | `0xE5242aa6b8385E7061F549a5508D65492b19d18E` |
| DealOpenTokenToken | `0x0f6Fa2Dec458E50bdaFda2d5da95B7BDFEc40Aa3` |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DealCoin/DC | `0x0688c9148d968bf4c2422caa8739112a04ddb5a5` |
| AUSD | `0xb91cf0c6edd1b9ec971343237fd8a119f77c7abf` |
| USDT | `0x21e6f21aa27ae519a6b7272611a1f2fd3b82dcda` |
| WrappedAGI | `0xc6ac293de4a720b689e1afbfb4658cda8c44052a` |
| DealInfoNFT | `0x7F83827b65AB95196e8466b8578B621Dac4Af841` |
| DealCreditGraph | `0xf721d35A5ae6DaB2576080061dF082E82f6cB697` |
| DealReader | `0xa3468253D82C8Ff607eFB8fccd8d53C8552E28f7` |
| DealRouter | `0x0567914660B853B5C8eB330552fbcCcE30B23a55` |
| DealRouterQuoter | `0xe3DC8dB874cB8c374f4AC88B0C7177c7fC6f12F8` |
| DealSwapOrderBook | `0xec83bfdc0b684642e409a29d6673ae03bd31ee67` |
| DCDomain | `0x4c2Ba367Ad95363E7551188B17c94DC3c986c644` |
| DCDomainRank | `0xe5508dd72041b41Dd773fad156E99c7398C8a993` |
| DCDomainRankReader | `0xA942ec4A1b76438511a5047E268bE3D77E65f626` |
| DCDomainListReader | `0x924e902601eD768D5E6714509035Ad42A16A355b` |

## 官方 pair

| pair | 地址 |
| --- | --- |
| DC/AUSD | `0x29401FAf6Db21a2e0DB8EdC07069D450d5926C14` |
| DC/USDT | `0x54c6F62cfC3E0bCc0CE3ee43E35F2B150Ec0A1dD` |
| DC/AGI | `0x5cbA53558F229136949AD23299fa6F989bA76609` |

## 前端注意

- 开新 deal、域名下创建 deal、消息、交易时间线和奖励结果全部使用新的 `DealFactory` 周边地址。
- 官方 swap 资产发现继续优先读 `DealSwapAssetRegistry.getSwapPairSet()`。
- 三个官方 pair 的控制权已接到新 `DealPairManager`，后续虚拟流动性/手续费调参走新 `DealPairManager`。
- `DealReader` 没有状态，本次复用旧地址即可。
- 旧 deal 不会迁移；新 Factory 生效后创建的 deal 才会使用新的信用分折算逻辑。
- 完整 ABI 和地址已写入 `deployments/agiking-31415926.json`。
