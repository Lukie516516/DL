# Deal DEX 紧凑架构实验（Pair + Quoter）

这是一个完全独立的体积实验，不属于生产程序清单，不会改变现有 Program ID、PDA、IDL、部署脚本或链上状态。

## 实验范围

- 完整保留 `deal-dex-pair` 的建池、流动性、虚拟储备、捐赠同步、四种兑换和 DC 销毁逻辑。
- 将 `deal-dex-quoter` 的七个报价入口直接放入同一个程序，并复用 Pair 的状态与数学函数。
- 实验 Program ID：`BMHErQjGPrA5dCURDqk9fDRwz4xx7ZVVpxWfXdGLy51j`（仅用于本地实验，没有保留部署私钥）。

## 真实 SBF 体积

| 方案 | 优化后体积 |
|---|---:|
| 原 Pair | 369,680 bytes |
| 原 Quoter | 142,264 bytes |
| 原方案合计 | 511,944 bytes |
| 合并程序 | 392,984 bytes |
| 减少 | 118,960 bytes（23.24%） |

按当前主网租金模型（Program 账户 36 bytes、ProgramData 元数据 45 bytes、每字节 6,960 lamports）计算：

- 两程序长期租金：3.56782128 SOL
- 单程序长期租金：2.73751416 SOL
- 长期锁定资金减少：0.83030712 SOL（23.27%）

在完整 24 程序架构中，最大程序仍是 522,144 bytes 的 `deal_asset_controller`，因此这次合并不会增加全系统所需的最大临时部署 buffer。

## 已验证

- Rust 单元测试：6/6 通过。
- LiteSVM 真实优化版 SBF：两组 Pair 建池/流动性、虚拟储备、兑换、DC 销毁、滑点失败、五个单 Pair 报价入口和两个双 Pair 路由报价入口全部通过。
- `cargo fmt --check` 通过。
- `cargo clippy --all-targets -- -D warnings` 通过。
- 原 Pair/Quoter 自身测试：9/9 通过。
- 原 Pair、Quoter 源文件、生产 `.so` 和 IDL 哈希保持不变。

## 不能从本实验推出的结论

这证明“把强关联且共享状态/数学的程序合并”能减少字节码与租金，但还不是生产迁移方案。若采用：

- Pair 与 Quoter 将共用一个新 Program ID；Pair PDA 与账户 owner 会变化。
- Router、SDK、前端、治理升级清单、部署脚本和测试必须统一改线。
- 需要重新做完整业务等价、权限、CPI、升级权限、Localnet/Devnet 与主网前审计。
- 不能把 23.24% 直接线性套到全部 24 个程序；不同模块的依赖重合程度不同。

当前 Solana 主网尚未部署，因此若要重构，成本最低的时间点是主网部署前；但在完成全量等价验证前，生产方案仍保持原 24 程序不变。
