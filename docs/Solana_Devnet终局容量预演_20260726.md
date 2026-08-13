# Solana Devnet 终局容量预演（2026-07-26）

## 结论

本轮已经完成最大账户终局链路的 SDK 容量建模、真实 SBF/LiteSVM 执行、
回滚/防重放验证和 Devnet 只读预检。

结论分两层：

- 本地生产字节码验证通过：完成态经济核心和派生索引补写都低于 Solana
  当前 64 个账户锁上限，v0 transaction + 1 个 ALT 的字节数和 CU 也通过；
- Devnet 集群部署与真实交易尚未执行：测试钱包余额为 0 SOL，24 个生产
  Program 均未部署，当前建议准备至少 `65.25564568 SOL` Devnet 测试币。

本轮没有部署或调用 Solana 主网，没有提交或推送 Git。

## 为什么终局链路需要拆成两笔

最初把结算、历史、奖励/信用索引和身份解锁全部放进一笔交易时，真实运行
会锁定 74 个账户。ALT 只能压缩交易消息中的地址字节，不能减少运行时
account locks，因此该设计会在执行前触发 `TooManyAccountLocks`。

修正后的生产流程是：

```text
交易 A：经济核心（原子）
  resolution
  -> DC/DC 时 route_dc_fees
  -> terminal receipt
  -> U18 valuation receipt
  -> reward quote
  -> reward mint receipt
  -> credit receipt / CreditGraph 写入

交易 B：权限开放、可重试的终局补写（交易内原子）
  completed history
  -> 实际非零的 identity reward records
  -> reward result indexes
  -> credit result indexes
  -> A/B identity unlock
```

资金交割、DC/DC 的 C/销毁手续费、DC 奖励和信用增量仍全部位于交易 A，
任一步失败都会整笔回滚。交易 B 只处理可查询派生状态和身份解锁：

- 任意执行者都可以代付并重试；
- history receipt、identity reward receipt 和 result marker 都是规范 PDA，
  防止重复写入；
- 交易 B 任一步失败会整笔回滚，身份保持锁定，索引不会出现半写状态；
- 交易 B 成功后再次提交会失败，历史和结果计数保持 `1`；
- 因此补写失败不会造成资金损失或双花，但在重试成功前，前端索引暂未出现，
  A/B 身份也仍处于锁定状态。

官方 keeper/SDK 必须在交易 A 确认后立即提交交易 B。每次重试前应同时读取
history receipt、identity reward receipts、result markers 和 AssetTerms
中的身份 mint，只构造仍未完成的步骤；`historyPending` 和各 pending 数组
已经覆盖“第三方提前完成了部分正确补写”后的断点续跑。

## 容量结果

### 保守 SDK 上限模型

该模型使用独立付款人与参与者双签名，并覆盖 A/B 身份、C 候选、两侧信用、
三种奖励角色、两侧结果索引和两次身份解锁。

| 流程 | 账户数 | 指令数（含 2 条 compute） | 签名数 | v0 字节 | 1232 上限余量 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 最大 DC/DC 经济核心 | 59 | 9 | 2 | 715 | 517 |
| 最大非 DC 奖励核心 | 59 | 8 | 2 | 684 | 548 |
| 最大终局补写 | 58 | 13 | 1 | 665 | 567 |

三类交易均使用 1 个 ALT 并通过。对应 legacy transaction 均超过编码容量，
生产客户端必须使用 v0 transaction。

### 真实 SBF/LiteSVM 执行

DC/DC 场景实际加载 Core、AssetController、Finalizer、HistoryIndex、
Valuator、RewardEngine、DCController、CreditGraph、Identity 和 ResultIndex
十个 SBF Program，并执行真实 SPL Token CPI。

| 流程 | 账户数 | 指令数（含 2 条 compute） | v0 字节 | CU |
| --- | ---: | ---: | ---: | ---: |
| DC/DC 经济核心 | 58 | 9 | 619 | 410,706–425,706 |
| 历史、信用索引和 A/B 解锁补写 | 39 | 7 | 474 | 216,064–220,564 |

该实际用例由参与者同时支付交易费，所以比独立付款人的保守模型少 1 个账户。
CU 做了 20 次独立账户/PDA 采样；PDA bump 搜索会引起小幅波动，表中给出
实测范围而不是伪造固定值。两笔交易都显著低于 `1,400,000` CU 上限；
Devnet 应按真实模拟值再加安全余量设置生产 compute limit。

实际状态断言包括：

- Deal 为 `Completed`，两个托管 vault 归零；
- DC/DC 双方手续费合计 `30` 原始单位正确转给 C；
- valuation 和 pair credit receipt 存在，A/B credit delta 均大于 0；
- 交易 A 后 history/result marker 尚不存在，身份仍锁定；
- 交易 B 后双方 completed history 各一条、A/B credit result 各一条、身份解锁；
- 重放交易 B 失败，四个计数均未增加。

## Devnet 只读预检

预检时间：`2026-07-26T10:50:24.592Z`

| 项目 | 结果 |
| --- | --- |
| Genesis hash | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| RPC core | `4.2.0-beta.1` |
| 测试钱包 | `GGj2HyMgoM4vCJdfs5xaEaKBmQmxYBTUwDUwmmVStu6p` |
| 钱包余额 | `0 SOL` |
| 生产范围 | 24 个 Program |
| Devnet 已部署 | `0 / 24` |
| 本地 SBF 总大小 | `8,632,144 bytes` |
| 最低持久租金 | `60.13601472 SOL` |
| 最大临时 buffer 租金 | `4.11963096 SOL` |
| 交易费预留 | `1 SOL` |
| 建议准备余额 | `65.25564568 SOL` |

当前环境中 `api.devnet.solana.com` 的本地 DNS 返回了错误站点证书。预检没有
关闭 TLS 校验，而是把 Cloudflare DoH 核验出的正确 IP 固定给 TLS 连接，
并继续验证官方 hostname 和 Devnet genesis hash。生产部署应改用有 SLA 的
可信 Devnet RPC，不应依赖固定 IP。

官方 faucet 的空投请求返回 429，未获得 SOL。由于钱包余额不足，本轮没有
尝试部署，也没有发出任何成功的 Devnet 交易。

## 自动化结果

- `cargo fmt --all -- --check`：通过。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过，0 warning。
- `cargo test --workspace --all-targets`：123 项非文档测试通过，0 失败。
- `npm test`：21 项终局 SDK/容量/IDL 防漂移测试通过，0 失败。
- `npm run capacity`：三类最大 v0 交易全部通过。
- `SOLANA_DEPLOY_DRY_RUN=1 npm run deploy:devnet`：24 个生产 Program 的
  Program ID、keypair、SBF 路径和 SHA-256 全部校验通过；四个参考 Program
  未进入部署清单。
- 修改涉及的 Finalizer、RewardEngine、AssetController SBF/IDL 已重建。

关键构建指纹：

| 产物 | SHA-256 |
| --- | --- |
| `deal_asset_controller.so` | `a4f523ed80d5e361b46135eddc32d1dd45c5207d93af80f9a6a0dbe26d47f262` |
| `deal_finalizer.so` | `fbb426a4843a0aed37f9f42c43be671c6323438c5de35b0bbd10a4c150b27624` |
| `deal_reward_engine.so` | `6db51317793cc234667429f57563efa9608b3f4d400f43c88162cfd94b791b39` |
| `deal_asset_controller.json` | `8a2910ed7795185f435d8f51d46fb78f33485e6e290bc8a82760137cb7f63085` |
| `deal_finalizer.json` | `a83157b13736bf651e6d5b6645f0e3adbfb9ba3b2e01a1beb0be111f05cf8139` |
| `deal_reward_engine.json` | `22a302b972c5a64722fbc4dd457a44feb66cd2a9d1729fb192db764338775221` |

## 复现命令

```bash
cd solana
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets

cd sdk
npm test
npm run capacity
SOLANA_RPC_URL=https://可信的-devnet-rpc \
SOLANA_WALLET_PATH=../.local/test-wallet.json \
npm run preflight:devnet

SOLANA_RPC_URL=https://可信的-devnet-rpc \
SOLANA_DEPLOY_DRY_RUN=1 \
npm run deploy:devnet
```

只有在本地 DNS 异常且已经从独立可信 DNS 核验 IP 时，才临时增加：

```bash
SOLANA_RPC_RESOLVE_IP=已核验的IP npm run preflight:devnet
```

该选项仍执行 TLS hostname 和 Devnet genesis 校验，不允许跳过证书验证。

## 剩余发布阻断项

1. 为测试钱包准备至少建议额度的 Devnet SOL，或提供有额度的独立部署钱包。
2. 使用可信 Devnet RPC 持久部署并初始化 24 个生产 Program。
3. 创建并冻结生产 ALT，实发交易 A/B，记录真实集群 signature、slot、bytes、
   CU、日志、余额和回滚结果。
4. 只读核验暂停状态、PDA 权限、upgrade authority、DC mint 权限和
   `terminal_guard_enabled`。
5. 完成三条真实桥的 Solana 官方验签 adapter 与故障注入。
6. 完成独立第三方审计和修复复审。

上述事项完成前，不能部署 Solana 主网，也不能宣称 Solana 已经“百分百完成”。
