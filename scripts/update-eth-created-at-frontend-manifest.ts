import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress, type Abi, type Address, type Hex } from "viem";

const deploymentFile = join(process.cwd(), "deployments", "eth-mainnet-1.json");
const governanceArtifactFile = join(
  process.cwd(),
  "artifacts",
  "contracts",
  "DealGovernance.sol",
  "DealGovernance.json"
);
const readerArtifactFile = join(
  process.cwd(),
  "artifacts",
  "contracts",
  "DealGovernanceReader.sol",
  "DealGovernanceReader.json"
);
const implementationFile = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-implementation-20260727.json"
);
const executionVerificationFile = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-created-at-execution-verification-20260727.json"
);

type Artifact = { abi: Abi };

type Deployment = {
  chainId: number;
  updatedAt?: string;
  addresses: Record<string, Address>;
  abi: Record<string, Abi>;
  notes?: string[];
  daoCreatedAt?: unknown;
};

type ImplementationRecord = {
  implementation: Address;
};

type ExecutionVerification = {
  verifiedAt: string;
  governance: Address;
  implementation: Address;
  proposal18: {
    executionTransactionHash: Hex;
    executionBlockNumber: string;
    executionBlockTimestamp: string;
    backfilledFirstProposalId: string;
    backfilledLastProposalId: string;
  };
  reader: {
    address: Address;
    deploymentTransactionHash: Hex;
    deploymentBlockNumber: string;
    runtimeCodeHash: Hex;
    proposal18FallbackCreatedAt: string;
  };
};

function main() {
  const deployment = JSON.parse(
    readFileSync(deploymentFile, "utf8")
  ) as Deployment;
  const governanceArtifact = JSON.parse(
    readFileSync(governanceArtifactFile, "utf8")
  ) as Artifact;
  const readerArtifact = JSON.parse(
    readFileSync(readerArtifactFile, "utf8")
  ) as Artifact;
  const implementationRecord = JSON.parse(
    readFileSync(implementationFile, "utf8")
  ) as ImplementationRecord;
  const verification = JSON.parse(
    readFileSync(executionVerificationFile, "utf8")
  ) as ExecutionVerification;

  if (deployment.chainId !== 1) throw new Error("Wrong deployment chain");
  const governance = getAddress(deployment.addresses.dealGovernance);
  const implementation = getAddress(implementationRecord.implementation);
  const reader = getAddress(verification.reader.address);
  if (
    getAddress(verification.governance) !== governance ||
    getAddress(verification.implementation) !== implementation
  ) {
    throw new Error("Verified createdAt addresses do not match the deployment");
  }

  deployment.addresses.dealGovernanceImpl = implementation;
  deployment.addresses.dealGovernanceReader = reader;
  deployment.abi.DealGovernance = governanceArtifact.abi;
  deployment.abi.DealGovernanceReader = readerArtifact.abi;
  deployment.daoCreatedAt = {
    upgradedAt: new Date(
      Number(verification.proposal18.executionBlockTimestamp) * 1000
    ).toISOString(),
    governanceProxy: governance,
    implementation,
    proposalId: "18",
    upgradeTransaction: verification.proposal18.executionTransactionHash,
    upgradeBlock: verification.proposal18.executionBlockNumber,
    storageBackfilledProposalIds: `${verification.proposal18.backfilledFirstProposalId}..${verification.proposal18.backfilledLastProposalId}`,
    readerV2: reader,
    readerDeploymentTransaction: verification.reader.deploymentTransactionHash,
    readerDeploymentBlock: verification.reader.deploymentBlockNumber,
    readerRuntimeCodeHash: verification.reader.runtimeCodeHash,
    readerHistoricalProposalIds: "1..18",
    proposal18FallbackCreatedAt:
      verification.reader.proposal18FallbackCreatedAt,
    verifiedAt: verification.verifiedAt,
  };
  deployment.updatedAt = new Date().toISOString();

  const note = `[2026-07-27] DealGovernance proposal 18 added Proposal.createdAt and backfilled proposals 1..17; frontend Reader V2=${reader} covers proposals 1..18`;
  deployment.notes ??= [];
  if (!deployment.notes.includes(note)) deployment.notes.push(note);

  writeFileSync(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        updated: deploymentFile,
        dealGovernanceImpl: implementation,
        dealGovernanceReader: reader,
        governanceAbiEntries: governanceArtifact.abi.length,
        readerAbiEntries: readerArtifact.abi.length,
      },
      null,
      2
    )
  );
}

main();
