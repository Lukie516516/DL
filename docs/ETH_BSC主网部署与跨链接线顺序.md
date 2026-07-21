# ETH / BSC 主网部署与跨链接线顺序

本文档用于主网部署前对齐协议层、DAO 层和跨链层的部署顺序。

具体脚本、环境变量和初始化参数见：

```text
docs/ETH_BSC主网脚本与参数清单.md
```

## 1. 总体结论

ETH 和 BSC 的业务合约地址一定不同。

跨链层不是“两个链同时填好地址再部署”，而是分阶段部署和接线：

1. 先部署 ETH 主链协议、DAO 和 `CrossChainBroadcaster`。
2. 再部署 BSC 协议目标合约和 `DualBridgeExecutor`。
3. 拿到 BSC `DualBridgeExecutor` 地址后，回到 ETH `CrossChainBroadcaster` 注册 BSC 链配置。
4. 两边 peer / source / target 白名单全部配置完成后，再打开 active，开始真正广播。

如果只先部署 ETH，可以先不注册或不激活 BSC 目标链；否则广播会因为目标链地址不存在或 peer 未配置而失败。

## 2. 生产跨链合约

| 部署位置 | 合约 | 作用 |
| --- | --- | --- |
| ETH 主网 | `CrossChainBroadcaster` | DAO 提案通过后，把治理 calldata 发往 BSC 等目标链。 |
| BSC 主网 | `DualBridgeExecutor` | 接收 LayerZero / Wormhole / Axelar 消息，满足阈值后执行 BSC 目标合约调用。 |

旧的 `CrossChainDispatcher` / `CrossChainExecutor` 不是生产双桥聚合路径，只作为兼容或占位，不作为主网上线的核心跨链入口。

## 3. 推荐部署顺序

| 步骤 | 链 | 操作 | 关键点 |
| --- | --- | --- | --- |
| 1 | ETH | 部署协议层合约 | Factory、InfoNFT、DC、DAO 等主链合约。 |
| 2 | ETH | 部署 `CrossChainBroadcaster` | 构造参数需要 ETH 侧 LZ endpoint、delegate、governance、Wormhole Relayer、Axelar Gateway、Axelar GasService。 |
| 3 | BSC | 部署协议层目标合约 | BSC 上需要被 DAO 控制的 Factory / 参数合约等。 |
| 4 | BSC | 部署 `DualBridgeExecutor` | 构造参数里需要 ETH `CrossChainBroadcaster` 地址作为 Wormhole / Axelar source。 |
| 5 | BSC | 配置 Executor | `setAllowedTarget(target,true)` 授权 BSC 上允许被跨链治理调用的目标合约；确认 `threshold=2`。 |
| 6 | ETH | 配置 Broadcaster | `addChain` / `setChain` 写入 BSC executor 地址、BSC LZ EID、Wormhole chain id、Axelar chain name/address。 |
| 7 | 双链 | 配置 LZ peer | ETH Broadcaster 和 BSC Executor 互设 LayerZero peer。 |
| 8 | ETH | 激活 BSC 广播 | 确认三桥参数无误后 `setChainActive(bscKey,true)`。 |
| 9 | 双链 | 小额灰度验证 | 先发一个低风险参数调用，确认 2-of-3 消息能执行。 |

## 4. 为什么不是一次性填完

`CrossChainBroadcaster` 部署时不需要提前知道 BSC `DualBridgeExecutor` 地址。

但真正向 BSC 广播前，ETH 侧必须知道 BSC executor 地址；BSC executor 也必须知道 ETH broadcaster 地址作为可信 source。

所以正确做法是：

```text
ETH 先部署 broadcaster
-> BSC 用 ETH broadcaster 地址部署 executor
-> ETH 再把 BSC executor 地址写进 chain config
-> 双边 peer / 白名单 / active 配好
```

## 5. 地址格式注意

| 项目 | 要求 |
| --- | --- |
| Wormhole source address | 使用 `bytes32(uint256(uint160(address)))` 的左补零格式。 |
| Axelar source address | 必须与 Axelar 传入的 `sourceAddress` 完全一致。ETH 主网实测为 checksum 格式，不能强行转全小写。 |
| Axelar target address | 目标链 DualBridgeExecutor 地址字符串；当前主网配置使用全小写，已被 Axelar 接受。 |
| LZ peer | 使用 `bytes32(uint256(uint160(address)))` 格式写 peer。 |
| BSC allowed target | 只允许 DAO 需要控制的目标合约，不要把任意地址加入白名单。 |

## 6. 部署前必须确认

| 项目 | 要确认什么 |
| --- | --- |
| ETH 部署钱包 | 是否为预期 owner / DAO 初始权限钱包。 |
| BSC 部署钱包 | 是否为预期 owner / DAO 初始权限钱包。 |
| ETH RPC | 是否为正式 ETH mainnet RPC。 |
| BSC RPC | 是否为正式 BSC mainnet RPC。 |
| LZ endpoint / EID | ETH 和 BSC 的 endpoint、EID 是否主网值。 |
| Wormhole Relayer / chain id | ETH / BSC 是否为主网地址和主网 chain id。 |
| Axelar Gateway / GasService / chain name | ETH / BSC 是否为主网配置。 |
| 激活状态 | 初始可以 inactive，灰度确认后再 active。 |

## 7. 这次参数初始化

| 参数 | 默认值 | 范围 / 说明 |
| --- | --- | --- |
| 身份 NFT 铸造价格 | `100,000 DC` | admin 后台范围 `100 - 5,000,000 DC`。 |
| 留言收费金额 | `100 DC` | admin 后台范围 `0.01 - 100 DC`。 |
| 留言收费状态 | 默认开启 | 新部署脚本会设置为使用 DC 收费。 |
| 协议国库 | 默认部署 `ProtocolTreasury` | 业务合约的 treasury / 分红 source 默认指向该合约；正式前应把 controller 迁到 DAO/timelock/executor 并锁定 bootstrap。 |

## 8. 当前脚本入口

| 操作 | 命令 |
| --- | --- |
| ETH 协议层部署 | `npm run deploy:mainnet:protocol:eth` |
| BSC 协议层部署 | `npm run deploy:mainnet:protocol:bsc` |
| 跨链参数检查 | `npm run deploy:mainnet:bridge -- env` |
| 跨链合约部署 | `npm run deploy:mainnet:bridge -- deploy` |
| 跨链接线 | `npm run deploy:mainnet:bridge -- wire` |
| 激活 BSC 跨链广播 | `npm run deploy:mainnet:bridge -- activate-bsc` |
| 查看跨链状态 | `npm run deploy:mainnet:bridge -- status` |
