import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  padHex,
  parseAbi,
  toFunctionSelector,
} from "viem";

const ETH_LZ_EID = 30101;
const BSC_LZ_EID = 30102;
const ETH_CCIP_SELECTOR = 5_009_297_550_715_157_269n;
const BSC_CCIP_SELECTOR = 11_344_663_589_394_136_015n;
const LZ_FEE = 2n;
const CCIP_FEE = 5n;
const AXELAR_FEE = 3n;
const TOTAL_FEE = LZ_FEE + CCIP_FEE + AXELAR_FEE;

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

function revertsWithSelector(
  action: () => Promise<unknown>,
  signature: string
) {
  const selector = toFunctionSelector(signature);
  return assert.rejects(action, (error: unknown) =>
    String(error).includes(selector)
  );
}

describe("CCIP third-bridge migration", function () {
  it("keeps the DAO ABI/payload and executes once after any two of LZ + CCIP + Axelar", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner] = await viem.getWalletClients();

    const lzEndpoint = await viem.deployContract("MockLzEndpointForCCIP", []);
    const ccipRouter = await viem.deployContract("MockCCIPRouter", []);
    const axelarGateway = await viem.deployContract(
      "MockAxelarGatewayForCCIP",
      []
    );
    const axelarGasService = await viem.deployContract(
      "MockAxelarGasServiceForCCIP",
      []
    );
    const target = await viem.deployContract("MockTarget", []);

    await waitFor(publicClient, await lzEndpoint.write.setFee([LZ_FEE]));
    await waitFor(publicClient, await ccipRouter.write.setFee([CCIP_FEE]));
    await waitFor(
      publicClient,
      await ccipRouter.write.setChainSupported([BSC_CCIP_SELECTOR, true])
    );

    const broadcaster = await viem.deployContract("CrossChainBroadcasterV2", [
      lzEndpoint.address,
      owner.account.address,
      owner.account.address,
      ccipRouter.address,
      axelarGateway.address,
      axelarGasService.address,
    ]);
    const executor = await viem.deployContract("DualBridgeExecutorV2", [
      lzEndpoint.address,
      owner.account.address,
      ccipRouter.address,
      ETH_CCIP_SELECTOR,
      broadcaster.address,
      axelarGateway.address,
      "Ethereum",
      broadcaster.address,
      2n,
    ]);
    const broadcasterBytes32 = padHex(broadcaster.address, { size: 32 });
    const executorBytes32 = padHex(executor.address, { size: 32 });

    await waitFor(
      publicClient,
      await broadcaster.write.setPeer([BSC_LZ_EID, executorBytes32])
    );
    await waitFor(
      publicClient,
      await executor.write.setPeer([ETH_LZ_EID, broadcasterBytes32])
    );
    await waitFor(
      publicClient,
      await executor.write.setAllowedTarget([target.address, true])
    );
    await waitFor(
      publicClient,
      await broadcaster.write.addChain([
        BSC_LZ_EID,
        {
          lzDstEid: BSC_LZ_EID,
          ccipDstChainSelector: BSC_CCIP_SELECTOR,
          ccipReceiver: executor.address,
          axDstChain: "binance",
          axDstAddress: executor.address.toLowerCase(),
          axMinFee: AXELAR_FEE,
          active: true,
        },
      ])
    );

    assert.equal(
      toFunctionSelector("broadcast(uint32[],address[],bytes,uint128)"),
      toFunctionSelector(
        broadcaster.abi.find((item: any) => item.name === "broadcast") as any
      )
    );

    const targetData = encodeFunctionData({
      abi: target.abi,
      functionName: "setParam",
      args: [42n],
    });
    const quoted = await broadcaster.read.quoteFees([
      [BSC_LZ_EID],
      [target.address],
      targetData,
      500_000n,
    ]);
    assert.equal(quoted, TOTAL_FEE);

    // Pre-existing ETH is recoverable only through owner rescue and must not be swept as a refund.
    await waitFor(
      publicClient,
      await owner.sendTransaction({ to: broadcaster.address, value: 7n })
    );

    await waitFor(
      publicClient,
      await broadcaster.write.broadcast(
        [[BSC_LZ_EID], [target.address], targetData, 500_000n],
        { value: TOTAL_FEE + 1n }
      )
    );
    assert.equal(
      await publicClient.getBalance({ address: broadcaster.address }),
      7n
    );
    assert.equal(await broadcaster.read.broadcastNonce(), 1n);
    assert.equal(await lzEndpoint.read.lastValue(), LZ_FEE);
    assert.equal(await ccipRouter.read.lastValue(), CCIP_FEE);
    assert.equal(await axelarGasService.read.lastValue(), AXELAR_FEE);
    assert.equal(
      await ccipRouter.read.lastFeeToken(),
      "0x0000000000000000000000000000000000000000"
    );
    assert.equal(
      await ccipRouter.read.lastDestinationChainSelector(),
      BSC_CCIP_SELECTOR
    );
    assert.equal(
      decodeAbiParameters(
        [{ type: "address" }],
        await ccipRouter.read.lastReceiver()
      )[0].toLowerCase(),
      executor.address.toLowerCase()
    );
    const extraArgs = await ccipRouter.read.lastExtraArgs();
    assert.equal(extraArgs.slice(0, 10), "0x181dcf10");
    assert.deepEqual(
      decodeAbiParameters(
        [{ type: "uint256" }, { type: "bool" }],
        `0x${extraArgs.slice(10)}`
      ),
      [500_000n, true]
    );

    const lzPayload = await lzEndpoint.read.lastMessage();
    const ccipPayload = await ccipRouter.read.lastData();
    const axelarPayload = await axelarGateway.read.lastPayload();
    assert.equal(ccipPayload, lzPayload);
    assert.equal(axelarPayload, lzPayload);
    const decoded = decodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      lzPayload
    );
    assert.equal(decoded[0], 1n);
    assert.equal(decoded[1].toLowerCase(), target.address.toLowerCase());
    assert.equal(decoded[2], targetData);

    const msgHash = keccak256(lzPayload);
    await waitFor(
      publicClient,
      await lzEndpoint.write.deliver([
        executor.address,
        { srcEid: ETH_LZ_EID, sender: broadcasterBytes32, nonce: 1n },
        lzPayload,
      ])
    );
    assert.deepEqual(await executor.read.confirmStatus([msgHash]), [
      true,
      false,
      false,
      1n,
      false,
    ]);
    assert.equal(await target.read.callCount(), 0n);

    await waitFor(
      publicClient,
      await ccipRouter.write.deliver([
        executor.address,
        keccak256("0x01"),
        ETH_CCIP_SELECTOR,
        encodeAbiParameters([{ type: "address" }], [broadcaster.address]),
        ccipPayload,
      ])
    );
    assert.deepEqual(await executor.read.confirmStatus([msgHash]), [
      true,
      true,
      false,
      2n,
      true,
    ]);
    assert.equal(await target.read.param(), 42n);
    assert.equal(await target.read.callCount(), 1n);
    assert.equal(
      (await target.read.lastCaller()).toLowerCase(),
      executor.address.toLowerCase()
    );

    // A healthy but slower third bridge remains observable and cannot execute twice.
    await waitFor(
      publicClient,
      await axelarGateway.write.deliver([
        executor.address,
        keccak256("0x02"),
        "Ethereum",
        broadcaster.address,
        axelarPayload,
      ])
    );
    assert.deepEqual(await executor.read.confirmStatus([msgHash]), [
      true,
      true,
      true,
      3n,
      true,
    ]);
    assert.equal(await target.read.callCount(), 1n);

    await assert.rejects(
      axelarGateway.write.deliver([
        executor.address,
        keccak256("0x03"),
        "Ethereum",
        broadcaster.address,
        axelarPayload,
      ]),
      /AlreadyConfirmed/
    );

    // A different bridge pair can reach the same threshold; the late LZ path is also recorded once.
    const secondTargetData = encodeFunctionData({
      abi: target.abi,
      functionName: "setParam",
      args: [43n],
    });
    await waitFor(
      publicClient,
      await broadcaster.write.broadcast(
        [[BSC_LZ_EID], [target.address], secondTargetData, 500_000n],
        { value: TOTAL_FEE }
      )
    );
    const secondPayload = await ccipRouter.read.lastData();
    const secondHash = keccak256(secondPayload);
    await waitFor(
      publicClient,
      await axelarGateway.write.deliver([
        executor.address,
        keccak256("0x04"),
        "Ethereum",
        broadcaster.address,
        secondPayload,
      ])
    );
    assert.deepEqual(await executor.read.confirmStatus([secondHash]), [
      false,
      false,
      true,
      1n,
      false,
    ]);
    await waitFor(
      publicClient,
      await ccipRouter.write.deliver([
        executor.address,
        keccak256("0x05"),
        ETH_CCIP_SELECTOR,
        encodeAbiParameters([{ type: "address" }], [broadcaster.address]),
        secondPayload,
      ])
    );
    assert.deepEqual(await executor.read.confirmStatus([secondHash]), [
      false,
      true,
      true,
      2n,
      true,
    ]);
    assert.equal(await target.read.param(), 43n);
    assert.equal(await target.read.callCount(), 2n);
    await waitFor(
      publicClient,
      await lzEndpoint.write.deliver([
        executor.address,
        { srcEid: ETH_LZ_EID, sender: broadcasterBytes32, nonce: 2n },
        secondPayload,
      ])
    );
    assert.deepEqual(await executor.read.confirmStatus([secondHash]), [
      true,
      true,
      true,
      3n,
      true,
    ]);
    assert.equal(await target.read.callCount(), 2n);
  });

  it("keeps a threshold-approved payload retryable until the target call really succeeds", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, outsider] = await viem.getWalletClients();

    const lzEndpoint = await viem.deployContract("MockLzEndpointForCCIP", []);
    const ccipRouter = await viem.deployContract("MockCCIPRouter", []);
    const axelarGateway = await viem.deployContract(
      "MockAxelarGatewayForCCIP",
      []
    );
    const target = await viem.deployContract("RetryableExecutionTarget", []);
    const sourceBytes32 = padHex(owner.account.address, { size: 32 });
    const sourceSender = encodeAbiParameters(
      [{ type: "address" }],
      [owner.account.address]
    );
    const executor = await viem.deployContract("DualBridgeExecutorV2", [
      lzEndpoint.address,
      owner.account.address,
      ccipRouter.address,
      ETH_CCIP_SELECTOR,
      owner.account.address,
      axelarGateway.address,
      "Ethereum",
      owner.account.address,
      2n,
    ]);
    await waitFor(
      publicClient,
      await executor.write.setPeer([ETH_LZ_EID, sourceBytes32])
    );

    const targetData = encodeFunctionData({
      abi: target.abi,
      functionName: "setParam",
      args: [99n],
    });
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [1n, target.address, targetData]
    );
    const msgHash = keccak256(payload);

    await waitFor(
      publicClient,
      await lzEndpoint.write.deliver([
        executor.address,
        { srcEid: ETH_LZ_EID, sender: sourceBytes32, nonce: 1n },
        payload,
      ])
    );
    await assert.rejects(
      executor.write.retryExecution([msgHash], { account: outsider.account }),
      /ThresholdNotReached/
    );

    // The second bridge reaches threshold, but a missing allowlist entry must not consume the action.
    await waitFor(
      publicClient,
      await ccipRouter.write.deliver([
        executor.address,
        keccak256("0x21"),
        ETH_CCIP_SELECTOR,
        sourceSender,
        payload,
      ])
    );
    assert.equal(await executor.read.executed([msgHash]), false);
    assert.equal(await executor.read.executionAttempts([msgHash]), 1n);

    await waitFor(
      publicClient,
      await executor.write.setAllowedTarget([target.address, true])
    );
    // The target itself still rejects; the exact approved payload remains retryable.
    await waitFor(
      publicClient,
      await executor.write.retryExecution([msgHash], {
        account: outsider.account,
      })
    );
    assert.equal(await executor.read.executed([msgHash]), false);
    assert.equal(await executor.read.executionAttempts([msgHash]), 2n);
    assert.equal(await target.read.successfulCalls(), 0n);

    await waitFor(publicClient, await target.write.setShouldFail([false]));
    await waitFor(
      publicClient,
      await executor.write.retryExecution([msgHash], {
        account: outsider.account,
      })
    );
    assert.equal(await executor.read.executed([msgHash]), true);
    assert.equal(await executor.read.executionAttempts([msgHash]), 3n);
    assert.equal(await target.read.param(), 99n);
    assert.equal(await target.read.successfulCalls(), 1n);
    await assert.rejects(
      executor.write.retryExecution([msgHash], { account: outsider.account }),
      /AlreadyExecuted/
    );

    await waitFor(
      publicClient,
      await axelarGateway.write.deliver([
        executor.address,
        keccak256("0x22"),
        "Ethereum",
        owner.account.address,
        payload,
      ])
    );
    assert.deepEqual(await executor.read.confirmStatus([msgHash]), [
      true,
      true,
      true,
      3n,
      true,
    ]);
    assert.equal(await executor.read.executionAttempts([msgHash]), 3n);
    assert.equal(await target.read.successfulCalls(), 1n);
  });

  it("blocks same-message retry reentrancy while allowing the approved outer call to finish", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner] = await viem.getWalletClients();

    const lzEndpoint = await viem.deployContract("MockLzEndpointForCCIP", []);
    const ccipRouter = await viem.deployContract("MockCCIPRouter", []);
    const axelarGateway = await viem.deployContract(
      "MockAxelarGatewayForCCIP",
      []
    );
    const target = await viem.deployContract("ReentrantRetryTarget", []);
    const sourceBytes32 = padHex(owner.account.address, { size: 32 });
    const executor = await viem.deployContract("DualBridgeExecutorV2", [
      lzEndpoint.address,
      owner.account.address,
      ccipRouter.address,
      ETH_CCIP_SELECTOR,
      owner.account.address,
      axelarGateway.address,
      "Ethereum",
      owner.account.address,
      2n,
    ]);
    await waitFor(
      publicClient,
      await executor.write.setPeer([ETH_LZ_EID, sourceBytes32])
    );
    await waitFor(
      publicClient,
      await executor.write.setAllowedTarget([target.address, true])
    );

    const targetData = encodeFunctionData({
      abi: target.abi,
      functionName: "executeAndTryReentry",
    });
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [1n, target.address, targetData]
    );
    const msgHash = keccak256(payload);
    await waitFor(
      publicClient,
      await target.write.configure([executor.address, msgHash])
    );

    await waitFor(
      publicClient,
      await lzEndpoint.write.deliver([
        executor.address,
        { srcEid: ETH_LZ_EID, sender: sourceBytes32, nonce: 1n },
        payload,
      ])
    );
    await waitFor(
      publicClient,
      await ccipRouter.write.deliver([
        executor.address,
        keccak256("0x23"),
        ETH_CCIP_SELECTOR,
        encodeAbiParameters([{ type: "address" }], [owner.account.address]),
        payload,
      ])
    );

    assert.equal(await executor.read.executed([msgHash]), true);
    assert.equal(await executor.read.executionAttempts([msgHash]), 1n);
    assert.equal(await target.read.callCount(), 1n);
    assert.equal(await target.read.reentryBlocked(), true);
  });

  it("rejects forged CCIP delivery, token payloads, invalid config, and unauthorized sends", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, outsider] = await viem.getWalletClients();

    const lzEndpoint = await viem.deployContract("MockLzEndpointForCCIP", []);
    const ccipRouter = await viem.deployContract("MockCCIPRouter", []);
    const axelarGateway = await viem.deployContract(
      "MockAxelarGatewayForCCIP",
      []
    );
    const axelarGasService = await viem.deployContract(
      "MockAxelarGasServiceForCCIP",
      []
    );
    await waitFor(
      publicClient,
      await ccipRouter.write.setChainSupported([BSC_CCIP_SELECTOR, true])
    );

    const broadcaster = await viem.deployContract("CrossChainBroadcasterV2", [
      lzEndpoint.address,
      owner.account.address,
      owner.account.address,
      ccipRouter.address,
      axelarGateway.address,
      axelarGasService.address,
    ]);
    const executor = await viem.deployContract("DualBridgeExecutorV2", [
      lzEndpoint.address,
      owner.account.address,
      ccipRouter.address,
      ETH_CCIP_SELECTOR,
      broadcaster.address,
      axelarGateway.address,
      "Ethereum",
      broadcaster.address,
      2n,
    ]);
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [1n, outsider.account.address, "0x1234"]
    );
    const sender = encodeAbiParameters(
      [{ type: "address" }],
      [broadcaster.address]
    );

    await assert.rejects(
      executor.write.lzReceive([
        {
          srcEid: ETH_LZ_EID,
          sender: padHex(broadcaster.address, { size: 32 }),
          nonce: 1n,
        },
        keccak256("0x10"),
        payload,
        outsider.account.address,
        "0x",
      ]),
      /NotEndpoint/
    );
    await waitFor(
      publicClient,
      await executor.write.setPeer([
        ETH_LZ_EID,
        padHex(broadcaster.address, { size: 32 }),
      ])
    );
    await assert.rejects(
      lzEndpoint.write.deliver([
        executor.address,
        {
          srcEid: ETH_LZ_EID,
          sender: padHex(outsider.account.address, { size: 32 }),
          nonce: 1n,
        },
        payload,
      ]),
      /InvalidSender/
    );

    await assert.rejects(
      executor.write.ccipReceive([
        {
          messageId: keccak256("0x11"),
          sourceChainSelector: ETH_CCIP_SELECTOR,
          sender,
          data: payload,
          destTokenAmounts: [],
        },
      ]),
      /NotCcipRouter/
    );
    await assert.rejects(
      ccipRouter.write.deliver([
        executor.address,
        keccak256("0x12"),
        ETH_CCIP_SELECTOR + 1n,
        sender,
        payload,
      ]),
      /WrongCcipSrcChain/
    );
    await assert.rejects(
      ccipRouter.write.deliver([
        executor.address,
        keccak256("0x13"),
        ETH_CCIP_SELECTOR,
        encodeAbiParameters([{ type: "address" }], [outsider.account.address]),
        payload,
      ]),
      /WrongCcipSrcSender/
    );
    await assert.rejects(
      ccipRouter.write.deliverWithToken([
        executor.address,
        keccak256("0x14"),
        ETH_CCIP_SELECTOR,
        sender,
        payload,
        outsider.account.address,
        1n,
      ]),
      /UnexpectedCcipTokens/
    );
    await assert.rejects(
      ccipRouter.write.deliver([
        executor.address,
        keccak256("0x15"),
        ETH_CCIP_SELECTOR,
        "0x1234",
        payload,
      ]),
      /InvalidCcipSenderEncoding/
    );

    await waitFor(
      publicClient,
      await axelarGateway.write.setValidationResult([false])
    );
    await assert.rejects(
      axelarGateway.write.deliver([
        executor.address,
        keccak256("0x16"),
        "Ethereum",
        broadcaster.address,
        payload,
      ]),
      /NotApprovedByAxelar/
    );
    await waitFor(
      publicClient,
      await axelarGateway.write.setValidationResult([true])
    );
    await assert.rejects(
      axelarGateway.write.deliver([
        executor.address,
        keccak256("0x17"),
        "WrongChain",
        broadcaster.address,
        payload,
      ]),
      /WrongAxSrcChain/
    );
    await assert.rejects(
      axelarGateway.write.deliver([
        executor.address,
        keccak256("0x18"),
        "Ethereum",
        outsider.account.address,
        payload,
      ]),
      /WrongAxSrcAddress/
    );

    await assert.rejects(
      broadcaster.write.addChain([
        BSC_LZ_EID,
        {
          lzDstEid: 0,
          ccipDstChainSelector: BSC_CCIP_SELECTOR + 1n,
          ccipReceiver: executor.address,
          axDstChain: "",
          axDstAddress: "",
          axMinFee: 0n,
          active: true,
        },
      ]),
      /UnsupportedCcipChain/
    );
    await waitFor(
      publicClient,
      await broadcaster.write.setPeer([
        BSC_LZ_EID,
        padHex(executor.address, { size: 32 }),
      ])
    );
    await waitFor(
      publicClient,
      await broadcaster.write.addChain([
        BSC_LZ_EID,
        {
          lzDstEid: BSC_LZ_EID,
          ccipDstChainSelector: 0n,
          ccipReceiver: "0x0000000000000000000000000000000000000000",
          axDstChain: "",
          axDstAddress: "",
          axMinFee: 0n,
          active: true,
        },
      ])
    );
    await assert.rejects(
      broadcaster.read.quoteFees([
        [BSC_LZ_EID],
        [outsider.account.address],
        "0x",
        0n,
      ]),
      /InvalidLzGas/
    );
    await assert.rejects(
      broadcaster.read.quoteFees([
        [BSC_LZ_EID, 99999],
        [outsider.account.address, owner.account.address],
        "0x",
        1n,
      ]),
      /UnexpectedTargetCount/
    );
    await revertsWithSelector(
      () =>
        broadcaster.write.broadcast(
          [[BSC_LZ_EID], [outsider.account.address], "0x", 1n],
          { account: outsider.account }
        ),
      "NotGovernance()"
    );
  });

  it("accepts the unchanged broadcast ABI only after the DAO policy is copied to the new address", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const [governance, newBroadcaster, oldBroadcaster, bscTarget] =
      await viem.getWalletClients();
    const broadcastSelector = toFunctionSelector(
      "broadcast(uint32[],address[],bytes,uint128)"
    );
    const innerAbi = parseAbi(["function setMinWindowSec(uint32 seconds_)"]);
    const innerSelector = toFunctionSelector("setMinWindowSec(uint32)");
    const maxValue = 10_000_000_000_000_000n;
    const initialRules = [0, 2].flatMap((kind) => [
      {
        kind,
        target: newBroadcaster.account.address,
        selector: broadcastSelector,
        allowed: true,
        validateNestedBroadcast: true,
        nestedOnly: false,
        maxValue,
      },
      {
        kind,
        target: bscTarget.account.address,
        selector: innerSelector,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: true,
        maxValue: 0n,
      },
    ]);
    const registry = await viem.deployContract("GovernancePolicyRegistry", [
      governance.account.address,
      initialRules,
    ]);
    const innerData = encodeFunctionData({
      abi: innerAbi,
      functionName: "setMinWindowSec",
      args: [1800],
    });
    const broadcastData = encodeFunctionData({
      abi: parseAbi([
        "function broadcast(uint32[] targetChainIds,address[] targets,bytes data,uint128 lzGas)",
      ]),
      functionName: "broadcast",
      args: [[30102], [bscTarget.account.address], innerData, 500_000n],
    });

    assert.equal(
      await registry.read.isActionAllowed([
        0,
        newBroadcaster.account.address,
        maxValue,
        broadcastData,
      ]),
      true
    );
    assert.equal(
      await registry.read.isActionAllowed([
        2,
        newBroadcaster.account.address,
        0n,
        broadcastData,
      ]),
      true
    );
    assert.equal(
      await registry.read.isActionAllowed([
        0,
        oldBroadcaster.account.address,
        0n,
        broadcastData,
      ]),
      false
    );
    assert.equal(
      await registry.read.isActionAllowed([
        0,
        newBroadcaster.account.address,
        maxValue + 1n,
        broadcastData,
      ]),
      false
    );
  });
});
