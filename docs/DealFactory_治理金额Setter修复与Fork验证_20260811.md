# DealFactory 治理金额 Setter 修复与 Fork 验证

日期：2026-08-11，2026-08-12 按 DAO 无金额范围要求复核更新

## 结论

本次只修复 `DealFactory` 中“治理正式值”和“admin 快捷通道上限”不一致的问题，尚未向任何主网发送交易。

- admin 仍是受限操作通道：留言费 `0.01 - 100 DC`，创建 burn 金额 `1 - 10 DC`。
- owner / `crossChainGovernance` 新增只改金额的治理通道，不修改各链自己的 token 地址和开关；金额没有上下限，`0` 到 `uint256.max` 均由 DAO 决定。
- 新函数使用相同 calldata，可由 ETH DAO 同步传给 BSC 和 Base。
- 没有新增存储变量，现有 UUPS proxy 地址、状态和历史数据不变。

## 新增接口

```solidity
function setMessagePriceAmount(uint256 amountInToken) external;
function setCreateBurnAmount(uint256 amountInToken) external;
```

两者权限均为 `onlyOwnerOrGovernance`。

`setMessagePriceAmount` 只修改 `msgPriceAmountInToken`；`setCreateBurnAmount` 只修改 `createBurnAmountInToken`。原有完整配置函数和 admin 函数保留，事件也继续复用原事件。

DAO/owner 的两个金额接口均不设置范围限制；即使创建 burn 已开启，DAO 仍可把金额设成 `0`。admin 的范围限制不会影响 DAO。

## 验证结果

- production profile 编译通过。
- `DealFactory` runtime bytecode：`23,842 bytes`，低于 EIP-170 的 `24,576 bytes`，剩余 `734 bytes`。
- 单元、权限、边界和 calldata 计划测试：`52 passing`。
- ETH mainnet fork：升级成功，31 项生产状态升级前后一致，`104 → 105 → 104` 与 `0 → 11 → 0` 完整恢复。
- BSC mainnet fork：同上，通过。
- Base mainnet fork：同上，通过。
- BSC + Base 真实 Executor 配置 fork：LayerZero + CCIP 达到 2-of-3 后执行，两个目标链均完成 `104 → 105 → 104`，共 `2 passing`。
- 治理对两个金额字段的 `0`、超出 admin 上限以及 `uint256.max` 边界测试通过；未授权地址调用会失败，admin 仍不能绕过自己的范围限制。

## DAO 最终控制补充

继续审计发现，旧版本中下列操作仍然依赖 admin 或本地 owner，不满足“ETH DAO 最终控制副链”的目标。本次已在同一 implementation 中补齐：

- `setAdmin(address)`：admin、owner、`crossChainGovernance` 均可轮换 admin。
- `setTreasury(address)`：新增 DAO/owner 正式治理入口；原 `setTreasuryByAdmin(address)` 保留给 admin。
- `setSpecialNoFeeToken(address)`：新增 DAO/owner 正式治理入口；原 `setSpecialNoFeeTokenByAdmin(address)` 保留给 admin。
- `setCrossChainGovernance(address)`：DAO/当前 executor 可执行自身的治理 executor 轮换。
- `_authorizeUpgrade`：新版本生效后，owner 或 `crossChainGovernance` 均可授权后续 UUPS 升级。

DAO setter 与 admin setter 分开，便于策略注册表使用明确 selector；必要的非零地址检查仍然保留。三条主网 fork 均已验证 DAO 临时修改并精确恢复 admin、treasury、specialNoFeeToken，随后由 DAO/executor 完成第二次 UUPS 升级，生产状态保持不变。

## 生产状态

当前三条主网的 Factory implementation 还没有升级，因此生产只读预检会正确返回阻断：

> governance amount-only setter is not deployed/callable on both destination Factories

这不是测试失败，而是防止在目标链尚未支持新 selector 时创建跨链提案。

旧 implementation 的 `_authorizeUpgrade` 仍然是 `onlyOwner`。所以第一次升级到本版本必须使用每条链当前旧 owner 的既有权限；只有本版本生效后，DAO/executor 才能独立授权未来升级。任何生产计划都不能跳过这一步。

## 后续操作边界

下一步应单独制定 ETH、BSC、Base 三条链的 implementation 部署与 proxy 升级顺序，并在部署地址、权限主体、calldata 和回滚方案全部复核后再请求授权。未经明确授权，不部署、不升级、不创建提案。
