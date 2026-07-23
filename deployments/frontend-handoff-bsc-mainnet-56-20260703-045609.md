# bsc-mainnet 前端部署地址交接

部署时间：2026-07-03T04:56:09.581Z

链：bsc-mainnet (56)

部署钱包：`0xe88c63d29ece76e3336b0db747e10876c3bf9893`

## 重要说明

- Factory 使用 UUPS proxy；前端和治理统一使用 `DealFactory` proxy 地址。
- `stable0/stable1` 是本链配置的官方认可交易币地址。
- 跨链治理合约已部署并接线。BSC `DealFactory.crossChainGovernance` 已指向 `DualBridgeExecutor`；ETH Broadcaster 侧 BSC 仍为 inactive，灰度前不要激活。

## 核心地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | `0x1ca748feb347d0d177e844e7d4cdca908957c256` |
| DealFactory implementation | `0xfef16c50afcf3bffb7136dbd58c4797f339dbe1d` |
| DealReader | `0x37fadb350fd4c00f6608e3c4fa2c172fab1ee11d` |
| DealMessageHub | `0xdcf150b3a9a3e1f93c057dfbf1943f8f906840a1` |
| DealResultIndex | `0x4b6ca91e47fcfb5c449962865e57a0625515590c` |
| DealActivityIndex | `0x00a23724a1964cdd766ca261acfd4f92b91d07fb` |
| DealPairManager | `0x428353575d19d250393385934caa3a38de69bc5c` |
| DealImplementationRegistry | `0x7338f2b51852dc93979cd2c02dba5163eab18ca2` |
| DealCoin/DC | `0xff5efe3b23762170a99f8f4c66abea11613b982d` |
| ProtocolTreasury / Treasury | `0xa7f98a2c6a7861ab73440f869dc6e7914c1d7c0b` |
| stable0 | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| stable1 | `0x55d398326f99059fF775485246999027B3197955` |
| wrappedNative | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| DealInfoNFT | `0xe698e7ee81209703122cd996096248f5c8db643d` |
| DealCreditGraph | `0xf6c44acbf320bd5471af6bff86bc2860f437b25d` |
| DCDomain | `0x08adc5f32337def9b0162f9f602de40822acb448` |
| DCDomainRank | `0x0355946ca58e24318e3cd69d4c634a1a1245a698` |
| DCDomainSwap | `0x27768c0c9b3f5a722eda5be9d398c6c0d2be5532` |
| DCDomainHall | `0xd8de3603d341584e0aef843ee8f4c00288179177` |
| DAO stack | `not deployed on this chain` |
| DualBridgeExecutor | `0x46839754B2dF96E887e41E688880be6aa0A9bF98` |

## BSC 初始流动性

已在 BSC 初始化三组官方 pair。模式为：

```text
真实 DC + 1 wei 真实对侧资产 + 对侧虚拟储备
```

注意：虚拟储备用于报价和深度展示，不等于真实可兑付资产；真实对侧资产目前只有 1 wei，后续如果希望用户能大量卖出 DC 换回 USDC/USDT/WBNB，需要继续补真实对侧流动性。

| Pair | 地址 | 真实储备 | 虚拟储备 | 有效储备 |
| --- | --- | --- | --- | --- |
| DC/USDC | `0xf5b388F37F08A27B2ba880119db353F64F1A52eC` | `5,000,000 DC + 1 wei USDC` | `499.999999999999999999 USDC` | `5,000,000 DC : 500 USDC` |
| DC/USDT | `0x28390eEa26C8040C36b81c7eC599019a16DA30F2` | `500,000,000 DC + 1 wei USDT` | `49,999.999999999999999999 USDT` | `500,000,000 DC : 50,000 USDT` |
| DC/WBNB | `0xd33adf46C967A171aA9B3199545EF2C5BA5C2091` | `500,000,000 DC + 1 wei WBNB` | `89.999999999999999999 WBNB` | `500,000,000 DC : 90 WBNB` |

## 跨链状态

| 项目 | 当前值 |
| --- | --- |
| ETH CrossChainBroadcaster | `0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf` |
| BSC DualBridgeExecutor | `0x46839754B2dF96E887e41E688880be6aa0A9bF98` |
| BSC `DealFactory.crossChainGovernance` | `0x46839754B2dF96E887e41E688880be6aa0A9bF98` |
| Executor threshold | `2` |
| BSC Factory 是否在 allowedTargets | `true` |
| ETH Broadcaster 里的 BSC active | `false` |

## 初始化参数

```json
{
  "treasury": "0xa7f98a2c6a7861ab73440f869dc6e7914c1d7c0b",
  "admin": "0xe88c63d29ece76e3336b0db747e10876c3bf9893",
  "protocolTreasuryEnabled": true,
  "protocolTreasury": "0xa7f98a2c6a7861ab73440f869dc6e7914c1d7c0b",
  "protocolTreasuryController": "0xe88c63d29ece76e3336b0db747e10876c3bf9893",
  "protocolTreasuryBootstrapLocked": false,
  "dividendExecutor": "0xa7f98a2c6a7861ab73440f869dc6e7914c1d7c0b",
  "dividendSource": "0xa7f98a2c6a7861ab73440f869dc6e7914c1d7c0b",
  "stable0": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  "stable1": "0x55d398326f99059fF775485246999027B3197955",
  "wrappedNative": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  "infoNftMintPriceDc": "100000000000000000000000",
  "messagePriceDc": "100000000000000000000",
  "messageFeeEnabled": true,
  "minTimeoutSeconds": 3600,
  "dealFee": "3/1000",
  "dealReward": "1/1000",
  "pairFee": "3/1000",
  "createPairs": true,
  "initPairs": false,
  "deployDao": false
}
```
