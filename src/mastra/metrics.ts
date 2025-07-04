// Simple in-memory metrics store for MEV protection suite

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const METRICS_FILE = path.join(__dirname, "../../metrics.json");

const metrics = {
  totalTransactionsAnalyzed: 0,
  totalMEVRisksDetected: 0,
  totalAlertsSent: 0,
  recentAlerts: [] as string[],
  sandwichAttacksDetected: 0,
  frontrunAttacksDetected: 0,
  backrunAttacksDetected: 0,
  userMetrics: {} as Record<string, any>, // userId -> metrics
};

async function saveMetrics() {
  try {
    await fs.writeFile(METRICS_FILE, JSON.stringify(metrics, null, 2), "utf-8");
  } catch (err: any) {
    console.error("Failed to save metrics:", err);
  }
}

async function loadMetrics() {
  try {
    const data = await fs.readFile(METRICS_FILE, "utf-8");
    const loaded = JSON.parse(data);
    Object.assign(metrics, loaded);
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error("Failed to load metrics:", err);
    }
    // else: file does not exist, start fresh
  }
}

// Immediately load metrics on module import
loadMetrics();

function getOrCreateUserMetrics(userId: string) {
  if (!metrics.userMetrics[userId]) {
    metrics.userMetrics[userId] = {
      totalTransactionsAnalyzed: 0,
      totalMEVRisksDetected: 0,
      totalAlertsSent: 0,
      recentAlerts: [] as string[],
      sandwichAttacksDetected: 0,
      frontrunAttacksDetected: 0,
      backrunAttacksDetected: 0,
    };
  }
  return metrics.userMetrics[userId];
}

export async function incrementUserMetric(userId: string, metric: string, message?: string) {
  const user = getOrCreateUserMetrics(userId);
  if (metric.endsWith("AttacksDetected")) {
    user[metric] = (user[metric] || 0) + 1;
  } else if (metric === "totalTransactionsAnalyzed" || metric === "totalMEVRisksDetected" || metric === "totalAlertsSent") {
    user[metric] = (user[metric] || 0) + 1;
  }
  if (metric === "totalAlertsSent" && message) {
    user.recentAlerts.unshift(message);
    if (user.recentAlerts.length > 10) user.recentAlerts.pop();
  }
  await saveMetrics();
}

export function getMetrics(userId?: string) {
  if (userId) {
    return metrics.userMetrics[userId] || getOrCreateUserMetrics(userId);
  }
  return { ...metrics };
} 