<p>
  <img src="banner.png" alt="pi-mcp-adapter" width="1100">
</p>

# Pi MCP Adapter

Use MCP servers with [Pi](https://github.com/badlogic/pi-mono/) without burning your context window.

https://github.com/user-attachments/assets/4b7c66ff-e27e-4639-b195-22c3db406a5a

## Why This Exists

Mario wrote about [why you might not need MCP](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/). The problem: tool definitions are verbose. A single MCP server can burn 10k+ tokens, and you're paying that cost whether you use those tools or not. Connect a few servers and you've burned half your context window before the conversation starts.

His take: skip MCP entirely, write simple CLI tools instead.

But the MCP ecosystem has useful stuff - databases, browsers, APIs. This adapter gives you access without the bloat. One proxy tool (~200 tokens) instead of hundreds. The agent discovers what it needs on-demand. Servers only start when you actually use them.

## Install

```bash
pi install npm:pi-mcp-adapter
```

Restart Pi after installation.

## What happens on first run

The adapter reads standard MCP files automatically. No extra setup needed if you already have them.

| You already have... | What happens |
|---------------------|--------------|
| `.mcp.json` or `~/.config/mcp/mcp.json` | Pi uses it immediately. The first time you open `/mcp`, you'll see a short heads-up explaining which file Pi detected and that Pi only writes adapter-specific overrides to its own files. |
| Host-specific configs (Cursor, Claude Code, Codex, etc.) but no standard MCP files | Run `/mcp setup` to adopt those host configs into Pi. The setup flow shows exactly what it found, lets you pick which ones to import, and previews the exact file changes before writing. |
| Nothing configured yet | Run `/mcp setup` to scaffold a minimal `.mcp.json`, quick-add RepoPrompt, or inspect what the adapter discovered on your machine. |

If you prefer the terminal, you can also run `pi-mcp-adapter init` after install to scan for host-specific configs and add missing compatibility imports to `~/.pi/agent/mcp.json`.

## Quick Start

Preferred project config: `.mcp.json`

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

Preferred user-global shared config: `~/.config/mcp/mcp.json`

Pi also reads Pi-owned override files for settings and host-specific compatibility:

- `~/.pi/agent/mcp.json` — Pi global override
- `.pi/mcp.json` — Pi project override

Precedence is:

1. `~/.config/mcp/mcp.json`
2. `~/.pi/agent/mcp.json`
3. `.mcp.json`
4. `.pi/mcp.json`

Servers are **lazy by default** — they won't connect until you actually call one of their tools. The adapter caches tool metadata so search and describe work without live connections.

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
mcp({ tool: "chrome_devtools_take_screenshot", args: '{"format": "png"}' })
```

Note: `args` is a JSON string, not an object.

Two calls instead of 26 tools cluttering the context.

## Config

### File Layout

Use the shared MCP files when you want one setup to work across hosts, and Pi-owned files when you need Pi-specific overrides or settings.

| File | Purpose |
|------|---------|
| `~/.config/mcp/mcp.json` | User-global shared MCP config |
| `.mcp.json` | Project-local shared MCP config |
| `~/.pi/agent/mcp.json` | Pi global override and compatibility imports |
| `.pi/mcp.json` | Pi project override |

Pi-specific files are the write targets for imported or shared global servers when Pi needs to persist adapter-only settings such as `directTools`.

### Server Options

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "lifecycle": "lazy",
      "idleTimeout": 10
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `command` | Executable for stdio transport |
| `args` | Command arguments |
| `env` | Environment variables (`${VAR}` interpolation) |
| `cwd` | Working directory |
| `url` | HTTP endpoint (StreamableHTTP with SSE fallback) |
| `auth` | `"bearer"` or `"oauth"` |
| `oauth.grantType` | `"authorization_code"` (default) or `"client_credentials"` for non-interactive machine auth |
| `bearerToken` / `bearerTokenEnv` | Token or env var name |
| `lifecycle` | `"lazy"` (default), `"eager"`, or `"keep-alive"` |
| `idleTimeout` | Minutes before idle disconnect (overrides global) |
| `exposeResources` | Expose MCP resources as tools (default: true) |
| `directTools` | `true`, `string[]`, or `false` — register tools individually instead of through proxy |
| `excludeTools` | `string[]` of tool names to hide (matches original names like `get_screenshot` and prefixed names like `figma_get_screenshot`) |
| `debug` | Show server stderr (default: false) |

### Lifecycle Modes

- **`lazy`** (default) — Don't connect at startup. Connect on first tool call. Disconnect after idle timeout. Cached metadata keeps search/list working without connections.
- **`eager`** — Connect at startup but don't auto-reconnect if the connection drops. No idle timeout by default (set `idleTimeout` explicitly to enable).
- **`keep-alive`** — Connect at startup. Auto-reconnect via health checks. No idle timeout. Use for servers you always need available.

### Settings

```json
{
  "settings": {
    "toolPrefix": "server",
    "idleTimeout": 10
  },
  "mcpServers": { }
}
```

| Setting | Description |
|---------|-------------|
| `toolPrefix` | `"server"` (default), `"short"` (strips `-mcp` suffix), or `"none"` |
| `idleTimeout` | Global idle timeout in minutes (default: 10, 0 to disable) |
| `directTools` | Global default for all servers (default: false). Per-server overrides this. |
| `disableProxyTool` | Hide the `mcp` proxy tool once configured direct tools are fully available from cache. |
| `autoAuth` | Auto-run OAuth on `connect`/tool calls when a server needs auth, then retry once (default: false). |

Per-server `idleTimeout` overrides the global setting.

### Direct Tools

By default, all MCP tools are accessed through the single `mcp` proxy tool. This keeps context small but means the LLM has to discover tools via search. If you want specific tools to show up directly in the agent's tool list — alongside `read`, `bash`, `edit`, etc. — add `directTools` to your config.

Per-server:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "directTools": true
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "directTools": ["search_repositories", "get_file_contents"]
    },
    "huge-server": {
      "command": "npx",
      "args": ["-y", "mega-mcp@latest"]
    }
  }
}
```

| Value | Behavior |
|-------|----------|
| `true` | Register all tools from this server as individual Pi tools |
| `["tool_a", "tool_b"]` | Register only these tools (use original MCP names) |
| Omitted or `false` | Proxy only (default) |

To set a global default for all servers:

```json
{
  "settings": {
    "directTools": true
  },
  "mcpServers": {
    "huge-server": {
      "directTools": false
    }
  }
}
```

Per-server `directTools` overrides the global setting. The example above registers direct tools for every server except `huge-server`.

To exclude specific tools while still using `directTools: true`, add `excludeTools` on the server:

```json
{
  "mcpServers": {
    "figma": {
      "url": "http://localhost:3845/mcp",
      "directTools": true,
      "excludeTools": ["get_figjam", "figma_get_code_connect_map"]
    }
  }
}
```

`excludeTools` filters direct tools, proxy search/list/describe, and the `/mcp` panel view.

Each direct tool costs ~150-300 tokens in the system prompt (name + description + schema). Good for targeted sets of 5-20 tools. For servers with 75+ tools, stick with the proxy or pick specific tools with a `string[]`.

Direct tools register from the metadata cache (`~/.pi/agent/mcp-cache.json`), so no server connections are needed at startup. On the first session after adding `directTools` to a new server, the cache won't exist yet — tools fall back to proxy-only and the cache populates in the background. To force it: `/mcp reconnect <server>`.

When you change direct-tool toggles in `/mcp` or write new config through `/mcp setup`, the extension triggers Pi's normal reload flow automatically. That refreshes extensions, prompts, skills, and MCP tool registration in one shot, so newly configured direct tools can appear without a manual restart.

**Interactive configuration:** Run `/mcp` to open an interactive panel showing all servers with connection status, tools, and direct/proxy toggles. You can reconnect servers, initiate OAuth, and toggle tools between direct and proxy — all from one overlay.

**Guided first-run setup:** Run `/mcp setup` to inspect detected shared MCP files, adopt compatibility imports from other hosts, open discovered config paths, preview exact before/after file diffs for writes, scaffold a minimal project `.mcp.json`, or quick-add RepoPrompt into a standard/shared MCP file.

**Subagent integration:** If you use the subagent extension, agents can request direct MCP tools in their frontmatter with `mcp:server-name` syntax. See the subagent README for details.

### MCP UI Integration

MCP servers can ship interactive UIs via the [MCP UI](https://github.com/MCP-UI-Org/mcp-ui) standard. When you call a tool that has a UI resource, the adapter opens it in a native macOS window via [Glimpse](https://github.com/hazat/glimpse) if available, otherwise falls back to the browser.

**How it works:**

1. Agent calls a tool like `launch_dashboard`
2. The tool's metadata includes `_meta.ui.resourceUri` pointing to a UI resource
3. pi-mcp-adapter fetches the UI HTML and opens it in an iframe
4. The UI can call MCP tools and send messages back to the agent

**Native rendering:** On macOS, if [Glimpse](https://github.com/hazat/glimpse) is installed (`pi install npm:glimpseui`), UIs open in a native WKWebView window instead of a browser tab. Set `MCP_UI_VIEWER=browser` to force the browser, or `MCP_UI_VIEWER=glimpse` to require native rendering.

**Bidirectional communication:** The UI talks back. When it sends a prompt or intent, the message is stored and `triggerTurn()` wakes the agent. The agent retrieves messages via `mcp({ action: "ui-messages" })` and responds, enabling conversational UIs where the app and agent collaborate in real-time.

**Session reuse:** When the agent calls the same tool again while its UI is already open, the adapter pushes the new result to the existing window instead of replacing it. This enables live updates — the agent can refine a chart, add data, or respond to user input without losing the current view. Different tools still replace the session as before.

**Message types from UI:**

| Type | Purpose |
|------|---------|
| `prompt` | User message that triggers an agent response |
| `intent` | Structured action with name + params |
| `notify` | Fire-and-forget notification |
| `message` | Generic message payload |
| (custom) | Any other type forwarded as intent |

**Retrieving UI messages:**

```
mcp({ action: "ui-messages" })
```

Returns accumulated messages from UI sessions. Each message includes `type`, `sessionId`, `serverName`, `toolName`, and `timestamp`. Prompt messages include `prompt`, intent messages include `intent` and `params`.

**Browser controls:**

- **Cmd/Ctrl+Enter** — Complete and close
- **Escape** — Cancel and close
- **Done/Cancel buttons** — Same as keyboard shortcuts

**Technical notes:**

- Tool consent gates whether UIs can call MCP tools (never/once-per-server/always)
- Works with both stdio and HTTP MCP servers
- Uses a local 408KB AppBridge bundle (MCP SDK + Zod) for browser↔server communication

### Local Example: Interactive Visualizer

A minimal MCP UI example at `examples/interactive-visualizer` demonstrating charts, bidirectional messaging, and streaming. From that directory:

```bash
npm install
npm run build
npm run install-local
```

Restart pi, then ask the agent to show a chart — it calls `show_chart` and opens the UI in Glimpse (macOS) or the browser. Use `npm run uninstall-local` to remove the MCP entry.

### Import Existing Configs

Shared MCP files are loaded automatically. Use `imports` only for host-specific config formats that are not already covered by `.mcp.json` or `~/.config/mcp/mcp.json`.

```json
{
  "imports": ["cursor", "claude-code", "claude-desktop"],
  "mcpServers": { }
}
```

Supported compatibility imports: `cursor`, `claude-code`, `claude-desktop`, `vscode`, `windsurf`, `codex`

`pi-mcp-adapter init` detects these host-specific configs and adds missing imports to `~/.pi/agent/mcp.json` for you.

### Project Config

Prefer `.mcp.json` for project-local shared MCP config. Use `.pi/mcp.json` only when you need a Pi-specific project override. Project files override both user-global shared MCP config and Pi global overrides.

## Usage

| Mode | Example |
|------|---------|
| Status | `mcp({ })` |
| List server | `mcp({ server: "name" })` |
| Search | `mcp({ search: "screenshot navigate" })` |
| Describe | `mcp({ describe: "tool_name" })` |
| Call | `mcp({ tool: "...", args: '{"key": "value"}' })` |
| Connect | `mcp({ connect: "server-name" })` |
| UI messages | `mcp({ action: "ui-messages" })` |

Search includes both MCP tools and Pi tools (from extensions). Pi tools appear first with `[pi tool]` prefix. Space-separated words are OR'd.

Tool names are fuzzy-matched on hyphens and underscores — `context7_resolve_library_id` finds `context7_resolve-library-id`.

## Commands

| Command | What it does |
|---------|--------------|
| `/mcp` | Interactive panel and first-run onboarding surface |
| `/mcp setup` | Guided setup for imports, a minimal `.mcp.json`, RepoPrompt quick-add, and config-path inspection |
| `/mcp tools` | List all tools |
| `/mcp reconnect` | Reconnect all servers |
| `/mcp reconnect <server>` | Connect or reconnect a single server |
| `/mcp-auth <server>` | OAuth setup |

If `settings.autoAuth` is `true`, `mcp({ connect: ... })`, `mcp({ tool: ... })`, and direct tool calls will automatically run OAuth when needed and retry once. In non-interactive sessions, browser-based OAuth still requires running `/mcp-auth <server>` manually.

## How It Works

- One `mcp` tool in context (~200 tokens) instead of hundreds
- Servers are lazy by default — they connect on first tool call, not at startup
- Tool metadata is cached to disk so search/list/describe work without live connections
- Idle servers disconnect after 10 minutes (configurable), reconnect automatically on next use
- npx-based servers resolve to direct binary paths, skipping the ~143 MB npm parent process
- MCP server validates arguments, not the adapter
- Keep-alive servers get health checks and auto-reconnect
- Specific tools can be promoted from the proxy to first-class Pi tools via `directTools` config, so the LLM sees them directly instead of having to search

## Limitations

- Cross-session server sharing not yet implemented (each Pi session runs its own server processes)
