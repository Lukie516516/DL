# base-mainnet 前端部署地址交接

部署时间：2026-08-07T14:42:18.051Z

链：base-mainnet (8453)

部署钱包：`0xe88c63d29ece76e3336b0db747e10876c3bf9893`

## 重要说明

- Factory 使用 UUPS proxy；前端和治理统一使用 `DealFactory` proxy 地址。
- `stable0/stable1` 是本链配置的官方认可交易币地址。
- 跨链治理尚未由本脚本开启，需要后续部署并接线 `CrossChainBroadcaster / DualBridgeExecutor`。
- 本次只完成协议部署与三个空池创建：DC 总供应量为 `0`，没有 mint、没有注入流动性。
- Base 是副链：没有部署 D、DAO、中本聪账户或分红模块。
- ProtocolTreasury 的 bootstrap 尚未锁定；应在跨链执行器接线和权限交接完成后再锁定。

## 核心地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | `0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D` |
| DealFactory implementation | `0xAcf74FD151DE6FFE455Ab862A7de9B77cfCe82ed` |
| DealReader | `0x5Ca2FB4bADa0F768e7F25F29ea0702e7A17ec5a8` |
| DealMessageHub | `0x02330431F96B21776274F3147bd4C233Caf7D752` |
| DealResultIndex | `0x9DDC85eb93a571B1C0F4BA7611dB02B159480A49` |
| DealActivityIndex | `0x167104853A997a4B2431B5d05273d6813331122b` |
| DealPairManager | `0x20289f30C92e0bb36cA0B32741EccFF2C95595Ee` |
| DealImplementationRegistry | `0x10Fd064bb8cb9ec9372Ff9E9e308C77f18e210A8` |
| DealCoin/DC | `0xBB88a5b4aCDD18Fca66C2eb14cBdB791b9e8Df23` |
| ProtocolTreasury / Treasury | `0xb8f27EEb0c21e69CdE1F7c4C27b81f5c71c21dCb` |
| stable0 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| stable1 | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` |
| wrappedNative | `0x4200000000000000000000000000000000000006` |
| DealInfoNFT | `0x5cd69B939eB7a9498a22B7d9DF66C0Cbf8E29CB6` |
| DealCreditGraph | `0xFF5efE3B23762170a99F8F4C66abea11613b982D` |
| DCDomain | `0x257c1fEab3D9E8d305325aA654fFa913a72510dd` |
| DCDomainRank | `0xd602fa2c7a4BBdCd841AD5e9D69b8C028D48e0B2` |
| DCDomainSwap | `0x37fadb350Fd4c00f6608E3C4FA2c172fab1eE11D` |
| DCDomainHall | `0x08ADc5F32337def9B0162f9F602DE40822ACB448` |
| DAO stack | `not deployed on this chain` |

## 三个已创建但未初始化的交易池

| 交易对 | 池地址 | 当前状态 |
| --- | --- | --- |
| DC/USDC | `0xee40Bbc8cC387aCa294fb9ECa429B10AbeBf1DBA` | 未初始化，余额/真实储备/虚拟储备均为 0 |
| DC/bridged USDT | `0x00e284922E5A727b4378768b5ED5D22fbF3297e8` | 未初始化，余额/真实储备/虚拟储备均为 0 |
| DC/WETH | `0xC99577B3027181F85b650651021bb7F804F50e61` | 未初始化，余额/真实储备/虚拟储备均为 0 |

## 部署验收

- 只读验收区块：Base `49662333`
- 记录的 41 个合约/代币地址均有运行代码。
- DealFactory UUPS implementation：`0xAcf74FD151DE6FFE455Ab862A7de9B77cfCe82ed`
- DCDomainRank UUPS implementation：`0xF9b15bc4347700Aa5e5Bf7bA85416E71C092ccF1`
- DC 总供应量：`0`
- 跨链治理：`0x0000000000000000000000000000000000000000`（未启用）
- 部署及配置总成本：`0.000477277982838216 ETH`
- 部署结束后钱包余额：`0.000570973689773402 ETH`
- 验收命令：`node --import tsx/esm scripts/verify-base-mainnet-deployment.ts`

## 初始化参数

```json
{
  "treasury": "0xb8f27EEb0c21e69CdE1F7c4C27b81f5c71c21dCb",
  "admin": "0xE88c63D29ECE76E3336B0Db747E10876c3bf9893",
  "protocolTreasuryEnabled": true,
  "protocolTreasury": "0xb8f27EEb0c21e69CdE1F7c4C27b81f5c71c21dCb",
  "protocolTreasuryController": "0xE88c63D29ECE76E3336B0Db747E10876c3bf9893",
  "protocolTreasuryBootstrapLocked": false,
  "dividendExecutor": "0xb8f27EEb0c21e69CdE1F7c4C27b81f5c71c21dCb",
  "dividendSource": "0xb8f27EEb0c21e69CdE1F7c4C27b81f5c71c21dCb",
  "stable0": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "stable1": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  "wrappedNative": "0x4200000000000000000000000000000000000006",
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
