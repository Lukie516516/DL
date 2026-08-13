# Entry composition experiment

This isolated experiment proves that unchanged Anchor handlers can be linked
behind one deployed Solana entrypoint. The first instruction byte selects the
legacy module and all remaining bytes are the original Anchor calldata.

It is intentionally outside both production and Compact V2 workspaces. It is
not a deployment artifact and its program id has no retained upgrade key.
