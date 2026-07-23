# Agiking 域名列表 Reader 前端接线

部署时间：2026-07-23T09:15:36.619Z

链：Agiking `31415926`

部署钱包：`0xE88c63D29ECE76E3336B0Db747E10876c3bf9893`

## 前端必须更新

| 项目 | 地址 |
| --- | --- |
| 新 DCDomainListReader | `0xA23638bDde663442271e478c538b66fb22a5bD83` |
| 旧 DCDomainListReader（停止使用） | `0x57DD9E0471C313Cc09B1123D384467A081DC776c` |
| DCDomain（未变） | `0x0a18a23B7B709Ae063d9dFF397008029f2b07EB7` |
| DCDomainRank proxy（未变） | `0x347F39116BDfca98788EBD60841e14226f63c761` |

部署交易：`0xd1e81e0681551b42c2c6820da483ee1208d025ddffc480a5d6f9b14af6eb211b`

部署区块：`3495107`

## 调用方法

```solidity
getDomainsByVolume(uint256 offset, uint256 limit)
```

- `limit` 为 `1..50`。
- 返回全部已注册域名，而不是只返回有成交额的 Top-50。
- 有已完成成交的域名按 `tradeVolume` 从高到低排列。
- 没有成交的域名也返回，`tradeVolume = 0`，排在有成交域名之后。
- 相同成交额按较新的 `tokenId` 优先。
- ABI 没变，前端只需要替换 Reader 地址。
- 这是 `eth_call` 只读调用，不消耗用户钱包 Gas；RPC 节点仍会限制单次调用的计算量，因此继续分页读取。

Viem 示例：

```ts
const page = await publicClient.readContract({
  address: "0xA23638bDde663442271e478c538b66fb22a5bD83",
  abi: DCDomainListReaderAbi,
  functionName: "getDomainsByVolume",
  args: [0n, 20n],
});
```

## 链上验证

- `dcDomain()` 精确指向现有 DCDomain。
- `rank()` 精确指向现有 DCDomainRank proxy。
- 当前 `totalDomains = 3`。
- 旧 Reader 默认列表返回 0 条。
- 新 Reader 默认列表返回 3 条，零成交域名已可见。
- 未升级或修改 DCDomain、DCDomainRank、Factory、DAO 或任何资产合约。

完整地址与 ABI：`deployments/agiking-31415926.json`
