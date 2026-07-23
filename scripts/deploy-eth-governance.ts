/**
 * Deploy and wire the full DealGovernance DAO on ETH mainnet without
 * redeploying the protocol stack.
 *
 * Scope:
 * - Deploy DealGovernance implementation + ERC1967Proxy.
 * - Initialize it with the already deployed D, DC, treasury, and NFT veto registry.
 * - Allow DealGovernance in NftVetoRegistry.
 * - Wire VoteDividendClaimer.governanceContract for staked-D dividend accounting.
 * - Point CrossChainBroadcaster.governance to DealGovernance.
 * - Update deployments/eth-mainnet-1.json and frontend handoff docs.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { encodeFunctionData, formatEther, getAddress, zeroAddress, type Address } from "viem";

type DeploymentJson = {
  chainId: number;
  network: string;
  deployedAt: string;
  deployer: Address;
  addresses: Record<string, Address>;
  abi: Record<string, unknown[]>;
  params?: Record<string, unknown>;
  notes?: string[];
};

const DEPLOYMENT_FILE = "eth-mainnet-1.json";
const CROSS_CHAIN_FILE = "mainnet-cross-chain.json";
const EXPECTED_CHAIN_ID = 1;

const ownableAbi = [
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

const broadcasterAbi = [
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "governance", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "setGovernance", inputs: [{ name: "gov", type: "address" }], outputs: [], stateMutability: "nonpayable" },
] as const;

const voteClaimerAbi = [
  { type: "function", name: "executor", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "governanceContract", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "setGovernanceContract", inputs: [{ name: "gov", type: "address" }], outputs: [], stateMutability: "nonpayable" },
] as const;

const nftVetoAbi = [
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "isGovernor", inputs: [{ name: "", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "setGovernor", inputs: [{ name: "governor", type: "address" }, { name: "allowed", type: "bool" }], outputs: [], stateMutability: "nonpayable" },
] as const;

function loadEnv() {
  try {
    readFileSync(".env", "utf8").split("\n").forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] ||= m[2].trim();
    });
  } catch {}
}

function loadDeployment(): DeploymentJson {
  return JSON.parse(readFileSync(join(process.cwd(), "deployments", DEPLOYMENT_FILE), "utf8")) as DeploymentJson;
}

function loadCrossChainBroadcaster(): Address {
  const state = JSON.parse(readFileSync(join(process.cwd(), "deployments", CROSS_CHAIN_FILE), "utf8")) as {
    eth?: { broadcaster?: string };
  };
  if (!state.eth?.broadcaster) throw new Error(`Missing eth.broadcaster in deployments/${CROSS_CHAIN_FILE}`);
  return getAddress(state.eth.broadcaster) as Address;
}

function loadAbi(relativeArtifactJson: string): unknown[] {
  return (JSON.parse(readFileSync(
    join(process.cwd(), "artifacts", "contracts", relativeArtifactJson),
    "utf8",
  )) as { abi: unknown[] }).abi;
}

function artifactAbi(name: string): unknown[] {
  if (name !== "ERC1967Proxy") throw new Error(`Unknown artifact: ${name}`);
  const candidates = [
    join(process.cwd(), "artifacts", "contracts", "TestProxy.sol", "ERC1967Proxy.json"),
    join(process.cwd(), "artifacts", "@openzeppelin", "contracts", "proxy", "ERC1967", "ERC1967Proxy.sol", "ERC1967Proxy.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
  }
  throw new Error("ERC1967Proxy artifact not found. Run hardhat compile first.");
}

async function waitFor(publicClient: any, hash: `0x${string}`, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`ok ${label}: ${hash}`);
  return receipt;
}

function same(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase();
}

async function main() {
  loadEnv();

  const depJson = loadDeployment();
  const a = depJson.addresses;
  const treasury = getAddress(String(a.protocolTreasury ?? depJson.params?.treasury ?? "")) as Address;
  const broadcaster = loadCrossChainBroadcaster();
  const { viem } = await network.connect({ network: "ethMainnet", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const client = { public: publicClient, wallet: deployer } as const;

  const chainId = Number(await publicClient.getChainId());
  if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`Wrong chainId: ${chainId}`);

  const dep = getAddress(deployer.account.address) as Address;
  console.log("network: eth mainnet");
  console.log("deployer:", dep);
  console.log("balance:", formatEther(await publicClient.getBalance({ address: dep })), "ETH");

  const required: Record<string, Address | undefined> = {
    dToken: a.dToken,
    dlToken: a.dlToken,
    protocolTreasury: treasury,
    nftVetoRegistry: a.nftVetoRegistry,
    voteDividendClaimer: a.voteDividendClaimer,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value || value === zeroAddress) throw new Error(`Missing deployments.${key}`);
  }

  if (a.dealGovernance && a.dealGovernance !== zeroAddress) {
    throw new Error(`deployments already has dealGovernance=${a.dealGovernance}; refusing to deploy duplicate`);
  }

  const nftOwner = getAddress(await publicClient.readContract({ address: a.nftVetoRegistry, abi: ownableAbi, functionName: "owner" }) as string) as Address;
  const claimerExecutor = getAddress(await publicClient.readContract({ address: a.voteDividendClaimer, abi: voteClaimerAbi, functionName: "executor" }) as string) as Address;
  const currentGovContract = getAddress(await publicClient.readContract({ address: a.voteDividendClaimer, abi: voteClaimerAbi, functionName: "governanceContract" }) as string) as Address;
  const broadcasterOwner = getAddress(await publicClient.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "owner" }) as string) as Address;
  const currentBroadcasterGov = getAddress(await publicClient.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "governance" }) as string) as Address;

  console.log("nftVetoRegistry.owner:", nftOwner);
  console.log("voteDividendClaimer.executor:", claimerExecutor);
  console.log("voteDividendClaimer.governanceContract:", currentGovContract);
  console.log("crossChainBroadcaster:", broadcaster);
  console.log("crossChainBroadcaster.owner:", broadcasterOwner);
  console.log("crossChainBroadcaster.governance:", currentBroadcasterGov);

  if (!same(nftOwner, dep)) throw new Error(`deployer is not NftVetoRegistry owner`);
  if (!same(claimerExecutor, dep)) throw new Error(`deployer is not VoteDividendClaimer executor`);
  if (!same(broadcasterOwner, dep)) throw new Error(`deployer is not CrossChainBroadcaster owner`);

  const govAbi = loadAbi("DealGovernance.sol/DealGovernance.json");
  const hasGetProposals = govAbi.some((x: any) => x.type === "function" && x.name === "getProposals");
  const hasStake = govAbi.some((x: any) => x.type === "function" && x.name === "stake");
  const hasExecute = govAbi.some((x: any) => x.type === "function" && x.name === "execute");
  if (!hasGetProposals || !hasStake || !hasExecute) {
    throw new Error("DealGovernance ABI does not look complete; run hardhat compile first.");
  }

  console.log("deploying DealGovernance implementation...");
  const impl = await viem.deployContract("DealGovernance", [], { client });
  const implAddress = getAddress(impl.address) as Address;
  console.log("DealGovernance impl:", implAddress);

  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [a.dToken, a.nftVetoRegistry, a.dlToken, treasury],
  });
  console.log("deploying DealGovernance proxy...");
  const proxy = await viem.deployContract("ERC1967Proxy", [implAddress, initData], { client });
  const proxyAddress = getAddress(proxy.address) as Address;
  console.log("DealGovernance proxy:", proxyAddress);

  const governance = await viem.getContractAt("DealGovernance", proxyAddress, { client });
  const activationThreshold = await governance.read.activationThreshold();
  const fastPassThreshold = await governance.read.fastPassThreshold();
  const majorProposalFee = await governance.read.majorProposalFee();
  const initializedD = getAddress(await governance.read.dToken() as string) as Address;
  const initializedDc = getAddress(await governance.read.dcToken() as string) as Address;
  const initializedTreasury = getAddress(await governance.read.treasury() as string) as Address;
  const initializedNftRegistry = getAddress(await governance.read.nftVetoRegistry() as string) as Address;

  if (!same(initializedD, a.dToken)) throw new Error("DealGovernance dToken mismatch");
  if (!same(initializedDc, a.dlToken)) throw new Error("DealGovernance dcToken mismatch");
  if (!same(initializedTreasury, treasury)) throw new Error("DealGovernance treasury mismatch");
  if (!same(initializedNftRegistry, a.nftVetoRegistry)) throw new Error("DealGovernance nftVetoRegistry mismatch");
  console.log("activationThreshold:", activationThreshold.toString());
  console.log("fastPassThreshold:", fastPassThreshold.toString());
  console.log("majorProposalFee:", majorProposalFee.toString());

  await waitFor(
    publicClient,
    await deployer.writeContract({ address: a.nftVetoRegistry, abi: nftVetoAbi, functionName: "setGovernor", args: [proxyAddress, true] }),
    "NftVetoRegistry.setGovernor(DealGovernance,true)",
  );
  await waitFor(
    publicClient,
    await deployer.writeContract({ address: a.voteDividendClaimer, abi: voteClaimerAbi, functionName: "setGovernanceContract", args: [proxyAddress] }),
    "VoteDividendClaimer.setGovernanceContract",
  );
  await waitFor(
    publicClient,
    await deployer.writeContract({ address: broadcaster, abi: broadcasterAbi, functionName: "setGovernance", args: [proxyAddress] }),
    "CrossChainBroadcaster.setGovernance",
  );

  const isGov = await publicClient.readContract({ address: a.nftVetoRegistry, abi: nftVetoAbi, functionName: "isGovernor", args: [proxyAddress] });
  const finalGovContract = getAddress(await publicClient.readContract({ address: a.voteDividendClaimer, abi: voteClaimerAbi, functionName: "governanceContract" }) as string) as Address;
  const finalBroadcasterGov = getAddress(await publicClient.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "governance" }) as string) as Address;
  if (!isGov) throw new Error("NftVetoRegistry did not accept DealGovernance");
  if (!same(finalGovContract, proxyAddress)) throw new Error("VoteDividendClaimer governanceContract not wired");
  if (!same(finalBroadcasterGov, proxyAddress)) throw new Error("CrossChainBroadcaster governance not wired");

  const deployedAt = new Date().toISOString();
  const dir = join(process.cwd(), "deployments");
  mkdirSync(join(dir, "backups"), { recursive: true });
  const filePath = join(dir, DEPLOYMENT_FILE);
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  copyFileSync(filePath, join(dir, "backups", `eth-mainnet-1.before-governance-${stamp}.json`));

  depJson.addresses.dealGovernance = proxyAddress;
  depJson.addresses.dealGovernanceImpl = implAddress;
  depJson.addresses.crossChainBroadcaster = broadcaster;
  depJson.addresses.protocolTreasury = treasury;
  depJson.abi.DealGovernance = govAbi;
  depJson.abi.ERC1967Proxy = depJson.abi.ERC1967Proxy ?? artifactAbi("ERC1967Proxy");
  depJson.abi.CrossChainBroadcaster = loadAbi("bridge/CrossChainBroadcaster.sol/CrossChainBroadcaster.json");
  depJson.deployedAt = deployedAt;
  depJson.notes = [
    ...(depJson.notes ?? []),
    `[${deployedAt}] DealGovernance deployed and wired: proxy=${proxyAddress} impl=${implAddress}; CrossChainBroadcaster=${broadcaster}`,
  ];
  writeFileSync(filePath, JSON.stringify(depJson, null, 2), "utf8");

  const handoff = [
    "# ETH 主网 DealGovernance 补全部署",
    "",
    `部署时间：${deployedAt}`,
    "",
    "链：Ethereum Mainnet (1)",
    "",
    `部署钱包：\`${dep}\``,
    "",
    "## 新增 / 更新地址",
    "",
    "| 模块 | 地址 |",
    "| --- | --- |",
    `| DealGovernance proxy | \`${proxyAddress}\` |`,
    `| DealGovernance implementation | \`${implAddress}\` |`,
    `| CrossChainBroadcaster | \`${broadcaster}\` |`,
    `| D | \`${a.dToken}\` |`,
    `| DealCoin/DC | \`${a.dlToken}\` |`,
    `| ProtocolTreasury | \`${treasury}\` |`,
    `| NftVetoRegistry | \`${a.nftVetoRegistry}\` |`,
    `| VoteDividendClaimer | \`${a.voteDividendClaimer}\` |`,
    "",
    "## 接线结果",
    "",
    "- `NftVetoRegistry.isGovernor(DealGovernance) = true`",
    "- `VoteDividendClaimer.governanceContract = DealGovernance`",
    "- `CrossChainBroadcaster.governance = DealGovernance`",
    "",
    "## 前端对接",
    "",
    "- 完整 DAO 页面使用 `DealGovernance` ABI + `dealGovernance` 地址。",
    "- 旧 `DealSeatVetoGovernor` 仍在部署文件中，但只作为旧席位否决制入口，不作为完整 DAO 主入口。",
    "- 跨链参数广播入口仍是 `CrossChainBroadcaster`，但现在只能由 `DealGovernance.execute()` 调用。",
    "",
  ].join("\n");
  writeFileSync(join(dir, `frontend-handoff-eth-governance-${stamp}.md`), handoff, "utf8");

  console.log("done");
  console.log("DealGovernance:", proxyAddress);
  console.log("DealGovernanceImpl:", implAddress);
  console.log("Updated:", filePath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
