# DAO V2 Satoshi 与专用 DC 分红模块安全审计

审计日期：2026-07-21
审计结论：**内部上线前审查通过；没有发现仍未修复的 Critical、High 或 Medium 级合约漏洞。**

> 部署后更新：四个合约已按本审计中的预测地址部署，proposal `8` 已开放四条精确规则，proposal `9` 已创建首轮 100 DC 分红。本文第 8～10 节保留的是部署前审计快照；当前生产接入见 `docs/ETH_DAO_V2_国库中本聪分红前端交接.md`。

> 本文是针对当前仓库代码和当前 ETH 主网状态的内部工程审查，不等同于独立第三方审计，也不构成“绝对安全”保证。大额资金进入前仍建议安排独立第三方审计或分阶段小额灰度。

## 1. 审计范围

核心合约：

```text
contracts/SatoshiVault.sol
contracts/DealDividendVault.sol
contracts/DealGovernance.sol
contracts/GovernancePolicyRegistry.sol
contracts/ProtocolTreasury.sol
contracts/D.sol
contracts/DL.sol
```

生产策略与脚本：

```text
scripts/dao-v2-policy.ts
scripts/prepare-eth-dao-treasury-modules.ts
scripts/deployed-runtime-code.ts
scripts/check-dao-treasury-module-storage-layout.ts
storage-layout/DaoTreasuryModules.v1.json
```

测试：

```text
test/DaoTreasuryModules.ts
test/DealGovernanceV2Policy.ts
test/DaoTreasuryModulesMainnetFork.ts
test/DealGovernanceV2MainnetFork.ts
forge-test/DaoTreasuryModulesSecurity.t.sol
```

依赖基线：

| 依赖 | 最终版本 |
| --- | --- |
| Solidity | `0.8.28` |
| OpenZeppelin Contracts | `5.4.0`，精确锁定 |
| OpenZeppelin Contracts Upgradeable | `5.4.0`，精确锁定 |
| viem | `2.55.4`，精确锁定 |
| ws | `8.21.1`，精确锁定 |
| undici | `6.27.0`，精确锁定 |

## 2. 风险结论

| 级别 | 未修复数量 | 结论 |
| --- | ---: | --- |
| Critical | 0 | 未发现可直接盗取 DC、夺取升级权或绕过 DAO 的路径 |
| High | 0 | 未发现未授权付款、重复领取、超发或代理接管路径 |
| Medium | 0 | 未发现会阻断正常治理/领取的未修复合约缺陷 |
| Low | 0 | 本轮发现的上线脚本问题已经修复 |
| Informational / 接受风险 | 5 | 见第 7 节，不属于当前部署阻断项 |

## 3. UUPS 与权限审查

### 3.1 初始化

1. 两个 implementation 构造函数都调用 `_disableInitializers()`。
2. 两个 ERC1967Proxy 在构造交易中原子执行 initializer，不存在未初始化代理抢占窗口。
3. initializer 检查零地址并且只能执行一次。
4. 生产脚本部署后会读取并比对 D、DC、governance/controller。

### 3.2 升级授权

1. `SatoshiVault._authorizeUpgrade` 只接受当前 DealGovernance proxy。
2. `DealDividendVault._authorizeUpgrade` 只接受当前 DealGovernance proxy。
3. EOA、部署账户、bootstrap admin 都不能直接升级。
4. Registry 只准备两条 Major `upgradeToAndCall(address,bytes)` 精确规则，目标分别固定为两个 proxy。
5. 升级必须创建并通过 Major 提案；脚本不存在直接升级路径。

### 3.3 存储布局

1. SatoshiVault：2 个业务字段 + 48 slot gap。
2. DealDividendVault：6 个业务存储位置 + 44 slot gap。
3. `Round` 的 5 个字段已建立固定基线。
4. 升级 mock 与当前布局完全一致。
5. 原 DealGovernance 的 29 个 V1 字段保持不变，V2 只在 slot 29 追加 `policyRegistry`。

结论：未发现初始化抢占、EOA 升级、实现合约自初始化或存储覆盖路径。

## 4. SatoshiVault 审查

1. 唯一资金出口是 `payDC(address,uint256)`。
2. 只有 DealGovernance 可以调用。
3. 拒绝零地址和零金额。
4. 使用 `SafeERC20`，并使用 `nonReentrant`。
5. 没有 owner 提款、rescue、任意调用或修改 controller 的入口。
6. Registry 只允许 Satoshi 类型调用该 proxy 的 `payDC` selector，`value == 0`。
7. 90 D 成功后支持者可取回 D，但执行前普通 veto 与 collective veto 仍然有效。
8. 提案执行前和执行时都会重新检查 Registry；策略被撤销后旧提案也不能绕过。

结论：未发现绕过 90 D/否决状态、任意收款人直接提款或重入付款路径。

## 5. DealDividendVault 审查

### 5.1 资金会计

核心不变量：

```text
reservedUnclaimed <= DealDividendVault 的 DC 实际余额
每轮 claimed <= total
每轮 claimedWeight <= totalWeight
同一地址每轮最多领取一次
所有有效权重领取完成后：claimed == total，reservedUnclaimed 释放对应整轮金额
```

检查结果：

1. 创建轮次前先检查 `balance - reservedUnclaimed`，同一 DC 不能被重复分配。
2. claim 先写 `claimed/claimedWeight/reservedUnclaimed`，再转 DC，符合 checks-effects-interactions。
3. `claim` 使用 `nonReentrant`。
4. 最后一个完整权重领取人收到剩余尾差，不会把整数除法 dust 永久留在已完整领取的轮次。
5. `previewClaim` 与 claim 使用相同权重和付款公式；领取后付款额返回 0。
6. 512 组随机 D 权重、分红金额和 6 种领取顺序证明没有超发，且最终余额守恒。

### 5.2 快照权重

1. 快照取 D 的 EIP-6372 当前时点减 1，避免同一交易/区块即时转移操纵。
2. 钱包 D 使用 `getPastBalanceOf`。
3. 支持 stake 与 collective veto stake 都来自 DealGovernance 的 `getPastStakedOf`。
4. DealGovernance 托管地址本身不能 claim，避免同一批质押 D 被托管地址和实际质押人重复领取。
5. D 总供应固定 100 D，不存在增发改变历史分母。

结论：未发现双领、托管余额重复计权、同一余额重复开轮或超发路径。

## 6. 策略与生产脚本审查

### 6.1 四条新增规则

| Kind | Target | Selector |
| --- | --- | --- |
| Satoshi | SatoshiVault proxy | `payDC(address,uint256)` |
| Treasury | DealDividendVault proxy | `createRound(uint256)` |
| Major | SatoshiVault proxy | `upgradeToAndCall(address,bytes)` |
| Major | DealDividendVault proxy | `upgradeToAndCall(address,bytes)` |

所有规则：

```text
allowed = true
validateNestedBroadcast = false
nestedOnly = false
maxValue = 0
```

原 48 条策略不会被替换。最新链上只读核验为 `48/48` 精确匹配。

### 6.2 已修复的审计发现

| 编号 | 原问题 | 处理结果 |
| --- | --- | --- |
| F-01 | 部署前显式传入四个预测地址时，脚本会误以为模块应该已经存在并提前失败 | 已区分“待部署地址”和“已部署地址”；部署前要求四个地址无 code，部署后才完整验证 |
| F-02 | 只检查 UUPS UUID、slot 和 getter，不能排除伪造 getter 的错误 implementation/proxy | 已按 artifact 与实际部署地址重建 runtime bytecode，并逐字节比对链上 code |
| F-03 | 模块脚本未自行复核原 48 条生产策略 | 已在每次 dry-run/写模式前逐条核验 `48/48` |
| F-04 | OpenZeppelin 5.2.0 命中 `Bytes.lastIndexOf` 已公开中危告警 | 已升级并精确锁定到已修复的 5.4.0，重新完成全部审查 |
| F-05 | 根级 viem 低于当前 Hardhat 插件要求，根级 ws/undici 命中已修复告警 | 已升级并精确锁定 viem 2.55.4、ws 8.21.1、undici 6.27.0 |

OpenZeppelin 官方 5.4.0 `Bytes.lastIndexOf` 实现已经在空 buffer 上安全返回，不再读取未初始化内存：

<https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.4.0/contracts/utils/Bytes.sol>

## 7. 已接受的残余风险

### R-01：DAO 本身拥有升级权

Major 提案可以把任一模块升级到新的 implementation。这是用户确认的治理设计，不是漏洞。任何未来升级仍必须重新做源码审计、存储检查和主网 Fork。

### R-02：没有救援和紧急 EOA 暂停

误转入非 DC 资产、强制转入 ETH 或其他不受支持资产会留在合约内。DC 如被其既有 PAUSER_ROLE 暂停，付款/领取会等待 DC 恢复。当前没有 EOA 可绕过 DAO 紧急提款，这是明确的安全取舍。

### R-03：误转给 DAO 的未记账 D

直接转给 DealGovernance、但没有通过 stake/vetoStake 记账的 D，不属于任何用户的分红权重。因为总供应分母仍包含它，对应 DC 比例会继续保留在分红合约，不会被其他人冒领。本轮按用户确认选择“不救援、不处理”。

### R-04：极小分红轮的整数精度

如果轮次 DC 总额极小，极小 D 权重计算出的 payout 可能向下取整为 0，用户会暂时无法领取该轮。生产操作应避免创建只有少量 DC wei 的无意义轮次；`0.01 D` 在正常业务金额下已验证可以按比例领取。

### R-05：开发工具链传递依赖告警

`npm audit` 仍报告 Hardhat/LayerZero/旧 ethers 的 ZIP、HTTP、WebSocket 等开发工具传递依赖告警，其中部分上游无修复版本。这些依赖不会编译进模块 runtime bytecode。生产部署机应只连接可信 RPC，不打开不可信 ZIP/项目文件，并保持独立、最小权限环境。

## 8. 验证证据

| 检查 | 最终结果 |
| --- | --- |
| 新模块 + DAO V2 专项 | `16 passing` |
| Hardhat 全量 | `189 passing` |
| Foundry 全量 | `33 passed, 0 failed` |
| 分红会计 fuzz | 512 组随机输入，全部通过 |
| Slither | 97 detectors；新模块无 Critical/High/Medium，只有 storage gap 与 OZ 事件信息项 |
| 新模块 ETH mainnet fork | `1 passing`，四策略/Satoshi/分红/UUPS 全流程 |
| 原 DAO V2 ETH mainnet fork | `1 passing`，历史/Treasury/跨链策略保持通过 |
| DAO V2 存储 | 29 个旧字段保留，`policyRegistry` 位于 slot 29 |
| 新模块存储 | Satoshi 3 项、Dividend 7 项、Round 5 项，全部匹配基线 |
| 合约体积 | 196 artifacts 全部符合 EIP-170 / EIP-3860 |
| 实时只读状态 | chainId 1；DAO/Treasury/D/DC/Registry 正确；原策略 `48/48` |
| 主网写操作 | 0；没有部署、approve、提案、stake 或 execute |

## 9. 当前只读部署计划

最新 dry-run：ETH block `25579260`，部署账户 nonce `108`，pending nonce `108`，原生余额 `0.027884300468960232 ETH`。

| 合约 | 预测地址 | 预测 runtime hash |
| --- | --- | --- |
| SatoshiVault implementation | `0x16b1Ad109E8D826F17B5542984c4B83643B4Ce48` | `0xe0e51b68f9c580b07d85068ba7d466132fd38ce6f515e8140236aa11c7bf600c` |
| SatoshiVault proxy | `0xA2C8d5B2E440EbA62a5fd0A55978b39c3dAcFB3e` | `0xc08b0f88e0e8f941508884b82220c370c9c107a38490f3d2d14253269c2b1ea4` |
| DealDividendVault implementation | `0xB5D30418AEb0a302847EE5227193082fF36C44A8` | `0x28a5a0133fb3e3b6fbfd361a2863d4bdc0fc6806f9b43915ad453d5ca6185be8` |
| DealDividendVault proxy | `0xc0aE5D371f4605c464493B0d056dA56357cD2850` | `0xc08b0f88e0e8f941508884b82220c370c9c107a38490f3d2d14253269c2b1ea4` |

注意：implementation runtime 包含其自身 immutable 地址，所以 nonce/预测地址变化时 implementation runtime hash 也会变化。发送交易前必须重新 dry-run，不得把本表当成永久地址。

## 10. Go / No-Go

当前判断：**GO，仅限部署阶段。**

下一步在得到用户明确授权后，只执行：

1. 部署 SatoshiVault implementation。
2. 部署并原子初始化 SatoshiVault ERC1967Proxy。
3. 部署 DealDividendVault implementation。
4. 部署并原子初始化 DealDividendVault ERC1967Proxy。
5. 逐字节核验 runtime、UUPS UUID、implementation slot、D/DC/governance/controller 和空轮次状态。
6. 回传四个地址、交易哈希和验证结果后停止。

该授权不包含：DC approve、创建 Major 提案、stake、执行提案、充值、创建分红轮、Git commit 或 push。
