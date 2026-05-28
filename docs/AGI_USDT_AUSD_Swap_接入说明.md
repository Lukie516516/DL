# AGI / USDT / AUSD 三资产 Swap 接入说明

## 1. 目标

当前 AISO / Agiking 链上，官方 swap 资产按三条 DC pair 处理：

| 资产 | Pair | 说明 |
| --- | --- | --- |
| AGI | `DC-AGI` | AGI 是链原生币，合约里用 `WAGI` 包装合约表示 |
| USDT | `DC-USDT` | 官方 USDT |
| AUSD | `DC-AUSD` | 官方 AUSD |

所有跨币种兑换仍然走 `DealCoin（DC）` 作为中间资产：

```text
AGI <-> DC <-> USDT
AGI <-> DC <-> AUSD
USDT <-> DC <-> AUSD
```

## 2. 本次新增内容

| 模块 | 作用 |
| --- | --- |
| `WrappedAGI` | 原生 AGI 的 WETH-style 包装合约，支持 `deposit()` / `withdraw()` |
| `DC-AGI Pair` | 新增 `DC <-> AGI` 交易对 |
| `DealRouter` | 重新部署，`WNATIVE` 指向 `WrappedAGI` |
| `DealSwapAssetRegistry` | 独立查询合约，前端一次从 `DealPairManager` 读取三个官方 pair |

没有把 AGI 逻辑继续塞进 `DealFactory` 或 Deal 模板里。Pair 创建、初始化、虚拟流动性等运维入口直接走 `DealPairManager`，避免主合约体积继续变紧。

## 3. 前端怎么读

优先调用：

```solidity
DealSwapAssetRegistry.getSwapPairSet()
```

返回：

```text
dl
agi
usdt
ausd
pairDlAgi
pairDlUsdt
pairDlAusd
router
```

前端拿这个结果后，不需要硬编码三个 pair。

## 4. 前端怎么换

### 4.1 DC <-> AGI

AGI 是原生币时：

| 方向 | 方法 |
| --- | --- |
| AGI -> DC | `DealRouter.swapExactETHFor0(pairDlAgi, minOut0Net, deadline)` |
| DC -> AGI | `DealRouter.swapExact0ForETH(pairDlAgi, amount0In, minOutETH, deadline)` |

如果用户手里已经是 `WAGI` ERC20，也可以按普通 ERC20 路径使用 `pairDlAgi`。

### 4.2 DC <-> USDT / AUSD

继续走普通 ERC20 方法：

| 方向 | 方法 |
| --- | --- |
| DC -> OTHER | `swapExact0For1(pair, amount0In, minOut1, deadline)` |
| OTHER -> DC | `swapExact1For0(pair, amount1In, minOut0Net, deadline)` |

### 4.3 AGI <-> USDT / AUSD

走双跳：

| 方向 | 方法 |
| --- | --- |
| AGI -> USDT/AUSD | `swapExactETHFor1ViaDL(pairDlAgi, pairB, minOutB, deadline)` |
| USDT/AUSD -> AGI | `swapExact1ForETHViaDL(pairA, pairDlAgi, amountAIn, minOutETH, deadline)` |

其中：

```text
pairA = DC-USDT 或 DC-AUSD
pairB = DC-USDT 或 DC-AUSD
pairDlAgi = DC-AGI
```

## 5. 部署脚本

脚本：

```bash
npm run deploy:agiking:agi-swap
```

可选环境变量：

| 变量 | 说明 |
| --- | --- |
| `PAIR_INIT_DL` | 初始化 `DC-AGI` pair 时注入的 DC 数量，18 位精度。变量名保留 `DL` 只是历史脚本命名。 |
| `PAIR_INIT_AGI` | 初始化 `DC-AGI` pair 时注入的 AGI 数量，18 位精度 |
| `AGI_TOKEN_ADDRESS` | 如果已有包装 AGI 合约，可传入；不传则部署新的 `WrappedAGI` |
| `REDEPLOY_ROUTER` | 默认 `true`；重新部署 Router 让原生币入口指向 AGI |
| `SET_FACTORY_WRAPPED_NATIVE` | 默认 `true`；通过 `Factory.setCoreGlobals(...)` 让 `wrappedNative` 指向 AGI |

部署完成后，脚本会更新：

```text
deployments/agiking-31415926.json
deployments/frontend-handoff-agiking-31415926-*.md
```

## 6. 注意点

| 项目 | 说明 |
| --- | --- |
| AGI 原生币 | 前端展示为 AGI，合约内部 pair 资产是 `WAGI` |
| `address(0)` | Router 原生币路径使用；pair 查询统一通过 `DealSwapAssetRegistry` 或 `DealPairManager.pairForToken(agi)` |
| 老 Router | 新部署后前端必须换新 `DealRouter` 地址 |
| 老 WNATIVE | 当前旧部署里的 `WNATIVE` 是测试 ERC20，不是真正的原生币包装合约；新 AGI 入口以 `WrappedAGI` 为准 |
| 信用分 U 价值 | 交易信用仍以 U 价值资产为主；AGI 如果要按 U 计信用，需要后续增加 AGI/USD 定价口径 |
