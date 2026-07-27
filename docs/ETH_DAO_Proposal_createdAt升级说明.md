# ETH DAO Proposal createdAt 升级说明

更新时间：2026-07-27

## 1. 结论

可以小改动解决，但不能只改辅助 Reader。

原因是 EVM 合约在 `eth_call` 中不能读取历史 event，也不能查询任意历史区块的时间戳。
现网 DAO 只在 `ProposalCreated` 事件中记录创建时间，Reader 无法把该事件直接转换成
链上返回值。

本次采用的最小可靠方案：

1. 在 `DealGovernance.Proposal` 尾部追加 `uint48 createdAt`；
2. `createProposal()` 创建时自动写入 `block.timestamp`；
3. DAO 增加只读 `proposalCreatedAt(proposalId)`；
4. Reader V2 的 `ProposalView` 增加 `createdAt`；
5. 升级前的历史提案通过受 DAO 治理限制的批量函数一次回填；
6. Reader V2 构造时固化已核验的历史时间，覆盖“升级提案自身无法预知创建区块时间”的边界。

完成升级后，前端调用一次 `getProposalPage()` 或 `getProposalDetail()` 就同时得到提案和
创建时间，不需要扫描 `ProposalCreated` 日志。

## 2. 合约接口

DAO 新增：

```solidity
function proposalCreatedAt(uint256 proposalId) external view returns (uint48);

function backfillProposalCreatedAt(
    uint256 firstProposalId,
    uint48[] calldata createdAts
) external onlyGovernance;
```

`backfillProposalCreatedAt` 的限制：

- 只能由 DAO proxy 自身调用；
- 只能写入已经存在的 proposalId；
- 时间必须非零且不能晚于当前区块；
- 必须按 proposalId 非递减；
- 已经非零的 `createdAt` 永远不能覆盖。

生产升级建议把回填编码进同一个：

```solidity
upgradeToAndCall(
    newImplementation,
    abi.encodeCall(
        DealGovernance.backfillProposalCreatedAt,
        (1, historicalCreatedAts)
    )
)
```

这样 implementation 切换和历史时间写入在同一笔治理执行交易中原子完成。

Reader V2 的 `ProposalView` 新增：

```text
createdAt: uint48
```

Reader V2 构造参数：

```solidity
constructor(
    address governance,
    uint256[] historicalProposalIds,
    uint48[] historicalCreatedAts
)
```

构造历史只允许 proposalId 严格递增、时间非零且不晚于部署区块，部署后没有任何修改入口。
Reader 优先返回 DAO storage 的 `createdAt`；DAO 返回 `0` 时才使用构造历史。

## 3. 兼容性

- `createdAt` 追加在 Proposal storage 的相对 slot 6；现有 13 个 Proposal 字段的
  slot、offset 和类型均未改变。
- DAO 顶层 29 个 V1 字段和 V2 的 `policyRegistry` slot 29 均未改变。
- 新字段追加在 ABI tuple 尾部；旧 Reader 对 `getProposal()` 的解码仍可正常工作。
- Reader V2 使用旧 Proposal ABI 前缀读取，并对 `proposalCreatedAt()` 做兼容
  `staticcall`：
  - 升级前调用旧 DAO：Reader 正常返回构造历史；未提供历史的 proposalId 返回 `0`；
  - 升级并回填后：同一接口返回真实时间。

因此 Reader V2 在 DAO 升级前也不会报错。为覆盖升级提案自身，生产应在该提案创建后
部署 Reader V2；前端仍应在升级完成后再正式切换地址和 ABI。

生产推荐顺序是：

1. 只读核验当时全部 `ProposalCreated`；
2. 部署新 DAO implementation；
3. 创建 Major 升级提案，升级 calldata 回填创建该提案之前的全部历史；
4. 从该 Major 提案的 `ProposalCreated` 读取其精确时间；
5. 部署 Reader V2，构造历史包含该 Major 提案；
6. 提案通过并执行后切换前端 Reader 地址和 ABI。

升级提案本身由旧 implementation 创建，无法在自己的 calldata 中预知未来区块时间。
Reader 的不可变历史兜底解决这一项，不需要为了一个展示字段再创建第二个治理提案。

## 4. Gas 与安全影响

- 每次新建提案增加一次 `uint48` storage 写入，主要增加约一个新 storage slot 的写入成本；
- Reader 仍然只有 view 函数，没有 owner、升级权、资产和治理权限；
- Reader 的历史时间只在 constructor 中写入，部署后不能修改；
- `createdAt` 只用于展示，不参与质押、通过、否决、执行或退款判断；
- 历史回填不能修改任何提案状态和资金；
- 精确历史时间必须从主网 `ProposalCreated` 日志生成，并在 fork 中逐条对照后才能进入
  升级 calldata。

## 5. 已完成验证

- `DealGovernance` 存储布局检查通过；
- Reader 单元测试 10 项通过；
- DAO/Reader/国库模块/跨链策略相关回归测试 69 项通过；
- 合约尺寸检查通过，`DealGovernance` runtime 为 `17406 bytes`，低于 EIP-170 上限；
- 验证了新提案自动写入并由 Reader 一次返回；
- 验证了历史回填、重复覆盖拒绝、非法范围和未来时间拒绝；
- 验证了旧 `getProposal` ABI 在增加尾字段后仍可读取；
- ETH mainnet fork 对现网 DAO/提案 13 对照通过；空历史 Reader V2 在升级前返回
  `createdAt = 0` 且其他字段、actions 和状态不变；
- 完整 ETH mainnet fork 升级通过：17 个历史 Proposal、actions、state、全部 staker
  支持/否决仓位、治理参数、policyRegistry 和 Treasury controller 升级前后逐项一致；
- fork 中验证现网 Reader V1 升级后仍可读取，Reader V2 升级前后均可一次返回全部时间；
- fork 中验证升级提案使用 Reader 不可变历史时间，升级后的新提案由 DAO 自动写入时间；
- 重复历史回填在 fork 中按预期回滚。
- Slither 对 Governance/Reader 定向扫描未发现本次新增的权限绕过、可重入写入或任意资产
  转移路径；报告的时间戳校验、兼容 `staticcall` 和分页循环均是本方案预期行为，其他告警
  属于既有治理实现或提示类规则。

## 6. 主网当前进度

- 新 DAO implementation 已单独部署：
  `0x23Bc252571BC446FDbbf466E5C35C38cc6F6e8A5`；
- 部署交易：
  `0x8fcebfdfbfcc75b7d72d6f83e613bf006b1d7dae1ebbdf8c29c82ca51e3929f7`，
  receipt 为 success；
- 已核验创建交易字节码与本地 artifact 完全一致；runtime 在填入 OpenZeppelin UUPS
  immutable 部署地址后与链上逐字节一致；
- Major 升级提案 `#18` 已执行：
  - 标题：`DAO提案创建时间升级`；
  - 唯一 action：DAO proxy 对新 implementation 执行 `upgradeToAndCall`，并原子回填
    提案 `1..17`；
  - 状态：`Executed (6)`；
  - 执行交易：
    `0x9682fe9201b5f55943a6259696b78bd0ea7eff6be5482bdfb990c7993eeec93d`；
  - 执行区块：`25622586`；
  - DAO proxy 当前 implementation：
    `0x23Bc252571BC446FDbbf466E5C35C38cc6F6e8A5`；
  - 提案 `1..17` 的 `createdAt` 已写入 DAO storage 并逐条核验；
  - 提案 `#18` 的精确事件时间为 `1785128315`，将由 Reader V2 构造历史兜底；
- 三笔创建交易均已独立只读复核：
  - mint 1000 DC：
    `0x6c9dad3b96223923a7eb42d63e4f26274d74349f93e3e37821ba97d3cab31a53`；
  - approve 1000 DC：
    `0xe033bb0db7ded4fb2197d997372dc76304bcb9959b14a6132387876a4fbd3c80`；
  - create proposal：
    `0xe7329f90ca5f2bcd5627b2d5c544c3b270bc4a6b4067c5a27d4f93e4b5da0827`；
- Reader V2 已部署：
  `0xc7Df737304d57595C0a0e690F2AE3400B7225CE6`；
- Reader V2 部署交易：
  `0x63023a36bd6dbcf983413cd763297d45b7b33ba4a23aeaab98039cfb6aebffad`；
- Reader V2 部署区块：`25622898`；
- Reader V2 runtime code hash：
  `0x27ace99bc2793f88befef69d8d3a7978716a54f1fe87d0c4402eb6ef5f7445e1`；
- Reader V2 的 `governance()`、页大小限制、提案总数和提案 `1..18` 的 `createdAt`
  已独立逐条复核；其中提案 `18` 的 DAO storage 按设计为 `0`，Reader 返回不可变历史值
  `1785128315`；
- 未提交或推送 Git。

只读历史快照：

`deployments/dao-created-at/eth-mainnet-proposal-created-at-20260727.json`

implementation 部署及独立复核记录：

`deployments/dao-created-at/eth-mainnet-implementation-20260727.json`

提案创建与独立复核记录：

```text
deployments/dao-created-at/eth-mainnet-created-at-proposal.json
deployments/dao-created-at/eth-mainnet-created-at-proposal-verification.json
```

执行与 Reader V2 部署复核记录：

```text
deployments/dao-created-at/eth-mainnet-created-at-execution-verification-20260727.json
deployments/dao-created-at/eth-mainnet-governance-reader-v2-20260727.json
```

当前 createdAt 的 DAO 升级、历史回填、Reader V2 部署、固定历史区块 fork 和主网逐条
只读验证均已完成。Reader V2 是无 owner、无写入口、无资产权限的前端读取层。
