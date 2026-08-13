# Solana / ETH 一致性审计与 Fork 验证（2026-07-24）

## 结论

本轮完成的是代码级一致性审计、本地 Solana 运行时测试和 ETH 主网 fork
参照验证，不是独立第三方安全审计，也不是 Solana 主网发布批准。

当前结论：

- 9 类 Deal 模板、普通/Fast 状态机、资产最终归属、DC 计费、奖励侧选择、
  身份信用和 DC/DC 的 C 手续费语义，已经具备可执行的一致性证据；
- 本轮新发现的 DC/DC 经济路径差异和 CreditScore 省略攻击面均已修复；
- 本地代码检查和测试没有剩余已知阻断项；
- 最大终局交易的本地真实 SBF 容量已通过；Devnet 实发、生产初始化、
  真实三桥适配器和独立审计仍是发布阻断项；
- 因此可以继续进入 Devnet 预演，不能据此直接部署 Solana 主网或宣称
  “100% 主网安全”。

## 本轮重点审计：DC/DC 手续费

ETH 生产语义：

1. A、B 都使用 DC 且金额大于 0 时，双方分别收取 0.1% 手续费。
2. 使用 Deal 当次锁定的身份和生产 `DealCreditGraph` 选择 C。
3. 双方都无有效分数、双方同分、身份属于同一 owner，或没有有效身份时，
   不选 C，双方手续费合计销毁。
4. 一方分数严格更高时，该方候选获胜；其 top peer 只有在快照严格高于本人
   分数时才替代本人。
5. 有 C 时双方手续费合计转给 C 当前持有人，DC 总供应量不变。

Solana 当前实现：

```text
resolution
  -> A/B 只收到净额，手续费暂留 controller vault
  -> route_dc_fees
       -> 验证 A/B IdentityRecord、持有人 token account、Deal binding
       -> 验证官方 CreditScore PDA 和 top peers
       -> 验证 C IdentityRecord、当前持有人和 DC 收款 token account
       -> transfer 给 C，或 burn
  -> finalization
```

`AssetTerms.dc_fees_routed` 是单次状态锁。Finalizer 同时要求
`resolved=true` 和 `dc_fees_routed=true`。Instructions sysvar 守卫强制上面
三步连续出现，所以少一步、插入一步、换 Deal、错账户或后续失败都会回滚
前面的资产变化。

## 已发现并修复的问题

### F-01：DC/DC 手续费错误进入 Solana 国库

- 风险：与 ETH 经济规则不一致，国库获得本不属于国库的 DC。
- 修复：无 C 时从 controller vault burn；有 C 时合计转给验证后的 C。
- 回归：9 个合法模板的无身份路径、C 成功路径和供应量变化均有断言。

### F-02：有身份时可省略 CreditScore，伪装成零分

- 风险：恶意客户端可以省略真实高分一方的 CreditScore 账户，使本应给 C
  的手续费被错误销毁。
- 修复：只要 `AssetTerms` 记录了身份 mint，就必须传该身份的规范
  CreditScore PDA。尚未初始化的分数也必须传规范空 PDA，不能传 `None`。
- 回归：省略 A CreditScore、错误 binding、错误 C 收款账户均失败，两个
  vault、C 余额、DC 供应量和 `dc_fees_routed` 全部保持原值。

### F-03：资产结算与手续费/最终记账可能被客户端拆开

- 风险：第三方客户端绕过官方 SDK，只提交资产结算，留下半完成状态。
- 修复：DC/DC resolution 必须紧跟 `route_dc_fees`，路由必须紧跟
  Finalizer；Finalizer 再检查链上路由状态。
- 回归：单独 resolution 和单独 route 都失败并整笔回滚；重复 route 失败。

## 测试证据

### Solana

- `cargo fmt --all -- --check`：通过。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过，0 warning。
- `cargo test --workspace --all-targets`：123 项非文档测试通过，0 失败。
- AssetController 专项：
  - 9/9 合法 ETH 模板形状完成实际 DC/NFT 结算；
  - 无 C burn、严格高分、top peer、错 C、错 binding、省略 CreditScore、
    重复路由和守卫回滚通过。
- Terminal Guard：10 项故障测试通过。
- 终局 SDK：21 项测试通过，并与生成 IDL 的 Program ID、discriminator 和
  关键账户索引逐项比对。
- Anchor SBF/IDL：本轮修改的 AssetController 和 Finalizer 已重新生成并由
  运行时加载；工作区 28 个 Program 的全量构建此前同轮通过。

本轮构建指纹：

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| `deal_asset_controller.so` | 578 KiB | `a4f523ed80d5e361b46135eddc32d1dd45c5207d93af80f9a6a0dbe26d47f262` |
| `deal_finalizer.so` | 478 KiB | `fbb426a4843a0aed37f9f42c43be671c6323438c5de35b0bbd10a4c150b27624` |
| `deal_asset_controller.json` | 85 KiB | `8a2910ed7795185f435d8f51d46fb78f33485e6e290bc8a82760137cb7f63085` |
| `deal_finalizer.json` | 71 KiB | `a83157b13736bf651e6d5b6645f0e3adbfb9ba3b2e01a1beb0be111f05cf8139` |

### ETH mainnet fork

固定参照区块：

- block：`25,602,224`
- hash：`0x0e1a7e57d34801686ee517a27a358a13003370973d29f8869f0191a0a7ac63d0`

已通过：

- 9 个合法、6 个非法共享模板向量；
- 9 个真实 clone 的生产 implementation 路由；
- 9/9 合法模板的实际 DC/NFT 最终状态；
- 新增 C 手续费连续场景：
  1. Alice 身份在结算前为 0 分、Bob 无身份：双方手续费合计销毁；
  2. 第一笔完成后 Alice 获得信用，Bob 新身份仍为 0 分；
  3. 第二笔结算前生产 CreditGraph 返回 Alice 为 C；
  4. 第二笔完成后 Alice 收到双方手续费合计，DC 总供应量不变。

本轮完整 fork 重跑期间公共 ETH RPC 曾返回 403 限流；这是历史状态数据源
失败，不是合约断言失败。切换为只运行新增 C 场景后用例完整通过。发布流水线
应使用有 SLA 的归档 RPC，避免把公共 RPC 限流当作协议结果。

## 尚未完成的发布证明

1. Devnet 真实完成态交易：本地真实 SBF 已证明经济核心/补写分别为
   `58/39` 个账户、`619/474` 字节和最高观测 `425,706/220,564` CU；仍需在
   Devnet 持久部署后实发并取得集群 signature。
2. 生产范围 24 个 Program 的持久部署、初始化、暂停态、升级权限和只读复核。
3. LayerZero、Wormhole、Axelar 的 Solana 官方验签适配器及三桥故障注入。
4. 奖励、信用、域名和治理剩余状态的更大规模 EVM/Solana 差分。
5. 独立第三方审计、修复复审和最终部署字节码/源码哈希确认。

## 下一步门槛

下一步只应进入 Devnet/本地验证环境：

1. 为测试钱包准备至少 `65.25564568 SOL` Devnet 测试币；当前余额为 0。
2. 使用可信 RPC 部署并初始化生产范围 24 个 Program。
3. 创建 ALT，实发“经济核心 + 权限开放补写”两笔交易并取得集群证据。
4. 记录 program data hash、IDL hash、账户数、交易大小、CU、日志和回滚结果。
5. 上述结果通过后，再安排独立审计；审计前不部署主网。

容量拆分、账户上限、重放结果和 Devnet 资金预检详见
`docs/Solana_Devnet终局容量预演_20260726.md`。
