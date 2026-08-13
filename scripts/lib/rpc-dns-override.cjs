"use strict";

const dns = require("node:dns");
const net = require("node:net");

const entries = (process.env.RPC_DNS_OVERRIDES || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separator = entry.lastIndexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid RPC_DNS_OVERRIDES entry: ${entry}`);
    }
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  });

const overrides = new Map(entries);
const originalLookup = dns.lookup.bind(dns);

dns.lookup = function lookup(hostname, options, callback) {
  let resolvedOptions = options;
  let resolvedCallback = callback;

  if (typeof options === "function") {
    resolvedOptions = {};
    resolvedCallback = options;
  } else if (typeof options === "number") {
    resolvedOptions = { family: options };
  } else {
    resolvedOptions = options || {};
  }

  const address = overrides.get(hostname);
  if (!address) {
    return originalLookup(hostname, options, callback);
  }

  const family = net.isIP(address);
  if (!family) {
    queueMicrotask(() =>
      resolvedCallback(new Error(`Invalid DNS override address for ${hostname}`)),
    );
    return;
  }

  queueMicrotask(() => {
    if (resolvedOptions.all) {
      resolvedCallback(null, [{ address, family }]);
      return;
    }
    resolvedCallback(null, address, family);
  });
};
