import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ethers } from "ethers";
import { notificationTool } from "../notification-agent/notification-tool";
import { incrementUserMetric } from "../../metrics";
import { RuntimeContext } from "@mastra/core/runtime-context";
import fs from "fs/promises";

const MEMPOOL_WS_URL = process.env.ETHEREUM_WSS_URL || "";

// Sample list of known MEV bot addresses (lowercase)
const KNOWN_MEV_BOTS = [
  "0x000000000000ad05ccc4f10045630fb830b95127",
  "0x88ad09518695c6c3712ac10a214be5109a655671",
];

// Sample list of known DEX router addresses (lowercase)
const KNOWN_DEX_ROUTERS = [
  "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Uniswap V2
  "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch
  "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f", // SushiSwap
].map(addr => addr.toLowerCase());

type MempoolTx = {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  gasPrice: string;
  type: string;
  suspicious: boolean;
  reason?: string;
};

const GWEI = 1_000_000_000n;
const SUSPICIOUS_GAS_PRICE = 100n * GWEI; // 100 gwei
const LARGE_VALUE_WEI = 10n * 1_000_000_000_000_000_000n; // 10 ETH
const GAS_WINDOW_SIZE = 20;
let recentGasPrices: bigint[] = [];

// Store recent transactions for pattern analysis
const RECENT_TX_WINDOW = 1000;
let recentTxs: MempoolTx[] = [];

const USERS_FILE = "./users.json";

async function loadUsers() {
  try {
    const data = await fs.readFile(USERS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function detectSandwichAttack(tx: MempoolTx): string | null {
  // Sandwich: look for a pair of txs from the same address, one just before and one just after a swap, both to the same DEX router
  // This is a simple heuristic: if the same address appears in recentTxs with the same to (DEX router) within a short window
  if (!tx.to || !KNOWN_DEX_ROUTERS.includes(tx.to)) return null;
  const idx = recentTxs.findIndex(t => t.hash === tx.hash);
  // Look for a tx from the same address to the same router just before and after
  let before = false, after = false;
  for (let i = Math.max(0, idx - 10); i < idx; i++) {
    if (recentTxs[i] && recentTxs[i].from === tx.from && recentTxs[i].to === tx.to) before = true;
  }
  for (let i = idx + 1; i < Math.min(recentTxs.length, idx + 10); i++) {
    if (recentTxs[i] && recentTxs[i].from === tx.from && recentTxs[i].to === tx.to) after = true;
  }
  if (before && after) return `Possible sandwich attack pattern: same address sent txs to ${tx.to} before and after this tx`;
  return null;
}

function detectFrontrun(tx: MempoolTx): string | null {
  // Frontrun: look for a similar tx (same to, similar value) with higher gas price just before this one
  if (!tx.to) return null;
  const idx = recentTxs.findIndex(t => t.hash === tx.hash);
  for (let i = Math.max(0, idx - 10); i < idx; i++) {
    const t = recentTxs[i];
    if (t && t.to === tx.to && t.value === tx.value && BigInt(t.gasPrice) > BigInt(tx.gasPrice)) {
      return `Possible frontrun: similar tx with higher gas price (${t.gasPrice}) just before this one`;
    }
  }
  return null;
}

function detectBackrun(tx: MempoolTx): string | null {
  // Backrun: look for a similar tx (same to, similar value) just after this one
  if (!tx.to) return null;
  const idx = recentTxs.findIndex(t => t.hash === tx.hash);
  for (let i = idx + 1; i < Math.min(recentTxs.length, idx + 10); i++) {
    const t = recentTxs[i];
    if (t && t.to === tx.to && t.value === tx.value) {
      return `Possible backrun: similar tx just after this one`;
    }
  }
  return null;
}

const monitorMempool = async (): Promise<MempoolTx[]> => {
  if (!MEMPOOL_WS_URL) {
    throw new Error("ETHEREUM_WSS_URL environment variable not set");
  }
  console.log("[mempoolMonitorTool] Connecting to:", MEMPOOL_WS_URL);
  const provider = new ethers.providers.WebSocketProvider(MEMPOOL_WS_URL);

  return new Promise((resolve, reject) => {
    const txs: MempoolTx[] = [];
    let timeout: NodeJS.Timeout | null = null;

    const onTx = async (txHash: string) => {
      try {
        const tx = await provider.getTransaction(txHash);
        if (tx) {
          console.log("[mempoolMonitorTool] Received tx:", tx.hash);
          let suspicious = false;
          let reasons: string[] = [];
          // Gas price checks
          const gasPrice = tx.gasPrice ? BigInt(tx.gasPrice.toString()) : 0n;
          // Maintain rolling window for dynamic threshold
          if (gasPrice > 0n) {
            recentGasPrices.push(gasPrice);
            if (recentGasPrices.length > GAS_WINDOW_SIZE) recentGasPrices.shift();
          }
          const avgGas = recentGasPrices.length > 0 ? recentGasPrices.reduce((a, b) => a + b, 0n) / BigInt(recentGasPrices.length) : 0n;
          if (gasPrice > SUSPICIOUS_GAS_PRICE) {
            suspicious = true;
            reasons.push(`High gas price: ${gasPrice} wei`);
          }
          if (avgGas > 0n && gasPrice > 2n * avgGas) {
            suspicious = true;
            reasons.push(`Gas price (${gasPrice} wei) is >2x recent average (${avgGas} wei)`);
          }
          // Known MEV bots
          const from = tx.from?.toLowerCase() || "";
          const to = tx.to?.toLowerCase() || "";
          if (KNOWN_MEV_BOTS.includes(from) || KNOWN_MEV_BOTS.includes(to)) {
            suspicious = true;
            reasons.push(`Known MEV bot address involved: ${from === to ? from : from + ' or ' + to}`);
          }
          // Large value transfer
          const value = tx.value ? BigInt(tx.value.toString()) : 0n;
          if (value > LARGE_VALUE_WEI) {
            suspicious = true;
            reasons.push(`Large value transfer: ${ethers.utils.formatUnits(value, 18)} ETH`);
          }
          // DEX router + high gas
          if (KNOWN_DEX_ROUTERS.includes(to) && gasPrice > SUSPICIOUS_GAS_PRICE) {
            suspicious = true;
            reasons.push(`To known DEX router (${to}) with high gas price (${gasPrice} wei)`);
          }
          // Add this tx to recentTxs for pattern analysis
          recentTxs.push({
            hash: tx.hash,
            from: tx.from,
            to: tx.to ?? null,
            value: tx.value ? tx.value.toString() : "0",
            gasPrice: tx.gasPrice ? tx.gasPrice.toString() : "0",
            type: tx.type?.toString() || "unknown",
            suspicious: false,
          });
          if (recentTxs.length > RECENT_TX_WINDOW) recentTxs.shift();
          // Now, check for advanced MEV patterns
          const thisTx: MempoolTx = {
            hash: tx.hash,
            from: tx.from,
            to: tx.to ?? null,
            value: tx.value ? tx.value.toString() : "0",
            gasPrice: tx.gasPrice ? tx.gasPrice.toString() : "0",
            type: tx.type?.toString() || "unknown",
            suspicious,
          };
          const sandwich = detectSandwichAttack(thisTx);
          if (sandwich) {
            suspicious = true;
            reasons.push(sandwich);
          }
          const frontrun = detectFrontrun(thisTx);
          if (frontrun) {
            suspicious = true;
            reasons.push(frontrun);
          }
          const backrun = detectBackrun(thisTx);
          if (backrun) {
            suspicious = true;
            reasons.push(backrun);
          }
          txs.push({
            hash: tx.hash,
            from: tx.from,
            to: tx.to ?? null,
            value: tx.value ? tx.value.toString() : "0",
            gasPrice: tx.gasPrice ? tx.gasPrice.toString() : "0",
            type: tx.type?.toString() || "unknown",
            suspicious,
            ...(suspicious && reasons.length ? { reason: reasons.join("; ") } : {}),
          });
          // --- After advanced MEV pattern detection ---
          // Per-user alerting and metrics
          const users = await loadUsers();
          const txAddresses = [from, to].filter(Boolean);
          // Increment global totalTransactionsAnalyzed
          await incrementUserMetric("global", "totalTransactionsAnalyzed");
          for (const user of users) {
            if (!user.wallets || user.wallets.length === 0) continue;
            const match = user.wallets.some((w: string) => txAddresses.includes(w.toLowerCase()));
            if (!match) continue;
            // Increment per-user totalTransactionsAnalyzed
            await incrementUserMetric(user.id, "totalTransactionsAnalyzed");
            // Use user-specific webhook if set
            const webhookUrl = user.notificationPrefs?.discordWebhook;
            if (sandwich) {
              await incrementUserMetric("global", "sandwichAttacksDetected");
              const alertMsg = `ALERT: Sandwich attack detected for tx ${tx.hash} (user ${user.username}) from ${tx.from} to ${tx.to}. Reason: ${sandwich}`;
              await notificationTool.execute({ context: { message: alertMsg, webhookUrl }, runtimeContext: new RuntimeContext() });
              await incrementUserMetric("global", "totalAlertsSent", alertMsg);
              await incrementUserMetric(user.id, "sandwichAttacksDetected");
              await incrementUserMetric(user.id, "totalAlertsSent", alertMsg);
            }
            if (frontrun) {
              await incrementUserMetric("global", "frontrunAttacksDetected");
              const alertMsg = `ALERT: Frontrun detected for tx ${tx.hash} (user ${user.username}) from ${tx.from} to ${tx.to}. Reason: ${frontrun}`;
              await notificationTool.execute({ context: { message: alertMsg, webhookUrl }, runtimeContext: new RuntimeContext() });
              await incrementUserMetric("global", "totalAlertsSent", alertMsg);
              await incrementUserMetric(user.id, "frontrunAttacksDetected");
              await incrementUserMetric(user.id, "totalAlertsSent", alertMsg);
            }
            if (backrun) {
              await incrementUserMetric("global", "backrunAttacksDetected");
              const alertMsg = `ALERT: Backrun detected for tx ${tx.hash} (user ${user.username}) from ${tx.from} to ${tx.to}. Reason: ${backrun}`;
              await notificationTool.execute({ context: { message: alertMsg, webhookUrl }, runtimeContext: new RuntimeContext() });
              await incrementUserMetric("global", "totalAlertsSent", alertMsg);
              await incrementUserMetric(user.id, "backrunAttacksDetected");
              await incrementUserMetric(user.id, "totalAlertsSent", alertMsg);
            }
            // Increment totalMEVRisksDetected for any suspicious tx
            if (suspicious) {
              await incrementUserMetric("global", "totalMEVRisksDetected");
              await incrementUserMetric(user.id, "totalMEVRisksDetected");
            }
          }
        }
        if (txs.length >= 1) {
          console.log("[mempoolMonitorTool] Collected 1 transaction, resolving.");
          provider.off("pending", onTx);
          if (timeout) clearTimeout(timeout);
          resolve(txs);
        }
      } catch (err) {
        console.error("[mempoolMonitorTool] Error processing tx:", err);
      }
    };

    provider.on("pending", onTx);
    console.log("[mempoolMonitorTool] Listening for pending transactions...");
    // Timeout after 30 seconds
    timeout = setTimeout(() => {
      console.log("[mempoolMonitorTool] Timeout reached, returning collected transactions:", txs.length);
      provider.off("pending", onTx);
      resolve(txs);
    }, 30000);
  });
};

// --- SIMULATION FOR TESTING MULTIPLE ATTACKS ---
async function simulateMultipleAttacks() {
  // 1. Large value transfer
  const largeValueTx = {
    hash: "0xlargevalue" + Date.now(),
    from: "0x1234567890abcdef1234567890abcdef12345678",
    to: "0xa1BB3d0e6D742a09fDb4cAcb51E76F91891eaD5F",
    value: "50000000000000000000", // 50 ETH
    gasPrice: "10000000000", // 10 gwei
    type: "0",
    suspicious: false,
  };
  recentTxs.push(largeValueTx);

  // 2. Known MEV bot
  const mevBotTx = {
    hash: "0xmevbot" + Date.now(),
    from: "0x000000000000ad05ccc4f10045630fb830b95127", // Known MEV bot
    to: "0xa1BB3d0e6D742a09fDb4cAcb51E76F91891eaD5F",
    value: "1000000000000000000", // 1 ETH
    gasPrice: "10000000000", // 10 gwei
    type: "0",
    suspicious: false,
  };
  recentTxs.push(mevBotTx);

  // 3. Sandwich attack (before, victim, after)
  const dexRouter = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
  const attacker = "0xaaaaaa000000000000000000000000000000aaaa";
  const beforeTx = {
    hash: "0xsandwichbefore" + Date.now(),
    from: attacker,
    to: dexRouter,
    value: "1000000000000000000",
    gasPrice: "20000000000",
    type: "0",
    suspicious: false,
  };
  const victimTx = {
    hash: "0xsandwichvictim" + Date.now(),
    from: "0xa1BB3d0e6D742a09fDb4cAcb51E76F91891eaD5F",
    to: dexRouter,
    value: "1000000000000000000",
    gasPrice: "15000000000",
    type: "0",
    suspicious: false,
  };
  const afterTx = {
    hash: "0xsandwichafter" + Date.now(),
    from: attacker,
    to: dexRouter,
    value: "1000000000000000000",
    gasPrice: "25000000000",
    type: "0",
    suspicious: false,
  };
  recentTxs.push(beforeTx, victimTx, afterTx);

  // 4. Frontrun
  const victimFrontrun = {
    hash: "0xvictimfrontrun" + Date.now(),
    from: "0xa1BB3d0e6D742a09fDb4cAcb51E76F91891eaD5F",
    to: dexRouter,
    value: "1000000000000000000",
    gasPrice: "10000000000",
    type: "0",
    suspicious: false,
  };
  const frontrunner = {
    hash: "0xfrontrunner" + Date.now(),
    from: "0xbbbbbb000000000000000000000000000000bbbb",
    to: dexRouter,
    value: "1000000000000000000",
    gasPrice: "20000000000", // higher gas
    type: "0",
    suspicious: false,
  };
  recentTxs.push(victimFrontrun, frontrunner);

  // 5. Backrun
  const victimBackrun = {
    hash: "0xvictimbackrun" + Date.now(),
    from: "0xa1BB3d0e6D742a09fDb4cAcb51E76F91891eaD5F",
    to: dexRouter,
    value: "1000000000000000000",
    gasPrice: "10000000000",
    type: "0",
    suspicious: false,
  };
  const backrunner = {
    hash: "0xbackrunner" + Date.now(),
    from: "0xcccccc000000000000000000000000000000cccc",
    to: dexRouter,
    value: "1000000000000000000",
    gasPrice: "9000000000", // lower gas, but after
    type: "0",
    suspicious: false,
  };
  recentTxs.push(victimBackrun, backrunner);

  // Run detection logic for each
  for (const tx of [largeValueTx, mevBotTx, beforeTx, victimTx, afterTx, victimFrontrun, frontrunner, victimBackrun]) {
    let suspicious = false;
    let reasons: string[] = [];
    const gasPrice = BigInt(tx.gasPrice);
    if (gasPrice > SUSPICIOUS_GAS_PRICE) {
      suspicious = true;
      reasons.push(`High gas price: ${gasPrice} wei`);
    }
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    if (KNOWN_MEV_BOTS.includes(from) || KNOWN_MEV_BOTS.includes(to)) {
      suspicious = true;
      reasons.push(`Known MEV bot address involved: ${from === to ? from : from + ' or ' + to}`);
    }
    const value = BigInt(tx.value);
    if (value > LARGE_VALUE_WEI) {
      suspicious = true;
      reasons.push(`Large value transfer: ${ethers.utils.formatUnits(value, 18)} ETH`);
    }
    if (KNOWN_DEX_ROUTERS.includes(to) && gasPrice > SUSPICIOUS_GAS_PRICE) {
      suspicious = true;
      reasons.push(`To known DEX router (${to}) with high gas price (${gasPrice} wei)`);
    }
    // Advanced MEV patterns
    const thisTx = { ...tx, suspicious };
    const sandwich = detectSandwichAttack(thisTx);
    if (sandwich) {
      suspicious = true;
      reasons.push(sandwich);
    }
    const frontrun = detectFrontrun(thisTx);
    if (frontrun) {
      suspicious = true;
      reasons.push(frontrun);
    }
    const backrun = detectBackrun(thisTx);
    if (backrun) {
      suspicious = true;
      reasons.push(backrun);
    }
    // Per-user alerting and metrics
    const users = await loadUsers();
    const txAddresses = [from, to].filter(Boolean);
    // Increment global totalTransactionsAnalyzed
    await incrementUserMetric("global", "totalTransactionsAnalyzed");
    for (const user of users) {
      if (!user.wallets || user.wallets.length === 0) continue;
      const match = user.wallets.some((w: string) => txAddresses.includes(w.toLowerCase()));
      if (!match) continue;
      // Increment per-user totalTransactionsAnalyzed
      await incrementUserMetric(user.id, "totalTransactionsAnalyzed");
      const webhookUrl = user.notificationPrefs?.discordWebhook;
      if (suspicious) {
        const alertMsg = `ALERT: Simulated suspicious tx for user ${user.username} to ${to}. Reason: ${reasons.join('; ')}`;
        await notificationTool.execute({ context: { message: alertMsg, webhookUrl }, runtimeContext: new RuntimeContext() });
        await incrementUserMetric("global", "totalAlertsSent", alertMsg);
        await incrementUserMetric(user.id, "totalAlertsSent", alertMsg);
        // Increment per-type metrics if detected
        if (reasons.some(r => r.toLowerCase().includes("sandwich"))) {
          await incrementUserMetric("global", "sandwichAttacksDetected");
          await incrementUserMetric(user.id, "sandwichAttacksDetected");
        }
        if (reasons.some(r => r.toLowerCase().includes("frontrun"))) {
          await incrementUserMetric("global", "frontrunAttacksDetected");
          await incrementUserMetric(user.id, "frontrunAttacksDetected");
        }
        if (reasons.some(r => r.toLowerCase().includes("backrun"))) {
          await incrementUserMetric("global", "backrunAttacksDetected");
          await incrementUserMetric(user.id, "backrunAttacksDetected");
        }
        // Increment totalMEVRisksDetected for any suspicious tx
        await incrementUserMetric("global", "totalMEVRisksDetected");
        await incrementUserMetric(user.id, "totalMEVRisksDetected");
      }
    }
  }
}
//simulateMultipleAttacks(); // Commented out after testing

export const mempoolMonitorTool = createTool({
  id: "monitor-mempool",
  description: "Monitor Ethereum mempool for suspicious or MEV-related transactions.",
  inputSchema: z.object({}), // No input for MVP
  outputSchema: z.object({
    txs: z.array(
      z.object({
        hash: z.string(),
        from: z.string(),
        to: z.string().nullable(),
        value: z.string(),
        gasPrice: z.string(),
        type: z.string(),
        suspicious: z.boolean(),
        reason: z.string().optional(),
      })
    ),
  }),
  execute: async () => {
    const txs = await monitorMempool();
    return { txs };
  },
}); 