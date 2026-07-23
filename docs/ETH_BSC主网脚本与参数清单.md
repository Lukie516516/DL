# ETH / BSC 主网脚本与参数清单

本文用于正式部署前整理脚本、环境变量和初始化参数。

## 1. 脚本总览

| 脚本 | 用途 | 是否发交易 | 备注 |
| --- | --- | --- | --- |
| `scripts/deploy-mainnet-protocol.ts` | 部署单条链上的 Deal 协议层、DAO 基础合约、域名模块、Reader、Router、PairManager 等 | 是 | ETH 和 BSC 分别跑一次。 |
| `scripts/deploy-mainnet-bridge.ts env` | 检查跨链部署参数 | 否 | 只打印参数，不发交易。 |
| `scripts/deploy-mainnet-bridge.ts deploy` | ETH 部署 `CrossChainBroadcaster`，BSC 部署 `DualBridgeExecutor` | 是 | 需要 ETH 和 BSC 两边 gas。 |
| `scripts/deploy-mainnet-bridge.ts wire` | 配置 LZ peer、WH source、AX source、BSC 目标白名单、BSC 链配置 | 是 | 默认把 BSC 注册为 inactive。 |
| `scripts/deploy-mainnet-bridge.ts activate-bsc` | 打开 ETH Broadcaster 到 BSC 的 active 开关 | 是 | 灰度确认后再执行。 |
| `scripts/deploy-mainnet-bridge.ts status` | 读取跨链 state 和链上基础状态 | 读链 | 不改链上状态。 |
| `scripts/init-bsc-mainnet-liquidity.ts` | 初始化 BSC 三组官方 pair | 是 | 已按“真实 DC + 1 wei 对侧资产 + 对侧虚拟储备”执行。 |
| `scripts/init-eth-mainnet-liquidity.ts` | 初始化 ETH 三组官方 pair | 是 | 已按“真实 DC + 1 个最小单位对侧资产 + 对侧虚拟储备”执行。 |

## 2. 协议层部署命令

### ETH 主网

```bash
export ETH_MAINNET_RPC_URL="..."
export ETH_MAINNET_PRIVATE_KEY="0x..."

export MAINNET_STABLE0_ADDRESS="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
export MAINNET_STABLE1_ADDRESS="0xdAC17F958D2ee523a2206206994597C13D831ec7"
export MAINNET_WRAPPED_NATIVE_ADDRESS="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"

npm run deploy:mainnet:protocol:eth
```

### BSC 主网

```bash
export BSC_MAINNET_RPC_URL="..."
export BSC_MAINNET_PRIVATE_KEY="0x..."

export MAINNET_STABLE0_ADDRESS="0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
export MAINNET_STABLE1_ADDRESS="0x55d398326f99059fF775485246999027B3197955"
export MAINNET_WRAPPED_NATIVE_ADDRESS="0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"

npm run deploy:mainnet:protocol:bsc
```

注意：

```text
主网默认不部署模拟 USDT / USDC。
如果没有传 MAINNET_STABLE0_ADDRESS / MAINNET_STABLE1_ADDRESS，脚本会直接停止。
只有明确设置 MAINNET_DEPLOY_MOCK_STABLES=1，才会部署测试币；正式主网不要这样做。
```

## 3. 协议层初始化参数

| 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 是否部署协议国库 | `MAINNET_USE_PROTOCOL_TREASURY` | `true` | 默认部署 `ProtocolTreasury` 合约作为协议收款地址。 |
| 外部 treasury | `MAINNET_TREASURY_ADDRESS` | 空 | 如果已准备多签/金库合约，可填该地址并跳过新 Treasury 部署。 |
| Treasury controller | `MAINNET_TREASURY_CONTROLLER_ADDRESS` | 部署钱包 | 能动用 `ProtocolTreasury` 资金的控制地址；正式应迁到 DAO / timelock / executor。 |
| 锁定 Treasury bootstrap | `MAINNET_LOCK_TREASURY_BOOTSTRAP` | `false` | 设为 `true` 后部署钱包不能再用 bootstrap 改 controller。 |
| 分红执行者 | `MAINNET_DIVIDEND_EXECUTOR` | `ProtocolTreasury` / 部署钱包 | 默认先用部署钱包接线，接线后交给 Treasury；手填时以手填为准。 |
| 分红资金来源 | `MAINNET_DIVIDEND_SOURCE` | treasury | `VoteDividendClaimer` 从该地址拉 DC；默认就是协议国库。 |
| admin | `MAINNET_ADMIN_ADDRESS` | 部署钱包 | 后台管理参数地址。 |
| 身份 NFT 铸造价 | `MAINNET_INFO_NFT_MINT_PRICE_DC` | `100000e18` | 默认 `100,000 DC`。 |
| 留言收费 | `MAINNET_MESSAGE_PRICE_DC` | `100e18` | 默认 `100 DC / 条`。 |
| 留言收费开关 | `MAINNET_MESSAGE_FEE_ENABLED` | `true` | 默认开启。 |
| deal 最小确认超时 | `MAINNET_MIN_TIMEOUT_SECONDS` | `3600` | Factory 初始化参数。 |
| deal 手续费 | `MAINNET_DEAL_FEE_NUM` | `3` | 分母固定按脚本传 `1000`，即默认 0.3%。 |
| deal 返利比例 | `MAINNET_DEAL_REWARD_NUM` | `1` | 分母固定按脚本传 `1000`，即默认 0.1%。 |
| pair swap 手续费分子 | `MAINNET_PAIR_FEE_NUM` | `3` | 默认 0.3%。 |
| pair swap 手续费分母 | `MAINNET_PAIR_FEE_DEN` | `1000` | 默认 1000。 |
| 是否创建 pair | `MAINNET_CREATE_PAIRS` | `true` | 创建 DC / stable0、DC / stable1、DC / wrappedNative。 |
| 是否初始化 pair | `MAINNET_INIT_PAIRS` | `false` | 默认不注入流动性。正式初始化需单独确认数量。 |
| 给部署者预铸 DC | `MAINNET_MINT_DC_TO_DEPLOYER` | `0` | 如果需要初始化真实 DC 流动性才设置。 |

## 4. Pair 初始化参数

只有 `MAINNET_INIT_PAIRS=true` 时才需要下面参数。

| 交易对 | DC 真实注入 | 对侧真实注入 | 对侧虚拟储备 |
| --- | --- | --- | --- |
| stable0 | `MAINNET_STABLE0_PAIR_REAL_DC` | `MAINNET_STABLE0_PAIR_REAL_OTHER` | `MAINNET_STABLE0_PAIR_VIRTUAL_OTHER` |
| stable1 | `MAINNET_STABLE1_PAIR_REAL_DC` | `MAINNET_STABLE1_PAIR_REAL_OTHER` | `MAINNET_STABLE1_PAIR_VIRTUAL_OTHER` |
| wrappedNative | `MAINNET_NATIVE_PAIR_REAL_DC` | `MAINNET_NATIVE_PAIR_REAL_OTHER` | `MAINNET_NATIVE_PAIR_VIRTUAL_OTHER` |

建议：

```text
正式首次部署可以先 MAINNET_INIT_PAIRS=false。
协议地址确认无误后，再由 PairManager 做初始化和虚拟流动性设置。
Pair 初始价格和虚拟储备会影响第一批用户报价，不建议混在整套部署脚本里盲跑。
```

### BSC 已执行初始化

当前 BSC 三组 pair 已通过 `scripts/init-bsc-mainnet-liquidity.ts` 单独初始化完成。

| Pair | 真实 DC | 真实对侧资产 | 对侧虚拟储备 | 有效储备 |
| --- | --- | --- | --- | --- |
| DC/USDC | `5,000,000 DC` | `1 wei USDC` | `499.999999999999999999 USDC` | `5,000,000 DC : 500 USDC` |
| DC/USDT | `500,000,000 DC` | `1 wei USDT` | `49,999.999999999999999999 USDT` | `500,000,000 DC : 50,000 USDT` |
| DC/WBNB | `500,000,000 DC` | `1 wei WBNB` | `89.999999999999999999 WBNB` | `500,000,000 DC : 90 WBNB` |

### ETH 已执行初始化

当前 ETH 三组 pair 已通过 `scripts/init-eth-mainnet-liquidity.ts` 单独初始化完成。

| Pair | 真实 DC | 真实对侧资产 | 对侧虚拟储备 | 有效储备 |
| --- | --- | --- | --- | --- |
| DC/USDC | `5,000,000 DC` | `0.000001 USDC` | `499.999999 USDC` | `5,000,000 DC : 500 USDC` |
| DC/USDT | `500,000,000 DC` | `0.000001 USDT` | `49,999.999999 USDT` | `500,000,000 DC : 50,000 USDT` |
| DC/WETH | `500,000,000 DC` | `1 wei WETH` | `31.999999999999999999 WETH` | `500,000,000 DC : 32 WETH` |

## 5. 跨链层环境变量

跨链层脚本不会内置官方桥地址，必须部署前人工填入并核对。

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| ETH RPC | `ETH_MAINNET_RPC_URL` | ETH 主网 RPC。 |
| BSC RPC | `BSC_MAINNET_RPC_URL` | BSC 主网 RPC。 |
| ETH 私钥 | `ETH_MAINNET_PRIVATE_KEY` | 部署 ETH Broadcaster 的钱包。 |
| BSC 私钥 | `BSC_MAINNET_PRIVATE_KEY` | 部署 BSC Executor 的钱包。 |
| ETH LZ endpoint | `ETH_LZ_ENDPOINT` | LayerZero V2 ETH endpoint。 |
| BSC LZ endpoint | `BSC_LZ_ENDPOINT` | LayerZero V2 BSC endpoint。 |
| ETH LZ EID | `ETH_LZ_EID` | 默认 `30101`。部署前仍需核对官方值。 |
| BSC LZ EID | `BSC_LZ_EID` | 默认 `30102`。部署前仍需核对官方值。 |
| ETH Wormhole Relayer | `ETH_WORMHOLE_RELAYER` | Wormhole ETH relayer。 |
| BSC Wormhole Relayer | `BSC_WORMHOLE_RELAYER` | Wormhole BSC relayer。 |
| ETH Wormhole chain id | `ETH_WORMHOLE_CHAIN_ID` | 默认 `2`。 |
| BSC Wormhole chain id | `BSC_WORMHOLE_CHAIN_ID` | 默认 `4`。 |
| ETH Axelar Gateway | `ETH_AXELAR_GATEWAY` | Axelar ETH gateway。 |
| ETH Axelar GasService | `ETH_AXELAR_GAS_SERVICE` | Axelar ETH gas service。 |
| BSC Axelar Gateway | `BSC_AXELAR_GATEWAY` | Axelar BSC gateway。 |
| ETH Axelar 链名 | `ETH_AXELAR_CHAIN_NAME` | 主网官方链名为 `Ethereum`，大小写敏感。 |
| BSC Axelar 链名 | `BSC_AXELAR_CHAIN_NAME` | 主网官方链名为 `binance`，大小写敏感。 |
| Axelar 预付 gas | `AXELAR_MIN_FEE_WEI` | 需要按主网测试后调整。 |
| ETH 治理入口 | `ETH_GOVERNANCE_ADDRESS` | 能调用 Broadcaster.broadcast 的治理合约或临时治理地址。 |
| BSC 执行白名单 | `BSC_ALLOWED_TARGETS` | 逗号分隔，如 BSC `DealFactory`、参数合约等。 |
| BSC Factory | `BSC_DEAL_FACTORY_ADDRESS` | 可选，用于接入 `setCrossChainGovernance`。 |
| 是否接入 BSC Factory | `SET_BSC_FACTORY_CROSSCHAIN` | `true` 时脚本调用 `DealFactory.setCrossChainGovernance(executor)`。 |

如果 `SET_BSC_FACTORY_CROSSCHAIN=true` 且填写了 `BSC_DEAL_FACTORY_ADDRESS`，脚本会自动把该 Factory 加入 BSC Executor 的 allowed target；其他需要跨链治理调用的目标合约仍然要写进 `BSC_ALLOWED_TARGETS`。

### 当前准备使用的 ETH/BSC 主网桥参数

部署前仍需按官方文档最终复核一次，尤其是 Axelar 链名大小写。

```bash
export ETH_LZ_ENDPOINT="0x1a44076050125825900e736c501f859c50fE728c"
export BSC_LZ_ENDPOINT="0x1a44076050125825900e736c501f859c50fE728c"
export ETH_LZ_EID=30101
export BSC_LZ_EID=30102

export ETH_WORMHOLE_RELAYER="0x27428DD2d3DD32A4D7f7C497eAaa23130d894911"
export BSC_WORMHOLE_RELAYER="0x27428DD2d3DD32A4D7f7C497eAaa23130d894911"
export ETH_WORMHOLE_CHAIN_ID=2
export BSC_WORMHOLE_CHAIN_ID=4

export ETH_AXELAR_GATEWAY="0x4F4495243837681061C4743b74B3eEdf548D56A5"
export ETH_AXELAR_GAS_SERVICE="0x2d5d7d31F671F86C782533cc367F14109a082712"
export BSC_AXELAR_GATEWAY="0x304acf330bbE08d1e512eefaa92F6a57871fD895"
export ETH_AXELAR_CHAIN_NAME="Ethereum"
export BSC_AXELAR_CHAIN_NAME="binance"
```

## 6. 跨链层命令顺序

先检查参数：

```bash
npm run deploy:mainnet:bridge -- env
```

部署 ETH Broadcaster 和 BSC Executor：

```bash
npm run deploy:mainnet:bridge -- deploy
```

接线但默认不激活：

```bash
npm run deploy:mainnet:bridge -- wire
```

确认无误后激活 BSC：

```bash
npm run deploy:mainnet:bridge -- activate-bsc
```

查看状态：

```bash
npm run deploy:mainnet:bridge -- status
```

## 7. 跨链脚本输出

脚本会写：

```text
deployments/mainnet-cross-chain.json
```

里面记录：

```text
ETH CrossChainBroadcaster
BSC DualBridgeExecutor
部署时间
接线时间
激活时间
关键桥参数
```

## 8. 部署后必须人工核对

| 检查项 | 预期 |
| --- | --- |
| ETH Broadcaster owner | ETH 部署钱包或后续多签 / DAO。 |
| ETH Broadcaster governance | `ETH_GOVERNANCE_ADDRESS`。 |
| BSC Executor owner | BSC 部署钱包或后续多签 / DAO。 |
| BSC Executor threshold | `2`。 |
| BSC Executor allowed target | 只包含允许跨链治理执行的目标合约。 |
| BSC Factory crossChainGovernance | 如已接入，应等于 BSC `DualBridgeExecutor`。 |
| BSC chain active | 灰度前 false，灰度通过后 true。 |

## 9. 关键风险

| 风险 | 处理 |
| --- | --- |
| 填错桥地址 | 跨链消息失败或进入错误通道。部署前必须按官方文档逐项核对。 |
| allowed target 过宽 | 跨链 executor 能调用过多合约，扩大治理风险。只放必要合约。 |
| active 过早打开 | 可能在目标白名单未完成时广播失败。先 wire，后 activate。 |
| Pair 初始化混在部署里 | 初始价格误设会直接影响市场。默认 `MAINNET_INIT_PAIRS=false`。 |
| 使用 mock stable | 主网不允许，除非明确是测试部署。 |
| Treasury bootstrap 未锁 | 部署钱包仍可改 Treasury controller。正式公开前应迁移 controller 到 DAO/timelock/executor 并锁定 bootstrap。 |
