# Pi MCP Adapter

Use MCP servers with [Pi](https://github.com/badlogic/pi-mono/) without burning your context window.

https://github.com/user-attachments/assets/4b7c66ff-e27e-4639-b195-22c3db406a5a

## Why This Exists

Mario (Pi's creator) wrote about [why you might not need MCP](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/). The core issue: MCP servers ship dozens of tools with verbose descriptions. Playwright MCP has 21 tools eating 13.7k tokens. Chrome DevTools MCP has 26 tools eating 18k tokens. Connect a few servers and you've burned 30-50k tokens before the conversation starts. That's context bloat, slower responses, higher costs, and confused agents drowning in tool options.

His solution: skip MCP, write simple CLI tools.

But there's an active ecosystem of well-maintained MCP servers for databases, browsers, APIs, file systems, and more. This adapter lets you tap into that ecosystem without the context cost. One proxy tool (~200 tokens) instead of hundreds of individual tool definitions. The LLM discovers what it needs on-demand.

## Install

```bash
npx pi-mcp-adapter
```

This downloads the extension to `~/.pi/agent/extensions/pi-mcp-adapter/`, installs dependencies, and configures Pi to load it. Restart Pi after installation.

## Quick Start

Create `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "lifecycle": "keep-alive"
    }
  }
}
```

The LLM searches for tools, sees their schemas, and calls them:

```
mcp({ search: "screenshot" })
```
```
chrome_devtools_take_screenshot
  Take a screenshot of the page or element.

  Parameters:
    format (enum: "png", "jpeg", "webp") [default: "png"]
    fullPage (boolean) - Full page instead of viewport
```
```
mcp({ tool: "chrome_devtools_take_screenshot", args: { format: "png" } })
```

Two calls instead of 26 tools cluttering the context.

## Config

### Server Options

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "lifecycle": "keep-alive"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `command` | Executable for stdio transport |
| `args` | Command arguments |
| `env` | Environment variables (`${VAR}` interpolation) |
| `url` | HTTP endpoint (StreamableHTTP with SSE fallback) |
| `auth` | `"bearer"` or `"oauth"` |
| `bearerToken` / `bearerTokenEnv` | Token or env var |
| `lifecycle` | `"keep-alive"` for auto-reconnect |
| `exposeResources` | Expose MCP resources as tools (default: true) |
| `debug` | Show server stderr (default: false) |

### Import Existing Configs

Already have MCP set up elsewhere? Import it:

```json
{
  "imports": ["cursor", "claude-code", "claude-desktop"],
  "mcpServers": { }
}
```

Supported: `cursor`, `claude-code`, `claude-desktop`, `vscode`, `windsurf`, `codex`

## Usage

| Mode | Example |
|------|---------|
| Search | `mcp({ search: "screenshot navigate" })` |
| Describe | `mcp({ describe: "tool_name" })` |
| Call | `mcp({ tool: "...", args: {...} })` |
| Status | `mcp({ })` or `mcp({ server: "name" })` |

Search includes parameter schemas by default. Space-separated words are OR'd.

## Commands

| Command | What it does |
|---------|--------------|
| `/mcp` | Server status |
| `/mcp tools` | List all tools |
| `/mcp reconnect` | Reconnect servers |
| `/mcp-auth <server>` | OAuth setup |

## How It Works

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details. Short version:

- One `mcp` tool in context (~200 tokens)
- Tool metadata stored in a map, looked up at call time
- MCP server validates arguments
- Keep-alive servers get health checks and auto-reconnect

## Limitations

- OAuth tokens obtained externally (no browser flow)
- No automatic token refresh
