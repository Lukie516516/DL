# 域名相关前端调用文档

这份文档是给前端 / 测试同学用的。

目标：
- 说明每个域名相关合约是干什么的
- 说明常用方法要传什么参数
- 说明参数格式
- 说明哪些地方容易传错
- 说明大厅模式下哪些单子不能直接点 `join`

适用网络：
- `agiking`
- `chainId = 31415926`
- `rpc = https://rpc.agikingrpc.shop`

---

## 1. 当前测试网地址

来源：
- `deployments/agiking-31415926.json`

**仅重新部署域名入口 / 排行榜版本并写回地址**

1. 使用 **在 Agiking 上有原生 gas**、且具备核心合约管理权限的部署私钥。
2. 配置 Hardhat 变量（PowerShell 示例）：

```powershell
$env:AGIKING_RPC_URL="https://rpc.agikingrpc.shop"
$env:AGIKING_PRIVATE_KEY="0x..."   # 勿提交到仓库
npm run deploy:agiking:domain-open-access
```

不要为域名排行榜小改动使用 `deploy:agiking:deal-upgrade`；那个是全量 Deal 升级脚本，会重新部署 Deal 模板、Factory、Reader 等核心合约。

3. 成功后脚本会 **覆盖写入** `deployments/agiking-31415926.json`（合并新地址与 ABI），并生成新的 `deployments/frontend-handoff-domain-open-access-*.md`。

当前域名相关地址：

- `DL / DC`: `0xf9606500fbbea6d220bb65fc5cea9641c6e436d3`
- `DCDomain`: `0xea6d563afe03142e8b9a0996b7f03c35b8ed45a3`
- `DCDomainRank`: `0x0beca59bc7f8bf68488fd7f4e3f16aabd8dbadee`
- `DCDomainMarket`: `0x10f393c7e7544c29eb6a768de4b1bb5e8a507fdd`
- `DCDomainSwap`: `0x39e77dd312f5dbc2b18396937a4e97163247497d`
- `DCDomainHall`: `0xf6d8d7bebc381674d4a72a5d1ae0a1971422eeef`
- `DealFactory`: `0xf698c84a771fb740743ba71baa5ae143b9a85c0c`
- `DealReader`: `0xd7b981136821259445360f3234e2b1307f6b811d`

---

## 2. 重要概念

### 2.1 `domainName` 和 `title` 不是一回事

- `domainName`：链上真实域名，用于合约调用
- `title`：合同标题 / 展示标题，只用于展示

不要把 `title` 当成 `domainName` 传给：
- `createHallDealTemplate23`
- `createTteHallDeal`
- `createDeal`

例如：

- 正确的 `domainName`：`hall11`
- 错误的 `domainName`：`Make Friend`

### 2.2 域名格式

`domainName` 当前要求：
- 长度固定 `6`
- 只能字母和数字

例如：
- `abc123`
- `hall11`
- `rank22`

### 2.3 金额格式

所有代币金额都按 `uint256` 最小单位传：
- `1 DL = 1e18`
- `500 DL = 500000000000000000000`

前端一般按：
- `parseUnits(value, 18)`

### 2.4 当前域名相关支付币种

- 一级注册域名：`DL`
- 二级市场购买域名 NFT：`DL`
- 域名排行榜充值：`DL`

---

## 3. 合约分工

### 3.1 `DCDomain`

作用：
- 一级注册域名 NFT
- 设置主域名
- 设置解析地址
- 设置域名描述
- 设置域名背景图
- 查询域名 / tokenId / tokenURI

### 3.2 `DCDomainMarket`

作用：
- 域名 NFT 二级市场
- 公开挂单
- 点对点挂单
- 购买后自动转移 NFT
- 自动同步 `resolve`

### 3.3 `DCDomainRank`

作用：
- 域名有效用户判断
- 黑名单（含 `blacklistedAddresses` 列表查询，见 §6.11）
- 域名内交易排行榜
- 域名总榜
- 对某笔交易做 DL 充值并按小时消耗

### 3.3.1 `DCDomainRankReader`

作用：
- 域名排行榜只读辅助合约
- 域名内交易排行榜分页查询
- 按 deal 地址精确查询历史/终局 deal 详情
- 不持有资金，不改状态；用于避免 `DCDomainRank` 本体继续变重

### 3.3.2 `DCDomainListReader`

作用：
- 域名列表分页查询
- 默认按域名累计成交额 `tradeVolume` 从高到低排序
- 按域名名称、域名 ID、解析地址精确查询
- 按创建者钱包地址查询“我创建的域名”
- 不持有资金，不改状态；只读辅助合约

### 3.4 `DCDomainHall`

作用：
- 大厅模式创建域名合同
- 发大厅消息
- 发某笔 deal 专属消息
- 选人
- 选人后开通加入权限

### 3.5 `DCDomainSwap`

作用：
- 非大厅模式下，直接在域名下创建 TokenToToken 合同
- 可以公开发单，也可以指定买家

---

## 4. `DCDomain` 常用方法

### 4.1 `getPrice(domainName)`

作用：
- 查询一级注册价格

参数：
- `domainName: string`

当前规则：
- 所有域名统一 `500 DL`

返回：
- `uint256`

示例：

```ts
const price = await dcDomain.getPrice("abc123");
```

### 4.2 `register(domainName)`

作用：
- 购买一级域名

前置条件：
- 先对 `DCDomain` 合约 `approve(500 DL)`

参数：
- `domainName: string`

参数格式：
- 固定 6 位
- 字母数字

示例：

```ts
await dl.approve(dcDomainAddress, price);
await dcDomain.register("abc123");
```

### 4.3 `setPrimaryDomain(domainName)`

作用：
- 设置自己的主域名

参数：
- `domainName: string`

### 4.4 `setResolve(domainName, target)`

作用：
- 修改域名解析地址

参数：
- `domainName: string`
- `target: address`

### 4.5 `setDomainDescriptionFor(domainName, desc)`

作用：
- 修改域名描述

参数：
- `domainName: string`
- `desc: string`

注意：
- 描述是链上存储
- 不要传会破坏 JSON 的特殊字符

### 4.6 `setDomainBackgroundUriFor(domainName, uri)`

作用：
- 修改域名背景图 URI

参数：
- `domainName: string`
- `uri: string`

推荐格式：
- `ipfs://...`
- `https://...`
- `ar://...`

### 4.7 查询类方法

常用：
- `domainOf(tokenId)`
- `isRegistered(domainName)`
- `tokenIdOf(domainName)`
- `totalDomains()`
- `resolve(domainName)`
- `creatorOf(tokenId)`
- `createdDomainCount(creator)`
- `createdDomainTokenAt(creator, index)`
- `createdDomainTokens(creator, offset, limit)`
- `domainDescription(tokenId)`
- `domainBackgroundUri(tokenId)`
- `tokenURI(tokenId)`

### 4.8 域名列表 / 搜索：`DCDomainListReader`

前端域名列表不要再自己从 `tokenId = 1..totalDomains` 全量拉取后排序。使用新的只读合约：

| 需求 | 方法 |
| --- | --- |
| 默认域名列表，按累计成交额排序 | `getDomainsByVolume(offset, limit)` |
| 按域名名称精确搜索 | `getDomainByName(domainName)` |
| 按域名 ID 精确搜索 | `getDomainById(tokenId)` |
| 按解析地址查询 | `getDomainsByResolve(resolved, offset, limit)` |
| 我的创建域名列表 | `getDomainsByCreator(creator, offset, limit)` |

单次 `limit` 范围是 `1..50`。

返回结构：

```solidity
struct DomainEntry {
    string domainName;      // 不含 @DC，例如 "abc123"
    uint256 tokenId;        // 域名 NFT ID
    address owner;          // 当前 NFT 持有人
    address creator;        // 首次注册创建者
    address resolved;       // 当前解析地址
    uint256 tradeVolume;    // 域名累计成交额，按创建 deal 时传入金额累计
    uint256 dealCount;      // 域名下创建过的 deal 数量
}
```

说明：
- `tradeVolume` 当前由 `DCDomainSwap` / `DCDomainHall` 在创建域名 deal 时上报。
- 普通币币域名 deal 记为 `aSwapAmount + bSwapAmount`。
- 大厅模板 2/3 记为 `aSwapAmount + aMarginAmount + bSwapAmount + bMarginAmount`。
- 这里是链上名义数量累计，默认按 18 位 token 金额处理；如果未来接入不同精度/不同价值币种，需要再接价格换算层。

---

## 5. `DCDomainMarket` 常用方法

### 5.1 `list(tokenId, price)`

作用：
- 公开挂单卖域名

前置条件：
- 必须先 `approve(tokenId)` 给 `DCDomainMarket`

参数：
- `tokenId: uint256`
- `price: uint256`

当前支付币种：
- `DL`

### 5.2 `listP2P(tokenId, price, buyer)`

作用：
- 点对点挂单，只允许指定买家购买

参数：
- `tokenId: uint256`
- `price: uint256`
- `buyer: address`

### 5.3 `updateListing(tokenId, newPrice)`

作用：
- 修改挂单价格

参数：
- `tokenId: uint256`
- `newPrice: uint256`

### 5.4 `delist(tokenId)`

作用：
- 取消挂单

参数：
- `tokenId: uint256`

### 5.5 `buy(tokenId)`

作用：
- 买断域名 NFT

前置条件：
- 买家先对 `DCDomainMarket` `approve(price)` 的 `DL`

参数：
- `tokenId: uint256`

当前费用规则：
- 成交手续费 `feeBps = 100`
- 即 `1%`

成交后：
- NFT 转给买家
- 卖家收到 `99%`
- `feeRecipient` 收到 `1%`
- 域名 `resolve` 自动改成买家地址

### 5.6 查询类方法

常用：
- `activeListingCount()`
- `activeTokenIdAt(index)`
- `activeTokenIds(offset, limit)`
- `getActiveListings(offset, limit)`
- `getPublicListings(offset, limit)`
- `getP2PListingsForBuyer(buyer)`
- `listings(tokenId)`

---

## 6. `DCDomainRank` 常用方法

### 6.1 `enterDomain(domainName)` / `leaveVisitor(domainName)`

作用：
- 旧前端兼容入口。
- 新逻辑不再区分 visitor / merchant，调用它们不会影响创建、留言、选人、充值等业务权限。

参数：
- `domainName: string`

注意：
- 如果域名不存在会 revert：
  - `DCDomainRank: domain not registered`
- 这里一定要传真实 `domainName`
- 不要传标题 / 页面标题

### 6.2 `isVisitorActive(domainName, user)`

作用：
- 旧前端兼容查询。
- 新逻辑固定返回 `false`，前端不要再用它判断用户是否能参与大厅。

参数：
- `domainName: string`
- `user: address`

返回：
- `bool`

注意：
- 现在是否能参与域名大厅，按 `isActive(domainName, user)` 或 `isBlacklisted(domainName, user)` 判断。
- 如果前端想做“先判断再 enter”，最好先额外调用 `dcDomain.isRegistered(domainName)`

### 6.3 `isActive(domainName, user)` / `isBlacklisted(domainName, user)`

作用：
- `isActive`：域名存在且用户未被拉黑。
- `isBlacklisted`：查询用户是否被该域名拉黑。

说明：
- 新大厅逻辑只看这个有效用户状态，不再看 visitor / merchant。

### 6.4 域名广告费策略（域名 NFT 持有人）

作用：
- 控制该域名下排行榜「广告费 / 时间扣费」是否开启及扣法

方法：
- `setDomainAdFeePolicy(domainName, mode, proportionalBpsPerHour, fixedHourlyRateWei)`：仅域名 NFT 持有人可调用
- `getDomainAdFeePolicy(domainName)`：读当前策略，返回 `(mode, proportionalBpsPerHour, fixedHourlyRateWei)`

`mode`（`uint8`）：
- `0` = **None（默认）**：不收取广告费，**禁止** `deposit`（会 `DCDomainRank: ad fees disabled`），前端可不展示充值入口
- `1` = **等比（Proportional）**：按「计费整点小时」对**当前余额**复利扣 `proportionalBpsPerHour`（万分比 / 小时），须 `1..9999`，余额理论上可无限趋近 0 但单小时不会 100% 扣光
- `2` = **等差（Fixed）**：按固定 `fixedHourlyRateWei`（DL，wei）× 经过时间折算扣费（与旧版线性逻辑一致），余额可被扣至 0

注意：
- 新注册域名默认 `mode = 0`，持有人必须先设策略，创建者才能 `deposit`

### 6.5 `deposit(domainName, deal, amount)`

作用：
- 给某笔 deal 的排行榜充值

参数：
- `domainName: string`
- `deal: address`
- `amount: uint256`

当前充值币种：
- `DL`

注意：
- 这不是合同保证金
- 这是排行榜充值
- 目前仍有最小充值门槛 `minDeposit`
- 若域名 `mode = 0`，会 revert：`DCDomainRank: ad fees disabled`
- 已完成 / 已取消 / 已废弃的终局 deal 不能继续充值，会 revert：`DCDomainRank: deal closed`

### 6.6 `withdraw(domainName, deal)`

作用：
- 取回这笔 deal 尚未消耗完的充值
- 用户主动取回后，这笔 deal 的排行榜余额清零，不再继续消耗

参数：
- `domainName: string`
- `deal: address`

### 6.7 `closeDeal(domainName, deal)`

作用：
- 交易终局后结算广告费，并把未消耗余额退回原充值者 / 创建者
- 任何人都可以调用，但钱只会退回原充值者，不会退给调用者
- 新版本会在 deal 进入 `Completed / Canceled / Abandoned` 时由 `DealFactory` 自动尝试调用
- 前端一般不需要再让用户额外签名调用；这个方法保留为自动结算失败或旧数据的兜底入口

参数：
- `domainName: string`
- `deal: address`

行为：
- 已消耗部分进入域名持有人的待领取广告收益
- 未消耗余额退回创建者
- 终局 deal 默认不再出现在 `getLeaderboard`
- 终局 deal 仍可通过 `DCDomainRankReader.getDomainDealInfo(domainName, deal)` 精确查到

常见 revert：
- `DCDomainRank: deal not reported`：这个 deal 没有被该域名排行榜记录
- `DCDomainRank: deal not closed`：deal 还没进入终局状态
- 已经结算过会直接返回 `(0, 0)`，不会重复退款或重复计入域名收益

### 6.8 `settle(domainName, deal, creatorAddr)`

作用：
- 主动结算当前应扣的排行消耗
- 非终局场景下可用；终局退款推荐用 `closeDeal`

参数：
- `domainName: string`
- `deal: address`
- `creatorAddr: address`

### 6.9 排行榜查询

常用：
- `DCDomainRankReader.getLeaderboard(domainName, limit)`
- `DCDomainRankReader.getLeaderboard(domainName, offset, limit)`
- `DCDomainRankReader.domainEntryCount(domainName)`
- `DCDomainRankReader.getDomainStatusCounts(domainName)`
- `getGlobalLeaderboard(limit)`
- `globalDomainCount()`

分页建议：
- `DCDomainRankReader.domainEntryCount(domainName)` 读取总条目数
- `DCDomainRankReader.getLeaderboard(domainName, offset, limit)` 读取分页结果
- `limit` 范围 `1 - 50`
- `offset >= DCDomainRankReader.domainEntryCount(domainName)` 时返回空数组

默认榜单规则：
- `DCDomainRankReader.getLeaderboard` 只返回未终局 deal：`Ready / Active / Locked`
- `Completed / Canceled / Abandoned` 不进入默认榜单
- 被域名持有人拉黑的创建者也不进入默认榜单

返回结构：
- `merchant`
- `deal`
- `score`

状态数量统计：
- 前端统计域名内“完成 / 进行中 / 待处理 / 失败 / 总计”时，直接调用 `DCDomainRankReader.getDomainStatusCounts(domainName)`
- 返回：
  - `completed`：`Completed`
  - `inProgress`：`Active / Locked`
  - `pending`：`Ready`
  - `failed`：`Canceled / Abandoned`，以及无法读取状态的异常条目
  - `total`：该域名记录过的总 deal 数
- 这个接口只返回数量，不返回完整列表，适合页面上的统计区

精确搜索：
- 如果用户在搜索框输入的是合约地址，直接调用 `DCDomainRankReader.getDomainDealInfo(domainName, deal)`
- 这个接口可以查到已经完成 / 取消 / 废弃的历史 deal
- 链上不做模糊搜索；按标题、昵称、短地址模糊搜建议前端或索引器做

`DCDomainRankReader.getDomainDealInfo` 返回：

| 下标 | 字段 | 说明 |
| --- | --- | --- |
| `0` | `exists` | 该 deal 是否属于这个域名榜单 |
| `1` | `merchant` | 原充值者 / 创建者 |
| `2` | `visible` | 是否会出现在默认 `getLeaderboard` |
| `3` | `dealStatus` | deal 状态；旧合约读不到状态时为 `255` |
| `4` | `dealEndedAt` | 终局时间；未终局为 `0` |
| `5` | `depositedDC` | 当前剩余充值余额 |
| `6` | `pendingConsume` | 当前待结算消耗 |
| `7` | `totalConsumed` | 已消耗 + 待结算消耗 |
| `8` | `active` | 是否还有有效充值余额 |
| `9` | `hoursRemaining` | 按当前策略估算可持续小时数 |
| `10` | `hourlyRate` | 当前小时扣费速率 |
| `11` | `percent` | 当前余额占最近一次充值基准的百分比 |
| `12` | `lastDepositAmount` | 上一次充值金额 |

### 6.10 充值状态查询

常用：
- `myDealStatus(domainName, deal)`：依赖 `msg.sender` 作为创建者；链下 `eth_call` 若未带 `from`，请改用 `myDealStatusOf`
- `myDealStatusOf(domainName, deal, creator)`：**推荐**前端 / 索引器使用，显式传入创建者地址
- `lastDepositAt(domainName, deal, creator)`
- `lastDepositAmount(domainName, deal, creator)`
- `depositPercent(domainName, deal, creator)`
- `previewHourlyRate(depositAmount)`：合约内历史「全局」公式预览；实际扣费以域名 `setDomainAdFeePolicy` 为准

说明：
- `depositPercent`：当前余额相对最近一次充值基准的百分比
- `lastDepositAmount`：上一次充值了多少 `DL`
- deal 终局后，扣费时间会停在 deal 的 `endedAt`，不会因为没人结算而一直扣下去

### 6.11 黑名单（列表查询与地址展示）

链上方法：

- `setBlacklisted(domainName, account, banned)`：仅域名 NFT 持有人可调用；`banned = true` 拉黑，`false` 解除。
- `isBlacklisted(domainName, account)`：是否仍被拉黑。
- `blacklistedCount(domainName)`：当前该域名下拉黑人数。
- `blacklistedAddresses(domainName)`：返回 `address[]`，即当前所有仍被拉黑的地址（顺序随解除/再拉黑可能变化，不要当稳定排序用）。

**升级 / 旧部署说明**：若在增加 `blacklistedAddresses` 之前已有拉黑数据，旧记录只在 `mapping` 里、未进入枚举数组；需持有人对相关地址再执行一次 `setBlacklisted(..., true)` 才会出现在列表中，或自行用历史 `BlacklistedSet` 事件在链下回放还原。

**前端「解析」地址（展示用）**：

1. **校验和地址（推荐）**：用 viem 的 `getAddress(raw)`，得到 EIP-55 混写地址，避免大小写抄错。
2. **可选展示主域名**：若该地址在 `DCDomain` 上设过主域名，可读 `primaryDomain(user)`；空字符串表示未设置。主域名是「标签」不是通行证，权限仍以钱包地址为准。

示例（读取列表并格式化）：

```ts
import { getAddress, type Address } from "viem";

const addrs = (await dcRank.read.blacklistedAddresses([domainName])) as Address[];
const rows = await Promise.all(
  addrs.map(async (a) => {
    const checksum = getAddress(a);
    const primary = await dcDomain.read.primaryDomain([a]);
    return { address: checksum, primaryDomain: primary as string };
  })
);
```

---

## 7. `DCDomainHall` 常用方法

## 7.1 模板说明

大厅这里主要有两类：

- `createTteHallDeal`
  - 域名下 TokenToToken
  - 先建单
  - 先发 deal 专属消息
  - 创建者选人
  - 选中后才能加入

- `createHallDealTemplate23`
  - `templateType = 2`：TokenToEmpty
  - `templateType = 3`：EmptyToEmpty
  - 也是先建单、先沟通、先选人

### 很重要

这两类大厅模板当前规则：
- 创建后默认不能直接 `deal.join()`
- 必须先 `confirmHallDealCounterparty`
- 然后被选中的人才能 `join`
- 不再区分 visitor / merchant；未被拉黑的域名用户都可以创建、留言、被选中。

所以前端这里：
- 不要给这类单子直接显示“立即加入 deal”
- 应该跳大厅

### 7.2 `createTteHallDeal(domainName, aSwapToken, aSwapAmount, bSwapToken, bSwapAmount, title, description, trackCreator)`

作用：
- 创建大厅 TokenToToken 合同

参数：
- `domainName: string`
- `aSwapToken: address`
- `aSwapAmount: uint256`
- `bSwapToken: address`
- `bSwapAmount: uint256`
- `title: string`
- `description: string`，创建时上链交易描述，可为空，最大 1500 bytes
- `trackCreator: bool`

说明：
- 创建后先锁住 join
- 需要后续 `confirmHallDealCounterparty`
- 调用者只需要是未被拉黑的有效域名用户。

### 7.3 `createHallDealTemplate23(...)`

作用：
- 创建大厅模板 2 / 3

参数顺序：
- `domainName: string`
- `templateType: uint8`
- `aSwapToken: address`
- `aSwapAmount: uint256`
- `aMarginToken: address`
- `aMarginAmount: uint256`
- `bSwapToken: address`
- `bSwapAmount: uint256`
- `bMarginToken: address`
- `bMarginAmount: uint256`
- `aNftId: uint256`
- `timeoutSeconds: uint64`
- `title: string`
- `description: string`，创建时上链交易描述，可为空，最大 1500 bytes
- `trackCreator: bool`

其中：
- `templateType = 2` 表示 `TokenToEmpty`
- `templateType = 3` 表示 `EmptyToEmpty`

当前规则：
- 保证金可为 `0`
- 创建后默认不能直接 `join`
- 调用者只需要是未被拉黑的有效域名用户。

### 7.4 `postMessage(domainName, userA, userB, content)`

作用：
- 两个未被拉黑的域名用户在普通大厅线程发消息。

参数：
- `domainName: string`
- `userA: address`
- `userB: address`
- `content: string`

### 7.5 `getMessages(domainName, userA, userB, offset, limit)`

作用：
- 分页获取普通大厅线程消息

参数：
- `domainName: string`
- `userA: address`
- `userB: address`
- `offset: uint256`
- `limit: uint256`

### 7.6 `signalPickUser(domainName, pickedUser, note)`

作用：
- 创建者发送“我准备选你”信号。
- `pickedUser` 只需要是未被拉黑的有效域名用户。

参数：
- `domainName: string`
- `pickedUser: address`
- `note: string`

### 7.7 `confirmHallDealCounterparty(domainName, deal, pickedVisitor)`

作用：
- 创建者正式指定某个地址获得加入权限
- 只有该 deal 的创建者 A 可以调用

参数：
- `domainName: string`
- `deal: address`
- `pickedVisitor: address`，名字沿用旧 ABI，实际含义是被选中的地址

作用结果：
- 对 deal 调 `openJoinFor(pickedVisitor)`
- 之后只有这个地址能 `join`

### 7.8 `postMessageOnDeal(domainName, deal, content)`

作用：
- 在某笔 deal 的专属大厅发消息

参数：
- `domainName: string`
- `deal: address`
- `content: string`

### 7.9 `getMessagesOnDeal(domainName, deal, offset, limit)`

作用：
- 分页获取某笔 deal 的专属消息

参数：
- `domainName: string`
- `deal: address`
- `offset: uint256`
- `limit: uint256`

### 7.10 `pickUserAndCreateDeal(domainName, pickedUser, aSwapToken, aSwapAmount, bSwapToken, bSwapAmount, title, description, trackCreator)`

作用：
- 域名用户直接点对点创建一笔指定地址才能加入的 TokenToToken

参数：
- `domainName: string`
- `pickedUser: address`
- `aSwapToken: address`
- `aSwapAmount: uint256`
- `bSwapToken: address`
- `bSwapAmount: uint256`
- `title: string`
- `description: string`，创建时上链交易描述，可为空，最大 1500 bytes
- `trackCreator: bool`

说明：
- 这个方法本来就是指定地址加入
- 不属于“先创建大厅再选人”的漏洞范围

---

## 8. `DCDomainSwap` 常用方法

### 8.1 `createDeal(domainName, aSwapToken, aSwapAmount, bSwapToken, bSwapAmount, title, description, expectedB)`

作用：
- 在域名下直接创建 TokenToToken 交易

参数：
- `domainName: string`
- `aSwapToken: address`
- `aSwapAmount: uint256`
- `bSwapToken: address`
- `bSwapAmount: uint256`
- `title: string`
- `description: string`，创建时上链交易描述，可为空，最大 1500 bytes
- `expectedB: address`

规则：
- `expectedB = 0x000...000`
  - 公开单
- `expectedB = 某个地址`
  - 点对点单

注意：
- 这不是大厅模式
- 如果是大厅撮合，不要调这个方法

### 8.2 `createDealWithInfoNft(domainName, aSwapToken, aSwapAmount, bSwapToken, bSwapAmount, title, description, expectedB, aNftId)`

作用：
- 在域名下直接创建 TokenToToken 交易，并绑定发起方 A 的官方 `DealInfoNFT`

参数：
- 前 8 个参数和 `createDeal` 一致
- `aNftId: uint256`，发起方 A 自己持有的官方 `DealInfoNFT tokenId`

规则：
- `aNftId = 0` 等价于不绑定身份 NFT
- `aNftId > 0` 时，底层 `DealOpenTokenToken` 会校验 `DealInfoNFT.ownerOf(aNftId) == msg.sender`
- 创建成功后，deal 会锁定该身份 NFT；成交后信用分按这个 tokenId 记账

前端建议：
- 用户选择身份 NFT 时调 `createDealWithInfoNft`
- 用户不选择身份 NFT 时继续调 `createDeal`

---

## 9. 通过 `DealFactory.createDeal` 卖域名 NFT

除了 `DCDomainMarket`，现在也支持通过普通 `Deal` 卖域名 NFT。

适用场景：
- 域名 NFT 作为交易资产
- 想走 Deal 状态机结算，而不是直接挂市场

关键字段：
- `aAssetNft = dcDomain 地址`
- `aAssetNftId = 域名 tokenId`

如果是指定买家：
- `joinMode = 1`
- `expectedB = 买家地址`

如果是公开出售：
- `joinMode = 0`
- `expectedB = 0`

注意：
- 这是普通 `DealFactory` 路径
- 不等于大厅模式

---

## 10. 前端最容易犯错的点

### 10.1 不要把标题当域名传

错误例子：
- `domainName = "Make Friend"`

正确例子：
- `domainName = "hall11"`

### 10.2 大厅模板不要直接给“加入 deal”按钮

以下创建方式出来的单子：
- `createTteHallDeal`
- `createHallDealTemplate23`

都应该：
- 先跳大厅
- 先发消息
- 创建者先选人
- `confirmHallDealCounterparty`
- 选中的人才点加入

### 10.3 先 `approve` 再发交易

常见前置：
- 一级注册域名前，要先 `approve(DCDomain, price)`
- 二级市场购买前，要先 `approve(DCDomainMarket, price)`
- 排行榜充值前，要先 `approve(DCDomainRank, amount)`

### 10.4 金额都用 18 位

当前域名相关的支付币：
- `DL`

前端统一按 `18 decimals` 处理。

---

## 11. 建议前端测试顺序

建议按这个顺序测：

1. 调 `getPrice("abc123")`
2. `approve + register("abc123")`
3. `tokenIdOf("abc123")`
4. `setDomainDescriptionFor`
5. `setDomainBackgroundUriFor`
6. `list / listP2P`
7. `buy`
8. `createTteHallDeal`
9. `postMessageOnDeal`
10. `confirmHallDealCounterparty`
11. 被选中的人再 `deal.join()`
12. `deposit / myDealStatus / DCDomainRankReader.getLeaderboard`

---

## 12. 前端一句话规则

- 域名调用只认真实 `domainName`
- 大厅模板先聊天选人，再允许加入
- 域名一级注册 / 二级市场 / 排行榜充值都用 `DL`
