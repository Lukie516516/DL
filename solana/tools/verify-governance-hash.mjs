import {
  concat,
  getBytes,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
} from "ethers";

const EXPECTED = "0xc8c0bf0f7dd412192c28fc58daa8ff7835019222924b4c10606471cea2c8448a";

const uint = (value, size) => getBytes(zeroPadValue(toBeHex(value), size));

const canonical = concat([
  toUtf8Bytes("DEAL_GOVERNANCE_V1"),
  uint(1, 1),
  uint(1, 8),
  new Uint8Array(32).fill(7),
  uint(1, 8),
  uint(42, 8),
  uint(1, 1),
  new Uint8Array(32).fill(8),
  uint(100, 8),
  uint(200, 8),
  uint(1, 2),
  new Uint8Array(32).fill(6),
  uint(1, 1),
  uint(0, 1),
  getBytes(keccak256(Uint8Array.from([1, 2, 3, 4]))),
]);

const actual = keccak256(canonical);
if (actual !== EXPECTED) {
  throw new Error(`governance hash mismatch: expected ${EXPECTED}, got ${actual}`);
}

console.log(actual);
