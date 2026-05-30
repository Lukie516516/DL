# Deal 信用分折算与返利上限说明

本文给前端和产品说明本次 deal 信用分更新。

## 1. 本次改了什么

| 项目 | 旧逻辑 | 新逻辑 |
| --- | --- | --- |
| USDT / AUSD 交易信用 | 按手续费的 U 价值直接加信用 | 不变 |
| DC / DC 交易信用 | DC 手续费没有 U 价值，可能不加信用 | 通过官方 DC/USDT 或 DC/AUSD pair 折算成 U 价值后加信用 |
| AGI 交易信用 | AGI 手续费没有 U 价值，可能不加信用 | 先用官方 DC/AGI pair 折成 DC，再用 DC/USDT 或 DC/AUSD pair 折成 U 价值后加信用 |
| 未认可币种 | 不确定 | 不加信用 |
| 返利参数 | 可调，但缺少总量上限保护 | A + B + C 三方理论最高返利总和不得超过协议手续费 |

## 2. 信用分怎么计算

交易完成后，合约先算本次手续费价值。

```text
基础贡献分 = 本次手续费折算的 U 价值
额外奖励分 = 基础贡献分 × clamp(对方信用分 / 自己信用分, 0.01, 2)
本次信用增量 = 基础贡献分 + 额外奖励分
```

说明：

| 情况 | 折算方式 |
| --- | --- |
| 手续费是 USDT / AUSD | 直接按 token decimals 归一成 18 位 U 价值 |
| 手续费是 DC | 通过官方 DC/USDT 优先折 U；没有则用 DC/AUSD |
| 手续费是 AGI | 通过 DC/AGI 折成 DC，再通过 DC/USDT 或 DC/AUSD 折 U |
| 其他 token | 不产生信用分 |

AGI 是链原生币时，deal 内部会把 `address(0)` 归一成 `WrappedAGI`，所以 AGI 原生币和 WrappedAGI 走同一套信用折算口径。

## 3. 返利上限

当前交易奖励可能涉及三份：

```text
A 方奖励
B 方奖励
C 位奖励
```

合约现在限制：

```text
3 × mintOnFees <= feeNonDL
```

例子：

| 协议手续费 | 单份返利 | 是否允许 |
| --- | --- | --- |
| 0.3% | 0.1% | 允许，三份合计 0.3% |
| 0.3% | 0.2% | 不允许，三份合计 0.6% 超过手续费 |
| 0.6% | 0.2% | 允许，三份合计 0.6% |

这个限制只管“返利比例不能超过手续费比例”，和 U 价值、信用分无关。

## 4. 前端要看什么

前端主要换部署地址和 ABI：

```text
deployments/agiking-31415926.json
docs/前端部署地址交接文档.md
```

需要重点使用新地址：

| 模块 | 用途 |
| --- | --- |
| `DealFactory` | 创建 deal、读取全局交易参数 |
| `DealPairManager` | 官方 pair 映射、虚拟流动性配置 |
| `DealSwapAssetRegistry` | 一次读取 AGI / USDT / AUSD 三个官方 pair |
| `DCDomainSwap` / `DCDomainHall` | 域名下创建 deal |

旧 deal 不迁移。新 Factory 生效后创建的 deal 才使用本次新的信用分折算逻辑。

## 5. 运维注意

| 项目 | 注意 |
| --- | --- |
| DC 信用折算 | 依赖官方 DC/USDT 或 DC/AUSD pair 有有效储备 |
| AGI 信用折算 | 依赖官方 DC/AGI pair 和 DC/稳定币 pair 有有效储备 |
| 虚拟流动性 | 会进入有效储备，影响 swap 价格，也会影响信用折算价格 |
| 返利参数 | `setFeesAndMintOnFees` 和 `setFeesAndMintOnFeesByAdmin` 都有上限保护 |
| 未认可币种 | 不要期待产生信用分 |
