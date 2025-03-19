const { ethers } = require("ethers");
const { FlashbotsBundleProvider, FlashbotsBundleResolution } = require("@flashbots/ethers-provider-bundle");
const readline = require("readline");
require("dotenv").config();

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m"
};

let RPC_URL;
let FLASHBOTS_ENDPOINT;

const providerOptions = {
  '1': {
    rpc: "https://ethereum.publicnode.com",
    flashbots: "https://rpc.titanbuilder.xyz"
  },
  '2': {
    rpc: "https://1rpc.io/sepolia",
    flashbots: "https://relay-sepolia.flashbots.net"
  }
};

let provider; // Changed from const to let for reassignment

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let assetType;
let contract;
let tokenIds;
let processingBlock = false;

function colorLog(color, message) {
  console.log(`${color}%s${colors.reset}`, message);
}

function showHeader() {
  colorLog(colors.blue, "┌──────────────────────────────────────────────────┐");
  colorLog(colors.blue, "│             CRYPTO ASSETS RESCUE TOOL            │");
  colorLog(colors.blue, "│                 Made by @Zun2025                 │");
  colorLog(colors.blue, "└──────────────────────────────────────────────────┘");
}

async function selectNetwork() {
  return new Promise((resolve) => {
    rl.question(`${colors.cyan}🌐 Select Network:\n${colors.reset}` +
      `${colors.yellow}1. Ethereum Mainnet\n${colors.green}2. Sepolia Testnet\n${colors.cyan}➜ `, (answer) => {
      if (['1', '2'].includes(answer)) {
        RPC_URL = providerOptions[answer].rpc;
        FLASHBOTS_ENDPOINT = providerOptions[answer].flashbots;
        resolve();
      } else {
        colorLog(colors.red, "❌ Invalid Network Selection");
        resolve(selectNetwork());
      }
    });
  });
}

async function getUserInput() {
  return new Promise((resolve) => {
    rl.question(`${colors.cyan}🌐 Choose Asset Type:\n${colors.reset}` +
      `${colors.yellow}1. ERC20 Tokens\n${colors.green}2. ERC721 NFTs\n${colors.cyan}➜ `, (answer) => {
      if (answer === "1") {
        rl.question(`${colors.cyan}📭 Enter ERC20 Contract: ${colors.reset}`, (contractAddress) => {
          resolve({ type: "ERC20", contractAddress });
        });
      } else if (answer === "2") {
        rl.question(`${colors.cyan}🖼  Enter ERC721 Contract: ${colors.reset}`, (contractAddress) => {
          rl.question(`${colors.cyan}🔢 Enter Token IDs (comma-separated): ${colors.reset}`, (tokenIdsInput) => {
            const tokenIdArray = tokenIdsInput.split(",").map(id => id.trim());
            resolve({ type: "ERC721", contractAddress, tokenIds: tokenIdArray });
          });
        });
      } else {
        colorLog(colors.red, "❌ Invalid Selection");
        resolve(getUserInput());
      }
    });
  });
}

async function prepareTransferTxs(hackedWallet, safeWalletAddress) {
  if (assetType === "ERC20") {
    colorLog(colors.magenta, "📊 Checking ERC20 Balance...");
    const balance = await contract.balanceOf(hackedWallet.address);
    if (balance.isZero()) {
      colorLog(colors.yellow, "💤 Zero Balance Detected");
      return { txs: [], info: null };
    }
    const symbol = await contract.symbol();
    const decimals = await contract.decimals();
    const formattedBalance = ethers.utils.formatUnits(balance, decimals);
    colorLog(colors.green, `💰 Balance: ${formattedBalance} ${symbol}`);
    const data = contract.interface.encodeFunctionData("transfer", [safeWalletAddress, balance]);
    const tx = { to: contract.address, data };
    const info = { type: "ERC20", amount: balance, symbol, decimals };
    return { txs: [tx], info };
  } else if (assetType === "ERC721") {
    if (!tokenIds || tokenIds.length === 0) {
      colorLog(colors.red, "🚫 Missing Token IDs");
      return { txs: [], info: null };
    }
    colorLog(colors.cyan, `📦 Preparing ${tokenIds.length} NFTs:`);
    tokenIds.forEach((id) => colorLog(colors.yellow, `  ↳ #${id}`));
    const txs = [];
    for (const tokenId of tokenIds) {
      const data = contract.interface.encodeFunctionData("transferFrom", [
        hackedWallet.address,
        safeWalletAddress,
        tokenId
      ]);
      txs.push({ to: contract.address, data });
    }
    const info = { type: "ERC721", tokenIds };
    return { txs, info };
  }
  return { txs: [], info: null };
}

async function processBlock(
  blockNumber,
  flashbotsProvider,
  sponsorWallet,
  hackedWallet,
  safeWalletAddress,
  CHAIN_ID,
  maxAttempts,
  priorityFeeBoost
) {
  try {
    const currentBlock = blockNumber + 1;
    const targetBlockHex = `0x${currentBlock.toString(16)}`;
    const feeData = await provider.getFeeData();

    const baseMaxPriorityFee = feeData.maxPriorityFeePerGas || ethers.utils.parseUnits("1", "gwei");
    const baseMaxFeePerGas = feeData.maxFeePerGas || ethers.utils.parseUnits("2", "gwei");
    const maxPriorityFeePerGas = baseMaxPriorityFee.add(
      ethers.utils.parseUnits(priorityFeeBoost.current.toString(), "gwei")
    );
    const maxFeePerGas = baseMaxFeePerGas.add(
      ethers.utils.parseUnits(priorityFeeBoost.current.toString(), "gwei")
    );

    colorLog(colors.magenta, `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    colorLog(colors.cyan, `🌀 Attempt ${priorityFeeBoost.attempts} » Target Block ${currentBlock}`);
    colorLog(colors.yellow, `⛽ Gas Boost: +${priorityFeeBoost.current} Gwei`);

    const { txs: transferTxs, info: transferInfo } = await prepareTransferTxs(hackedWallet, safeWalletAddress);
    if (transferTxs.length === 0) return;

    const gasEstimates = await Promise.all(
      transferTxs.map(tx =>
        provider.estimateGas({
          to: tx.to,
          data: tx.data,
          from: hackedWallet.address
        })
      )
    );

    const totalGasLimit = gasEstimates.reduce((sum, gas) => sum.add(gas), ethers.BigNumber.from(0));
    const ethNeeded = totalGasLimit.mul(maxFeePerGas);
    colorLog(colors.cyan, `⛽ Total Gas: ${totalGasLimit.toString()}`);
    colorLog(colors.cyan, `💸 ETH Required: ${ethers.utils.formatEther(ethNeeded)}`);

    const [sponsorNonce, hackedNonce] = await Promise.all([
      provider.getTransactionCount(sponsorWallet.address, "pending"),
      provider.getTransactionCount(hackedWallet.address, "pending")
    ]);

    const sponsorTx = {
      chainId: CHAIN_ID,
      to: hackedWallet.address,
      value: ethNeeded,
      type: 2,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit: 21000,
      nonce: sponsorNonce
    };
    const signedSponsorTx = await sponsorWallet.signTransaction(sponsorTx);

    const signedTransferTxs = [];
    for (let i = 0; i < transferTxs.length; i++) {
      const tx = transferTxs[i];
      const gasLimit = gasEstimates[i];
      const transferTx = {
        chainId: CHAIN_ID,
        to: tx.to,
        data: tx.data,
        type: 2,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit,
        nonce: hackedNonce + i
      };
      const signedTx = await hackedWallet.signTransaction(transferTx);
      signedTransferTxs.push(signedTx);
    }

    const simulationBundle = [signedSponsorTx, ...signedTransferTxs];
    try {
      const simulation = await flashbotsProvider.simulate(simulationBundle, targetBlockHex, "latest");
      if (simulation.firstRevert) {
        colorLog(colors.red, `💣 Simulation Failed: ${simulation.firstRevert.error}`);
        priorityFeeBoost.current += 1;
        return false;
      }
      colorLog(colors.green, "✅ Simulation Passed");
    } catch (simError) {
      colorLog(colors.red, `💣 Simulation Error: ${simError.message}`);
      priorityFeeBoost.current += 1;
      return false;
    }

    const sendBundle = [
      { signedTransaction: signedSponsorTx },
      ...signedTransferTxs.map(signedTx => ({ signedTransaction: signedTx }))
    ];

    const bundleResponse = await flashbotsProvider.sendBundle(sendBundle, currentBlock);
    const resolution = await bundleResponse.wait();

    if (resolution === FlashbotsBundleResolution.BundleIncluded) {
      colorLog(colors.green, "🎉 Bundle Accepted");
      if (transferInfo.type === "ERC20") {
        const formattedAmount = ethers.utils.formatUnits(transferInfo.amount, transferInfo.decimals);
        colorLog(colors.green, `\n🎉 Success! Recovered ${formattedAmount} ${transferInfo.symbol}`);
      } else {
        colorLog(colors.green, `\n🎉 Success! Recovered ${transferInfo.tokenIds.length} NFTs`);
      }
      colorLog(colors.green, `📦 Block: ${currentBlock}`);
      return true;
    }

    colorLog(colors.red, "❌ Bundle Not Included");
    priorityFeeBoost.current += 1;
    priorityFeeBoost.attempts += 1;
    return false;

  } catch (error) {
    colorLog(colors.red, `⚠️  Processing Error: ${error.message}`);
    return false;
  }
}

async function executeSafeTransfer(sponsorWallet, hackedWallet, safeWalletAddress) {
  try {
    showHeader();
    colorLog(colors.green, "\n🔐 Initializing Flashbots Module...");

    const network = await provider.getNetwork();
    const CHAIN_ID = network.chainId;
    colorLog(colors.cyan, `⛓  Chain ID: ${CHAIN_ID}`);

    const authSigner = sponsorWallet;
    const flashbotsProvider = await FlashbotsBundleProvider.create(
      provider,
      authSigner,
      FLASHBOTS_ENDPOINT
    );

    const maxAttempts = 30;
    const priorityFeeBoost = { current: 0, attempts: 1 };

    colorLog(colors.blue, "\n📡 Monitoring Blockchain...");
    colorLog(colors.yellow, "⏳ Press CTRL+C to abort\n");

    provider.on("block", async (blockNumber) => {
      if (processingBlock || priorityFeeBoost.attempts > maxAttempts) return;
      processingBlock = true;

      try {
        if (priorityFeeBoost.attempts >= maxAttempts) {
          colorLog(colors.red, `\n⛔ Max Attempts Reached (${maxAttempts})`);
          process.exit(1);
        }

        const success = await processBlock(
          blockNumber,
          flashbotsProvider,
          sponsorWallet,
          hackedWallet,
          safeWalletAddress,
          CHAIN_ID,
          maxAttempts,
          priorityFeeBoost
        );

        if (success) process.exit(0);
        if (!success) colorLog(colors.yellow, "\n🔄 Retrying with Higher Priority Fee...");

      } finally {
        processingBlock = false;
      }
    });
  } catch (error) {
    colorLog(colors.red, `\n💀 Critical Error: ${error.message}`);
    process.exit(1);
  }
}

(async () => {
  try {
    await selectNetwork();
    provider = new ethers.providers.JsonRpcProvider(RPC_URL); // Assign provider after network selection

    const network = await provider.getNetwork();
    const CHAIN_ID = network.chainId;
    colorLog(colors.cyan, `⛓  Active Chain: ${CHAIN_ID}`);

    const sponsorWallet = new ethers.Wallet(process.env.PRIVATE_KEY_SPONSOR, provider);
    const hackedWallet = new ethers.Wallet(process.env.PRIVATE_KEY_HACKED, provider);
    const safeWalletAddress = process.env.SAFE_WALLET_ADDRESS;

    const erc20ABI = ["function transfer(address,uint256)", "function balanceOf(address)", "function symbol()", "function decimals()"];
    const erc721ABI = ["function transferFrom(address,address,uint256)", "function balanceOf(address)"];

    const userInput = await getUserInput();
    assetType = userInput.type;
    contract = new ethers.Contract(
      userInput.contractAddress,
      assetType === "ERC20" ? erc20ABI : erc721ABI,
      provider
    );
    if (assetType === "ERC721") tokenIds = userInput.tokenIds;

    rl.close();
    await executeSafeTransfer(sponsorWallet, hackedWallet, safeWalletAddress);
  } catch (error) {
    colorLog(colors.red, `\n🔥 Initialization Failed: ${error.message}`);
    process.exit(1);
  }
})();
