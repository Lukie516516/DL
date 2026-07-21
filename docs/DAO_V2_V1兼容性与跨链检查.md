# DAO V2 对 V1 的兼容性与跨链可用性检查

> 检查日期：2026-07-20；主网升级复核：2026-07-21
> 结论：DAO V2 已通过现有主网 V1 proxy 完成 UUPS 原地升级，不是新 DAO；V1 的 ABI 和存储状态保持兼容，新增的是提案动作安全策略。
> 升级提案 7 已执行，治理 proxy 地址不变。

## 1. 主网 V1 源码身份

使用项目实际编译器 `solc 0.8.28+commit.7893614a`、相同 optimizer/viaIR/metadata 设置，在内存中重新编译 Git `HEAD` 的 V1 `DealGovernance.sol`。

结果：

- 本地 V1 runtime：15,848 bytes。
- ETH 主网当前 implementation `0xECB7A086Aa87B9e2BcBbc6573fA9D0FEF7b7D1D6`：15,848 bytes。
- 排除 OpenZeppelin UUPS 在部署时注入的两处 implementation 自身地址 immutable 后，字节差异数为 `0`。

因此，本次用来比较的 V1 源码可复现当前主网 implementation，不是拿另一个未知版本对比。

## 2. ABI 兼容性

| 项目 | 结果 |
| --- | ---: |
| V1 function selectors | 52 |
| V2 function selectors | 54 |
| V1 在 V2 中缺失或改变的 selector | 0 |

V2 仅新增：

```text
policyRegistry()             0x1c4dd7d0
setPolicyRegistry(address)   0xe015c85d
```

V1 所有对外函数签名和 selector 都在 V2 中保留。前端、脚本和外部合约继续通过同一个 proxy 地址调用。

## 3. 存储布局与历史状态

| 项目 | 结果 |
| --- | --- |
| V1 存储字段 | 29 |
| V2 存储字段 | 30 |
| 前 29 个字段的 label/slot/offset/递归类型差异 | 0 |
| Proposal struct 内部布局 | 不变 |
| V2 新增字段 | `policyRegistry`, slot 29 |

ETH mainnet fork 原位升级后已验证：

- proxy 地址不变。
- D、DC、Treasury、NftVetoRegistry 指针不变。
- 激活阈值、Treasury/Satoshi/fast-pass 阈值和提案窗口不变。
- `proposalCount`、`executedProposalCount` 连续累加。
- 主网历史 proposal 5 的 Proposal 结构和 actions 逐字段不变。
- stake/veto/claimBack/checkpoint 等旧治理逻辑继续通过回归。

## 4. V2 相对 V1 的有意变化

V2 不改变 V1 的提案状态机、阈值、质押或否决逻辑，但会有意收紧可执行 action：

1. `createProposal()` 创建时检查 proposal kind + target + selector + value。
2. `execute()` 执行时再检查一次，防止旧 pending 提案绕过新策略。
3. `execute()` 要求 `msg.value` 精确等于全部 action value 之和。
4. SatoshiVault 未部署前，Satoshi action 默认全部拒绝。

这些是 V2 的安全增强，意味着 V1 中“可对任意 target/selector 发起 action”的能力不会原样保留；其他治理功能保留。

## 5. ETH/BSC 跨链实时接线

主网只读检查通过：

- ETH chainId = 1，BSC chainId = 56。
- ETH `CrossChainBroadcaster` 存在代码，`governance` 仍是不变的 DAO proxy `0x9a41...07F7`。
- ETH 端 LayerZero peer 指向 BSC `DualBridgeExecutor`。
- BSC 端 LayerZero peer 指向 ETH `CrossChainBroadcaster`。
- Wormhole source chain = 2，source address = ETH broadcaster。
- Axelar source chain = `Ethereum`，source address checksum 与 ETH broadcaster 完全一致。
- BSC executor threshold = 2（2-of-3）。
- BSC DealFactory 已在 executor `allowedTargets` 中。
- BSC DealFactory `crossChainGovernance` = BSC executor。
- BSC 链配置 active = true。
- 当前广播 quote = `1040836170195005 wei`，低于 V2 `0.01 ETH` 上限。

## 6. 升级后跨链实执行预演

fork 测试原先只验证合法广播能创建提案。本次已加强为：

1. 在真实 ETH mainnet fork 上原位升级 DAO V1 到 V2。
2. 创建带真实 LayerZero/Wormhole/Axelar 费用 quote 的 Parameter 跨链提案。
3. 70 D fast-pass。
4. 通过 V2 `DealGovernance.execute{value: quote}` 真正调用 `CrossChainBroadcaster.broadcast()`。
5. 广播内部三条外部桥调用在 fork 上全部不 revert，`broadcastNonce` 精确加 1。

结果：`1 passing`，证明 V2 的策略层、`msg.value` 校验和原 DAO proxy 地址不会阻断现有 broadcaster 发送路径。

fork 不能等待主网桥的异步消息真正到达 BSC；因此接收侧的保证来自实时 ETH/BSC 接线、来源验证、threshold 和 allowed target 检查。桥服务本身的实时可用性仍属于 LayerZero/Wormhole/Axelar 外部运行风险。

## 7. 最终回归

| 检查 | 结果 |
| --- | --- |
| V1 主网 runtime 同源 | PASS |
| V1 ABI 为 V2 ABI 子集 | PASS |
| V1/V2 存储语义布局 | PASS |
| ETH/BSC 跨链实时接线 | PASS |
| 升级后 fork 真正执行 broadcast | 1 passing |
| Hardhat 全量 | 179 passing |
| Foundry 全量 | 31 passed, 0 failed |
| 存储布局独立检查 | PASS |
| 190 个 artifacts 体积 | PASS |
| `git diff --check` | PASS |

## 8. 主网执行结果与安全边界

ETH 主网当前状态：

- DealGovernance proxy：`0x9a41a9A85C16F590789C846Fb933fF8C715407F7`
- V2 implementation：`0xAAB065B8FDB3c09C207273eA53B2E0DF0EafD1e5`
- GovernancePolicyRegistry：`0xBFF01F91291476e671f0F310846D5dDb460e2382`
- 提案 7：`Executed`
- 升级交易：`0x7ce0d235e82c946f0974640acc6c41eb4aa23d2628a20e0f5e95f089e92ccb64`
- 48 条生产策略、Treasury controller/lock、ETH/BSC 跨链治理指针均通过升级后只读复核。

上述证据支持“V2 是 V1 的兼容安全增强，不是换一个新 DAO”。但是：

- 当前是内部代码审核式复核、自动化测试和 mainnet fork 预演，不是第三方审计机构出具的正式审计报告。
- 无法数学上保证没有任何未知 bug。
- 跨链桥服务、relayer 和对端链的运行状态是外部依赖。

如果安全标准要求“必须有独立机构背书”，仍应补充第三方审计。后续新增 SatoshiVault、专用分红合约或开放新的 action 时，应继续走独立开发、测试、审计和 Major 提案流程。
