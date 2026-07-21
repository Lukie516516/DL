# ETH DAO V2、国库、中本聪与分红前端交接

更新时间：2026-07-21
网络：Ethereum Mainnet，`chainId = 1`

## 1. 前端结论

本轮不是只有中本聪和分红与前端有关。四个部分的前端影响如下：

| 模块 | 是否影响前端 | 前端职责 |
| --- | --- | --- |
| DAO V2 | 是，必须更新 | 提案类型、状态、action 展示、质押、取回、否决、执行和错误提示 |
| ProtocolTreasury | 是，但普通用户不直接付款 | 展示 ETH/DC 等余额；构造和解码 Treasury 提案 action |
| SatoshiVault | 是 | 创建/展示 Satoshi 提案；展示 Vault DC 余额与付款记录 |
| DealDividendVault | 是，用户直接使用 | 展示轮次、预计可领、已领状态，并调用 `claim(roundId)` |
| GovernancePolicyRegistry | 主要是开发/管理页 | 创建提案前预校验 action 是否被策略允许 |

前端必须使用 proxy 地址。所有 implementation 地址只用于版本展示和区块浏览器链接，不能作为业务调用地址。

## 2. 本轮已经完成什么

1. ProtocolTreasury controller 已交给现有 DealGovernance proxy，并永久锁定 bootstrap。
2. DAO 通过 proposal `7` 完成 DAO V2 UUPS 原地升级，DAO proxy 地址不变。
3. DAO V2 接入 GovernancePolicyRegistry，初始精确策略为 48 条。
4. 部署 SatoshiVault implementation + ERC1967Proxy。
5. 部署 DealDividendVault implementation + ERC1967Proxy。
6. DAO 通过 proposal `8` 新增四条模块策略，总策略变为 52 条。
7. DAO 通过 Treasury proposal `9` 从 ProtocolTreasury 转入 100 DC，并创建分红 round `0`。
8. 当前没有执行过 Satoshi 付款；SatoshiVault 当前 DC 余额为 0。

主网执行记录：

| 动作 | Proposal | 执行交易 |
| --- | ---: | --- |
| DAO V2 升级并安装 Registry | 7 | `0x7ce0d235e82c946f0974640acc6c41eb4aa23d2628a20e0f5e95f089e92ccb64` |
| 开放 Satoshi/分红四条策略 | 8 | `0xe255f8bd53ba84193f1636bd889eb5747b57c226a9b82a8e8dd2ef32540229d7` |
| 创建首轮 100 DC 分红 | 9 | `0x192878dbfc5005e232d7088d7be868bd18fa629a5d0abdb9d5d34da7778dd953` |

## 3. 生产地址

| 模块 | 前端使用地址 | 说明 |
| --- | --- | --- |
| DealGovernance proxy | `0x9a41a9A85C16F590789C846Fb933fF8C715407F7` | DAO 唯一主入口 |
| DAO V2 implementation | `0xAAB065B8FDB3c09C207273eA53B2E0DF0EafD1e5` | 不直接调用 |
| GovernancePolicyRegistry | `0xBFF01F91291476e671f0F310846D5dDb460e2382` | action 策略查询 |
| ProtocolTreasury | `0x19CC1320DcF7e1396404599209D7c9a844A21b8a` | 协议国库 |
| SatoshiVault proxy | `0xA2C8d5B2E440EbA62a5fd0A55978b39c3dAcFB3e` | 中本聪资金与付款入口 |
| SatoshiVault implementation | `0x16b1Ad109E8D826F17B5542984c4B83643B4Ce48` | 不直接调用 |
| DealDividendVault proxy | `0xc0aE5D371f4605c464493B0d056dA56357cD2850` | 新分红主入口 |
| DealDividendVault implementation | `0xB5D30418AEb0a302847EE5227193082fF36C44A8` | 不直接调用 |
| D | `0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f` | 治理/分红权重代币，18 decimals |
| DealCoin / DC | `0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D` | 提案费、国库与分红资产，18 decimals |
| NftVetoRegistry | `0xd8de3603d341584e0aef843ee8f4c00288179177` | Major NFT 否决读取 |
| CrossChainBroadcaster | `0xa5bbD19f109afB7D2768C4f0f3B691936639BDCf` | ETH DAO 向副链广播治理动作 |

统一地址和 DAO ABI 来源：

```text
deployments/eth-mainnet-1.json
```

前端读取：

```ts
const governanceAddress = deployment.addresses.dealGovernance;
const governanceAbi = deployment.abi.DealGovernance;
const treasuryAddress = deployment.addresses.protocolTreasury;
const treasuryAbi = deployment.abi.ProtocolTreasury;
const satoshiVaultAddress = deployment.addresses.satoshiVault;
const dividendVaultAddress = deployment.addresses.dealDividendVault;
```

## 4. DAO V2 枚举映射

### 4.1 ProposalKind

前端禁止自行改变数字映射：

| 数字 | 名称 | 业务规则 |
| ---: | --- | --- |
| 0 | Parameter | 2.5 D 激活；24 小时后通过，或 70 D fast-pass；可否决 |
| 1 | Treasury | 70 D 通过；没有时间自动通过；不可否决；无创建费 |
| 2 | Major | 2.5 D 激活；120 小时后通过，或 70 D fast-pass；D/NFT 可否决；创建费 1000 DC |
| 3 | Satoshi | 90 D 后永久标记成功；执行前仍可否决；支持者可自由取回 D；无创建费 |

### 4.2 ProposalState

前端必须调用 `state(proposalId)`，不要只根据 `totalStaked` 或时间自行推导。

| 数字 | 名称 | 推荐 UI |
| ---: | --- | --- |
| 0 | Missing | 不存在 |
| 1 | Pending | 待激活 |
| 2 | Active | 进行中 |
| 3 | Succeeded | 已通过，可执行 |
| 4 | Vetoed | 已否决 |
| 5 | Canceled | 已取消/过期 |
| 6 | Executed | 已执行 |

## 5. DAO 页面读取

推荐读取：

```text
proposalCount()
activeProposalCount()
executedProposalCount()
todayProposalCount()
getProposals(offset, limit)
getProposal(proposalId)
getActions(proposalId)
state(proposalId)
stakeOf(proposalId, account)
vetoStakeOf(proposalId, account)
totalVetoStaked(proposalId)
getStakerList(proposalId)
currentStakedOf(account)
```

`getProposal()` 返回字段顺序：

```text
proposer
kind
totalStaked
windowEndsAt
vetoed
canceled
executed
nftRegistered
satoshiSucceeded
activationReturnable
vetoer
actionsHash
description
```

注意：

1. `description` 是提案创建者提供的链上文本，应直接展示并做 XSS 转义。
2. `getActions()` 返回 target/value/calldata，前端应按 ABI 解码展示，不应只显示原始 hex。
3. `getProposals(offset, limit)` 按 proposalId 从小到大返回；最新列表可先读 `proposalCount()` 再计算 offset。
4. 金额全部使用 bigint；D/DC 都按 18 decimals 格式化，禁止使用 JavaScript `number`。

## 6. DAO 用户写操作

### 6.1 创建提案

```solidity
createProposal(
    address[] targets,
    uint256[] values,
    bytes[] calldatas,
    string description,
    ProposalKind kind
) returns (uint256 proposalId)
```

前端预检查：

1. `targets.length > 0`，且三组 action 数组长度相同。
2. Parameter/Satoshi 创建者钱包内至少持有 `activationThreshold()`，当前为 2.5 D。
3. Major 创建前读取 `majorProposalFee()`，当前为 1000 DC；检查 DC balance 和对 Governance 的 allowance，不足时先单独 approve。
4. Treasury/Parameter/Satoshi 创建提案不收 DC 创建费。
5. action 必须通过 Registry；可以先调用 `policyRegistry.isActionAllowed(kind,target,value,data)` 做只读预校验。
6. 合约在创建时与执行时都会重新校验 action；提案创建后策略被关闭，执行仍可能失败。

### 6.2 支持质押

先检查 D 对 Governance 的 allowance，然后：

```solidity
stake(proposalId, amount)
```

不要把 `stake()` 显示成永久消耗。D 只是进入 Governance 托管，之后按规则调用 `unstake()` 或 `claimBack()` 取回。

### 6.3 主动撤回支持

```solidity
unstake(proposalId, amount)
```

前端按种类提示：

- Parameter/Major：只允许在窗口结束前且尚未达到 70 D fast-pass 时撤回。
- Treasury：提案结束前可撤回；撤回可能使总量重新低于 70 D。
- Satoshi：执行前可撤回；达到 90 D 后 `satoshiSucceeded` 不会被撤回动作取消。

### 6.4 提案结束后取回 D

```solidity
claimBack(proposalId)
```

该函数一次取回调用者在该提案中的支持 stake 和 collective veto stake。D 不会自动退回。

Major 激活后 `activationReturnable` 可能允许提前 `claimBack()`；前端应结合 `getProposal()` 和模拟调用决定按钮状态。

### 6.5 否决

有完整 2.5 D 席位：

```solidity
veto(proposalId)
```

不足 2.5 D 可参与集体否决，先 approve D：

```solidity
vetoStake(proposalId, amount)
```

Treasury 不可否决。Satoshi 在执行前始终可否决，即使已经达到 90 D。

### 6.6 执行

```solidity
execute(proposalId) payable
```

任何地址都能执行 `Succeeded` 提案。交易 `msg.value` 必须严格等于该提案所有 action value 之和。普通国库/中本聪/DC 分红 action 的 value 都是 0。

## 7. ProtocolTreasury 前端边界

### 7.1 普通用户页面

普通用户只需要读取：

```text
controller()
bootstrapLocked()
ETH balance
DC.balanceOf(ProtocolTreasury)
其他受支持 token.balanceOf(ProtocolTreasury)
```

当前生产值：

```text
controller = DealGovernance proxy
bootstrapLocked = true
DC balance = 2900 DC（读取区块 25579995）
```

### 7.2 不允许前端钱包直接调用的函数

```text
payNative(...)
payToken(...)
approveToken(...)
approveAndCreateDividendRound(...)
setController(...)
```

这些函数只有 Governance 能调用。前端应把它们编码进对应提案 action，而不是让当前用户直接向 Treasury 发交易。

`execute(address,uint256,bytes)` 当前没有进入 DAO V2 生产白名单，不能当作通用捷径。

## 8. SatoshiVault 前端接入

SatoshiVault 不是“一个人的钱包”，而是 DAO 控制的专用 DC 金库。

### 8.1 页面读取

最小 ABI：

```ts
import { parseAbi } from "viem";

export const satoshiVaultAbi = parseAbi([
  "function dealCoin() view returns (address)",
  "function controller() view returns (address)",
  "function payDC(address to,uint256 amount)",
  "event DealCoinPaid(address indexed to,uint256 amount)",
]);
```

```text
dealCoin()
controller()
DC.balanceOf(SatoshiVault)
DealCoinPaid(to, amount) 事件
```

当前生产值：

```text
dealCoin = DC
controller = DealGovernance proxy
DC balance = 0
```

### 8.2 创建中本聪付款提案

前端构造：

```text
kind        = 3 (Satoshi)
target      = SatoshiVault proxy
value       = 0
calldata    = encodeFunctionData(payDC, [recipient, amount])
description = 明确写出用途、收款地址和金额
```

唯一业务付款函数：

```solidity
payDC(address to, uint256 amount)
```

用户钱包不能直接调用 `payDC()`；它只能在 Satoshi 提案通过后由 Governance 执行。

前端在允许创建提案前应检查：

1. `recipient != address(0)`。
2. `amount > 0`。
3. `DC.balanceOf(SatoshiVault) >= amount`，否则即使提案通过也会执行失败。
4. 创建者钱包内至少有 2.5 D。

## 9. DealDividendVault 前端接入

这是当前 ETH D 持有人 DC 分红的主入口。旧 `VoteDividendClaimer` 保留历史兼容，但新页面和新业务不要继续接旧入口。

### 9.1 最小 ABI

```ts
import { parseAbi } from "viem";

export const dividendVaultAbi = parseAbi([
  "function roundsCount() view returns (uint256)",
  "function getRound(uint256 roundId) view returns ((uint48 snapshot,uint256 total,uint256 claimed,uint256 totalWeight,uint256 claimedWeight))",
  "function previewClaim(uint256 roundId,address account) view returns (uint256 walletBalance,uint256 governanceStaked,uint256 payout)",
  "function claimed(uint256 roundId,address account) view returns (bool)",
  "function reservedUnclaimed() view returns (uint256)",
  "function unallocatedDC() view returns (uint256)",
  "function claim(uint256 roundId)",
  "event RoundCreated(uint256 indexed roundId,uint48 snapshot,uint256 total,uint256 totalWeight)",
  "event Claimed(uint256 indexed roundId,address indexed account,uint256 walletBalance,uint256 governanceStaked,uint256 payout)",
]);
```

### 9.2 轮次列表

1. 调用 `roundsCount()`。
2. roundId 范围为 `0 .. roundsCount - 1`。
3. 对每轮调用 `getRound(roundId)`。

Round 字段：

| 字段 | 含义 |
| --- | --- |
| `snapshot` | D/DAO 质押权重使用的 ETH 历史区块 |
| `total` | 本轮总 DC |
| `claimed` | 已领取 DC |
| `totalWeight` | 本轮总 D 权重，当前固定供应口径为 100 D |
| `claimedWeight` | 已完成领取的 D 权重 |

页面可计算：

```text
剩余 DC = total - claimed
领取进度 = claimed / total
权重进度 = claimedWeight / totalWeight
```

### 9.3 用户预计可领

```solidity
previewClaim(roundId, account)
```

返回：

```text
walletBalance      快照时钱包内 D
governanceStaked   快照时归属于该用户、托管在 Governance 中的 D
payout             当前可领取 DC；已经领取后为 0
```

按钮逻辑建议：

```text
claimed(roundId, account) == true  → “已领取”
payout > 0                         → “领取 X DC”
payout == 0 且未领取               → “本轮无可领取份额”
```

### 9.4 用户领取

```solidity
claim(uint256 roundId)
```

规则：

1. 必须由拥有快照权重的地址自己调用。
2. DC 只能发给 `msg.sender`，不能指定第三方收款地址。
3. 每个地址每轮最多领取一次。
4. 领取不需要 approve D，也不会扣除或锁定 D。
5. 快照之后转走 D 不影响该轮权利；新地址也不会继承旧轮权利。
6. 领取没有到期时间。

viem 示例：

```ts
const preview = await publicClient.readContract({
  address: dividendVaultAddress,
  abi: dividendVaultAbi,
  functionName: "previewClaim",
  args: [roundId, account],
});

if (preview[2] > 0n) {
  const hash = await walletClient.writeContract({
    account,
    address: dividendVaultAddress,
    abi: dividendVaultAbi,
    functionName: "claim",
    args: [roundId],
  });
}
```

### 9.5 首轮生产数据

读取区块：`25579995`

```text
roundId          = 0
snapshot         = 25579735
total            = 100 DC
claimed          = 0 DC
totalWeight      = 100 D
claimedWeight    = 0 D
reservedUnclaimed= 100 DC
unallocatedDC    = 0 DC
```

这些数值会随用户领取变化，前端不得把它们写死，应以链上 getter 为准。

## 10. 创建新分红轮的提案构造

普通用户不能直接调用 `createRound()`。创建轮次通过 Treasury proposal 完成。

推荐两个 action，顺序固定：

```text
Action 1
target   = ProtocolTreasury
value    = 0
calldata = payToken(DC, DealDividendVault, amount)

Action 2
target   = DealDividendVault
value    = 0
calldata = createRound(amount)

kind     = 1 (Treasury)
```

前端构造前检查：

1. `amount > 0`。
2. Treasury 的 DC 余额至少为 amount。
3. 两个 action 的 amount 必须一致。
4. target 必须是上述生产 proxy，不能使用 implementation。
5. Treasury proposal 需要累计 70 D 才能执行，不能被否决。

如果 Vault 已经存在足够 `unallocatedDC()`，可以只创建 Action 2；普通业务默认仍使用两 action 原子流程。

## 11. Registry 预校验

前端的高级提案构造器可以调用：

```solidity
isActionAllowed(uint8 kind, address target, uint256 value, bytes data)
```

返回 false 时禁止提交并提示“该 action 不在当前 DAO 策略白名单”。

当前与本轮模块有关的四条规则：

| Kind | Target | Selector |
| --- | --- | --- |
| Satoshi | SatoshiVault proxy | `payDC(address,uint256)` |
| Treasury | DealDividendVault proxy | `createRound(uint256)` |
| Major | SatoshiVault proxy | `upgradeToAndCall(address,bytes)` |
| Major | DealDividendVault proxy | `upgradeToAndCall(address,bytes)` |

Treasury 的 `payToken` 原本已在 48 条基础规则中，因此 proposal 9 可以组合“国库付款 + 创建轮次”。

## 12. 事件订阅

DAO：

```text
ProposalCreated
ProposalActivated
SatoshiSucceeded
Staked
Unstaked
StakeClaimed
ProposalVetoed
VetoStaked
VetoStakeClaimed
ProposalCanceled
ProposalExecuted
PolicyRegistryUpdated
```

Treasury：

```text
NativeReceived
NativePaid
TokenPaid
TokenApproved
ControllerUpdated
BootstrapLocked
```

SatoshiVault：

```text
DealCoinPaid
```

DealDividendVault：

```text
RoundCreated
Claimed
```

事件用于增量刷新和历史展示，最终状态仍以 getter 为准。

## 13. 前端迁移检查表

- [ ] DAO 地址仍使用 `0x9a41...07F7` proxy，但 ABI 更新为当前 DealGovernance V2。
- [ ] ProposalKind 增加并正确显示 Satoshi `3`。
- [ ] ProposalState 按 `0..6` 映射，状态以 `state()` 为准。
- [ ] 提案详情同时展示 description 和解码后的 actions。
- [ ] stake/vetoStake 前检查 D allowance。
- [ ] Major 创建前检查 1000 DC fee 和 allowance。
- [ ] 结束后提供 `claimBack()`，不要显示“D 自动退回”。
- [ ] 国库页面只读余额；付款通过提案构造，不直接调用 Treasury。
- [ ] Satoshi 页面构造 `payDC` action，不直接调用 Vault。
- [ ] 新分红页面使用 DealDividendVault，不再使用 VoteDividendClaimer。
- [ ] 分红列表实现 `roundsCount/getRound`。
- [ ] 用户卡片实现 `previewClaim/claimed/claim`。
- [ ] 所有 D/DC 数值使用 bigint + 18 decimals。
- [ ] implementation 地址不出现在可调用入口中。
- [ ] BSC 暂无 D、SatoshiVault 和本地分红 Vault，不要展示为已经支持跨链领取。

## 14. 安全与产品提示

1. 前端绝不能要求用户上传私钥、助记词、交易所密码或验证码。
2. `claim()` 必须由有快照权重的地址签名；交易所托管地址通常无法自行调用。
3. 先 `simulateContract`，成功后再展示确认交易按钮。
4. 对自定义 revert 显示业务提示，保留原始错误供开发排查。
5. 所有写操作等待 receipt `status == success` 后再刷新链上状态。
6. 不要仅凭交易成功提示业务成功；重新读取 proposal state、round 或余额确认结果。
7. ETH 当前逻辑只支持 ETH 本链分红。副链本地分红需要另行开发 ETH 快照证明/远端分红模块。

## 15. 验收标准

前端交付至少完成以下端到端测试：

1. 能列出 proposal 7、8、9，并正确显示为 Executed。
2. 能解码 proposal 9 的 `ProtocolTreasury.payToken` 和 `DealDividendVault.createRound` 两个 action。
3. 能显示 Treasury 当前 DC 余额。
4. 能显示 SatoshiVault controller、DC 余额和空付款历史。
5. 能显示 round 0 的链上动态数据。
6. 对任意钱包调用 `previewClaim(0, account)` 并正确格式化三项返回值。
7. 有可领份额的钱包可以调用 `claim(0)`；领取后按钮变为“已领取”，payout 变为 0。
8. 不具备权限的钱包不会看到直接调用 Treasury/Satoshi `pay` 的按钮。
