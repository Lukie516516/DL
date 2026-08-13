import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, getAddress, parseEther, type Hex } from "viem";

import { BASE_MAINNET } from "../scripts/lib/evm-chain-config.js";

const runFork = process.env.BASE_PROTOCOL_MAINNET_FORK === "1";
const forkDescribe = runFork ? describe : describe.skip;
const ONE = 10n ** 18n;

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

forkDescribe("Base protocol mainnet fork", function () {
  it("validates canonical assets, U normalization, three pools and Treasury behavior", async function () {
    const { viem } = await network.connect({
      network: "hardhatBaseFork",
      chainType: "op",
    });
    const publicClient = await viem.getPublicClient();
    const [deployer, outsider] = await viem.getWalletClients();
    const client = { public: publicClient, wallet: deployer } as const;
    assert.equal(await publicClient.getChainId(), BASE_MAINNET.chainId);

    const metadataAbi = [
      { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
      { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
      { type: "function", name: "l1Token", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
      { type: "function", name: "l2Bridge", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    ] as const;
    const [usdcSymbol, usdcDecimals, usdtSymbol, usdtDecimals, usdtL1, usdtBridge, wethSymbol, wethDecimals] =
      await Promise.all([
        publicClient.readContract({ address: BASE_MAINNET.usdc, abi: metadataAbi, functionName: "symbol" }),
        publicClient.readContract({ address: BASE_MAINNET.usdc, abi: metadataAbi, functionName: "decimals" }),
        publicClient.readContract({ address: BASE_MAINNET.usdt, abi: metadataAbi, functionName: "symbol" }),
        publicClient.readContract({ address: BASE_MAINNET.usdt, abi: metadataAbi, functionName: "decimals" }),
        publicClient.readContract({ address: BASE_MAINNET.usdt, abi: metadataAbi, functionName: "l1Token" }),
        publicClient.readContract({ address: BASE_MAINNET.usdt, abi: metadataAbi, functionName: "l2Bridge" }),
        publicClient.readContract({ address: BASE_MAINNET.weth, abi: metadataAbi, functionName: "symbol" }),
        publicClient.readContract({ address: BASE_MAINNET.weth, abi: metadataAbi, functionName: "decimals" }),
      ]);
    assert.equal(usdcSymbol, "USDC");
    assert.equal(usdcDecimals, 6);
    assert.equal(usdtSymbol, "USDT");
    assert.equal(usdtDecimals, 6);
    assert.equal(getAddress(usdtL1), BASE_MAINNET.ethereumUsdt);
    assert.equal(getAddress(usdtBridge), BASE_MAINNET.standardBridge);
    assert.equal(wethSymbol, "WETH");
    assert.equal(wethDecimals, 18);

    const dealLib = await viem.deployContract("DealLib", [], { client });
    const normalizedUsdc = await dealLib.read.feeCreditU([
      deployer.account.address,
      deployer.account.address,
      BASE_MAINNET.weth,
      BASE_MAINNET.usdc,
      1_000_000n,
      BASE_MAINNET.usdc,
      BASE_MAINNET.usdt,
      deployer.account.address,
    ]);
    const normalizedUsdt = await dealLib.read.feeCreditU([
      deployer.account.address,
      deployer.account.address,
      BASE_MAINNET.weth,
      BASE_MAINNET.usdt,
      1_000_000n,
      BASE_MAINNET.usdc,
      BASE_MAINNET.usdt,
      deployer.account.address,
    ]);
    assert.equal(normalizedUsdc, ONE);
    assert.equal(normalizedUsdt, ONE);

    const dealImplementation = await viem.deployContract("Deal", [], { client });
    const pairImplementation = await viem.deployContract("DealSwapTemplate", [], { client });
    const factoryImplementation = await viem.deployContract("DealFactory", [], { client });
    const initData = encodeFunctionData({
      abi: [{
        type: "function",
        name: "initialize",
        inputs: [
          { name: "dealImpl", type: "address" },
          { name: "pairImpl", type: "address" },
          { name: "minTimeoutSeconds", type: "uint64" },
        ],
      }],
      functionName: "initialize",
      args: [dealImplementation.address, pairImplementation.address, 3600n],
    });
    const factoryProxy = await viem.deployContract(
      "ERC1967Proxy",
      [factoryImplementation.address, initData],
      { client },
    );
    const factory = await viem.getContractAt("DealFactory", factoryProxy.address, { client });
    const dc = await viem.deployContract(
      "DCToken",
      ["DealCoin", "DC", 0n, deployer.account.address, deployer.account.address],
      { client },
    );
    const pairManager = await viem.deployContract("DealPairManager", [factory.address], { client });
    await waitFor(
      publicClient,
      await factory.write.setCoreGlobals([
        dc.address,
        deployer.account.address,
        BASE_MAINNET.weth,
        pairManager.address,
      ]),
    );
    await waitFor(
      publicClient,
      await factory.write.setRecognizedTokens([BASE_MAINNET.usdc, BASE_MAINNET.usdt]),
    );

    for (const token of [BASE_MAINNET.usdc, BASE_MAINNET.usdt, BASE_MAINNET.weth]) {
      await waitFor(publicClient, await pairManager.write.createPair([token, 3, 1000]));
      const pairAddress = getAddress(await pairManager.read.pairForToken([token]));
      assert.notEqual(pairAddress, "0x0000000000000000000000000000000000000000");
      const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);
      assert.equal(getAddress(await pair.read.token0()), getAddress(dc.address));
      assert.equal(getAddress(await pair.read.token1()), token);
    }

    const treasury = await viem.deployContract(
      "ProtocolTreasury",
      [deployer.account.address, deployer.account.address],
      { client },
    );
    await waitFor(
      publicClient,
      await deployer.sendTransaction({ to: treasury.address, value: parseEther("0.001") }),
    );
    assert.equal(await publicClient.getBalance({ address: treasury.address }), parseEther("0.001"));
    const treasuryAsOutsider = await viem.getContractAt("ProtocolTreasury", treasury.address, {
      client: { public: publicClient, wallet: outsider },
    });
    await assert.rejects(
      treasuryAsOutsider.write.payNative([outsider.account.address, 1n]),
    );
    await waitFor(publicClient, await treasury.write.lockBootstrap());
    assert.equal(await treasury.read.bootstrapLocked(), true);
    await assert.rejects(
      treasury.write.bootstrapSetController([outsider.account.address]),
    );
  });
});
