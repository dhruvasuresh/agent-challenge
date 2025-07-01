import { Agent } from "@mastra/core/agent";
import { model } from "../../config";
import { mempoolMonitorTool } from "./mempool-monitor-tool";

const name = "Mempool Monitor Agent";
const instructions = `
  You are a mempool monitoring agent for debugging.
  For ANY user message, immediately call the mempoolMonitorTool and return its output directly, without any additional reasoning, explanation, or formatting.
  Do not attempt to answer in your own words or provide context—just call the tool and return the result.
`;

export const mempoolMonitorAgent = new Agent({
  name,
  instructions,
  model,
  tools: { mempoolMonitorTool },
}); 