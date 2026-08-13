# Solana Deal Terminal Flow SDK

`terminal-flow.mjs` 是终局交易编排校验器。它接收前端已经通过 Anchor IDL
构造的 `TransactionInstruction`，校验 Program、discriminator、Deal 和
receipt 链路后，分别返回“经济核心”和“权限开放补写”两笔交易的规范顺序。

```js
import {
  buildCompletedPostIndexFlow,
  buildCompletedTerminalFlow,
} from "./terminal-flow.mjs";

const coreInstructions = buildCompletedTerminalFlow({
  requirements: {
    // 必须由同一次终局预计算结果生成，不可直接信任用户输入。
    dcToDc: true,
    creditMode: "pair",
  },
  resolution,
  dcFeeRoute,
  finalization,
  valuation,
  rewardQuote,
  rewardMint,
  credit,
});

const postIndexInstructions = buildCompletedPostIndexFlow({
  requirements: {
    deal,
    historyPending: true,
    identityRewardRoles: [0],
    rewardIndexRoles: [0, 1],
    creditIndexSides: [0, 1],
    identityUnlockMints: [aIdentityMint],
  },
  historyIndex,
  identityRewardRecords,
  rewardIndexes,
  creditIndexes,
  identityUnlocks,
});
```

两份 `requirements` 都必须由官方客户端根据同一份 Deal、AssetTerms、身份锁
和奖励预计算结果生成。核心清单声明是否为 DC/DC 和四种信用模式；补写清单
显式绑定 Deal，并声明仍待执行的 history、身份奖励角色、奖励索引角色、
信用索引双方和身份 mint。

DC/DC 结算必须额外提供 `dcFeeRoute`，规范顺序固定为
`resolution -> dcFeeRoute -> finalization`。该指令按照双方锁定身份和官方
CreditGraph 选择 C；严格高分方（包括其更高分 top peer）收取双方 DC
手续费，双方零分、同分、同一持有人或没有有效身份时销毁手续费。非 DC/DC
交易不得夹带该指令。

必选步骤缺失、Program ID 错误、指令类型错误、Deal 不一致、receipt 不衔接、
索引重复，或者实际指令与 `requirements` 少一条/多一条时，都会在钱包签名
前抛错。各角色和双方索引会按数字排序，身份解锁会按 mint 排序，因此调用方
传入顺序不会改变最终规范顺序。

信用模式必须与实际身份锁一致：

- `pair`：双方都有有效身份，使用双边信用指令；
- `single-a` / `single-b`：仅对应一方有身份，使用单边信用指令；
- `none`：双方都没有身份，只生成零增量审计 receipt，不调用 CreditGraph；
- 补写清单中的信用索引必须与实际 receipt 的非零一侧一致，`none` 不包含信用索引。

非 Completed 终局使用 `buildNonCompletedTerminalFlow`，同样必须提供 `requirements.identityUnlockMints`，顺序固定为退款/取消动作、非完成 receipt、身份解锁。

身份解锁指令必须调用 `deal_asset_controller.unlock_identity`，不能直接调用
`deal_identity.unlock_identity`。生产配置中 Identity 的
`trusted_controller` 是 AssetController config PDA，普通钱包不存在也不应持有
controller 私钥。

## 安全边界

经济核心包含资产交割、DC/DC C/销毁手续费、terminal/valuation/reward
receipt、DC 奖励和信用写入，链上 `deal-terminal-guard` 强制其连续出现，
任一步失败整笔回滚。

completed history、身份奖励累计、奖励/信用索引和身份解锁位于第二笔权限
开放交易。其规范 PDA receipt/marker 防止重复；失败时整笔补写回滚并保持
身份锁定，任何执行者都可以重试。

重试前必须只读检查每个规范 receipt/marker 和 `AssetTerms`。如果第三方已经
提前完成了部分正确补写，应把 `historyPending` 设为 `false`，并只把仍缺失
的 role、side 和 identity mint 放入 pending 数组；SDK 会生成断点续跑交易，
不会因为已存在的正确索引永久卡住。

生产交易必须使用 v0 transaction + ALT。保守容量模型为 `59/59/58` 个账户，
本地真实 DC/DC SBF 为 `58/39` 个账户；仍需在 Devnet 持久部署后取得真实
集群 signature。

运行测试：

```bash
cd sdk
npm test
npm run capacity
npm run preflight:devnet
SOLANA_DEPLOY_DRY_RUN=1 npm run deploy:devnet
```

实际部署脚本只接受 Devnet genesis，且必须显式设置
`SOLANA_DEPLOY_CONFIRM=DEVNET_24_PROGRAMS`；它只部署 24 个生产 Program，
自动排除本地 DAO/D/治理活跃和 ETH 专属分红参考 Program。没有明确授权时
只能运行 dry-run。
