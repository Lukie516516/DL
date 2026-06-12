# DAO Deployment Handoff — Impact Assessment Prompt

This document is a briefing for an AI (or engineer) to evaluate the deployment impact of the new DAO governance system on the existing Deal protocol contracts.

---

## Context

The Deal protocol runs on **agiking chain (chainId 31415926)**. All addresses are already deployed. The new DAO governance system has been written but **not yet deployed**. Your job is to assess what must change, in what order, and what risks exist.

---

## What Was Written (not yet deployed)

### 1. `contracts/DealGovernance.sol` — NEW contract

Replaces `DealSeatVetoGovernor.sol` + `DealGovernor.sol` / `DealDao.sol` (whichever is active).

Key design:
- Three proposal kinds: `Parameter`, `Treasury`, `Major`
- Physical D staking: D is transferred INTO the governance contract on `stake()`
- Threshold-based (no time windows): 2.5 D to activate, 70 D to pass
- `veto()` allowed for Parameter/Major (any address with ≥ 2.5 D wallet balance); BLOCKED for Treasury
- `cancel()` by proposer only
- `execute()` runs actions then auto-returns all staked D
- Exposes `getPastStakedOf(address, uint256 timepoint)` via `Checkpoints.Trace208` for dividend calculations
- Major proposals additionally require 70% NFT approval via `NftApprovalRegistry`

Constructor: `constructor(address dToken_, address nftApprovalRegistry_)`

### 2. `contracts/NftApprovalRegistry.sol` — NEW contract

Replaces `NftVetoRegistry.sol`.

Key design:
- Flipped model: 70% NFT **approval** (was: 20% NFT **veto**)
- NFT not locked; votes retractable
- Ownership re-verified at execute time
- `registerProposal()` callable only by addresses in `isGovernor` mapping
- `setGovernor(address, bool)` callable only by owner (set owner = governance timelock or multisig)

Constructor: `constructor(address infoNft_, address activity_)`
- `infoNft_` = DealInfoNFT contract
- `activity_` = the NFT activity recorder (already deployed; the same one used by the existing system)

### 3. `contracts/VoteDividendClaimer.sol` — MODIFIED (minor, backward-compatible)

Added:
- `address public governanceContract` — new field, defaults to `address(0)`
- `event GovernanceContractUpdated(address indexed gov)`
- `function setGovernanceContract(address gov) external onlyExecutor`
- Interface `IDealGovernanceStaked`
- In `_claim()` and `previewClaim()`: if `governanceContract != address(0)`, adds `getPastStakedOf(account, snapshot)` to the D balance used for dividend share calculation

**Backward compatible**: if `governanceContract` is never set, behavior is identical to before.

---

## What Stays the Same (no code changes needed)

| Contract | Status | Notes |
|---|---|---|
| `D.sol` | Unchanged | Source of staked D; governance contract calls `safeTransferFrom` / `safeTransfer` on it |
| `DC.sol` (DealCoin) | Unchanged | Dividend token; VoteDividendClaimer pulls from `dividendSource` |
| `DealInfoNFT.sol` | Unchanged | Used by NftApprovalRegistry for `ownerOf()` |
| NFT activity recorder | Unchanged | NftApprovalRegistry calls `isActive()`, `markActive()`, `activeGovernanceSupply()` |
| `DealFactory.sol` and all protocol contracts | Unchanged at code level | Their admin/owner setter functions are the *targets* of governance proposals |

---

## Old Contracts to Retire

| Old contract | Replaced by | Migration note |
|---|---|---|
| `DealSeatVetoGovernor.sol` | `DealGovernance.sol` | Keep deployed; do NOT self-destruct. Any in-flight proposals must complete first. Stop routing new proposals to it. |
| `NftVetoRegistry.sol` | `NftApprovalRegistry.sol` | Same as above — keep deployed until all old proposals finish. |
| `DealGovernor.sol` / `DealDao.sol` | `DealGovernance.sol` | If either holds `executor` role on VoteDividendClaimer or admin rights on other contracts, those roles must be transferred before decommissioning. |

---

## Deployment & Wiring Steps (recommended order)

1. **Deploy `NftApprovalRegistry`**
   - Args: `(infoNftAddress, activityRecorderAddress)`
   - Call `setGovernor(newDealGovernanceAddress, true)` AFTER step 2 (or pre-authorize with a placeholder and update)

2. **Deploy `DealGovernance`**
   - Args: `(dTokenAddress, nftApprovalRegistryAddress)`
   - This contract must be approved to transfer D on behalf of stakers — stakers grant approval themselves via standard ERC-20 `approve()`, so no protocol-level change is needed here.

3. **Wire NftApprovalRegistry → DealGovernance**
   - Call `NftApprovalRegistry.setGovernor(dealGovernanceAddress, true)`

4. **Update VoteDividendClaimer**
   - Call `VoteDividendClaimer.setGovernanceContract(dealGovernanceAddress)`
   - Caller must be the current `executor` of VoteDividendClaimer

5. **Transfer admin/executor roles to DealGovernance** (or a timelock wrapping it)
   - Identify every contract that has `executor`, `owner`, or role-based admin currently held by the old governor or a multisig
   - For each: call the appropriate setter (e.g., `setExecutor(newGov)`, `transferOwnership(newGov)`)
   - **Do this last** — once DealGovernance holds these roles, all future parameter changes must go through governance proposals

6. **Grant NftApprovalRegistry ownership to DealGovernance** (or a multisig)
   - Call `NftApprovalRegistry.transferOwnership(dealGovernanceAddress)`

---

## Key Risks to Evaluate

### R1 — Physical D transfer approval
When a user calls `DealGovernance.stake()`, the contract does `IERC20(dToken).safeTransferFrom(msg.sender, address(this), amount)`. Users must have called `D.approve(dealGovernanceAddress, amount)` first. **No risk to existing balances** — this is a standard ERC-20 pull. Confirm the frontend approves before staking.

### R2 — Staked D leaves wallet during voting period
Because D is physically moved, wallet balance drops. The `getPastStakedOf` checkpoint in `DealGovernance` compensates for this in dividend calculations — but only once `setGovernanceContract()` is called on `VoteDividendClaimer`. If a dividend round is created between DealGovernance deployment and `setGovernanceContract()` being called, stakers in that window will under-claim. **Mitigate**: call `setGovernanceContract()` in the same deployment batch.

### R3 — Auto-return gas limit
`_returnAllStakes()` loops all stakers in a proposal. With 100 D total supply and 2.5 D minimum stake, the max staker list is 40 addresses. At ~30,000 gas per ERC-20 transfer, this is ~1.2M gas per execute/veto/cancel — well within block limits on agiking chain. Confirm the chain's block gas limit is ≥ 3M.

### R4 — NftApprovalRegistry ownership
The `setGovernor()` function on NftApprovalRegistry is `onlyOwner`. After deployment the deployer is owner. Before transferring ownership to DealGovernance, ensure DealGovernance can execute a `setGovernor()` call via a proposal (it can — the action would be `NftApprovalRegistry.setGovernor(addr, bool)` as a `Parameter` proposal).

### R5 — Old proposals in DealSeatVetoGovernor
Any proposals currently in the old governor that have not been executed or vetoed will remain there. They cannot be migrated. They will complete (or expire) under the old rules. Confirm whether any live proposals exist before decommissioning.

### R6 — Treasury proposals have no veto
This is intentional by design. Confirm stakeholders understand that once 70 D is staked in support of a Treasury proposal, it executes with no veto mechanism. The only protection is the proposer's `cancel()`.

### R7 — NftApprovalRegistry activeSupplySnapshot
The snapshot is taken at proposal activation time (when staked D first crosses 2.5 D), not at execution time. If the active NFT supply changes significantly between activation and execution, the threshold could be harder or easier to meet than expected. The registry's `isActive` gate prevents governance-inactive NFTs from voting, which bounds the pool.

### R8 — Clock alignment
`DealGovernance._checkpointStaked()` reads `dToken.clock()` (EIP-6372, timestamp-based). `VoteDividendClaimer.createRound()` also uses `votesClock.clock()` (same D token). These must use the same timepoint domain. They do — both call `D.clock()`. No issue.

---

## Questions for the Evaluating AI

1. Do any currently deployed contracts grant admin rights to `DealSeatVetoGovernor` or `DealDao` that must be migrated?
2. Is there a timelock contract sitting between the governor and the protocol contracts? If so, it may need to be updated to point at `DealGovernance` as the proposer/executor.
3. Are there any live proposals in the old governor today?
4. What is the block gas limit on agiking chain (chainId 31415926)?
5. Does the frontend wallet currently auto-approve D transfers, or does the user need a new approval flow for staking?
6. Is `VoteDividendClaimer.executor` currently set to a multisig, the old governor, or `address(0)`? Who can call `setGovernanceContract()`?
