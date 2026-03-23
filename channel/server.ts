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

// ── Types ─────────────────────────────────────────────────────────

type Loop = {
  id: string;
  interval: string;
  command: string;
  createdAt: string;
};

type ChatMessage = {
  text: string;
  type: "user" | "claude";
  timestamp: number;
};

type ChatSession = {
  chatId: string;
  messages: ChatMessage[];
  createdAt: string;
  lastMessage: string;
};

// ── State ─────────────────────────────────────────────────────────

const loops = new Map<string, Loop>();
const sessions = new Map<string, ChatSession>();
const clients = new Map<string, WebSocket>(); // chatId -> active ws
let nextChatId = 1;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Loop helpers ──────────────────────────────────────────────────

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

// ── Session helpers ───────────────────────────────────────────────

function createSession(): ChatSession {
  const chatId = String(nextChatId++);
  const session: ChatSession = {
    chatId,
    messages: [],
    createdAt: new Date().toISOString(),
    lastMessage: "",
  };
  sessions.set(chatId, session);
  console.error(`[channel-ui] Session created: chat_id=${chatId}`);
  return session;
}

function getSessionsList() {
  return Array.from(sessions.values()).map((s) => ({
    chatId: s.chatId,
    messageCount: s.messages.length,
    lastMessage: s.lastMessage,
    createdAt: s.createdAt,
  }));
}

function broadcastSessionsList(): void {
  const payload = JSON.stringify({
    type: "sessions:list",
    sessions: getSessionsList(),
  });
  for (const ws of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ── MCP Channel Server ─────────────────────────────────────────────

const mcp = new Server(
  { name: "channel-ui", version: "0.2.0" },
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

// ── MCP Tools ───────────────────────────────────────────────────────

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

    // Store reply in session
    const session = sessions.get(chat_id);
    if (session) {
      session.messages.push({ text, type: "claude", timestamp: Date.now() });
      session.lastMessage = text.slice(0, 80);
    }

    // Send to connected client
    const clientWs = clients.get(chat_id);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({ type: "reply", chatId: chat_id, text, timestamp: Date.now() })
      );
    }

    // Broadcast updated session list to all clients
    broadcastSessionsList();

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
  // Don't assign a chatId yet — wait for the client to either
  // create a new session or join an existing one
  let boundChatId: string | null = null;

  // Send existing sessions + loops immediately
  ws.send(
    JSON.stringify({
      type: "sessions:list",
      sessions: getSessionsList(),
    })
  );

  ws.send(
    JSON.stringify({
      type: "loops:state",
      loops: Array.from(loops.values()),
    })
  );

  console.error(`[channel-ui] WebSocket connected (not yet bound to a session)`);

  ws.on("message", async (raw) => {
    const data = JSON.parse(String(raw));

    // ── Create new session ──
    if (data.type === "session:create") {
      const session = createSession();
      boundChatId = session.chatId;

      // Unbind from previous session if any
      clients.set(session.chatId, ws);

      ws.send(
        JSON.stringify({
          type: "session:created",
          chatId: session.chatId,
          messages: [],
        })
      );

      broadcastSessionsList();
    }

    // ── Join existing session ──
    if (data.type === "session:join") {
      const session = sessions.get(data.chatId);
      if (session) {
        boundChatId = session.chatId;
        clients.set(session.chatId, ws);

        ws.send(
          JSON.stringify({
            type: "session:joined",
            chatId: session.chatId,
            messages: session.messages,
          })
        );

        console.error(
          `[channel-ui] Client joined session: chat_id=${session.chatId} (${session.messages.length} messages)`
        );
      }
    }

    // ── Send message ──
    if (data.type === "message" && boundChatId) {
      const session = sessions.get(boundChatId);

      // Store user message
      if (session) {
        session.messages.push({
          text: data.text,
          type: "user",
          timestamp: Date.now(),
        });
        session.lastMessage = data.text.slice(0, 80);
      }

      // Intercept /loop commands
      const loop = parseLoopCommand(data.text);
      if (loop) {
        loops.set(loop.id, loop);
        console.error(
          `[channel-ui] Loop registered: id=${loop.id} interval=${loop.interval} cmd=${loop.command}`
        );
        broadcastLoops();
      }

      // Forward to Claude Code
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: data.text,
          meta: { chat_id: boundChatId },
        },
      });

      broadcastSessionsList();

      console.error(
        `[channel-ui] Message forwarded to Claude: chat_id=${boundChatId}`
      );
    }

    // ── Loop management ──
    if (data.type === "loops:list") {
      ws.send(
        JSON.stringify({
          type: "loops:state",
          loops: Array.from(loops.values()),
        })
      );
    }
  });

  ws.on("close", () => {
    // Don't delete the session — just unbind the ws
    if (boundChatId) {
      const current = clients.get(boundChatId);
      if (current === ws) {
        clients.delete(boundChatId);
      }
      console.error(
        `[channel-ui] Client disconnected from session: chat_id=${boundChatId}`
      );
    }
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
