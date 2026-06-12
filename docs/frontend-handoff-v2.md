# Frontend Handoff — v2 Full UUPS Deployment

**Chain**: Agiking (chainId: 31415926)  
**RPC**: `https://rpc.agikingrpc.shop`  
**Deployed at**: 2026-06-12T10:31:26Z  
**Deployer**: `0xe88c63d29ece76e3336b0db747e10876c3bf9893`

---

## 1. All Contract Addresses

### Tokens (unchanged)
| Contract | Address |
|---|---|
| DL Token (`dlToken`) | `0x802C43662C38aAd9b4299c2f723A6B16f228217A` |
| AUSD (`ausd`) | `0x8fc6dB736Dce11233078EA6f6EBa4c9F44E4C123` |
| USDT (`usdt`) | `0x1035F65fc63342F9878C4D03e4372718Dbb33d32` |
| Wrapped AGI (`wrappedNative`) | `0x391747E54d24AA8Cef1388FE1C13f8fD57051153` |
| **D Token** (NEW governance seat) | `0xA57b99E48f2fc24282E8F263D24468a51C5242DB` |

### Swap Pools (unchanged — liquidity preserved)
| Contract | Address |
|---|---|
| DL/AUSD pair | `0xEb92069fDDbD0435F194E3608D37B3D2E81286c9` |
| DL/USDT pair | `0x88b399d8E41D392Db6A56ADAAdcFb18f37c9DDFc` |
| DL/AGI pair | `0x16FD32B9f1060392272F1145b28110C3A18fc7C5` |

### Core — Deal System (NEW addresses)
| Contract | Address | Note |
|---|---|---|
| **DealFactory** (proxy) | `0xd0Fc2685945790df25bDdeaA69426a348D05775B` | UUPS proxy |
| DealFactory impl | `0x9c0e10155bdFE97451fcD1D159fA4B89bC8E669C` | impl only, don't use directly |
| DealImplementationRegistry | `0x8bB59bb5269EE46F56fddD7BDbCC498c17B84DE3` | NEW |
| DealPairManager | `0x66Ae5a605a566B59cFB33dbCf1DDC0cFB853A8a5` | |
| DealMessageHub | `0x84E1940E1a5Ad8100f41248254881fb6015926df` | |
| DealActivityIndex | `0x1E0b2Ba7572Df0338be4edAe63aF67C0BDdb222a` | |
| DealResultIndex | `0x7D3f79D24972d6B7A9f5D9358d550895Ed612278` | |

### Swap Stack (NEW addresses)
| Contract | Address |
|---|---|
| DealSwapOrderBook | `0x71d8a47AD749aB8aAf5e184b428B2e2B6b891606` |
| DealRouter | `0x624324B79ca78d0eB45f804fA5a076bA285A5F35` |
| DealRouterQuoter | `0x0171E0445BA759bED1Dcd3AA39d5b9A9c297b56F` |
| DealSwapAssetRegistry | `0x77eA130D6b7F293579b0bcd5D19B3F22ECa45528` |

### Info / Read (NEW addresses)
| Contract | Address |
|---|---|
| DealInfoNFT | `0x7E4eD273FAc90A87Ea4C2205B7c37d4A31B08844` *(unchanged)* |
| DealInfoNFTRenderer | `0x2f678Cd7ff82f1828621718eEfb67b514F9a0C16` |
| DealCreditGraph | `0x186312887782596fbE83c964b734b485110DA4AD` *(unchanged)* |
| DealReader | `0x10340C8138c29F6772061a0aae34982e74D3780E` |

### DC Domain Stack (NEW addresses)
| Contract | Address | Note |
|---|---|---|
| DCDomain | `0x0a18a23B7B709Ae063d9dFF397008029f2b07EB7` | |
| **DCDomainRank** (proxy) | `0x347F39116BDfca98788EBD60841e14226f63c761` | UUPS proxy |
| DCDomainRank impl | `0x4bf05220e5190cFC8A178A2Bb8b3f45049Dc103D` | impl only |
| DCDomainRankReader | `0x3160026ffcDa4481D5601c1b2563Dde0ADf78bc7` | |
| DCDomainListReader | `0xeeCF3206152E6ca3D1938b6191e4284e15D89c75` | |
| DCDomainMarket | `0x85CaC6b96FC473f4C57A26068500514D092fe48e` | |
| DCDomainSwap | `0x79D16213e4AcdF1Fb9Cf471ffB8B812169095D34` | |
| DCDomainHall | `0x3fE565C12fB8080d946BBC56D57641f9272D472C` | |

### Governance Stack (NEW)
| Contract | Address | Note |
|---|---|---|
| **DealGovernance** (proxy) | `0x281B18d6755869A0552088ef190ED9BBcceAfA1C` | UUPS proxy |
| DealGovernance impl | `0xC909b5752BaA0d8eBab511eF10bdd15Ad8fa564B` | impl only |
| DealNftGovernanceActivity | `0x9FDA424449e52D2C38Fe19080a8D681A085D536a` | NEW |
| NftVetoRegistry | `0xD8Ed220604Fbf0F861D64CaEe2cAE88c1a7258a8` | |
| DealSeatVetoGovernor | `0x17406e466443da378817A8d69f212B4FC359e48C` | NEW |
| VoteDividendClaimer | `0xEfe550dF7BD394c7791AA56f64efC2D938C576f9` | NEW |

### Cross-Chain Bridge (placeholder)
| Contract | Address | Note |
|---|---|---|
| CrossChainDispatcher | `0x42A59a08f7Ec25c75Ab97815981333F18395805b` | NEW |
| CrossChainExecutor | `0x1ABC100Ca6eaB03Ca9a0a75f65239ca9e3FE9A7e` | NEW |

---

## 2. ABIs That Changed — What to Update

The canonical ABI source is `deployments/agiking-31415926.json` → `abi` map.  
Below is a summary of what changed vs. the previous deployment.

### Must Replace ABI (contract address also changed)

| Contract key | New address | Why ABI changed |
|---|---|---|
| `DealFactory` | `0xd0Fc...5B` | UUPS proxy — added `initialize`, `upgradeTo`, `upgradeToAndCall`, `owner`, `transferOwnership`, `proxiableUUID`. State-variable reads behave the same. |
| `DealImplementationRegistry` | `0x8bB5...E3` | **New contract** — use for querying available deal types. |
| `DealPairManager` | `0x66Ae...5` | New address only; ABI unchanged. |
| `DealMessageHub` | `0x84E1...f` | New address only. |
| `DealActivityIndex` | `0x1E0b...a` | New address only. |
| `DealResultIndex` | `0x7D3f...8` | New address only. |
| `DealSwapOrderBook` | `0x71d8...6` | New address only. |
| `DealRouter` | `0x624324...5` | Constructor changed (3 args: WNATIVE, ORDER_BOOK, PAIR_MANAGER). **Pair whitelist now enforced** — `swapExactTokensForTokens` / `swapTokensForExactTokens` will revert if the pair is not registered. |
| `DealRouterQuoter` | `0x0171...F` | New address; ABI unchanged. |
| `DealSwapAssetRegistry` | `0x77eA...8` | New address only. |
| `DealInfoNFTRenderer` | `0x2f67...6` | New address only. |
| `DealReader` | `0x1034...E` | New address only. |
| `DCDomain` | `0x0a18...7` | `tokenURI` response now includes `chainId` and `contractAddress` attributes in the metadata JSON. Parse `attributes` array for these new fields. |
| `DCDomainRank` | `0x347F...1` | UUPS proxy — added `initialize`, `upgradeTo`, `owner`. Core rank/score functions unchanged. |
| `DCDomainRankReader` | `0x3160...7` | New address only. |
| `DCDomainListReader` | `0xeeCF...5` | New address only. |
| `DCDomainMarket` | `0x85Ca...e` | New address only. |
| `DCDomainSwap` | `0x79D1...4` | New address only. |
| `DCDomainHall` | `0x3fE5...C` | New address only. |
| `DealGovernance` | `0x281B...C` | UUPS proxy — added `initialize`, `upgradeTo`. **Staking bug fixed** — window reset on 1st stake no longer happens. |
| `D` | `0xA57b...B` | **New governance seat token**. ERC20 + ERC20Burnable but `burn`/`burnFrom` revert with `BurnDisabled`. ABI differs from `dlToken`. |
| `DealNftGovernanceActivity` | `0x9FDA...a` | **New contract** — records governance participation. |
| `NftVetoRegistry` | `0xD8Ed...8` | New/updated address. |
| `DealSeatVetoGovernor` | `0x1740...C` | **New contract** — NFT seat-based veto. |
| `VoteDividendClaimer` | `0xEfe5...9` | **New contract** — claim dividends proportional to governance votes. |
| `CrossChainDispatcher` | `0x42A5...b` | **New contract** — bridge dispatcher. Call `setBridgeAdapter` when real bridge is wired. |
| `CrossChainExecutor` | `0x1ABC...e` | **New contract** — bridge executor. `setBridgeAdapter` + `addAuthorizedCaller` before production use. |

### Address Unchanged — ABI Unchanged
| Contract | Address |
|---|---|
| `dlToken` | `0x802C...A` |
| `ausd` | `0x8fc6...3` |
| `usdt` | `0x1035...2` |
| `wrappedNative` | `0x3917...3` |
| `dealInfoNFT` | `0x7E4e...4` |
| `dealCreditGraph` | `0x1863...D` |
| `pairDlAusd` | `0xEb92...9` |
| `pairDlUsdt` | `0x88b3...c` |
| `pairDlAgi` | `0x16FD...5` |

---

## 3. Changed / New Functionality

### 3.1 UUPS Upgradeable Proxies
**Contracts**: `DealFactory`, `DCDomainRank`, `DealGovernance`  
**What it means for the frontend**:
- Always point to the **proxy** address (e.g. `dealFactory`, not `dealFactoryImpl`).
- Proxy address stays stable across future upgrades — you do **not** need to update the frontend address when the contract logic is upgraded.
- New ABI methods added to these contracts: `proxiableUUID()`, `upgradeToAndCall(address, bytes)`, `owner()`, `transferOwnership(address)`. Ignore them unless building an admin panel.

### 3.2 DealSwapRouter — Pair Whitelist Enforced (C-2 fix)
**What changed**: `DealRouter` now checks that the swap pair is registered in `DealPairManager` before executing. Swap calls for unregistered pairs revert.  
**Frontend impact**: No behavior change for UI — existing pools (DL/AUSD, DL/USDT, DL/AGI) are all registered. If you integrate new pairs, call `DealPairManager.mapPair` first.

### 3.3 DealGovernance — Staking Window Bug Fixed (HIGH severity)
**What changed**: A bug where a user's staking window was reset to a new 1-hour window every time they called `stake()` has been fixed. The window now extends only if it has already expired.  
**Frontend impact**: Staking UX is now correct. Users who stake multiple times within the window will see their window correctly maintained, not reset.

### 3.4 DealGovernance — Staker Dedup
**What changed**: `_inStakerList` mapping prevents the same address from being added to the staker list twice.  
**Frontend impact**: None. Internal consistency fix.

### 3.5 DealLib — Reward Split Fix (M-2)
**What changed**: `DealLib` reward distribution calculation was incorrect (wrong split ratio). All deal implementation contracts are redeployed with the corrected library.  
**Frontend impact**: Reward amounts displayed to users may change slightly for new deals. Existing completed deals on the old factory are unaffected.

### 3.6 D Token — Governance Seat Token (NEW)
**Contract**: `D` at `0xA57b99E48f2fc24282E8F263D24468a51C5242DB`  
**What it is**: ERC-20 governance seat token. Holders can vote on proposals and veto governance actions via `DealSeatVetoGovernor`.  
**Key difference from DL token**: `burn()` and `burnFrom()` are disabled (revert with `BurnDisabled`). Transfer is allowed.  
**Initial state**: 100 D tokens minted to deployer (`0xe88c63d29...`). Distribute to governance seat holders.

### 3.7 DealGovernance — NFT Veto Integration (NEW)
**Contracts**: `DealSeatVetoGovernor`, `NftVetoRegistry`, `DealNftGovernanceActivity`  
**What it is**: D token holders can veto proposals via `DealSeatVetoGovernor`. `NftVetoRegistry` tracks veto delegations.  
**Frontend note**: `DealGovernance.nftVetoRegistry` is currently `address(0)` (inactive). NFT veto is enabled by passing a governance proposal to call `setNftVetoRegistry`. Do not show NFT veto UI until this is set.

### 3.8 VoteDividendClaimer (NEW)
**Contract**: `0xEfe550dF7BD394c7791AA56f64efC2D938C576f9`  
**What it is**: Allows governance participants to claim dividends proportional to their governance votes.  
**Frontend**: Add a "Claim Dividend" action that calls `VoteDividendClaimer.claim()`. The dividend source wallet must deposit funds first.

### 3.9 CrossChain Bridge (NEW — Placeholder)
**Contracts**: `CrossChainDispatcher`, `CrossChainExecutor`  
**Status**: Deployed but not yet wired to a real bridge. `bridgeAdapter` is `address(0)`.  
**Frontend**: Do not expose cross-chain UI until `setBridgeAdapter` is called by the admin to wire the real bridge adapter.

### 3.10 DCDomain + DealInfoNFT — Richer Metadata
**What changed**: `tokenURI` JSON now includes `chainId` and `contractAddress` fields in the `attributes` array.  
**Frontend**: If you render NFT metadata attributes, expect two new entries:
```json
{ "trait_type": "Chain ID", "value": "31415926" },
{ "trait_type": "Contract", "value": "0x..." }
```

### 3.11 DealImplementationRegistry (NEW)
**Contract**: `0x8bB59bb5269EE46F56fddD7BDbCC498c17B84DE3`  
**What it is**: Registry mapping deal type IDs to implementation addresses. Replaces hard-coded implementation lookups in `DealFactory`.  
**Frontend**: Use `DealImplementationRegistry.getImplementation(typeId)` to resolve deal type → implementation address for display purposes.

### 3.12 CrossChainExecutor — Auth Fix
**What changed**: `_checkCaller()` now enforces authorization. Added `setBridgeAdapter()` and `addAuthorizedCaller()` admin functions.  
**Frontend**: No UI change. Admin must call `setBridgeAdapter` before bridge goes live.

---

## 4. Documents to Read

| Document | Purpose |
|---|---|
| `deployments/agiking-31415926.json` | **Primary source of truth** — all addresses and full ABIs for v2 deployment |
| `contracts/DealFactory.sol` | UUPS proxy factory — `createDeal`, `setOpsGlobals`, `setCoreGlobals` |
| `contracts/DealGovernance.sol` | Governance — `stake`, `propose`, `vote`, `execute`; **read comments on staking window** |
| `contracts/DCdomainrank.sol` | Domain rank — `record`, `getScore`, `joinedAt` fix for inactive users |
| `contracts/DealSwapRouter.sol` | Swap router — `swapExactTokensForTokens`, `swapTokensForExactTokens` (pair whitelist) |
| `contracts/D.sol` | Governance seat token — ERC-20, burn disabled |
| `contracts/CrossChainDispatcher.sol` | Bridge dispatcher — `dispatch`, `setExecutor`, `setBridgeAdapter` |
| `contracts/CrossChainExecutor.sol` | Bridge executor — `execute`, `setBridgeAdapter`, `addAuthorizedCaller` |
| `contracts/DealImplementationRegistry.sol` | Deal type registry |
| `contracts/VoteDividendClaimer.sol` | Dividend claiming for governance voters |

---

## 5. Migration Checklist for Frontend

- [ ] Replace all contract addresses for changed contracts (see table in §1)
- [ ] Replace ABIs from `deployments/agiking-31415926.json → abi`
- [ ] **DealFactory**: now a proxy — point to proxy address `0xd0Fc...5B`, not impl
- [ ] **DCDomainRank**: now a proxy — point to proxy address `0x347F...1`, not impl
- [ ] **DealGovernance**: now a proxy — point to proxy address `0x281B...C`, not impl
- [ ] Add D token to wallet/balance displays (separate from DL token)
- [ ] Update NFT metadata parsers to handle new `chainId` and `contractAddress` attributes
- [ ] Add `DealImplementationRegistry` for deal type lookup
- [ ] Add `VoteDividendClaimer.claim()` action to governance UI
- [ ] Hide cross-chain and NFT veto UI until bridge and veto registry are configured by admin
- [ ] Verify swap flows still work — pairs are whitelisted, no regression expected

---

## 6. Wiring Verification

All 29 wiring transactions confirmed on-chain:
- `DealFactory`: core globals, service globals, ops globals, recognized tokens, treasury, cross-chain governance
- `DealImplementationRegistry`: all 6 deal implementations registered
- `DealPairManager`: 3 existing pools mapped (AUSD, USDT, AGI)
- `DealSwapOrderBook`: router set
- `DealInfoNFT`: factory added, factory set, renderer set
- `DealCreditGraph`: factory recorder set
- `DL token`: minter role granted to factory
- `DCDomainRank`: auto-closer set, reporters set (DCDomainSwap, DCDomainHall)
- `DCDomain`: market set
- `DealFactory`: DCDomainSwap + DCDomainHall allowed
- `DealNftGovernanceActivity`: recorders set (factory, nftVetoRegistry, voteClaimer)
- `NftVetoRegistry`: governor set to DealSeatVetoGovernor
- `VoteDividendClaimer`: governance activity + governance contract set
- `CrossChainDispatcher`: executor set for Agiking chainId 31415926
