import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { notificationTool } from "../notification-agent/notification-tool";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { incrementUserMetric, getMetrics } from "../../metrics";

// Minimal mock runtime context for tool execution
const mockRuntimeContext = {
  registry: {},
  set: () => {},
  get: () => undefined,
  has: () => false,
  delete: () => {},
  keys: () => [],
  values: () => [],
  entries: () => [],
  clear: () => {},
  forEach: () => {},
  size: 0,
};

// Detection logic (same as before)
const KNOWN_MEV_BOTS = [
  "0x000000000000ad05ccc4f10045630fb830b95127",
  "0x88ad09518695c6c3712ac10a214be5109a655671",
];
const KNOWN_DEX_ROUTERS = [
  "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
  "0x1111111254eeb25477b68fb85ed929f73a960582",
  "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f",
];
const GWEI = 1_000_000_000n;
const SUSPICIOUS_GAS_PRICE = 100n * GWEI;
const LARGE_VALUE_WEI = 10n * 1_000_000_000_000_000_000n; // 10 ETH

function parseWeiString(str: string): bigint {
  return BigInt(str.replace(/\s*wei$/i, '').trim());
}

export const protectionTool = createTool({
  id: "protect-transaction",
  description: "Check a transaction for MEV risk and route through MEV-protected relays (simulated).",
  inputSchema: z.object({
    from: z.string().describe("Sender address"),
    to: z.string().describe("Recipient address"),
    value: z.string().describe("Value in wei"),
    data: z.string().optional().describe("Transaction data (hex)"),
    gasPrice: z.string().describe("Gas price in wei"),
  }),
  outputSchema: z.object({
    status: z.string(),
    mevRisk: z.boolean(),
    reason: z.string().optional(),
    action: z.string(),
  }),
  execute: async ({ context }) => {
    await incrementUserMetric("global", "totalTransactionsAnalyzed");
    let mevRisk = false;
    let reasons: string[] = [];
    const from = context.from.toLowerCase();
    const to = context.to.toLowerCase();
    const gasPrice = parseWeiString(context.gasPrice);
    const value = parseWeiString(context.value);
    if (gasPrice > SUSPICIOUS_GAS_PRICE) {
      mevRisk = true;
      reasons.push(`High gas price: ${gasPrice} wei`);
    }
    if (KNOWN_MEV_BOTS.includes(from) || KNOWN_MEV_BOTS.includes(to)) {
      mevRisk = true;
      reasons.push(`Known MEV bot address involved: ${from === to ? from : from + ' or ' + to}`);
    }
    if (value > LARGE_VALUE_WEI) {
      mevRisk = true;
      reasons.push(`Large value transfer: ${value} wei`);
    }
    if (KNOWN_DEX_ROUTERS.includes(to) && gasPrice > SUSPICIOUS_GAS_PRICE) {
      mevRisk = true;
      reasons.push(`To known DEX router (${to}) with high gas price (${gasPrice} wei)`);
    }
    let action = "Sent directly to Ethereum mempool (no protection needed)";
    if (mevRisk) {
      await incrementUserMetric("global", "totalMEVRisksDetected");
      action = "Simulated: Routed through Flashbots Protect for MEV protection";
      // Send alert
      const alertMsg = `ALERT: MEV risk detected for tx from ${from} to ${to}, value ${value}, gasPrice ${gasPrice}. Reason: ${reasons.join("; ")}`;
      await notificationTool.execute({
        context: { message: alertMsg },
        runtimeContext: new RuntimeContext()
      });
      await incrementUserMetric("global", "totalAlertsSent", alertMsg);
    }
    return {
      status: mevRisk ? "MEV risk detected" : "No MEV risk detected",
      mevRisk,
      reason: reasons.join("; "),
      action,
    };
  },
});

export const metricsTool = createTool({
  id: "get-metrics",
  description: "Get current MEV protection suite metrics (transactions analyzed, MEV risks, alerts, recent alerts).",
  inputSchema: z.object({}),
  outputSchema: z.object({
    totalTransactionsAnalyzed: z.number(),
    totalMEVRisksDetected: z.number(),
    totalAlertsSent: z.number(),
    recentAlerts: z.array(z.string()),
  }),
  execute: async () => {
    return getMetrics();
  },
}); 