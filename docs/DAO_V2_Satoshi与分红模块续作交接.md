# DAO V2 Satoshi 与专用 DC 分红模块续作交接

更新时间：2026-07-21

## 1. 一句话状态

**ETH 主网 DAO V2、`SatoshiVault` 与 `DealDividendVault` 已完成部署和治理接线。Major proposal `8` 已执行并开放四条精确策略；Treasury proposal `9` 已执行并创建首轮 100 DC 分红。当前前端接入以 `docs/ETH_DAO_V2_国库中本聪分红前端交接.md` 为准。**

当前边界：

1. 两个模块都采用 `implementation + ERC1967Proxy`。
2. 两个代理都只能由当前 DealGovernance proxy 授权升级，不存在 EOA 管理员。
3. 不提供普通救援、任意代币提取或 generic execute。
4. SatoshiVault 当前尚未充值或执行付款；DealDividendVault 已有 round `0`。

## 2. 仓库与分支

```text
仓库：/Users/a1234/Desktop/Solidity_code/deal完整 2/deal完整 2
分支：agent/dao-v2-treasury-modules
```

工作区存在大量来自其他任务和窗口的未提交修改。

注意：

1. 不要回滚、覆盖或清理不属于本任务的修改。
2. 不要提交 `.codegraph/`。
3. 不要打印、写入文档或提交任何私钥。
4. 未经用户逐阶段明确确认，不得部署、授权代币、创建提案、stake、执行或发送其他主网交易。
5. 2026-07-21 用户已明确授权整理本轮代码、提交、推送并创建 PR。

## 3. DAO V2 已完成的主网状态

| 项目 | ETH 主网当前值 |
| --- | --- |
| DealGovernance proxy | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` |
| DAO V2 implementation | `0xAAB065B8FDB3c09C207273eA53B2E0DF0EafD1e5` |
| GovernancePolicyRegistry | `0xBFF01F91291476e671f0F310846D5dDb460e2382` |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` |
| D | `0x61921ecb954ffaaf8cd3fd2e71eecb14b3ed529f` |
| DealCoin / DC | `0x591625be924b98accab7e2c8af698c858aa2608d` |
| DAO V2 升级提案 | proposal `7`，已执行 |
| DAO V2 升级交易 | `0x7ce0d235e82c946f0974640acc6c41eb4aa23d2628a20e0f5e95f089e92ccb64` |
| 当前生产策略 | 原始 48 条保持不变，新增四条模块规则，共 52 条 |
| Satoshi 策略 | 已精确开放 SatoshiVault `payDC(address,uint256)` |
| ProtocolTreasury.controller | DealGovernance proxy |
| ProtocolTreasury.bootstrapLocked | `true` |

DAO V2 存储布局已经检查：V1 的 29 个字段保持不变，`policyRegistry` 仅追加在 slot 29。

## 4. 已确认的最终业务规则

### 4.1 Satoshi 账户

1. V1 只部署在 ETH。
2. 只持有和支付 DealCoin（DC）。
3. 可以给国库、投资对象或其他 DAO 提案指定的准确地址付款。
4. 只有 Satoshi 类型提案达到 `90 D` 后才能进入 `Succeeded` 并执行付款。
5. 达到 90 D 后的成功标记只属于该条 `proposalId`，不会影响其他提案。
6. 达到 90 D 后，支持者可以 `unstake` 取回 D；取回后该提案不会因为支持质押下降而退回未通过状态。
7. **提案在尚未执行时仍可继续被 D 否决。**普通 `veto` 和集体 `vetoStake` 都保留；一旦达到否决条件，该提案不能再执行。
8. 一条 Satoshi 提案成功，不会让其他 Satoshi 提案自动成功。
9. 每一笔不同的收款地址或金额，都必须由新的提案明确批准。

因此当前 DAO V2 已满足本轮要求，不需要为了“90 D 后取回 D”再次修改或升级 DealGovernance。

### 4.2 国库提案

1. Treasury 类型提案通过门槛为 `70 D`。
2. ProtocolTreasury 继续收协议收入并由 DealGovernance 控制。
3. 国库可以把 DC 打入专用分红合约，再在同一提案中创建分红轮。

### 4.3 专用 DC 分红

1. 只分 DealCoin（DC），不分 ETH、USDT、USDC 或其他代币。
2. 分红资金必须先进入 `DealDividendVault`。
3. 资金可以来自 ProtocolTreasury，也可以先由 SatoshiVault 按提案转入。
4. 创建分红轮不会从提案人或执行者个人钱包扣款。
5. 每轮使用创建交易前一个有效时点的 D 持仓快照。
6. 分红权重 = 钱包内 D + 当时质押在 DealGovernance 中的 D。
7. 治理质押既包括支持提案的 stake，也包括集体否决的 veto stake。
8. 用户自己调用 `claim(roundId)` 领取，不做自动批量发放。
9. 每个地址每轮最多领取一次；已经领取后，`previewClaim` 的预计付款额返回 `0`。
10. 领取不设到期时间，未领取份额一直保留。
11. `0.01 D` 等小数持仓也按比例参与。
12. 直接误转给 DealGovernance 的 D 不计入任何人的分红权重，也不在本轮提供救援入口。
13. 老 `VoteDividendClaimer` 不删除，但新业务接入后不再作为主分红入口。

### 4.4 跨链分红边界

当前 D 只在 ETH 存在，因此 V1 分红只在 ETH 领取。

BSC 或未来其他链不能直接声称“持有 ETH 的 D”并在本链领取。后续如需跨链分红，需要单独设计：

1. ETH 快照权重根或领取根。
2. 可信跨链消息验证。
3. 远端 DC 资金来源或资产桥。
4. 全局防重复领取规则。

上述跨链分红不属于本轮部署范围。

## 5. 当前新增代码

### 5.1 `contracts/SatoshiVault.sol`

核心边界：

1. 使用 UUPS implementation，通过 ERC1967Proxy 对外工作。
2. `initialize(DC, DealGovernance proxy)` 只允许初始化一次，implementation 构造时永久禁用初始化。
3. 代理内保存 `dealCoin` 和 `controller`；`controller` 必须是当前 DealGovernance proxy。
4. 没有 EOA owner、管理员提款、普通救援或任意执行入口。
5. 唯一付款入口为：

```solidity
payDC(address to, uint256 amount)
```

6. 只有 DealGovernance 可以调用，收款地址和金额必须与已执行的 Satoshi 提案 action 完全一致。
7. 向代理直接转入 DC 即可完成充值，不需要额外记账函数。
8. `_authorizeUpgrade` 只允许 DealGovernance 调用；升级必须再走 Major 提案和精确策略。

### 5.2 `contracts/DealDividendVault.sol`

核心边界：

1. 使用 UUPS implementation，通过 ERC1967Proxy 对外工作。
2. `initialize(D, DC, DealGovernance proxy)` 只允许初始化一次，implementation 构造时永久禁用初始化。
3. 只有 DealGovernance 可以调用 `createRound(uint256 total)`。
4. `reservedUnclaimed` 防止同一笔 DC 被重复分配给多轮。
5. `claim(roundId)` 采用 pull 模式，由 D 持有人自己领取。
6. 同时统计钱包 D 和 DealGovernance 中的历史质押 D，包括支持 stake 与集体否决 stake。
7. DealGovernance 托管地址本身被禁止领取，避免托管 D 与用户质押权重重复计算。
8. 最终完整权重领取时会释放整数除法留下的尾差。
9. 已领取地址再次调用 `previewClaim` 时，预计付款额为 `0`。
10. `_authorizeUpgrade` 只允许 DealGovernance 调用；升级后必须保持代理地址和已有轮次状态。
11. 不提供普通救援或任意代币提取。

主要读取/用户入口：

```text
roundsCount()
getRound(roundId)
unallocatedDC()
previewClaim(roundId, account)
claim(roundId)
```

### 5.3 `scripts/dao-v2-policy.ts`

原始 48 条生产规则保持不变。

`buildDaoV2TreasuryModuleRules(satoshiVaultProxy, dividendVaultProxy)` 只生成以下四条精确规则：

| 提案类型 | 目标 | 允许 selector |
| --- | --- | --- |
| Satoshi | SatoshiVault proxy | `payDC(address,uint256)` |
| Treasury | DealDividendVault proxy | `createRound(uint256)` |
| Major | SatoshiVault proxy | `upgradeToAndCall(address,bytes)` |
| Major | DealDividendVault proxy | `upgradeToAndCall(address,bytes)` |

不开放任意 target，不开放 generic execute，不开放 EOA 管理函数；用户 `claim` 不需要加入 DAO 策略。

### 5.4 生产准备脚本（历史部署阶段记录）

`scripts/prepare-eth-dao-treasury-modules.ts` 默认只读，已经具备：

1. 强制校验 Ethereum `chainId == 1`。
2. 核验当前 DAO V2 implementation、Registry、Treasury、D、DC 和 Treasury controller/锁定状态。
3. 预测两套 implementation/proxy 地址并展示 initializer 参数。
4. 展示四条精确规则及完整 `setRules` calldata。
5. 部署、DC fee approve、创建 Major 提案为三个互斥写模式。
6. 脚本不提供 mint、stake 或 execute 路径。

最新只读 dry-run（block `25579260`，部署账户 nonce `108`，原生余额 `0.027884300468960232 ETH`）预测：

| 合约 | 仅预测地址 |
| --- | --- |
| SatoshiVault implementation | `0x16b1Ad109E8D826F17B5542984c4B83643B4Ce48` |
| SatoshiVault proxy | `0xA2C8d5B2E440EbA62a5fd0A55978b39c3dAcFB3e` |
| DealDividendVault implementation | `0xB5D30418AEb0a302847EE5227193082fF36C44A8` |
| DealDividendVault proxy | `0xc0aE5D371f4605c464493B0d056dA56357cD2850` |

上述预测地址后来成为实际部署地址。该表保留为部署前证据，不能用于推导未来部署地址。

## 6. 正确的提案调用方式

### 6.1 Satoshi 付款

前提：SatoshiVault proxy 已经持有足够 DC。

Satoshi 提案只有一个 action：

```text
target: SatoshiVault proxy
value: 0
calldata: payDC(本提案指定收款地址, 本提案指定DC金额)
kind: Satoshi
通过门槛: 90 D
```

### 6.2 国库出资并创建分红轮

Treasury 提案建议包含两个按顺序执行的 action：

```text
Action 1:
ProtocolTreasury.payToken(DC, DealDividendVault proxy, 本轮金额)

Action 2:
DealDividendVault proxy.createRound(本轮金额)

kind: Treasury
通过门槛: 70 D
```

如果 DealDividendVault 已经有足够未分配 DC，可以只执行 Action 2。

### 6.3 模块升级

每个模块单独创建 Major 提案：

```text
target: 对应模块 proxy
value: 0
calldata: upgradeToAndCall(新 implementation, 初始化/迁移 calldata)
kind: Major
```

升级不会更换代理地址。新 implementation 必须重新审计、做存储兼容检查和 Fork 预演；“DAO 有权升级”不等于可以绕过提案直接升级。

## 7. 已完成测试与当前验证结果

专项和 Fork 测试：

```text
test/DaoTreasuryModules.ts
test/DealGovernanceV2Policy.ts
test/DaoTreasuryModulesMainnetFork.ts
test/DealGovernanceV2MainnetFork.ts
```

覆盖内容：

1. Satoshi 成功只影响达到 90 D 的具体 proposalId。
2. 达到 90 D 后取回 D，该条提案仍为 Succeeded。
3. 执行前仍可使用普通否决和集体否决；其他 Satoshi 提案不会连带成功。
4. 非治理地址不能付款、创建轮次或升级两个代理。
5. implementation 不能被外部初始化，代理不能重复初始化。
6. 70 D Treasury 提案可以完成“国库转 DC + 创建分红轮”。
7. 钱包 D、支持 stake 和集体否决 stake 都进入快照权重。
8. 治理托管地址本身不能重复领取。
9. 同一 DC 余额不能重复分配给两轮。
10. `0.01 D` 可按比例领取，365 天后仍可领取。
11. 已领取后 `previewClaim` 付款额为 0；最后一份完整权重不会残留舍入尾差。
12. 两个 UUPS 代理均可由 DAO 升级，并保持配置、已有分红轮和状态。
13. 当前 ETH 主网 Fork 可完成：部署模块、Major 加四条规则、90 D Satoshi 付款、70 D 分红、领取以及两模块升级。
14. 原 DAO V2 主网 Fork 的升级、Treasury 和跨链路径保持通过。

当前结果：

| 检查 | 结果 |
| --- | --- |
| DAO V2 + 新模块专项 | `16 passing` |
| Hardhat 全量 | `189 passing` |
| Foundry 全量 | `33 passed, 0 failed`；模块会计 fuzz 512 组通过 |
| 新模块 ETH mainnet Fork | `1 passing` |
| 原 DAO V2 ETH mainnet Fork | `1 passing` |
| DAO V2 存储布局 | 29 个旧字段保留，新增 `policyRegistry` slot 29 |
| 新模块存储布局 | Satoshi 3 个字段、Dividend 7 个字段；升级 mock 布局兼容 |
| 合约体积 | 196 artifacts 全部符合 EIP-170 / EIP-3860 |
| `git diff --check` | 通过 |

安全审计补充：

1. Slither 97 detectors 未发现新模块 Critical/High/Medium 告警。
2. OpenZeppelin Contracts / Upgradeable 已升级并精确锁定到 `5.4.0`。
3. 生产脚本会先核验原始 `48/48` 策略，并逐字节比对两个 implementation 和两个 proxy 的链上 runtime bytecode。
4. 根级 RPC 工具已锁定 viem `2.55.4`、ws `8.21.1`、undici `6.27.0`。
5. 完整审计结论见 `docs/DAO_V2_Satoshi与分红模块安全审计.md`。

建议使用 Node 22。Node 25 会触发 Hardhat reporter 的 `grey/gray` 兼容问题，这不是合约测试失败。

```bash
cd "/Users/a1234/Desktop/Solidity_code/deal完整 2/deal完整 2"

$HOME/.nvm/versions/node/v22.22.1/bin/node \
  node_modules/hardhat/dist/src/cli.js test

PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run dao:v2:storage
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run dao:treasury-modules:storage
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run check:contract-sizes
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run test:dao-treasury-modules:fork
forge test
git diff --check
```

## 8. 历史生产执行顺序

本节记录当时逐阶段授权的实施流程。阶段 B 至 E 已完成；阶段 F 已完成首轮 Treasury 分红灰度，尚未执行 Satoshi 付款灰度。

以下每一阶段都是独立授权；上一阶段的授权不会自动包含下一阶段。

### 阶段 A：重新只读核验

1. 重新运行默认 dry-run，核验链上状态、部署账户、nonce、余额、四个预测地址和 calldata。
2. 预测地址变化属于正常现象，以发送部署交易前的最后一次结果为准。
3. 只读核验不发送交易。

### 阶段 B：用户明确批准后，仅部署两个模块

实际发送四笔部署交易：两个 implementation + 两个 ERC1967Proxy。

initializer：

```text
SatoshiVault.initialize(DC, DealGovernance proxy)
DealDividendVault.initialize(D, DC, DealGovernance proxy)
```

部署后只读验证：

1. 两个 implementation 和两个 proxy 都有 runtime code。
2. 两个 implementation 的 `proxiableUUID` 正确。
3. 两个 ERC1967 implementation slot 指向正确 implementation。
4. SatoshiVault 的 DC/controller 正确。
5. DealDividendVault 的 D/DC/governance 正确，`roundsCount == 0`、`reservedUnclaimed == 0`。
6. 此时四条新策略仍未开放，不能误写成“已接线完成”。

部署写模式的显式确认变量为：

```text
DAO_TREASURY_MODULES_MAINNET_DEPLOY_CONFIRM=DEPLOY_DAO_TREASURY_MODULES_ON_ETHEREUM_MAINNET
```

### 阶段 C：单独准备 Major 提案费

下一条 Major 提案需要 `1000 DC`。最新只读状态中，当前提案账户的 DC 余额和 allowance 都是 0，因此尚不具备创建条件。

1. 必须由用户明确指定合法 DC 来源和准确账户。
2. 当前脚本只允许精确 approve 一次 Major fee，不会 mint DC。
3. approve 授权不包含创建提案。

fee approve 写模式的显式确认变量为：

```text
DAO_TREASURY_MODULES_FEE_APPROVE_CONFIRM=APPROVE_DAO_TREASURY_MODULE_RULES_FEE
```

### 阶段 D：再次确认后，创建开放四条规则的 Major 提案

1. 使用两个已部署 proxy 地址生成四条规则。
2. Major 提案调用 `GovernancePolicyRegistry.setRules(...)`。
3. 人工复核 proposal actions、target、selector、value 和两个 proxy 地址。
4. 创建提案后停止；不得自动 stake 或执行。

创建提案写模式的显式确认变量为：

```text
DAO_TREASURY_MODULES_MAINNET_PROPOSE_CONFIRM=CREATE_DAO_TREASURY_MODULE_RULES_PROPOSAL
```

### 阶段 E：stake 与执行分别再次确认

1. Major 提案的 stake 需要单独明确授权。
2. stake 授权不包含执行提案。
3. 达到条件后执行仍需再次明确授权。
4. 执行后逐条读取 Registry，确认原 48 条不变且四条新规则正确。

### 阶段 F：小额灰度

1. 先给 SatoshiVault 转入很小额 DC，创建一条小额 Satoshi 付款提案。
2. 验证达到 90 D、取回 D、该条提案仍成功；执行前再验证否决路径。
3. 再用小额 Treasury 提案执行“国库转 DC + 创建分红轮”。
4. 使用普通钱包 D、支持 stake 和集体否决 stake 分别验证自领取。
5. 灰度验证完成前不要大额充值。

## 9. 明确禁止事项

1. 不要重新升级或重新部署现有 DealGovernance；当前业务规则不要求修改 DAO V2。
2. 不要替换现有 48 条规则；本轮只追加四条精确规则。
3. 不要把 SatoshiVault 或 DealDividendVault 的升级权交给 EOA。
4. 不要增加普通 rescue、管理员提款或 generic execute。
5. 不要开放 `ProtocolTreasury.execute` 作为捷径。
6. 不要把 `claim` 加入 DAO 策略。
7. 不要自动向全部 D 持有人推送 DC。
8. 不要把直接误转给 DAO 的 D 计入用户分红。
9. 不要把 BSC 或其他链写成已支持跨链分红。
10. 未经用户逐阶段明确确认，不得部署、approve、创建提案、stake、投票或执行。
11. Git 提交/推送必须有用户明确授权；本轮已在 2026-07-21 获得授权。

## 10. 当前停点

当前停在：**DAO V2、Treasury 权限、SatoshiVault、DealDividendVault、四条策略和首轮 100 DC 分红均已完成；等待前端按新交接文档接入。**

尚未完成的后续业务包括：SatoshiVault 充值/实际付款灰度，以及 BSC/其他副链本地分红模块设计与实施。
