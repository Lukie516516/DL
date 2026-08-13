# Terminal Guard Design

## Goal

The official SDK must not be the only protection for the economically critical
terminal Deal path. A third-party client or wrapper must not be able to commit
asset resolution while omitting fee routing, the terminal receipt, valuation,
reward minting, or credit recording.

Derived discovery indexes and identity unlocks must remain permissionless,
replay-safe, and retryable after the economic core commits.

## Chosen design

Keep the existing 28 Program architecture and add a shared, non-Program Rust
crate: `deal-terminal-guard`.

Each terminal checkpoint reads the Instructions sysvar and validates:

1. The current top-level instruction is the expected official Program and
   Anchor discriminator. This rejects a third-party wrapper that invokes a
   protected instruction through CPI.
2. Required economic-core instructions are contiguous and in canonical order.
3. Every following instruction uses the expected Program, discriminator, Deal,
   receipt, identity, role, or side.
4. Dynamic credit requirements are derived from the immutable on-chain
   AssetTerms. The caller is never trusted to self-report the identity mode.

Solana transaction atomicity guarantees that a failure anywhere in the guarded
economic core rolls back assets, fees, rewards, and credit.

## Checkpoint chain

```text
AssetController terminal resolution
  -> DC/DC only: AssetController C-fee transfer or burn
  -> Finalizer terminal receipt
  -> CreditValuator receipt
  -> RewardEngine quote
  -> RewardEngine mint receipt
  -> Finalizer credit receipt
```

The permissionless post-index transaction is:

```text
Finalizer completed-history receipt and A/B history
  -> non-zero Identity reward records
  -> Reward result indexes
  -> Credit result indexes
  -> AssetController-wrapped A/B Identity unlocks
```

The concrete economic suffix is computed in stages:

- AssetController proves that DC/DC resolution is immediately followed by the
  official fee-routing instruction, and that fee routing is immediately
  followed by Finalizer. Non-DC/DC resolution still points directly to
  Finalizer.
- Finalizer and Valuator prove the fixed completed/non-completed continuation.
- RewardEngine requires the correct pair, single-A, single-B, or no-identity
  Finalizer credit instruction.
- Finalizer validates the current top-level credit instruction. It no longer
  requires unlocks in the same transaction because doing so pushes the maximum
  production path over the runtime account-lock limit.

The post-index transaction uses canonical init PDAs for completed history,
identity reward receipts, and result markers. If any post step fails, the whole
post transaction rolls back and identities remain locked. Any signer can retry.
After success, replay fails without duplicating history or result counts.
Before retrying, the keeper reads every expected receipt/marker and AssetTerms,
then passes only still-pending roles, sides, and identity mints to the SDK. This
also recovers safely if a third party completed a valid subset first.

## Rollout rule

Do not enable a partial guard in a deployed configuration. All protected
Programs, IDLs, both SDK builders, runtime tests, transaction-size tests, and
compute-budget tests must be updated as one release.

## Current implementation status

The shared validation crate, both SDK builders, and the economic checkpoints
are implemented locally. Pair, A-only, B-only, and no-identity credit paths are
covered. DC/DC additionally requires the identity-aware fee route; Finalizer
refuses completed deals until AssetTerms records both resolution and fee
routing.

The original one-transaction design was executed with real SBF programs and
failed at 74 locked accounts. The bounded design now passes:

- conservative SDK models: 59 DC/DC core, 59 maximum reward core, and 58
  maximum post-index accounts;
- real DC/DC LiteSVM: 58-account/619-byte core with 425,706 maximum observed
  CU, and 39-account/474-byte post-index with 220,564 maximum observed CU
  across 20 independently generated PDA sets;
- replay of the completed post-index transaction fails without changing
  history or result counts.

Production release still requires persistent Devnet deployment and real
cluster signatures. The current Devnet wallet has 0 SOL and none of the 24
production programs are deployed, so local evidence is not represented as
cluster-level evidence.

Identity unlock expectations must target `deal_asset_controller.unlock_identity`.
The AssetController config PDA is the configured Identity controller and signs
the downstream CPI; a direct top-level `deal_identity.unlock_identity` is not a
valid production terminal step.
