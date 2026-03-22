#!/usr/bin/env npx tsx
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Loop Registry ─────────────────────────────────────────────────

type Loop = {
  id: string;
  interval: string;
  command: string;
  createdAt: string;
};

const loops = new Map<string, Loop>();

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function parseLoopCommand(text: string): Loop | null {
  const match = text.match(/^\/loop\s+(\d+[smhd]?m?)\s+(.+)$/i);
  if (!match) return null;
  return {
    id: generateId(),
    interval: match[1],
    command: match[2].trim(),
    createdAt: new Date().toISOString(),
  };
}

function broadcastLoops(): void {
  const payload = JSON.stringify({
    type: "loops:state",
    loops: Array.from(loops.values()),
  });
  for (const ws of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ── MCP Channel Server ─────────────────────────────────────────────

const mcp = new Server(
  { name: "channel-ui", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `Messages arrive as <channel source="channel-ui" chat_id="...">.
These are messages from the user through a web chat interface.
Reply using the "reply" tool, passing the chat_id from the channel tag.
Always reply to every message — the user is waiting for your response in the UI.`,
  }
);

// ── Connected WebSocket clients ─────────────────────────────────────

const clients = new Map<string, WebSocket>();
let nextChatId = 1;

// ── MCP Tools: reply back to the UI ─────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a reply message back to the user in the web chat UI. Use this to respond to every channel message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "The chat_id from the channel message tag",
          },
          text: {
            type: "string",
            description: "The message text to send back to the user",
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text } = req.params.arguments as {
      chat_id: string;
      text: string;
    };

    const clientWs = clients.get(chat_id);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "reply",
          text,
          timestamp: Date.now(),
        })
      );
    }

    return {
      content: [
        { type: "text" as const, text: `Reply sent to chat ${chat_id}` },
      ],
    };
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

// ── Connect to Claude Code via stdio ────────────────────────────────

await mcp.connect(new StdioServerTransport());

// ── HTTP Server (serves UI) ─────────────────────────────────────────

const PORT = Number(process.env.CHANNEL_UI_PORT) || 8787;
const uiHtml = readFileSync(join(__dirname, "ui", "index.html"), "utf-8");

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(uiHtml);
});

// ── WebSocket Server ────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const chatId = String(nextChatId++);
  clients.set(chatId, ws);

  // Send connection ack + current loop state
  ws.send(
    JSON.stringify({
      type: "connected",
      chatId,
      message: "Connected to Claude Code channel",
    })
  );

  ws.send(
    JSON.stringify({
      type: "loops:state",
      loops: Array.from(loops.values()),
    })
  );

  console.error(`[channel-ui] Client connected: chat_id=${chatId}`);

  ws.on("message", async (raw) => {
    const data = JSON.parse(String(raw));

    if (data.type === "message") {
      // Intercept /loop commands to register in the loop registry
      const loop = parseLoopCommand(data.text);
      if (loop) {
        loops.set(loop.id, loop);
        console.error(
          `[channel-ui] Loop registered: id=${loop.id} interval=${loop.interval} cmd=${loop.command}`
        );
        broadcastLoops();
      }

      // Forward user message to Claude Code via MCP notification
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: data.text,
          meta: {
            chat_id: chatId,
          },
        },
      });

      console.error(
        `[channel-ui] Message forwarded to Claude: chat_id=${chatId}`
      );
    }

    // ── Loop management messages ──
    if (data.type === "loops:list") {
      ws.send(
        JSON.stringify({
          type: "loops:state",
          loops: Array.from(loops.values()),
        })
      );
    }

    if (data.type === "loops:remove") {
      const loop = data.id ? loops.get(data.id) : undefined;
      if (loop) {
        loops.delete(data.id);
        console.error(
          `[channel-ui] Loop removed: id=${data.id} cmd=${loop.command}`
        );
        broadcastLoops();

        // Ask Claude to cancel the actual cron job
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: `Cancel the scheduled loop that runs "${loop.command}" every ${loop.interval}. Use CronDelete to remove it. Do not reply to this message in the chat — just delete the cron silently.`,
            meta: {
              chat_id: chatId,
            },
          },
        });

        console.error(
          `[channel-ui] Cancel request sent to Claude for loop: ${loop.command}`
        );
      }
    }
  });

  ws.on("close", () => {
    clients.delete(chatId);
    console.error(`[channel-ui] Client disconnected: chat_id=${chatId}`);
  });
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(
    `[channel-ui] Web UI running at http://127.0.0.1:${PORT}`
  );
  console.error(
    `[channel-ui] Open this URL in your browser to chat with Claude Code`
  );
});
