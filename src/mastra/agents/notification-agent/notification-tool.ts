import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const DEFAULT_DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1389868065184809010/XVG_y5uL1u_5aCtNHsTL3IRH4-Jy95hGiME3Enamj8OADUJzbWXlJaUkKruOTXt0sW9r";

export const notificationTool = createTool({
  id: "send-notification",
  description: "Send a real-time alert (Discord webhook + console log).",
  inputSchema: z.object({
    message: z.string().describe("Alert message to send"),
    webhookUrl: z.string().optional().describe("Override Discord webhook URL")
  }),
  outputSchema: z.object({
    status: z.string(),
  }),
  execute: async ({ context }) => {
    const message = context.message;
    const webhookUrl = context.webhookUrl || process.env.DISCORD_WEBHOOK_URL || DEFAULT_DISCORD_WEBHOOK_URL;
    console.log(`[ALERT] ${message}`);
    let discordStatus = "";
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      if (res.ok) {
        discordStatus = "Discord notification sent";
      } else {
        discordStatus = `Discord notification failed: ${res.status}`;
      }
    } catch (err: any) {
      discordStatus = `Discord notification error: ${err.message}`;
    }
    return { status: `Notification sent (console log). ${discordStatus}` };
  },
}); 