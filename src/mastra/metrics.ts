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

export async function incrementTransactionsAnalyzed() {
  metrics.totalTransactionsAnalyzed++;
  await saveMetrics();
}

export async function incrementMEVRisksDetected() {
  metrics.totalMEVRisksDetected++;
  await saveMetrics();
}

export async function incrementAlertsSent(message: string) {
  metrics.totalAlertsSent++;
  metrics.recentAlerts.unshift(message);
  if (metrics.recentAlerts.length > 10) metrics.recentAlerts.pop();
  await saveMetrics();
}

export function getMetrics() {
  return { ...metrics };
} 