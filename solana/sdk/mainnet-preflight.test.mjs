import assert from "node:assert/strict";
import test from "node:test";

import {
  MAINNET_GENESIS_HASH,
  readRpc,
} from "./mainnet-preflight.mjs";

test("Mainnet preflight pins the complete Solana genesis hash", () => {
  assert.equal(
    MAINNET_GENESIS_HASH,
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  );
});

test("Mainnet preflight retries only transient RPC failures", async () => {
  let attempts = 0;
  const result = await readRpc("test RPC", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("fetch failed");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 2);

  let deterministicAttempts = 0;
  await assert.rejects(
    readRpc("test RPC", async () => {
      deterministicAttempts += 1;
      throw new Error("403 Forbidden");
    }),
    /test RPC failed: 403 Forbidden/,
  );
  assert.equal(deterministicAttempts, 1);
});
