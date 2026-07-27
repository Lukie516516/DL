import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type Deployment = {
  chainId: number;
  addresses: {
    dealGovernance: Address;
    dealGovernanceImpl: Address;
    dealGovernanceReader: Address;
  };
  abi: {
    DealGovernance: Abi;
    DealGovernanceReader: Abi;
  };
};

function loadEnv() {
  for (const line of readFileSync(join(process.cwd(), ".env"), "utf8").split(
    /\r?\n/
  )) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ||= match[2].trim();
  }
}

function slotAddress(word: Hex | undefined): Address {
  if (!word || word.length !== 66)
    throw new Error("Implementation slot missing");
  return getAddress(`0x${word.slice(-40)}`);
}

async function main() {
  loadEnv();
  const rpc = process.env.ETH_MAINNET_RPC_URL?.trim();
  if (!rpc) throw new Error("ETH_MAINNET_RPC_URL is required");
  const deployment = JSON.parse(
    readFileSync(
      join(process.cwd(), "deployments", "eth-mainnet-1.json"),
      "utf8"
    )
  ) as Deployment;
  if (deployment.chainId !== 1) throw new Error("Wrong deployment chain");

  const governance = getAddress(deployment.addresses.dealGovernance);
  const implementation = getAddress(deployment.addresses.dealGovernanceImpl);
  const reader = getAddress(deployment.addresses.dealGovernanceReader);
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpc),
  });

  const [
    chainId,
    checkedBlock,
    implementationSlot,
    configuredGovernance,
    page,
  ] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getStorageAt({
      address: governance,
      slot: IMPLEMENTATION_SLOT,
    }),
    publicClient.readContract({
      address: reader,
      abi: deployment.abi.DealGovernanceReader,
      functionName: "governance",
    }) as Promise<Address>,
    publicClient.readContract({
      address: reader,
      abi: deployment.abi.DealGovernanceReader,
      functionName: "getProposalPage",
      args: [ZERO_ADDRESS, 0n, 18n, false],
    }) as Promise<
      readonly [readonly { proposalId: bigint; createdAt: number }[], bigint]
    >,
  ]);

  if (chainId !== 1) throw new Error(`Wrong live chain ${chainId}`);
  if (slotAddress(implementationSlot) !== implementation) {
    throw new Error("Manifest implementation does not match the proxy");
  }
  if (getAddress(configuredGovernance) !== governance) {
    throw new Error("Manifest Reader does not point to the governance proxy");
  }

  const [proposals, total] = page;
  if (total !== 18n || proposals.length !== 18) {
    throw new Error("Manifest Reader did not return proposals 1..18");
  }
  for (const [index, proposal] of proposals.entries()) {
    const expectedId = BigInt(index + 1);
    if (proposal.proposalId !== expectedId || proposal.createdAt === 0) {
      throw new Error(`Bad proposal ${expectedId} in frontend manifest read`);
    }
  }

  console.log(
    JSON.stringify(
      {
        verified: true,
        chainId,
        checkedBlock: checkedBlock.toString(),
        governance,
        implementation,
        reader,
        proposalCount: total.toString(),
        createdAtVerifiedProposalIds: "1..18",
        proposal18CreatedAt: proposals[17].createdAt.toString(),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
