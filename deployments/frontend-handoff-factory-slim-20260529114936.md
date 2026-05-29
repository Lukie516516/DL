# Agiking Factory 瘦身部署交接

部署时间：2026-05-29T11:49:36.974Z

部署钱包：`0xe88c63d29ece76e3336b0db747e10876c3bf9893`

## 新地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | `0x0b20917DF7040D859D04313a71517f315EFd0898` |
| DealPairManager | `0x62e33F04229e3e631B30881527E5903b5d7D7EA3` |
| DealMessageHub | `0xb1Cd85F3A4c115CfaE1B08baCD0a669F9b85E4C5` |
| DealActivityIndex | `0x9e22A6877Cd22297D3648dE53fc1B883C6077c11` |
| DealResultIndex | `0x8175b939e947F160761B012a8a49EE13e26C8c05` |
| DealImplementationRegistry | `0x89cCcd7b67AF8c0595923b7cf2a36956649dF764` |
| DealRouter | `0x0567914660B853B5C8eB330552fbcCcE30B23a55` |
| DealRouterQuoter | `0xe3DC8dB874cB8c374f4AC88B0C7177c7fC6f12F8` |
| DealSwapAssetRegistry | `0x3F1415e45D7b59CBAAe200d4d00fa6091758Fe60` |
| DCDomainSwap | `0xBcB85564c19149A054eB3485dBb7f4eBed9BA8Cc` |
| DCDomainHall | `0x1D62D0069D06B13A0802be5025d5a86FD4F4b46B` |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DealCoin/DC | `0x0688c9148d968bf4c2422caa8739112a04ddb5a5` |
| DealInfoNFT | `0x7F83827b65AB95196e8466b8578B621Dac4Af841` |
| DealCreditGraph | `0xf721d35A5ae6DaB2576080061dF082E82f6cB697` |
| DCDomain | `0x4c2Ba367Ad95363E7551188B17c94DC3c986c644` |
| DCDomainRank | `0xe5508dd72041b41Dd773fad156E99c7398C8a993` |
| DCDomainMarket | `0x494309b589d5578dE60a7095Cb66cB0191758749` |
| DCDomainListReader | `0x924e902601eD768D5E6714509035Ad42A16A355b` |

## 前端注意

- active/completed deal 列表直接读 `DealActivityIndex`，不要再读 `DealFactory.trackedCount/getTracked/isTracked/completedCount/getCompleted`。
- `DealFactory` 只保留创建、权限、模块接线、奖励/信用回调。
- 完整地址和 ABI 已写入 `deployments/agiking-31415926.json`。
