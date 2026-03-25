# Claude Channel UI Plugin

A web-based chat interface for Claude Code. Opens a browser UI that connects directly to your running Claude Code session — your tools, your MCP servers, your project context.

## Architecture

```
Browser (http://127.0.0.1:8787)
    ↕ WebSocket
Channel MCP Server (Node.js)
    ↕ stdio (MCP protocol)
Claude Code (local CLI session)
    ↕
Your MCP servers, tools, filesystem, CLAUDE.md
```

The plugin is an MCP server that acts as a bridge between a browser-based chat UI and Claude Code. When you send a message in the browser, it's forwarded to Claude Code as an MCP channel notification. Claude Code responds by calling a `reply` tool, which sends the message back to your browser via WebSocket.

Claude Code has full access to everything it normally does — your project files, MCP servers (xSeek, Firecrawl, etc.), slash commands (`/generate-article`, `/aeo-audit`), and your CLAUDE.md project instructions.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (`claude --version`)
- Logged in (`claude login`)
- Node.js 18+

## Installation

```bash
cd claude-channel-ui-plugin
npm install
```

## Quick Start (Same Directory)

From inside this repo:

```bash
claude --dangerously-load-development-channels server:channel-ui
```

Then open **http://127.0.0.1:8787** in your browser.

That's it. You're chatting with Claude Code through the web UI.

## Using From Another Project

You can use this plugin from any project directory. This is the most common setup — you want Claude Code to work in your project (reading its CLAUDE.md, accessing its files) while you chat through the browser UI.

### Step 1: Add the MCP server to your project

Create or edit `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "channel-ui": {
      "command": "npx",
      "args": ["tsx", "/Users/YOUR_USERNAME/projects/claude-channel-ui-plugin/channel/server.ts"]
    }
  }
}
```

Replace the path with the absolute path to `channel/server.ts` on your machine.

### Step 2: Launch Claude Code with the channel

```bash
cd /path/to/your-project
claude --dangerously-load-development-channels server:channel-ui
```

### Step 3: Open the browser

Go to **http://127.0.0.1:8787**. Create a new session and start chatting.

Claude Code runs in your project directory. It reads your project's CLAUDE.md, has access to your files, and can use any MCP servers configured in your project's `.mcp.json`.

## Global Installation (All Projects)

To make the channel UI available from any project without per-project `.mcp.json`:

Edit `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "channel-ui": {
      "command": "npx",
      "args": ["tsx", "/Users/YOUR_USERNAME/projects/claude-channel-ui-plugin/channel/server.ts"]
    }
  }
}
```

Then from any project:

```bash
claude --dangerously-load-development-channels server:channel-ui
```

## Configuration

### Port

Default port is `8787`. Change it with an environment variable:

```bash
CHANNEL_UI_PORT=9000 claude --dangerously-load-development-channels server:channel-ui
```

Or set it in your `.mcp.json`:

```json
{
  "mcpServers": {
    "channel-ui": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/channel/server.ts"],
      "env": {
        "CHANNEL_UI_PORT": "9000"
      }
    }
  }
}
```

## Features

### Sessions

- Click **"New Session"** to start a fresh conversation
- Sessions persist across browser refreshes — reconnect to continue where you left off
- Switch between sessions in the sidebar
- Each session maintains its own message history

### Slash Commands

The UI has built-in autocomplete for common commands:

| Command | Description |
|---------|-------------|
| `/generate-article` | Generate an article from an opportunity |
| `/find-opportunities` | Find content gaps and opportunities |
| `/aeo-audit` | Full AI Engine Optimization audit |
| `/weekly-report` | AI visibility weekly report |
| `/track-visibility` | Quick visibility overview |
| `/optimize-page URL` | Optimize a page for AI visibility |
| `/rewrite-page URL` | Rewrite page content |
| `/loop 10m /command` | Schedule a recurring command |

These are sent as text to Claude Code, which executes them as slash commands in your project context.

### Loops

Schedule recurring commands:

```
/loop 10m /track-visibility
/loop 1h /weekly-report
```

Loops are displayed in the sidebar. (Scheduling is tracked in-memory for the current session.)

## How It Works (Technical)

### Message Flow: User → Claude

1. User types a message in the browser
2. Browser sends `{ type: "message", text: "..." }` via WebSocket
3. Server stores the message in the session
4. Server sends an MCP notification to Claude Code:
   ```
   notifications/claude/channel → { content: "...", meta: { chat_id: "1" } }
   ```
5. Claude Code processes the message with full project context

### Message Flow: Claude → User

1. Claude Code calls the `reply` MCP tool: `reply({ chat_id: "1", text: "..." })`
2. Server stores the reply in the session
3. Server sends `{ type: "reply", chatId: "1", text: "..." }` via WebSocket
4. Browser renders the markdown response

### Key Files

| File | Purpose |
|------|---------|
| `channel/server.ts` | MCP server + HTTP server + WebSocket bridge |
| `channel/ui/index.html` | Complete browser UI (vanilla JS, no build step) |
| `.claude-plugin/plugin.json` | Plugin metadata for Claude Code |
| `.mcp.json` | Local MCP server configuration |

### Session State

Sessions are stored in-memory on the server:

```typescript
{
  chatId: string;          // Auto-incrementing ID
  messages: ChatMessage[]; // Full message history
  createdAt: string;       // ISO timestamp
  lastMessage: string;     // Preview (first 80 chars)
}
```

Sessions persist as long as the Claude Code process is running. Closing the browser doesn't destroy the session — you can reconnect and see your full history.

## Troubleshooting

### "Cannot connect" in the browser

Make sure Claude Code is running with the channel flag:

```bash
claude --dangerously-load-development-channels server:channel-ui
```

Check the terminal — you should see:

```
[channel-ui] Web UI running at http://127.0.0.1:8787
[channel-ui] Open this URL in your browser to chat with Claude Code
```

### Port already in use

Another instance may be running. Change the port:

```bash
CHANNEL_UI_PORT=9000 claude --dangerously-load-development-channels server:channel-ui
```

### Claude doesn't respond

1. Check the terminal for errors
2. Make sure you created a session (click "New Session")
3. Claude Code must be authenticated (`claude login`)

### MCP server not found

If Claude Code says it can't find the channel-ui server:

1. Verify the path in `.mcp.json` is absolute and correct
2. Make sure `npm install` was run in this repo
3. Check that `npx tsx` works: `npx tsx --version`
