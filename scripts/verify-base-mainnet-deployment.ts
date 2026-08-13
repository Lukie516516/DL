import { readFileSync } from "node:fs";

import {
  createPublicClient,
  fallback,
  formatEther,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { base } from "viem/chains";

type Deployment = {
  chainId: number;
  network: string;
  deployer: Address;
  addresses: Record<string, Address>;
  abi: Record<string, readonly unknown[]>;
  params: Record<string, unknown>;
};

const FILE = process.env.BASE_DEPLOYMENT_FILE?.trim() || "deployments/base-mainnet-8453.json";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const pairManagerAbi = parseAbi([
  "function factory() view returns (address)",
  "function owner() view returns (address)",
  "function pairForToken(address) view returns (address)",
]);
const pairAbi = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidityInited() view returns (bool)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function getVirtualReserves() view returns (uint256,uint256)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function PAUSER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
]);

function same(a: unknown, b: unknown) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function implementationFromWord(word: string | undefined): Address {
  assertThat(word && word !== "0x", "empty ERC-1967 implementation slot");
  return getAddress(`0x${word.slice(-40)}`);
}

async function main() {
  const deployment = JSON.parse(readFileSync(FILE, "utf8")) as Deployment;
  assertThat(deployment.chainId === 8453 && deployment.network === "base-mainnet", "not Base mainnet deployment");
  assertThat(deployment.params.deployDao === false, "Base secondary-chain deployment must not contain DAO");

  const a = deployment.addresses;
  const deployer = getAddress(deployment.deployer);
  const client: any = createPublicClient({
    chain: base,
    transport: fallback([
      http(process.env.BASE_MAINNET_RPC_URL?.trim() || "https://mainnet.base.org", { timeout: 30_000 }),
      http("https://base-mainnet.public.blastapi.io", { timeout: 30_000 }),
      http("https://base-rpc.publicnode.com", { timeout: 30_000 }),
    ], { rank: false }),
  });
  assertThat(await client.getChainId() === 8453, "RPC is not Base mainnet");

  for (const forbidden of ["dToken", "dealGovernance", "satoshiVault", "voteDividendClaimer"]) {
    assertThat(!a[forbidden] || same(a[forbidden], ZERO), `unexpected secondary-chain module: ${forbidden}`);
  }

  const codeChecks = await Promise.all(Object.entries(a).map(async ([name, address]) => ({
    name,
    address: getAddress(address),
    code: await client.getCode({ address: getAddress(address) }),
  })));
  const missingCode = codeChecks.filter((item) => !item.code || item.code === "0x");
  assertThat(missingCode.length === 0, `addresses without runtime code: ${missingCode.map((item) => item.name).join(", ")}`);

  const read = (contract: string, address: Address, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi: deployment.abi[contract], functionName, args });
  const factory = getAddress(a.dealFactory);
  const dc = getAddress(a.dlToken);
  const treasury = getAddress(a.protocolTreasury);
  const pairManager = getAddress(a.dealPairManager);

  const [factoryImplWord, rankImplWord] = await Promise.all([
    client.getStorageAt({ address: factory, slot: IMPLEMENTATION_SLOT }),
    client.getStorageAt({ address: getAddress(a.dcDomainRank), slot: IMPLEMENTATION_SLOT }),
  ]);
  assertThat(same(implementationFromWord(factoryImplWord), a.dealFactoryImplementation), "Factory proxy implementation mismatch");
  assertThat(same(implementationFromWord(rankImplWord), a.dcDomainRankImplementation), "DomainRank proxy implementation mismatch");

  const factoryAddressChecks: Array<[string, Address]> = [
    ["owner", deployer],
    ["admin", deployer],
    ["dlToken", dc],
    ["infoNft", getAddress(a.dealInfoNFT)],
    ["wrappedNative", getAddress(a.wrappedNative)],
    ["dealPairManager", pairManager],
    ["dealMessageHub", getAddress(a.dealMessageHub)],
    ["creditGraph", getAddress(a.dealCreditGraph)],
    ["dealActivityIndex", getAddress(a.dealActivityIndex)],
    ["dealResultIndex", getAddress(a.dealResultIndex)],
    ["dealImplementationRegistry", getAddress(a.dealImplementationRegistry)],
    ["recognizedToken0", getAddress(a.stable0)],
    ["recognizedToken1", getAddress(a.stable1)],
    ["treasury", treasury],
    ["swapOrderBook", getAddress(a.dealSwapOrderBook)],
    ["dcDomainRank", getAddress(a.dcDomainRank)],
    ["crossChainGovernance", ZERO],
  ];
  for (const [getter, expected] of factoryAddressChecks) {
    assertThat(same(await read("DealFactory", factory, getter), expected), `Factory.${getter} mismatch`);
  }
  assertThat(await read("DealFactory", factory, "allowedMarginToken", [getAddress(a.stable0)]), "USDC margin token disabled");
  assertThat(await read("DealFactory", factory, "allowedMarginToken", [getAddress(a.stable1)]), "USDT margin token disabled");
  assertThat(await read("DealFactory", factory, "allowedMarginToken", [getAddress(a.wrappedNative)]), "WETH margin token disabled");
  assertThat(await read("DealFactory", factory, "isAllowedCreateFor", [getAddress(a.dcDomainSwap)]), "DCDomainSwap not allowed");
  assertThat(await read("DealFactory", factory, "isAllowedCreateFor", [getAddress(a.dcDomainHall)]), "DCDomainHall not allowed");
  assertThat(await read("DealFactory", factory, "msgPriceEnabled") === true, "message fee should be enabled");
  assertThat(same(await read("DealFactory", factory, "msgPriceToken"), dc), "message fee token mismatch");
  assertThat(BigInt(await read("DealFactory", factory, "msgPriceAmountInToken") as bigint) === 100n * 10n ** 18n, "message price mismatch");
  assertThat(BigInt(await read("DealFactory", factory, "minTimeoutSeconds") as bigint) === 3600n, "minimum timeout mismatch");

  const [totalSupply, adminRole, minterRole, pauserRole] = await Promise.all([
    client.readContract({ address: dc, abi: erc20Abi, functionName: "totalSupply" }),
    client.readContract({ address: dc, abi: erc20Abi, functionName: "DEFAULT_ADMIN_ROLE" }),
    client.readContract({ address: dc, abi: erc20Abi, functionName: "MINTER_ROLE" }),
    client.readContract({ address: dc, abi: erc20Abi, functionName: "PAUSER_ROLE" }),
  ]);
  assertThat(totalSupply === 0n, `DC supply must still be zero, got ${totalSupply}`);
  for (const [roleName, role] of [["admin", adminRole], ["minter", minterRole]] as const) {
    assertThat(await client.readContract({ address: dc, abi: erc20Abi, functionName: "hasRole", args: [role, deployer] }), `deployer missing DC ${roleName} role`);
  }
  assertThat(
    !(await client.readContract({ address: dc, abi: erc20Abi, functionName: "hasRole", args: [pauserRole, deployer] })),
    "deployer unexpectedly has the not-yet-wired DC pauser role",
  );
  assertThat(await client.readContract({ address: dc, abi: erc20Abi, functionName: "hasRole", args: [minterRole, factory] }), "Factory missing DC minter role");

  assertThat(same(await read("ProtocolTreasury", treasury, "controller"), deployer), "Treasury controller mismatch");
  assertThat(same(await read("ProtocolTreasury", treasury, "bootstrapAdmin"), deployer), "Treasury bootstrap admin mismatch");
  assertThat(await read("ProtocolTreasury", treasury, "bootstrapLocked") === false, "Treasury bootstrap unexpectedly locked");

  assertThat(same(await client.readContract({ address: pairManager, abi: pairManagerAbi, functionName: "factory" }), factory), "PairManager factory mismatch");
  assertThat(same(await client.readContract({ address: pairManager, abi: pairManagerAbi, functionName: "owner" }), deployer), "PairManager owner mismatch");
  const pools = [
    ["DC/USDC", getAddress(a.stable0), getAddress(a.pairStable0)],
    ["DC/bridged USDT", getAddress(a.stable1), getAddress(a.pairStable1)],
    ["DC/WETH", getAddress(a.wrappedNative), getAddress(a.pairWrappedNative)],
  ] as const;
  for (const [label, other, pair] of pools) {
    const [mapped, token0, token1, pairFactory, initialized, reserves, virtuals, dcBalance, otherBalance] = await Promise.all([
      client.readContract({ address: pairManager, abi: pairManagerAbi, functionName: "pairForToken", args: [other] }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "token1" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "factory" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "liquidityInited" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "getVirtualReserves" }),
      client.readContract({ address: dc, abi: erc20Abi, functionName: "balanceOf", args: [pair] }),
      client.readContract({ address: other, abi: erc20Abi, functionName: "balanceOf", args: [pair] }),
    ]);
    assertThat(same(mapped, pair), `${label} PairManager mapping mismatch`);
    assertThat(same(token0, dc) && same(token1, other), `${label} token order mismatch`);
    assertThat(same(pairFactory, pairManager), `${label} controller mismatch`);
    assertThat(initialized === false, `${label} unexpectedly initialized`);
    assertThat(reserves[0] === 0n && reserves[1] === 0n, `${label} reserves are not zero`);
    assertThat(virtuals[0] === 0n && virtuals[1] === 0n, `${label} virtual reserves are not zero`);
    assertThat(dcBalance === 0n && otherBalance === 0n, `${label} token balances are not zero`);
  }

  assertThat(same(await read("DealSwapOrderBook", getAddress(a.dealSwapOrderBook), "owner"), deployer), "OrderBook owner mismatch");
  assertThat(same(await read("DealSwapOrderBook", getAddress(a.dealSwapOrderBook), "router"), a.dealRouter), "OrderBook router mismatch");
  assertThat(same(await read("DealSwapOrderBook", getAddress(a.dealSwapOrderBook), "treasury"), treasury), "OrderBook treasury mismatch");
  assertThat(same(await read("DealRouter", getAddress(a.dealRouter), "PAIR_MANAGER"), pairManager), "Router PairManager mismatch");
  assertThat(same(await read("DealRouter", getAddress(a.dealRouter), "ORDER_BOOK"), a.dealSwapOrderBook), "Router OrderBook mismatch");
  assertThat(same(await read("DealRouter", getAddress(a.dealRouter), "WNATIVE"), a.wrappedNative), "Router WETH mismatch");

  assertThat(same(await read("DealInfoNFT", getAddress(a.dealInfoNFT), "owner"), deployer), "InfoNFT owner mismatch");
  assertThat(same(await read("DealInfoNFT", getAddress(a.dealInfoNFT), "admin"), deployer), "InfoNFT admin mismatch");
  assertThat(same(await read("DealInfoNFT", getAddress(a.dealInfoNFT), "factory"), factory), "InfoNFT factory mismatch");
  assertThat(same(await read("DealInfoNFT", getAddress(a.dealInfoNFT), "renderer"), a.dealInfoNFTRenderer), "InfoNFT renderer mismatch");
  assertThat(await read("DealCreditGraph", getAddress(a.dealCreditGraph), "isRecorder", [factory]), "Factory is not CreditGraph recorder");

  const domain = getAddress(a.dcDomain);
  const rank = getAddress(a.dcDomainRank);
  assertThat(same(await read("DCDomain", domain, "owner"), deployer), "DCDomain owner mismatch");
  assertThat(same(await read("DCDomain", domain, "paymentToken"), dc), "DCDomain payment token mismatch");
  assertThat(same(await read("DCDomain", domain, "treasury"), treasury), "DCDomain treasury mismatch");
  assertThat(same(await read("DCDomain", domain, "domainMarket"), a.dcDomainMarket), "DCDomain market mismatch");
  assertThat(same(await read("DCDomainRank", rank, "owner"), deployer), "DCDomainRank owner mismatch");
  assertThat(same(await read("DCDomainRank", rank, "dcToken"), dc), "DCDomainRank DC mismatch");
  assertThat(same(await read("DCDomainRank", rank, "dcDomain"), domain), "DCDomainRank domain mismatch");
  assertThat(same(await read("DCDomainRank", rank, "treasury"), treasury), "DCDomainRank treasury mismatch");
  assertThat(same(await read("DCDomainRank", rank, "autoCloser"), factory), "DCDomainRank autoCloser mismatch");
  assertThat(await read("DCDomainRank", rank, "isDealReporter", [getAddress(a.dcDomainSwap)]), "DCDomainSwap is not reporter");
  assertThat(await read("DCDomainRank", rank, "isDealReporter", [getAddress(a.dcDomainHall)]), "DCDomainHall is not reporter");

  const registry = getAddress(a.dealImplementationRegistry);
  const implementations: Array<[string, Address]> = [
    ["fallbackImplementation", getAddress(a.dealImplementation)],
    ["noAssetImplementation", getAddress(a.dealNoAssetImplementation)],
    ["aAssetNftImplementation", getAddress(a.dealAAssetNftImplementation)],
    ["bAssetNftImplementation", getAddress(a.dealBAssetNftImplementation)],
    ["aAssetNftOnlyImplementation", getAddress(a.dealAAssetNftOnlyImplementation)],
    ["bAssetNftOnlyImplementation", getAddress(a.dealBAssetNftOnlyImplementation)],
    ["openTokenTokenImplementation", getAddress(a.dealOpenTokenTokenImplementation)],
  ];
  for (const [getter, expected] of implementations) {
    assertThat(same(await read("DealImplementationRegistry", registry, getter), expected), `Registry.${getter} mismatch`);
  }

  const [blockNumber, nativeBalance] = await Promise.all([
    client.getBlockNumber(),
    client.getBalance({ address: deployer }),
  ]);
  console.log(JSON.stringify({
    status: "PASS",
    network: deployment.network,
    chainId: deployment.chainId,
    blockNumber: blockNumber.toString(),
    deploymentFile: FILE,
    contractsWithCode: codeChecks.length,
    factoryImplementation: implementationFromWord(factoryImplWord),
    domainRankImplementation: implementationFromWord(rankImplWord),
    dcTotalSupply: totalSupply.toString(),
    pools: pools.map(([label, token, pair]) => ({ label, token, pair, initialized: false })),
    crossChainGovernance: ZERO,
    daoDeployed: false,
    deployerBaseEth: formatEther(nativeBalance),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
