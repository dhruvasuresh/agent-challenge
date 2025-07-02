import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { weatherAgent } from "./agents/weather-agent/weather-agent"; // This can be deleted later
import { weatherWorkflow } from "./agents/weather-agent/weather-workflow"; // This can be deleted later
import { yourAgent } from "./agents/your-agent/your-agent"; // Build your agent here
import { mempoolMonitorAgent } from "./agents/mempool-monitor-agent/mempool-monitor-agent";
import { protectionAgent } from "./agents/protection-agent/protection-agent";
import { notificationAgent } from "./agents/notification-agent/notification-agent";
import express, { Request, Response } from "express";
import { getMetrics } from "./metrics";

export const mastra = new Mastra({
	workflows: { weatherWorkflow }, // can be deleted later
	agents: { weatherAgent, yourAgent, mempoolMonitorAgent, protectionAgent, notificationAgent },
	logger: new PinoLogger({
		name: "Mastra",
		level: "info",
	}),
	server: {
		port: 8080,
		timeout: 10000,
	},
});

// Add metrics API endpoint
const app = express();
app.get("/api/metrics", (req: Request, res: Response) => {
	res.json(getMetrics());
});
app.listen(8090, () => {
	console.log("Metrics API available at http://localhost:8090/api/metrics");
});
