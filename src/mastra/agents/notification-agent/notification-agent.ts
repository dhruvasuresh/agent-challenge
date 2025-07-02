import { Agent } from "@mastra/core/agent";
import { model } from "../../config";
import { notificationTool } from "./notification-tool";

const name = "Notification Agent";
const instructions = `
You are a notification agent.
For any message you receive, always call the notificationTool to send a real-time alert (console log for MVP).
Return the result of the tool call directly.
`;

export const notificationAgent = new Agent({
  name,
  instructions,
  model,
  tools: { notificationTool },
}); 