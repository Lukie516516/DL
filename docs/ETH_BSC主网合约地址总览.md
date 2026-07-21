# ETH / BSC 主网合约地址总览

更新时间：2026-07-10

数据来源：

- `deployments/eth-mainnet-1.json`
- `deployments/bsc-mainnet-56.json`
- `deployments/mainnet-cross-chain.json`

完整 ABI 在对应 `deployments/*.json` 文件的 `abi` 字段里。前端接线优先使用这些 JSON，本文档用于项目组快速核对地址。

## 一、核心入口

| 模块 | ETH Mainnet | BSC Mainnet |
| --- | --- | --- |
| Chain ID | `1` | `56` |
| DealFactory | `0x02330431f96b21776274f3147bd4c233caf7d752` | `0x1ca748feb347d0d177e844e7d4cdca908957c256` |
| DealReader | `0xf9b15bc4347700aa5e5bf7ba85416e71c092ccf1` | `0x37fadb350fd4c00f6608e3c4fa2c172fab1ee11d` |
| DealRouter | `0xe1939e2818049a58c819d63fa536cfa97bb78e32` | `0x9418ef8f45971d58968cc537f6aa19dbe881c842` |
| DealRouterQuoter | `0xd2a702bf9732f4fb2dd84f36fc03251816bea07c` | `0x6cffc8617f8f157a9e184f6357f3e813fda3aa8a` |
| DealMessageHub | `0x9ddc85eb93a571b1c0f4ba7611db02b159480a49` | `0xdcf150b3a9a3e1f93c057dfbf1943f8f906840a1` |
| DealResultIndex | `0x5cd69b939eb7a9498a22b7d9df66c0cbf8e29cb6` | `0x4b6ca91e47fcfb5c449962865e57a0625515590c` |
| DealActivityIndex | `0x10fd064bb8cb9ec9372ff9e9e308c77f18e210a8` | `0x00a23724a1964cdd766ca261acfd4f92b91d07fb` |
| DealInfoNFT | `0xff5efe3b23762170a99f8f4c66abea11613b982d` | `0xe698e7ee81209703122cd996096248f5c8db643d` |
| DealCoin / DC | `0x591625be924b98accab7e2c8af698c858aa2608d` | `0xff5efe3b23762170a99f8f4c66abea11613b982d` |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` | `0xa7f98a2c6a7861ab73440f869dc6e7914c1d7c0b` |

## 二、ETH Mainnet 全量地址

### 2.1 资产与基础地址

| 名称 | 地址 |
| --- | --- |
| DealCoin / DC | `0x591625be924b98accab7e2c8af698c858aa2608d` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` |

### 2.2 Deal 核心

| 名称 | 地址 |
| --- | --- |
| DealFactory | `0x02330431f96b21776274f3147bd4c233caf7d752` |
| DealPairManager | `0x167104853a997a4b2431b5d05273d6813331122b` |
| DealMessageHub | `0x9ddc85eb93a571b1c0f4ba7611db02b159480a49` |
| DealCreditGraph | `0x1ca748feb347d0d177e844e7d4cdca908957c256` |
| DealActivityIndex | `0x10fd064bb8cb9ec9372ff9e9e308c77f18e210a8` |
| DealResultIndex | `0x5cd69b939eb7a9498a22b7d9df66c0cbf8e29cb6` |
| DealInfoNFT | `0xff5efe3b23762170a99f8f4c66abea11613b982d` |
| DealInfoNFTRenderer | `0xfef16c50afcf3bffb7136dbd58c4797f339dbe1d` |
| DealReader | `0xf9b15bc4347700aa5e5bf7ba85416e71c092ccf1` |
| DealImplementationRegistry | `0x9a143fe401200ed882eafc84038e5e91f0024505` |

### 2.3 Deal 模板与库

| 名称 | 地址 |
| --- | --- |
| DealLib | `0xdb1cab9f6ccaf78ee8c673517c8bef6ad62de58c` |
| DealAssetNftLib | `0x8af16ec65e2bee3897a0d6de1350e8d74a61c410` |
| Deal Implementation | `0xb6f24d3ed15351b9bfd47b7ebb9ea5beda05728f` |
| DealNoAsset Implementation | `0xa952c195cadf2d148582e90612b6a40f7b99f508` |
| DealAAssetNft Implementation | `0x7979abcf36fe76940c557de7b942a2fe69edb6b8` |
| DealBAssetNft Implementation | `0x93066f6d0c18266db369b1d38d6fe4cd6bd480c3` |
| DealAAssetNftOnly Implementation | `0xbb686a57fff9b2886622369cf30e085aedea5dcd` |
| DealBAssetNftOnly Implementation | `0xa7f98a2c6a7861ab73440f869dc6e7914c1d7c0b` |
| DealOpenTokenToken Implementation | `0xbb88a5b4acdd18fca66c2eb14cbdb791b9e8df23` |
| Pair Implementation | `0xacf74fd151de6ffe455ab862a7de9b77cfce82ed` |
| DealFactory Implementation | `0x20289f30c92e0bb36ca0b32741eccff2c95595ee` |

### 2.4 DEX / Pair

| 名称 | 地址 |
| --- | --- |
| DC/USDC Pair | `0xFA891Ff307D0D46ccA371390E836F96739b7988F` |
| DC/USDT Pair | `0x1A9fE3bbb9740e851eae919B29C63832BBe70479` |
| DC/WETH Pair | `0x88E089aE7Fa1358aF7500AeE124d388C54691A91` |
| DealSwapOrderBook | `0xfd06e0a2023b271f463e4d81f5378fd349b9f1f2` |
| DealRouter | `0xe1939e2818049a58c819d63fa536cfa97bb78e32` |
| DealRouterQuoter | `0xd2a702bf9732f4fb2dd84f36fc03251816bea07c` |
| DealSwapAssetRegistry | `0x257c1feab3d9e8d305325aa654ffa913a72510dd` |

### 2.5 域名模块

| 名称 | 地址 |
| --- | --- |
| DCDomain | `0xd602fa2c7a4bbdcd841ad5e9d69b8c028d48e0b2` |
| DCDomainRank Implementation | `0x40126ed70176ae11ce33cc8ad32fb7f6690a9a72` |
| DCDomainRank | `0x8956fd25a7d1cef97d191285181231c544389530` |
| DCDomainRankReader | `0x9418ef8f45971d58968cc537f6aa19dbe881c842` |
| DCDomainListReader | `0x6cffc8617f8f157a9e184f6357f3e813fda3aa8a` |
| DCDomainMarket | `0x37fadb350fd4c00f6608e3c4fa2c172fab1ee11d` |
| DCDomainSwap | `0xec12468e4131f18b2446204dbb20240883a6fe2f` |
| DCDomainHall | `0x0355946ca58e24318e3cd69d4c634a1a1245a698` |

### 2.6 DAO / 分红 / 跨链

| 名称 | 地址 |
| --- | --- |
| D Token | `0x61921ecb954ffaaf8cd3fd2e71eecb14b3ed529f` |
| DealNftGovernanceActivity | `0x0b57997bf372e41ca1b027cb57da5b581f1b5678` |
| NftVetoRegistry | `0xd8de3603d341584e0aef843ee8f4c00288179177` |
| DealSeatVetoGovernor | `0xa3e818a45281038f5ae8bf213bfdbe1abbb99b7a` |
| VoteDividendClaimer | `0xc42afc0a57e90c41ec3dd29a6b6794a81737f9f3` |
| DealGovernance | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| DealGovernance Implementation | `0xECB7A086Aa87B9e2BcBbc6573fA9D0FEF7b7D1D6` |
| CrossChainBroadcaster | `0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf` |

## 三、BSC Mainnet 全量地址

### 3.1 资产与基础地址

| 名称 | 地址 |
| --- | --- |
| DealCoin / DC | `0xff5efe3b23762170a99f8f4c66abea11613b982d` |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| USDT | `0x55d398326f99059fF775485246999027B3197955` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| ProtocolTreasury | `0xa7f98a2c6a7861ab73440f869dc6e7914c1d7c0b` |

### 3.2 Deal 核心

| 名称 | 地址 |
| --- | --- |
| DealFactory | `0x1ca748feb347d0d177e844e7d4cdca908957c256` |
| DealPairManager | `0x428353575d19d250393385934caa3a38de69bc5c` |
| DealMessageHub | `0xdcf150b3a9a3e1f93c057dfbf1943f8f906840a1` |
| DealCreditGraph | `0xf6c44acbf320bd5471af6bff86bc2860f437b25d` |
| DealActivityIndex | `0x00a23724a1964cdd766ca261acfd4f92b91d07fb` |
| DealResultIndex | `0x4b6ca91e47fcfb5c449962865e57a0625515590c` |
| DealInfoNFT | `0xe698e7ee81209703122cd996096248f5c8db643d` |
| DealInfoNFTRenderer | `0x0f7342ce4c60941fdd8ab2f4059ee1a75910a9e2` |
| DealReader | `0x37fadb350fd4c00f6608e3c4fa2c172fab1ee11d` |
| DealImplementationRegistry | `0x7338f2b51852dc93979cd2c02dba5163eab18ca2` |

### 3.3 Deal 模板与库

| 名称 | 地址 |
| --- | --- |
| DealLib | `0xbb88a5b4acdd18fca66c2eb14cbdb791b9e8df23` |
| DealAssetNftLib | `0xacf74fd151de6ffe455ab862a7de9b77cfce82ed` |
| Deal Implementation | `0x591625be924b98accab7e2c8af698c858aa2608d` |
| DealNoAsset Implementation | `0x20289f30c92e0bb36ca0b32741eccff2c95595ee` |
| DealAAssetNft Implementation | `0x02330431f96b21776274f3147bd4c233caf7d752` |
| DealBAssetNft Implementation | `0x167104853a997a4b2431b5d05273d6813331122b` |
| DealAAssetNftOnly Implementation | `0x9ddc85eb93a571b1c0f4ba7611db02b159480a49` |
| DealBAssetNftOnly Implementation | `0x10fd064bb8cb9ec9372ff9e9e308c77f18e210a8` |
| DealOpenTokenToken Implementation | `0x5cd69b939eb7a9498a22b7d9df66c0cbf8e29cb6` |
| Pair Implementation | `0x9a143fe401200ed882eafc84038e5e91f0024505` |
| DealFactory Implementation | `0xfef16c50afcf3bffb7136dbd58c4797f339dbe1d` |

### 3.4 DEX / Pair

| 名称 | 地址 |
| --- | --- |
| DC/USDC Pair | `0xf5b388F37F08A27B2ba880119db353F64F1A52eC` |
| DC/USDT Pair | `0x28390eEa26C8040C36b81c7eC599019a16DA30F2` |
| DC/WBNB Pair | `0xd33adf46C967A171aA9B3199545EF2C5BA5C2091` |
| DealSwapOrderBook | `0x40126ed70176ae11ce33cc8ad32fb7f6690a9a72` |
| DealRouter | `0x9418ef8f45971d58968cc537f6aa19dbe881c842` |
| DealRouterQuoter | `0x6cffc8617f8f157a9e184f6357f3e813fda3aa8a` |
| DealSwapAssetRegistry | `0xc17e3952312a09a3cb13591dc79337cd5e839510` |

### 3.5 域名模块

| 名称 | 地址 |
| --- | --- |
| DCDomain | `0x08adc5f32337def9b0162f9f602de40822acb448` |
| DCDomainRank Implementation | `0xec12468e4131f18b2446204dbb20240883a6fe2f` |
| DCDomainRank | `0x0355946ca58e24318e3cd69d4c634a1a1245a698` |
| DCDomainRankReader | `0xff099c4552039a1c061120ad57430b1eac717a8f` |
| DCDomainListReader | `0x92d337bd8a80a6ccac58b77175c76f6ad13f6764` |
| DCDomainMarket | `0x61921ecb954ffaaf8cd3fd2e71eecb14b3ed529f` |
| DCDomainSwap | `0x27768c0c9b3f5a722eda5be9d398c6c0d2be5532` |
| DCDomainHall | `0xd8de3603d341584e0aef843ee8f4c00288179177` |

### 3.6 跨链接收

| 名称 | 地址 |
| --- | --- |
| DualBridgeExecutor | `0x46839754B2dF96E887e41E688880be6aa0A9bF98` |

说明：BSC 当前不部署 DAO 主治理合约；BSC 通过 `DualBridgeExecutor` 接收 ETH DAO 的跨链治理消息并执行被授权的目标合约调用。
