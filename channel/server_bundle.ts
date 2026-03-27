// Bundled version — no file reads, HTML is inlined
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { uiHtml } from "./_ui_html.js";

type Loop = { id: string; interval: string; command: string; createdAt: string };
type ChatMessage = { text: string; type: "user" | "claude"; timestamp: number };
type ChatSession = { chatId: string; messages: ChatMessage[]; createdAt: string; lastMessage: string };

const loops = new Map<string, Loop>();
const sessions = new Map<string, ChatSession>();
const clients = new Map<string, WebSocket>();
let nextChatId = 1;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function parseLoopCommand(text: string): Loop | null {
  const match = text.match(/^\/loop\s+(\d+[smhd]?m?)\s+(.+)$/i);
  if (!match) return null;
  return { id: generateId(), interval: match[1], command: match[2].trim(), createdAt: new Date().toISOString() };
}

function broadcastLoops(): void {
  const payload = JSON.stringify({ type: "loops:state", loops: Array.from(loops.values()) });
  for (const ws of clients.values()) { if (ws.readyState === WebSocket.OPEN) ws.send(payload); }
}

function createSession(): ChatSession {
  const chatId = String(nextChatId++);
  const session: ChatSession = { chatId, messages: [], createdAt: new Date().toISOString(), lastMessage: "" };
  sessions.set(chatId, session);
  console.error(`[channel-ui] Session created: chat_id=${chatId}`);
  return session;
}

function getSessionsList() {
  return Array.from(sessions.values()).map((s) => ({
    chatId: s.chatId, messageCount: s.messages.length, lastMessage: s.lastMessage, createdAt: s.createdAt,
  }));
}

function broadcastSessionsList(): void {
  const payload = JSON.stringify({ type: "sessions:list", sessions: getSessionsList() });
  for (const ws of clients.values()) { if (ws.readyState === WebSocket.OPEN) ws.send(payload); }
}

const mcp = new Server(
  { name: "channel-ui", version: "0.3.0" },
  {
    capabilities: { experimental: { "claude/channel": {} }, tools: {} },
    instructions: `Messages arrive as <channel source="channel-ui" chat_id="...">.
These are messages from the user through a web chat interface.
Reply using the "reply" tool, passing the chat_id from the channel tag.
Always reply to every message — the user is waiting for your response in the UI.`,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "reply",
    description: "Send a reply message back to the user in the web chat UI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: { type: "string", description: "The chat_id from the channel message tag" },
        text: { type: "string", description: "The message text to send back to the user" },
      },
      required: ["chat_id", "text"],
    },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string };
    const session = sessions.get(chat_id);
    if (session) {
      session.messages.push({ text, type: "claude", timestamp: Date.now() });
      session.lastMessage = text.slice(0, 80);
    }
    const clientWs = clients.get(chat_id);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "reply", chatId: chat_id, text, timestamp: Date.now() }));
    }
    broadcastSessionsList();
    return { content: [{ type: "text" as const, text: `Reply sent to chat ${chat_id}` }] };
  }
  throw new Error(`Unknown tool: ${req.params.name}`);
});

(async () => { await mcp.connect(new StdioServerTransport());

const PORT = Number(process.env.CHANNEL_UI_PORT) || 8787;

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(uiHtml);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let boundChatId: string | null = null;
  ws.send(JSON.stringify({ type: "sessions:list", sessions: getSessionsList() }));
  ws.send(JSON.stringify({ type: "loops:state", loops: Array.from(loops.values()) }));

  ws.on("message", async (raw) => {
    const data = JSON.parse(String(raw));
    if (data.type === "session:create") {
      const session = createSession();
      boundChatId = session.chatId;
      clients.set(session.chatId, ws);
      ws.send(JSON.stringify({ type: "session:created", chatId: session.chatId, messages: [] }));
      broadcastSessionsList();
    }
    if (data.type === "session:join") {
      const session = sessions.get(data.chatId);
      if (session) {
        boundChatId = session.chatId;
        clients.set(session.chatId, ws);
        ws.send(JSON.stringify({ type: "session:joined", chatId: session.chatId, messages: session.messages }));
      }
    }
    if (data.type === "message" && boundChatId) {
      const session = sessions.get(boundChatId);
      if (session) {
        session.messages.push({ text: data.text, type: "user", timestamp: Date.now() });
        session.lastMessage = data.text.slice(0, 80);
      }
      const loop = parseLoopCommand(data.text);
      if (loop) { loops.set(loop.id, loop); broadcastLoops(); }
      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content: data.text, meta: { chat_id: boundChatId } },
      });
      broadcastSessionsList();
    }
    if (data.type === "loops:list") {
      ws.send(JSON.stringify({ type: "loops:state", loops: Array.from(loops.values()) }));
    }
  });

  ws.on("close", () => {
    if (boundChatId) {
      const current = clients.get(boundChatId);
      if (current === ws) clients.delete(boundChatId);
    }
  });
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(`[channel-ui] Web UI running at http://127.0.0.1:${PORT}`);
});
})();
