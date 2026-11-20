# @njuptlzf/mcp-adapter

**Universal MCP (Model Context Protocol) adapter** — Pi as a first-class host (native extension), plus any MCP-compatible coding agent via the universal `mcp-server` stdio entry point.

> Fork of [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter). The full upstream documentation is preserved in [README-src.md](README-src.md).

Use MCP servers without burning your context window: one ~200-token proxy tool instead of hundreds of tool definitions. Servers start lazily on first use, and tool metadata is cached so search/describe work with no live connection.

## What this fork changes

- **Repackaged as `@njuptlzf/mcp-adapter`** — org-scoped npm package, currently `7.0.0-0.0.1` (tracks upstream `v7.0.0`).
- **Config-watch self-heal for the stdio entry** (issue #34) — `mcp-server` fingerprints every config file it loaded and re-checks them on a timer; a manifest written *after* startup no longer leaves the process stuck with stale servers. On drift the adapter logs the truth and exits(0) so a supervising client respawns it with the fresh config; `mcp({ action: "reload" })` forces the same restart manually, and `MCP_CONFIG_WATCH=0` downgrades to warn-only. `mcp({})` status and tool-not-found results report the config paths and whether they changed since process start.
- **Pure upstream core** — `index.ts`, `config.ts`, `agent-dir.ts`, etc. run as upstream code; the fork's host layer lives in `adapters/` (and `interfaces/`) so upstream merges stay surgical.
- **Universal host** — `adapters/universal-host.ts` impersonates Pi's `ExtensionAPI`, so the same engine runs unchanged behind the `mcp-server` stdio layer for any MCP-compatible agent.
- **Prebuilt subpath exports** — `@njuptlzf/mcp-adapter/types`, `/config`, and `/metadata-cache` ship compiled `.js` + `.d.ts` from `dist/`.
## What's new in 7.0

https://github.com/user-attachments/assets/a3fc7834-2540-45b6-a80e-d9c17125a66c

On servers that support MCP Tasks, add `"protocolVersion": "auto"` and slow tools run in the background while the agent keeps working. Tool search can rank tools by meaning and send full schemas only for the ones that fit. And `extract` hands the agent just the values it asked for from a long result. Everything else is in the [changelog](CHANGELOG.md).

## What's new in 7.0

https://github.com/user-attachments/assets/a3fc7834-2540-45b6-a80e-d9c17125a66c

On servers that support MCP Tasks, add `"protocolVersion": "auto"` and slow tools run in the background while the agent keeps working. Tool search can rank tools by meaning and send full schemas only for the ones that fit. And `extract` hands the agent just the values it asked for from a long result. Everything else is in the [changelog](CHANGELOG.md).

## What's new in 7.0

https://github.com/user-attachments/assets/a3fc7834-2540-45b6-a80e-d9c17125a66c

On servers that support MCP Tasks, add `"protocolVersion": "auto"` and slow tools run in the background while the agent keeps working. Tool search can rank tools by meaning and send full schemas only for the ones that fit. And `extract` hands the agent just the values it asked for from a long result. Everything else is in the [changelog](CHANGELOG.md).

## Why This Exists

Mario wrote about [why you might not need MCP](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/). The problem: tool definitions are verbose. A single MCP server can burn 10k+ tokens, and you're paying that cost whether you use those tools or not. Connect a few servers and you've burned half your context window before the conversation starts.

His take: skip MCP entirely, write simple CLI tools instead.

But the MCP ecosystem has useful stuff - databases, browsers, APIs. This adapter gives you access without the bloat. One proxy tool (~200 tokens) instead of hundreds. The agent discovers what it needs on-demand. Servers only start when you actually use them.

## pi-mcp-adapter vs Pi's built-in MCP

Since then, Pi 0.99 added MCP support of its own, which also keeps tool definitions out of context. Installing the adapter replaces it in Pi sessions. What you get by switching:

- **Install many servers without paying for idle ones.** The built-in starts every enabled server in every Pi session and keeps it running until the session ends. By default, the adapter starts a server when the model first calls it and stops it after 10 idle minutes.
- **More servers work fully.** Servers can ask you questions through forms, show interactive UIs, offer prompt templates as slash commands, and run long jobs in the background while the agent keeps working. The built-in doesn't handle these.
- **Find tools by what you mean.** The built-in's tool search only matches words. The adapter can also rank tools by meaning with a classifier model you can already use in Pi, such as Jev or Cloudflare's Clef: in a test of 12 everyday requests across 95 tools, Jev put the right tool first in 10 of 11, where word search did in 5.
- **Sign-in tokens go in your OS keychain** by default (an encrypted file is opt-in), not in a plain JSON file under `~/.pi/agent`.
- **Adding servers is easier.** Give the agent a server's URL and it installs it and checks its tools in the same session, opening sign-in first if the server needs it, with no shell command or `/reload`. Servers already configured in Cursor, Claude Code, Codex, or VS Code can be imported with `/mcp-adapter setup`, which also adds presets such as Figma and GitHub.

The built-in turns `codemode` on by itself; with the adapter, add `"+codemode"` to `defaultTools` in Pi's settings. Pi's `codemode` works with both.

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Servers running | Every enabled server, for the whole session | Only servers in use; each stops after 10 idle minutes |
| Server memory (100 installed, 3 in use) | 7.0 GB at start, 5.9 GB after 15 minutes | Only the 3 in use, then none once they're idle |
| How the model reaches tools | Default: `codemode` scripts. Per server: direct, or loaded by `tool_search` | Default: one `mcp` proxy tool. Per server: direct, or loaded by `tool_search`. Scripts: Pi's `codemode`, opt-in (add `"+codemode"` to `defaultTools`) ([MCP scripting](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/scripting.md#scripting-mcp-calls-with-pis-codemode)) |
| Token cost | By default, every call is a `codemode` script | Single lookups cost about the same as the built-in's default. Bulk tasks cost up to 5.5× more without scripts, and up to 2.9× more with Pi's `codemode` turned on ([measured](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/pi-builtin-comparison.md#measured-token-cost)) |
| Tool search | `tool_search`, ranked by words | `mcp({ search })` ranked by words or regex. With a classifier model in Pi, such as Jev through `/login` to OpenRouter, semantic search ranks tools by meaning ([setup](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/scripting.md#semantic-search)) |
| Long tool results | A `codemode` script can filter a result before the model sees it | Opt-in per server: `mcp({ tool, args, extract: { total: "number" } })` returns only the values you name, as numbers and dates read by Cloudflare's Clairic model with your Cloudflare credentials in Pi; the full result is saved to a file ([Typed values](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/scripting.md#typed-values-from-tool-results)) |
| Saved workflows as tools | No | A workflow you repeat becomes one tool with fixed inputs: a saved script that calls MCP and Pi tools, found by search and called like any other tool (`scriptTools`, [Script tools](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/scripting.md#script-tools)) |
| Executor app tools | Only Executor's own six tools; the model reaches app tools through Executor's `search` and `call` | Each tool of your [Executor](https://executor.sh) apps is a Pi tool, found by search and called by name with Pi's approvals ([Executor app tools](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/prompts-and-ui.md#executor-app-tools)) |
| OAuth tokens | JSON file in `~/.pi/agent` | OS keychain |
| MCP prompts, elicitation, sampling, Tasks | No | Yes; Tasks run in the background and need `"protocolVersion": "auto"` |
| MCP UI apps | Left out | Native window or browser |
| Add a server | `pi mcp add` in a shell, then `/reload` | Give the agent the URL: `mcp({ action: "install", url })` connects it and checks its tools in the current session; for an OAuth server it opens sign-in first and checks the tools once you approve |
| Configs from Cursor, Claude Code, Codex, VS Code | Convert by hand | Imported |
| Guided setup in a session | No; `/mcp` manages servers that are already configured | `/mcp-adapter setup` overlay: imports configs found on your machine, adds presets (Figma desktop and RepoPrompt when installed, GitHub, Notion, Context7, DeepWiki, Parallel Search, Tavily Search, Chrome DevTools), and previews each file change before writing |
| Ask before risky tools | Through a permission extension, which sees every MCP call | Built in (`approveTools`); permission extensions also see each MCP call under the tool's own name |
| Roots (session directory sent to servers) | Yes | Yes |
| Shell commands | `pi mcp add`, `remove`, `list` | `pi-mcp-adapter init`, `doctor` |
| Transports | stdio, streamable HTTP | stdio, streamable HTTP, legacy SSE, `rmcp-mux` socket |

Over a session, measured on Pi 0.99.2 with 100 small local servers:

| 100 servers installed, 3 used | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Servers running at session start | 100 | 0 |
| While you use 3 | 100 | 3 |
| After the idle timeout (10 min) | 100 | 0 |

Stopping a server doesn't take its tools away: the model can still search them, and a stopped server starts again on its next call (0.1–0.3 s for a small local server). For a server that must keep state between calls, set `"lifecycle": "lazy-keep-alive"`. The first session briefly starts new servers, 10 at a time, to read their tool lists. [Measurements and details](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/pi-builtin-comparison.md#measured-with-100-servers).

The [full comparison](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/pi-builtin-comparison.md) has every row with sources, as of Pi 1.3.0.

When you install or update the adapter, it turns Pi's built-in MCP off in Pi's settings for you (the same switch as `pi config` → Built-in), so the two don't both run. If you remove the adapter, turn the built-in back on there ([details](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#pis-built-in-mcp)).

## Install

### Pi (recommended)

```bash
pi install npm:@njuptlzf/mcp-adapter
```

Restart Pi. Standard MCP files (`.mcp.json`, `~/.config/mcp/mcp.json`) are discovered automatically.

### Any other MCP-compatible agent

```json
{
  "mcpServers": {
    "mcp-adapter": { "command": "mcp-server" }
  }
}
```

## Entry points

| Bin | File | Purpose |
|-----|------|---------|
| `pi-mcp-adapter` | `cli.js` | CLI — `init` (detect host configs → Pi imports), `token` (bearer auth) |
| `mcp-adapter` / `mcp-server` | `mcp-server.mjs` | Universal stdio MCP server (self-contained esbuild bundle) |

Programmatic Pi entry point (backward-compatible):

```typescript
import { mcpAdapter } from "@njuptlzf/mcp-adapter";
export default mcpAdapter(pi);
```

## Development

```bash
npm install
npm test                    # prebuild visualizer + full vitest suite
npm run typecheck           # tsc --noEmit
npm run build:public        # tsc -> dist/ (subpath exports)
npm run build:mcp-server    # esbuild -> self-contained mcp-server.mjs
```

| Want | Do | Details |
|------|----|---------|
| Add a server without editing JSON | `/mcp-adapter setup`, or `mcp({ action: "install", url: "..." })` | [Configuration](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#setup-panel), [Install from one URL](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/servers.md#install-from-one-url) |
| Use servers from Cursor, Claude Code, or Codex | `/mcp-adapter setup` or `pi-mcp-adapter init` | [Import existing configs](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#import-existing-configs) |
| Sign in to an OAuth server | `/mcp-auth <server>` | [Authentication](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/auth.md) |
| Put a few tools directly in the model's tool list | `"directTools": ["tool_a"]` on the server | [Direct tools](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/tools.md#direct-tools) |
| Ask before a risky tool runs | `"approveTools": "destructive"` | [Tool approval](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/tools.md#tool-approval) |
| Keep a server running | `"lifecycle": "keep-alive"` | [Lifecycle modes](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#lifecycle-modes) |
| Hide noisy tools | `includeTools` / `excludeTools` on the server | [Search-activated direct tools](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/tools.md#search-activated-direct-tools) |
| Chain many MCP calls in one step | `"+codemode"` in Pi's `defaultTools`, then `codemode` | [MCP scripting](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/scripting.md#scripting-mcp-calls-with-pis-codemode) |
| Use Figma | `/mcp-adapter setup`, add Figma (desktop) | [Setup panel](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/configuration.md#setup-panel) |

- [README-src.md](README-src.md) — full upstream documentation (config options, agent skills, OAuth, MCP UI, direct tools, verification).
- [MAPPING.md](MAPPING.md) — host-surface contract for the universal host.
- [CHANGELOG.md](CHANGELOG.md) — release history.

| Command | What it does |
|---------|--------------|
| `/mcp-adapter` | Interactive panel and first-run onboarding surface |
| `/mcp` | Same as `/mcp-adapter` |
| `/mcp-adapter setup` | Guided setup for imports, a minimal `.mcp.json`, curated known servers, RepoPrompt quick-add, and config-path inspection |
| `/mcp-adapter semantic setup` | Choose which servers may share tool names and descriptions with semantic search, save that choice for the project, and reload Pi |
| `/mcp-adapter edit [project\|global]` | Open `.mcp.json` (default) or `~/.config/mcp/mcp.json` in an editor; Ctrl+G opens `$EDITOR`; saves a valid JSONC object and reloads |
| `/mcp-adapter tools` | List all tools |
| `/mcp-adapter prompts` | List all MCP prompts registered as slash commands |
| `/mcp-adapter tasks [stop <server>/<taskId>]` | List long-running MCP tasks still working in the background, or stop one |
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
| [pi-mcp-adapter vs Pi's built-in MCP](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/pi-builtin-comparison.md) | Every difference, with sources, as of Pi 1.3.0. |
| [Using MCP tools](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/tools.md) | The `mcp` tool, search and search keywords, direct tools, tool approval, and the output guard. |
| [MCP scripting](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/scripting.md) | Semantic tool search, and scripting MCP calls with Pi's `codemode`. |
| [Prompts, elicitation, and MCP UI](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/prompts-and-ui.md) | MCP prompts as slash commands, servers asking for input, and interactive MCP UI windows. |
| [Extension API, plugins, and SDK](https://github.com/nicobailon/pi-mcp-adapter/blob/main/docs/extension-api.md) | Agent Plugins, Claude plugin bundles, Pi package manifests, runtime registration and tool calls, `createMcpAdapter`, host-managed embedding, and status events. |
## License

MIT

