# Base 主网协议部署验收

验收结果：**PASS**

- 网络：Base mainnet（chainId `8453`）
- 验收区块：`49662333`
- 部署钱包：`0xE88c63D29ECE76E3336B0Db747E10876c3bf9893`
- 有运行代码的记录地址：`41/41`
- DC 总供应量：`0`
- DAO：未部署
- 跨链治理：未启用（零地址）
- 部署及配置总成本：`0.000477277982838216 ETH`
- 部署后钱包余额：`0.000570973689773402 ETH`

## 代理实现

- DealFactory proxy：`0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D`
- DealFactory implementation：`0xAcf74FD151DE6FFE455Ab862A7de9B77cfCe82ed`
- DCDomainRank proxy：`0xd602fa2c7a4BBdCd841AD5e9D69b8C028D48e0B2`
- DCDomainRank implementation：`0xF9b15bc4347700Aa5e5Bf7bA85416E71C092ccF1`

两个 ERC-1967 implementation slot 均与部署记录一致。

## 空池状态

| 交易对 | 池地址 | 验收状态 |
| --- | --- | --- |
| DC/USDC | `0xee40Bbc8cC387aCa294fb9ECa429B10AbeBf1DBA` | 未初始化；余额、真实储备、虚拟储备均为 0 |
| DC/bridged USDT | `0x00e284922E5A727b4378768b5ED5D22fbF3297e8` | 未初始化；余额、真实储备、虚拟储备均为 0 |
| DC/WETH | `0xC99577B3027181F85b650651021bb7F804F50e61` | 未初始化；余额、真实储备、虚拟储备均为 0 |

## 权限与接线

- Factory、PairManager、InfoNFT、域名模块、OrderBook 和 Router 接线一致。
- 部署钱包拥有 DC 管理员和铸币权限，Factory 拥有 DC 铸币权限。
- `PAUSER_ROLE` 仍未授予；这是 DCToken 构造函数和当前部署流程的原始行为，后续在跨链执行器权限交接阶段处理。
- Treasury controller/bootstrapAdmin 当前均为部署钱包，`bootstrapLocked=false`。
- DCDomainSwap 与 DCDomainHall 的创建权限和排行榜 reporter 权限已启用。

## 未执行事项

- 未 mint DC。
- 未给国库打款。
- 未给三个池注入资产或设置虚拟储备。
- 未部署 Base DAO、中本聪账户或分红模块。
- 未部署/接线跨链执行器，未锁定 Treasury bootstrap。

可重复运行的只读验收脚本：`scripts/verify-base-mainnet-deployment.ts`。
