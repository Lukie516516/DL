# Deal 库拆分后的部署接线说明

本文记录 **Deal 手续费 / 奖励 / 商品 NFT 逻辑外提到库** 之后，链上部署与运维需要如何 **接线（library linking）**、部署清单要记哪些地址，以及与旧版部署的差异。

适用对象：合约部署、升级、前端/后端切地址、运维审计。

相关合约：

- `[Deal.sol](../contracts/Deal.sol)`
- `[DealOpenTokenToken.sol](../contracts/DealOpenTokenToken.sol)`
- `[DealLib.sol](../contracts/utils/DealLib.sol)`（手续费、奖励、报价等共用逻辑）
- `[DealAssetNftLib.sol](../contracts/utils/DealAssetNftLib.sol)`（**仅 Deal** 使用的商品 NFT 拉取/结算/校验）
- `[DealErrors.sol](../contracts/utils/DealErrors.sol)`（统一 `DealError(uint16)`）

---

## 0. 本次改动上线：要不要重部署？（一览）

下面针对 **采用本分支代码、要让新逻辑在链上生效** 的情况；**已存在的 Deal 克隆实例**不会自动变，见 §4.3。


| 链上对象                           | 是否必须重新部署 / 换新地址         | 说明                                                                                                                                                            |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**DealLib`**                  | **是**（随本次发版一般为新部署地址）    | 手续费/奖励等对外的库函数签名已改为 **tuple 参数**；旧实现去调新库会 **selector 对不上**。若你 **完全不换** `DealLib` 地址且链上仍是旧字节码，则下面新实现也不应单独上线。                                                    |
| `**DealAssetNftLib`**          | **是**（至少部署一次）           | 新库；旧环境没有该合约则 **必须部署**。`Deal` 实现必须链接它。                                                                                                                         |
| `**Deal` 实现合约**                | **是**                   | 本体字节码与 **双库链接** 均与旧版不同；必须用本次编译产物 + `DealLib` + `DealAssetNftLib` 部署新实现。                                                                                       |
| `**DealOpenTokenToken` 实现**    | **是**（与新版 `DealLib` 配套） | 源码里对 `DealLib.processDealFees` / `computeDealRewards` 的调用已改为 **struct**；须用 **与当前 `DealLib` 同一次编译/同一套 ABI** 重新部署 OpenTT 实现。**旧 OpenTT 实现 + 新 `DealLib` 不可混用。** |
| `**DealFactory`（工厂本体）**        | **通常不必**                | 多数流程只需 `**setDealImplementation`**、`**setDealOpenTokenTokenImplementation**` 指到 **新实现地址**；只有当你要换新工厂治理/配置策略时才部署新工厂。                                            |
| **已创建的 Deal / OpenTT 克隆**      | **不必**（不能靠重部署克隆升级）      | 克隆逻辑在 **当时的实现地址**；升级 = 工厂改 **实现指针**，之后 **新创建的**实例才用新代码。                                                                                                       |
| **Pair、Router、OrderBook、DL 等** | **不必**（与本次库拆分无直接关系）     | 除非你们另有升级计划。                                                                                                                                                   |


**最小可执行组合（在同一发版内对齐）：**

1. 部署（或确认）与 artifact 一致的 `**DealLib`**、`**DealAssetNftLib**`。
2. 部署链接好两库的 `**Deal` 实现**。
3. 部署只链 `**DealLib`** 的 `**DealOpenTokenToken` 实现**（须与步骤 1 的 `DealLib` 同源构建）。
4. 在所用 `**DealFactory`** 上更新 **Deal / OpenTT 实现指针**（及你们惯例下的 `dealMessageHub` 等全局配置，若有）。

---

## 1. 和旧版部署的核心区别（接线层面）


| 项目                          | 旧版（典型）              | 当前版本                                                                           |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `**Deal` 实现合约**             | 链接 `**DealLib`** 即可 | 必须同时链接 `**DealLib` + `DealAssetNftLib**`                                       |
| `**DealOpenTokenToken` 实现** | 链接 `**DealLib`**    | **仍为仅 `DealLib`**（不链接 `DealAssetNftLib`）                                       |
| **链上多出来的部署单元**              | —                   | 多一个已部署的 `**DealAssetNftLib` 地址**（与 `DealLib` 并列）                               |
| `**Deal` 对外 ABI**           | 不变                  | **不变**（用户仍只与 `Deal` / 工厂 / 克隆交互）                                               |
| **直接调用 `DealLib` 的低级集成**    | 若存在                 | `**processDealFees` / `computeDealRewards` 的函数选择器已变**（参数改为 ABI tuple，见下文第 6 节） |


业务规则在测试覆盖范围内与重构前对齐；**部署错误（少链一个库、库地址与实现不匹配）会导致创建或运行失败**，不属于“逻辑变更”。

---

## 2. 部署顺序建议

1. 部署 `**DealLib`**（若本次升级改动了库代码，通常为新地址；否则可复用已有地址，见第 4 节）。
2. 部署 `**DealAssetNftLib**`（**Deal 路径新增**；OpenTT 不需要部署给 OpenTT 用，但可与 Deal 共用同一部署地址）。
3. 编译并部署 `**Deal` 实现**，在 Hardhat / Foundry 中显式传入：
  ```text
   libraries: {
     DealLib: <DealLib 地址>,
     DealAssetNftLib: <DealAssetNftLib 地址>,
   }
  ```
4. 部署 `**DealOpenTokenToken` 实现**（仅）：
  ```text
   libraries: {
     DealLib: <DealLib 地址>,
   }
  ```
5. 配置 `**DealFactory**`：`dealImplementation`、`setDealOpenTokenTokenImplementation` 等按你们现有流程指向 **新实现地址**。

---

## 3. 部署清单（JSON / 运维台账）建议字段

在 `deployments/*.json` 或内部地址表中，建议在原有 `dealLib`、`dealImplementation` 旁 **固定增加**：


| 字段名（建议）                            | 含义                                  |
| ---------------------------------- | ----------------------------------- |
| `dealLib`                          | `DealLib` 部署地址                      |
| `**dealAssetNftLib`**              | `**DealAssetNftLib` 部署地址（新增，务必记录）** |
| `dealImplementation`               | 已正确链接上述两库的 `Deal` 实现                |
| `dealOpenTokenTokenImplementation` | 仅链接 `DealLib` 的 OpenTT 实现           |


升级 `**Deal` 实现** 时：**两个库地址必须与编译该实现时使用的链接一致**；只换实现、不换库或链错库，会出现未解析占位符或运行时错误。

---

## 4. 升级场景对照

### 4.1 全量重新部署（新库 + 新实现 + 新工厂）

- 部署新 `DealLib`、新 `DealAssetNftLib`，再部署链接两者的 `Deal` 实现。
- 与旧版差别：**多一步 `DealAssetNftLib` + `Deal` 多一个 library 槽位**。

### 4.2 仅升级 `Deal` 实现、复用已有 `DealLib`

- 若 `**DealLib` 字节码与链上地址一致**（未重新编译或未改库），可继续用原 `dealLib`。
- **仍须部署或复用一个与当前 `Deal` 编译匹配的 `DealAssetNftLib`**，并在部署 `Deal` 时链接：
  - `DealLib: 已有地址`
  - `DealAssetNftLib: 新部署或已有地址（须与本次 Deal  artifact 匹配）`

参考仓库脚本：`[scripts/deploy-deal-impl-fix.ts](../scripts/deploy-deal-impl-fix.ts)`（复用 `dealLib`、新部署 `DealAssetNftLib`、再部署 `Deal`）。

### 4.3 已上链的旧 Deal 克隆

- 已创建实例绑定的是 **当时的 `dealImplementation`**；**不会**因你本地改代码自动升级。
- 只有工厂将 `**dealImplementation` 指到新实现**（或用户与新工厂交互）后，**新创建的 Deal** 才用新接线；旧实例行为取决于当时实现，与本次文档所述“新接线”无关。

---

## 5. 仓库内脚本与测试的对齐情况（便于自查）

下列脚本 **已按「Deal 双库链接」** 更新，可作为接线参考：

- `[scripts/deploy-agiking.ts](../scripts/deploy-agiking.ts)`
- `[scripts/deploy-upgrade.ts](../scripts/deploy-upgrade.ts)`
- `[scripts/deploy-deal-impl-fix.ts](../scripts/deploy-deal-impl-fix.ts)`

Hardhat 集成测试中的 `Deal` 部署均已增加 `DealAssetNftLib`（例如 `test/DealRules.ts`、`test/DomainFlows.ts` 等）。

**仍使用「单占位符替换整段 bytecode」的旧脚本**（假设只有一个 library）**与当前 `Deal` 字节码不兼容**，在升级前需改为 `**viem.deployContract("Deal", [], { libraries: { DealLib, DealAssetNftLib } })`** 或等价的多占位符正确替换。例如：

- `[scripts/deploy-agiking-full-upgrade.ts](../scripts/deploy-agiking-full-upgrade.ts)` 中 Deal 部署段仍为单库替换逻辑，**若继续使用须先按双库方式改写**。

---

## 6. 直接调用 `DealLib` 的集成方（低级 `call` / 自定义索引）

以下函数在 `**DealLib` 合约**上的 **Solidity/ABI 签名**已改为 **带结构体（tuple）参数**（与 `Deal` 内部调用一致），**函数选择器与「扁平多参数」旧版不同**：

- `processDealFees(DealLib.ProcessDealFeesParams calldata)`
- `computeDealRewards(DealLib.ComputeDealRewardsParams calldata)`

**通过 `Deal` / `DealOpenTokenToken` 的公开方法间接执行时，无需修改。**  
仅当存在 **对 `DealLib` 合约地址的直接 `call`** 时，必须改用新 ABI（或改为调用 `Deal`）。

---

## 7. 体积与 EIP-170（提醒）

- `Deal` 实现仍受 **24 KB runtime** 限制；逻辑外提后 `**Deal` 本身体积缩小**，但 `**DealLib` / `DealAssetNftLib` 为独立部署**，总代码量分散到多个地址。
- 当前 `forge build --sizes` 下 `Deal` 仍留有 **约 2 KB 级** EIP-170 余量（以本仓库编译配置为准）；后续继续在 `Deal` 内堆逻辑时仍需警惕顶格。

---

## 8. 部署后自检清单

- `Deal` 部署交易 / artifact 中 **无未解析的 `__$...$__` library 占位符**。
- 台账中同时存在 `**dealLib` 与 `dealAssetNftLib`**，且与部署 `Deal` 时传入的一致。
- `DealOpenTokenToken` 实现 **仅** 链接 `DealLib`，未错误链接 `DealAssetNftLib`（链了通常也不会被 OpenTT 用到，但应以编译配置为准）。
- 工厂 `dealImplementation` / OpenTT 实现指针已指向 **本次**构建出的地址。
- 若有链下脚本直接调 `DealLib`，已切换到 **tuple 参数** ABI。

---

## 9. 文档修订记录


| 日期         | 说明                                                                |
| ---------- | ----------------------------------------------------------------- |
| 2026-04-22 | 初版：Deal 双库链接、`DealAssetNftLib` 台账、`DealLib` 直接调用 ABI 变更说明、过时脚本警示。 |
| 2026-04-22 | 增补 §0：明确本次上线须重部署的合约、工厂/克隆是否动、以及 OpenTT 须与新版 `DealLib` 配套。         |


