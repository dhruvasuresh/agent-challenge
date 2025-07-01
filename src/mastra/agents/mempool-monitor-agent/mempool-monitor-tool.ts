import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { WebSocketProvider, formatUnits } from "ethers";

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

const monitorMempool = async (): Promise<MempoolTx[]> => {
  if (!MEMPOOL_WS_URL) {
    throw new Error("ETHEREUM_WSS_URL environment variable not set");
  }
  console.log("[mempoolMonitorTool] Connecting to:", MEMPOOL_WS_URL);
  const provider = new WebSocketProvider(MEMPOOL_WS_URL);

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
            reasons.push(`Large value transfer: ${formatUnits(value, 18)} ETH`);
          }
          // DEX router + high gas
          if (KNOWN_DEX_ROUTERS.includes(to) && gasPrice > SUSPICIOUS_GAS_PRICE) {
            suspicious = true;
            reasons.push(`To known DEX router (${to}) with high gas price (${gasPrice} wei)`);
          }
          txs.push({
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            value: tx.value ? tx.value.toString() : "0",
            gasPrice: tx.gasPrice ? tx.gasPrice.toString() : "0",
            type: tx.type?.toString() || "unknown",
            suspicious,
            ...(suspicious && reasons.length ? { reason: reasons.join("; ") } : {}),
          });
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