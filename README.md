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

## pi-mcp-adapter vs Pi's built-in MCP

Since then, Pi 0.99 added MCP support of its own, which also keeps tool definitions out of context. Installing the adapter replaces it in Pi sessions. What you get by switching:

- **Install many servers without paying for idle ones.** The built-in starts every enabled server in every Pi session and keeps it running until the session ends. By default, the adapter starts a server when the model first calls it and stops it after 10 idle minutes.
- **More servers work fully.** Servers can ask you questions through forms, show interactive UIs, and offer prompt templates as slash commands. The built-in doesn't handle these.
- **Sign-in tokens go in your OS keychain** by default (an encrypted file is opt-in), not in a plain JSON file under `~/.pi/agent`.
- **Adding servers is easier.** Give the agent a server's URL and it installs it and checks its tools in the same session, opening sign-in first if the server needs it, with no shell command or `/reload`. Servers already configured in Cursor, Claude Code, Codex, or VS Code can be imported with `/mcp-adapter setup`, which also adds presets such as Figma and GitHub.

The built-in has two things the adapter doesn't: Pi's permission extensions see each MCP call as its own tool call without changes, and it sends roots (the session directory) to servers. Pi's `codemode` works with both.

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Servers running | Every enabled server, for the whole session | Only servers in use; each stops after 10 idle minutes |
| Server memory (100 installed, 3 in use) | 7.0 GB at start, 5.9 GB after 15 minutes | Only the 3 in use, then none once they're idle |
| How the model reaches tools | Default: `codemode` scripts. Per server: direct, or loaded by `tool_search` | Default: one `mcp` proxy tool. Per server: direct, or loaded by `tool_search`. Scripts: Pi's `codemode` (add `"+codemode"` to `defaultTools`) or the adapter's `mcpScript`, both opt-in |
| Tool search | `tool_search`, ranked by words | `mcp({ search })` ranked by words or regex, plus optional semantic search with Jev |
| OAuth tokens | JSON file in `~/.pi/agent` | OS keychain |
| MCP prompts, elicitation, sampling, Tasks | No | Yes; Tasks need `"protocolVersion": "auto"` |
| MCP UI apps | Left out | Native window or browser |
| Add a server | `pi mcp add` in a shell, then `/reload` | Give the agent the URL: `mcp({ action: "install", url })` connects it and checks its tools in the current session; for an OAuth server it opens sign-in first and checks the tools once you approve |
| Configs from Cursor, Claude Code, Codex, VS Code | Convert by hand | Imported |
| Guided setup in a session | No; `/mcp` manages servers that are already configured | `/mcp-adapter setup` overlay: imports configs found on your machine, adds presets (Figma desktop and RepoPrompt when installed, GitHub, Notion, Context7, DeepWiki, Parallel Search, Chrome DevTools), and previews each file change before writing |
| Ask before risky tools | Through a permission extension, which sees every MCP call | Built in (`approveTools`); permission extensions see proxy calls as the proxy tool |
| Roots (session directory sent to servers) | Yes | No |
| Shell commands | `pi mcp add`, `remove`, `list` | `pi-mcp-adapter init`, `doctor` |
| Transports | stdio, streamable HTTP | stdio, streamable HTTP, legacy SSE, `rmcp-mux` socket |

Over a session, measured with 100 small local servers:

| 100 servers installed, 3 used | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Servers running at session start | 100 | 0 |
| While you use 3 | 100 | 3 |
| After the idle timeout (10 min) | 100 | 0 |

Stopping a server doesn't take its tools away: the model can still search them, and a stopped server starts again on its next call (0.1–0.3 s for a small local server). For a server that must keep state between calls, set `"lifecycle": "lazy-keep-alive"`. The first session briefly starts new servers, 10 at a time, to read their tool lists. [Measurements and details](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/pi-builtin-comparison.md#measured-with-100-servers).

The [full comparison](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/pi-builtin-comparison.md) has every row with sources, as of Pi 0.99.2.

When you install or update the adapter, it turns Pi's built-in MCP off in Pi's settings for you (the same switch as `pi config` → Built-in), so the two don't both run. If you remove the adapter, turn the built-in back on there ([details](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#pis-built-in-mcp)).

## Install

```bash
pi install npm:pi-mcp-adapter
```

Restart Pi after installation.

> **DeepSeek Harness (third-party bridge):** Run the unmodified adapter in DSH via [pi2dsh](https://github.com/weijiafu14/pi2dsh); see the [verified dsh-TUI and Web MCP guide](https://github.com/weijiafu14/pi2dsh/tree/main/examples/tui-mcp).

## What happens on first run

The adapter reads standard MCP files automatically. No extra setup needed if you already have them.

| You already have... | What happens |
|---------------------|--------------|
| `.mcp.json` or `~/.config/mcp/mcp.json` | Pi uses it immediately. Use `.mcp.json` for project/team sharing and `~/.config/mcp/mcp.json` for all projects. |
| Servers added with `pi mcp add` (`~/.pi/agent/mcp.json`, `.pi/mcp.json`) | On Pi 0.99 and later, the adapter uses them and replaces Pi's built-in MCP extension, which Pi reports at startup; see [Pi's built-in MCP](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#pis-built-in-mcp). |
| Host-specific configs (Cursor, Claude Code, Codex, etc.) but no standard MCP files | Run `/mcp-adapter setup` to adopt those host configs into Pi. The setup flow shows exactly what it found, lets you pick which ones to import, and previews the exact file changes before writing. |
| Nothing configured yet | Run `/mcp-adapter setup`, choose project `.mcp.json` or global `~/.config/mcp/mcp.json`, then scaffold a minimal config, add a curated known server, quick-add RepoPrompt, or inspect what the adapter discovered on your machine. |

If you prefer the terminal, you can also run `pi-mcp-adapter init` after install to scan for host-specific configs and add missing compatibility imports to the adapter config (`~/.pi/agent/mcp-adapter.json` by default, or `$PI_CODING_AGENT_DIR/mcp-adapter.json` when set).

## Quick Start

Add a server to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.6.0"]
    }
  }
}
```

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
mcp({ tool: "chrome_devtools_take_screenshot", args: { format: "png" } })
```

Two calls instead of 26 tools cluttering the context.

## Common tasks

| Want | Do | Details |
|------|----|---------|
| Add a server without editing JSON | `/mcp-adapter setup`, or `mcp({ action: "install", url: "..." })` | [Configuration](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#setup-panel), [Install from one URL](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/servers.md#install-from-one-url) |
| Use servers from Cursor, Claude Code, or Codex | `/mcp-adapter setup` or `pi-mcp-adapter init` | [Import existing configs](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#import-existing-configs) |
| Sign in to an OAuth server | `/mcp-auth <server>` | [Authentication](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/auth.md) |
| Put a few tools directly in the model's tool list | `"directTools": ["tool_a"]` on the server | [Direct tools](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/tools.md#direct-tools) |
| Ask before a risky tool runs | `"approveTools": "destructive"` | [Tool approval](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/tools.md#tool-approval) |
| Keep a server running | `"lifecycle": "keep-alive"` | [Lifecycle modes](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#lifecycle-modes) |
| Hide noisy tools | `includeTools` / `excludeTools` on the server | [Search-activated direct tools](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/tools.md#search-activated-direct-tools) |
| Chain many MCP calls in one step | `settings.scriptMode: true`, then `mcpScript` | [MCP scripting](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/scripting.md) |
| Use Figma | `/mcp-adapter setup`, add Figma (desktop) | [Setup panel](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#setup-panel) |

## Commands

| Command | What it does |
|---------|--------------|
| `/mcp-adapter` | Interactive panel and first-run onboarding surface |
| `/mcp` | Same as `/mcp-adapter` |
| `/mcp-adapter setup` | Guided setup for imports, a minimal `.mcp.json`, curated known servers, RepoPrompt quick-add, and config-path inspection |
| `/mcp-adapter jev setup` | Restrict which servers may share semantic-search data, save the project policy, and reload Pi |
| `/mcp-adapter edit [project\|global]` | Open `.mcp.json` (default) or `~/.config/mcp/mcp.json` in an editor; Ctrl+G opens `$EDITOR`; saves a valid JSONC object and reloads |
| `/mcp-adapter tools` | List all tools |
| `/mcp-adapter prompts` | List all MCP prompts registered as slash commands |
| `/mcp-adapter reconnect` | Reconnect all servers |
| `/mcp-adapter reconnect <server>` | Connect or reconnect a single server |
| `/mcp-adapter disable <server>` | Disable a server in the project-local `.pi/mcp-adapter.json` (requires `/reload` to apply) |
| `/mcp-adapter enable <server>` | Enable through the project-local override layer (requires `/reload` to apply) |
| `/mcp-adapter logout <server>` | Clear stored OAuth credentials for a server and disconnect it |
| `/mcp-auth` | Open an OAuth server picker in interactive UI sessions |
| `/mcp-auth <server>` | OAuth setup for a specific server |

If `settings.autoAuth` is `true`, `mcp({ connect: ... })`, `mcp({ tool: ... })`, and direct tool calls automatically run OAuth when needed and retry once.

In interactive sessions, you can also authenticate from `/mcp-adapter` with `ctrl+a` or Enter on a server that needs auth. `/mcp-auth` without a server only opens a picker in the interactive UI. For gateway authorization and manual callback completion, see [Remote/headless authentication](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/auth.md#remoteheadless-authentication).

On Pi 0.99 and later, servers you already signed in to with Pi's built-in MCP can reuse that sign-in: the adapter asks once per server, and `/mcp-adapter` offers `ctrl+p` to import them. See [Import a sign-in from Pi's built-in MCP](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/auth.md#import-a-sign-in-from-pis-built-in-mcp).

## How It Works

- One `mcp` tool in context (~200 tokens) instead of hundreds
- Servers are lazy by default — they connect on first tool call, not at startup
- Tool metadata is cached to disk so search/list/describe work without live connections
- Idle servers disconnect after 10 minutes (configurable), reconnect automatically on next use
- npx-based servers resolve to direct binary paths, skipping the ~143 MB npm parent process
- MCP server validates arguments, not the adapter
- Remote keep-alive servers force-refresh their tool catalog during health checks, before user input, and before adapter-triggered turns, with bounded reconnect backoff
- Specific tools can be promoted from the proxy to first-class Pi tools via `directTools` config, so the LLM sees them directly instead of having to search

## Limitations

- Each Pi session runs its own server processes; [rmcp-mux](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/servers.md#shared-mcp-processes-with-rmcp-mux) can share one across sessions
- Compact MCP result rendering summarizes text, but inline images are still controlled by Pi's image display settings and may render below the compact text summary.
- Pi still owns one separator row before self-rendered tool output, so compact mode reduces adapter rendering height but cannot promise true zero-gap rows.
- MCP sampling support is text-only; context inclusion, tools, stop sequences, audio, and image content are rejected with explicit errors.

## Documentation

The full reference lives in `docs/`:

| Doc | What's in it |
|-----|--------------|
| [Configuration](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md) | The setup panel, config files and precedence, imports from other hosts, project server trust, lifecycle modes, and every `settings` key. |
| [Server options](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/servers.md) | Every server field, custom HTTPS trust, macOS local-network access, protocol negotiation, MCP Tasks, stdio environment, rmcp-mux, and URL install. |
| [Authentication](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/auth.md) | OAuth setup, remote and headless sign-in, token storage, headers, bearer tokens, and secret commands. |
| [pi-mcp-adapter vs Pi's built-in MCP](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/pi-builtin-comparison.md) | Every difference, with sources, as of Pi 0.99.2. |
| [Using MCP tools](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/tools.md) | The `mcp` tool, search and search keywords, direct tools, tool approval, and the output guard. |
| [MCP scripting](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/scripting.md) | Jev semantic search, the `mcpScript` tool, and composable tool search. |
| [Prompts, elicitation, and MCP UI](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/prompts-and-ui.md) | MCP prompts as slash commands, servers asking for input, and interactive MCP UI windows. |
| [Extension API, plugins, and SDK](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/extension-api.md) | Agent Plugins, Claude plugin bundles, Pi package manifests, runtime registration and tool calls, `createMcpAdapter`, host-managed embedding, and status events. |
