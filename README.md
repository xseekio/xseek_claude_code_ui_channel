# Claude Channel UI Plugin

A Claude Code channel plugin that provides a web-based chat UI. It connects directly to your local Claude Code session — your tools, your MCP servers, your environment.

## How it works

```
Browser (localhost:8787)
    ↕ WebSocket
Channel MCP Server
    ↕ stdio
Your local Claude Code session
```

## Setup

```bash
npm install
```

## Usage

From any project where you want to use this:

```bash
claude --dangerously-load-development-channels server:channel-ui
```

Then open http://127.0.0.1:8787 in your browser.

## Installing in another repo

Add to the target project's `.mcp.json`:

```json
{
  "mcpServers": {
    "channel-ui": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/claude-channel-ui-plugin/channel/server.ts"]
    }
  }
}
```

Then launch:

```bash
claude --dangerously-load-development-channels server:channel-ui
```

## Configuration

Set the port via environment variable:

```bash
CHANNEL_UI_PORT=9000 claude --dangerously-load-development-channels server:channel-ui
```
