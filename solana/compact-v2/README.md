# Deal Solana Compact V2

这是独立于现有 24 个生产候选程序的紧凑架构实现。它把 24 个旧模块组合为 10 个根程序，同时保留旧 Anchor calldata、状态字段、PDA seed、权限、暂停位、receipt 和两阶段终局语义。

当前状态是“本地实现、内部审计和隔离 loopback Localnet 全链路通过”，不是 Devnet/Mainnet 发布批准：

- 原 `solana/programs`、原 `Anchor.toml` 和 24 个生产 Program ID 不被覆盖；
- `tools/generate-composed-programs.mjs` 从原源码和 IDL 确定性生成 `generated/`；
- 10 个 `testProgramId` 只用于本地 SBF/LiteSVM；本轮另行生成的 Localnet ID/私钥只保存在忽略提交的 `.local/compact-v2/`；
- 已在 `127.0.0.1` 全新 validator 完成 10 根部署、生产拓扑、真实资产业务烟测和 DAO 升级/回滚；
- 未部署 Devnet/Mainnet，未创建或发送任何外部网络 Solana/ETH 治理交易；
- 外部独立审计仍未完成。

## 实测结果

| 指标 | 原 24 程序 | Compact 10 程序 | 变化 |
|---|---:|---:|---:|
| 优化 SBF 总字节 | 7,870,608 | 6,174,656 | -1,695,952（-21.55%） |
| 永久程序租金 | 54.83572416 SOL | 42.99906096 SOL | -11.83666320 SOL |
| 建议部署钱包余额 | 60.47099480 SOL | 51.48319880 SOL | -8.98779600 SOL |
| 最大单程序 | 522,144 B | 931,464 B | 可复用部署 Buffer 变大 |

建议余额按“永久租金 + 最大单程序可复用 Buffer + 2 SOL 重试余量”计算；Buffer 关闭后可回收，不是永久费用。

生成器验证结果：

- 24 个模块恰好映射一次；
- 32 个 Rust 业务源文件经归一化后完全一致；
- 249 条旧 ABI 全部支持原 calldata，`prefixedOnly = 0`；
- 66 条冲突路由使用账户数和规范 PDA 消歧；
- 只有治理 `execute_message` 被显式允许携带动态剩余账户；
- 22 处同程序 CPI 后的 Anchor 账户 `reload()`、4 处终局守卫 Program ID 重映射，以及 2 处 Exchange 同根身份例外/测试被单独记录在 `source-equivalence.json`。

隔离 Localnet 结果：10/10 链上 dump hash 匹配、24/24 模块路由、22 个配置和 3 个官方 Pair 完成、Core/DEX/域名/排行/Hall/国库烟测通过、部署钱包直升拒绝、DAO 升级和回滚后最终 hash 恢复。精确尺寸 ProgramData 无法容纳大 80 bytes 的候选，因此正式部署前必须确定 `max_len` 扩容预留。

## 复现

```bash
cd solana
node compact-v2/tools/generate-composed-programs.mjs
node compact-v2/tools/analyze-layout.mjs
node compact-v2/tools/verify-final-artifacts.mjs

cd compact-v2/generated
cargo fmt --all -- --check
cargo test --workspace --all-targets --locked --offline
cargo clippy --workspace --all-targets --locked --offline -- -D warnings
```

真实 SBF 构建：

```bash
for manifest in programs/*/Cargo.toml; do
  cargo build-sbf --manifest-path "$manifest" --sbf-out-dir target/deploy
done
```

完整边界、测试、风险和发布门槛见 `ARCHITECTURE.md`、`docs/Solana_Compact_V2_紧凑架构测试与内部安全审计_20260731.md` 与 `docs/Solana_Compact_V2_本地部署全链路与升级回滚审计_20260801.md`。

最终 10 个本地 `.so` 的字节数、SHA-256 和构建工具链锁定在 `final-sbf-manifest.json`；验证脚本会同时检查输入 hash、二进制 hash、249 条路由和 28 处允许的 plumbing。
