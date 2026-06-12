# Real AGI Pair Handoff

ChainId: 31415926
UpdatedAt: 2026-06-03T09:09:43.200Z

## Changed Addresses

| Name | Address |
| --- | --- |
| DealPairManager | 0x6eEC737af52A8100bC6234e59c94504715F79682 |
| DC/AGI Pair | 0x16FD32B9f1060392272F1145b28110C3A18fc7C5 |

## Unchanged Entry Points

| Name | Address |
| --- | --- |
| DealFactory | 0x4adaa0097cd4ba6f93b468d869072e2daa17bc2e |
| DealRouter | 0x93bf524603cf975746d0761cce13e8610bb8b1e4 |
| DealRouterQuoter | 0x805566afb0a00597f28bfbaf6b8a86314c2eee0b |
| DealSwapAssetRegistry | 0xd9f9c2d41c14d3fa19ac83008bc372605888ec59 |
| DC | 0x802c43662c38aad9b4299c2f723a6b16f228217a |
| WAGI / AGI | 0x391747e54d24aa8cef1388fe1c13f8fd57051153 |

## New AGI Pair Reserves

- Real DC: 500000
- Real AGI/WAGI: 50
- Virtual reserve0: 0
- Virtual reserve1: 0

## Frontend Notes

- Use the updated deployments/agiking-31415926.json.
- AGI pair no longer relies on virtual AGI reserve.
- DC -> AGI can now pay out real AGI/WAGI from the pair reserve.
