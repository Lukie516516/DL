# DealFactory DAO 治理权限生产升级记录

日期：2026-08-12

## 最终结论（2026-08-12）

- ETH Factory 已升级到新 implementation。
- BSC Factory 已升级到新 implementation。
- Base Factory 已经 DAO 提案 `#23` 与 2-of-3 跨链执行器升级到新 implementation。
- DAO Major 策略提案 `#22` 已执行；跨链升级提案 `#23` 已以 70 D 通过并执行。
- 没有修改留言费、创建 burn、国库、admin 或免手续费 token 的正式值。

提案 `#23` ETH 执行交易：`0xd5aff31a473b2de61e81029689fd07c2395e2364b48cb9e9602928c30523c63d`。BSC 与 Base 均收到 LayerZero、CCIP、Axelar 3/3 确认，每条链业务调用严格只执行一次。三链 Factory 现均指向 `0x7fC9...887E`，且 runtime hash 均为 `0xdc7b...6002`。完整机读结果见 `deployments/deal-factory-crosschain-upgrade-final-verification.json`。

## implementation

三条链使用 CREATE2 部署了完全相同的 implementation 地址：

`0x7fC9145A2539F0eD52Cf6E7E34Ce485635A9887E`

校验后的 runtime code hash：

`0xdc7b6c061c5d97b62294659bf5ee9d40353238010763d1bd8c804a1974676002`

### 部署交易

| 链 | 交易 |
| --- | --- |
| Base | `0x2c5ad94d72dea45ae4a68aecc0eff7f4473faa8cd8443e4705f4acd98bb3f03f` |
| BSC | `0x197a50f26955c5e1dce005d41b01497d7e4e2a567a13708203d59ff8adb93d17` |
| ETH | `0xb565a65599cb4158c39269262cbc75835b854cf78f16a6a3914dcabf4cab439c` |

## Proxy 升级

| 链 | Factory proxy | 旧 implementation | 当前 implementation | 交易 |
| --- | --- | --- | --- | --- |
| ETH | `0x02330431F96B21776274F3147bd4C233Caf7D752` | `0x20289f30C92e0bb36cA0B32741EccFF2C95595Ee` | `0x7fC9145A2539F0eD52Cf6E7E34Ce485635A9887E` | `0x476a49e2556adf0ae0408ff365000c54f5ca32b74f2af7381f305e09ef036042` |
| BSC | `0x1Ca748Feb347d0d177E844E7D4CDCA908957c256` | `0xfeF16C50aFcf3bFfb7136DBD58c4797f339dBe1D` | `0x7fC9145A2539F0eD52Cf6E7E34Ce485635A9887E` | `0x8165c40def9552c4ff334d71d60e1ca31735398012d2cbcaa90eb87c4d814e66` |
| Base | `0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D` | `0xAcf74FD151DE6FFE455Ab862A7de9B77cfCe82ed` | `0x7fC9145A2539F0eD52Cf6E7E34Ce485635A9887E` | 跨链执行 `0x8fe256e1e7d26b4eb29c1e3b930df2244d9c7f4b6910c5cc487535a4fc48992f` |

ETH/BSC 升级前后 owner、admin、crossChainGovernance、treasury、specialNoFeeToken、留言规则、创建 burn 规则、timeout/window 和手续费比例均保持不变。新治理 selector 的只读调用验证通过。

生产升级后重新运行 ETH/BSC/Base 三链 fork，全部通过：

- 全量 Factory 存储前后一致。
- 留言费 `104 -> 105 -> 104 DC` 恢复精确。
- 创建 burn `0 -> 11 -> 0 DC` 恢复精确。
- treasury、specialNoFeeToken、admin 的 DAO 修改与恢复通过。
- 非授权账户全部被拒绝。
- DAO/跨链 Executor 后续 UUPS 升级通过。
- 同 implementation 升级重放通过，业务状态不变。

## DAO 策略提案 #22

描述：

> 授权BSC和Base由DAO升级Factory，不修改业务参数。

提案仅对以下 Major nested selector 开放：

- BSC Factory `upgradeToAndCall(address,bytes)`
- Base Factory `upgradeToAndCall(address,bytes)`

当前状态：Pending，`totalStaked = 0`，未执行，策略尚未激活。

| 动作 | 交易 |
| --- | --- |
| 精确 mint 1000 DC | `0x0f68095d7dbf6f486e9ff3964b1dc07319b5dd201d78f1a4552f1158130bacb8` |
| approve 1000 DC | `0x378aa512737fc40e86a53a4560ccf101aa20bffb6643468c976e89e1ae1e4376` |
| 创建提案 #22 | `0x7e8982672223b4ed2b265c02569109086a7af8f16d3dfdf2eaf98c70c060d47d` |

1000 DC 已作为 Major 提案费进入 DAO Treasury；9893 的 DC 余额和 allowance 均恢复为 `0`。

## 下一步

1. 由前端/治理参与者让提案 `#22` 达到可执行状态。
2. 明确授权后执行 `#22`，激活两条精确策略规则。
3. 再创建单独的 Major 跨链升级提案：对 BSC 和 Base 发送相同的 `upgradeToAndCall(0x7fC9...887E, 0x)`。
4. 生产节点 `eth_call` 已确认：BSC 重放同一 implementation 的升级调用可成功且不改变协议状态；Base 从旧 implementation 切换到新 implementation 也可成功。因此 Broadcaster 覆盖全部 active 链的同 calldata 路径可用。
5. 完成 Base proxy 切换后，验证所有生产状态和 DAO 治理 selector。

未经再次确认，不 stake、不执行 #22、不创建 Base 升级提案。
