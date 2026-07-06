# eth-mainnet 前端部署地址交接

部署时间：2026-07-03T02:51:40.121Z

链：eth-mainnet (1)

部署钱包：`0xe88c63d29ece76e3336b0db747e10876c3bf9893`

## 重要说明

- Factory 使用 UUPS proxy；前端和治理统一使用 `DealFactory` proxy 地址。
- `stable0/stable1` 是本链配置的官方认可交易币地址。
- 跨链治理合约已部署并接线。当前 BSC 目标链已登记但保持 inactive，灰度前不要调用 `activate-bsc`。

## 核心地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | `0x02330431f96b21776274f3147bd4c233caf7d752` |
| DealFactory implementation | `0x20289f30c92e0bb36ca0b32741eccff2c95595ee` |
| DealReader | `0xf9b15bc4347700aa5e5bf7ba85416e71c092ccf1` |
| DealMessageHub | `0x9ddc85eb93a571b1c0f4ba7611db02b159480a49` |
| DealResultIndex | `0x5cd69b939eb7a9498a22b7d9df66c0cbf8e29cb6` |
| DealActivityIndex | `0x10fd064bb8cb9ec9372ff9e9e308c77f18e210a8` |
| DealPairManager | `0x167104853a997a4b2431b5d05273d6813331122b` |
| DealImplementationRegistry | `0x9a143fe401200ed882eafc84038e5e91f0024505` |
| DealCoin/DC | `0x591625be924b98accab7e2c8af698c858aa2608d` |
| ProtocolTreasury / Treasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` |
| stable0 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| stable1 | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| wrappedNative | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| DealInfoNFT | `0xff5efe3b23762170a99f8f4c66abea11613b982d` |
| DealCreditGraph | `0x1ca748feb347d0d177e844e7d4cdca908957c256` |
| DCDomain | `0xd602fa2c7a4bbdcd841ad5e9d69b8c028d48e0b2` |
| DCDomainRank | `0x8956fd25a7d1cef97d191285181231c544389530` |
| DCDomainSwap | `0xec12468e4131f18b2446204dbb20240883a6fe2f` |
| DCDomainHall | `0x0355946ca58e24318e3cd69d4c634a1a1245a698` |
| D | `0x61921ecb954ffaaf8cd3fd2e71eecb14b3ed529f` |
| DealSeatVetoGovernor | `0xa3e818a45281038f5ae8bf213bfdbe1abbb99b7a` |
| VoteDividendClaimer | `0xc42afc0a57e90c41ec3dd29a6b6794a81737f9f3` |
| CrossChainBroadcaster | `0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf` |

## ETH 初始流动性

已在 ETH 初始化三组官方 pair。模式为：

```text
真实 DC + 1 个最小单位真实对侧资产 + 对侧虚拟储备
```

注意：虚拟储备用于报价和深度展示，不等于真实可兑付资产；真实对侧资产目前只有 1 个最小单位。后续如果希望用户能大量卖出 DC 换回 USDC/USDT/WETH，需要继续补真实对侧流动性。

| Pair | 地址 | 真实储备 | 虚拟储备 | 有效储备 |
| --- | --- | --- | --- | --- |
| DC/USDC | `0xFA891Ff307D0D46ccA371390E836F96739b7988F` | `5,000,000 DC + 0.000001 USDC` | `499.999999 USDC` | `5,000,000 DC : 500 USDC` |
| DC/USDT | `0x1A9fE3bbb9740e851eae919B29C63832BBe70479` | `500,000,000 DC + 0.000001 USDT` | `49,999.999999 USDT` | `500,000,000 DC : 50,000 USDT` |
| DC/WETH | `0x88E089aE7Fa1358aF7500AeE124d388C54691A91` | `500,000,000 DC + 1 wei WETH` | `31.999999999999999999 WETH` | `500,000,000 DC : 32 WETH` |

## 跨链状态

| 项目 | 当前值 |
| --- | --- |
| ETH CrossChainBroadcaster | `0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf` |
| BSC DualBridgeExecutor | `0x46839754B2dF96E887e41E688880be6aa0A9bF98` |
| BSC chain key / LZ EID | `30102` |
| BSC active | `false` |
| BSC Executor threshold | `2` |
| ETH governance | `0xE88c63D29ECE76E3336B0Db747E10876c3bf9893` |

## 初始化参数

```json
{
  "treasury": "0x19CC1320DcF7e1396404599209D7c9a844A21b8a",
  "admin": "0xe88c63d29ece76e3336b0db747e10876c3bf9893",
  "protocolTreasuryEnabled": false,
  "protocolTreasury": "",
  "protocolTreasuryController": "0x0000000000000000000000000000000000000000",
  "protocolTreasuryBootstrapLocked": false,
  "dividendExecutor": "0xe88c63d29ece76e3336b0db747e10876c3bf9893",
  "dividendSource": "0x19CC1320DcF7e1396404599209D7c9a844A21b8a",
  "stable0": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "stable1": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  "wrappedNative": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "infoNftMintPriceDc": "100000000000000000000000",
  "messagePriceDc": "100000000000000000000",
  "messageFeeEnabled": true,
  "minTimeoutSeconds": 3600,
  "dealFee": "3/1000",
  "dealReward": "1/1000",
  "pairFee": "3/1000",
  "createPairs": true,
  "initPairs": false
}
```

说明：`protocolTreasuryEnabled=false` 表示本次协议部署脚本没有重新部署 treasury；本次实际接入的是已经提前部署好的 `ProtocolTreasury` 合约，地址就是上面的 `treasury`。
