# Configuration

Where the adapter reads MCP servers from, which file wins, how project servers are trusted, and every `settings` key.

## Setup panel

**Interactive configuration:** Run `/mcp-adapter` to open an interactive panel showing all servers with connection status, tools, and direct/proxy toggles. `/mcp` is also available as an alias when Pi's built-in MCP extension is not installed. You can reconnect servers, toggle tools between direct and proxy, and enable or disable servers (`ctrl+d`) from the same overlay. For OAuth, press Enter on a server that needs auth or `ctrl+a` on any OAuth server. The Save action defaults to `ctrl+s` and can be remapped with the `mcp.panel.save` keybinding.

**Guided first-run setup:** Run `/mcp-adapter setup` to choose the normal write target for new shared servers — project `.mcp.json` or global `~/.config/mcp/mcp.json` — inspect detected shared MCP files, adopt compatibility imports from other hosts, open discovered config paths, preview exact before/after file diffs for writes, scaffold a minimal selected config, add a curated known server (DeepWiki, Context7, Notion, GitHub, Chrome DevTools, or Figma (desktop) when the Figma app is installed), or quick-add RepoPrompt into a standard/shared MCP file.

**Figma:** Figma's remote server, `https://mcp.figma.com/mcp`, only accepts approved clients, and Pi isn't approved yet. Use the Figma desktop app's local server instead: run `/mcp-adapter setup` and add Figma (desktop). It needs a Dev or Full seat on a paid Figma plan; to turn it on, open a Design file, switch to Dev Mode (Shift+D), and click "Enable desktop MCP server" in the inspect panel.

## File Layout

Use shared MCP files when you want one setup to work across hosts, and adapter-owned files for adapter-specific overrides or settings.

| File | Purpose |
|------|---------|
| `~/.config/mcp/mcp.json` | User-global shared MCP config |
| `~/.agents/mcp.json` | User-global tool-agnostic MCP config |
| `~/.agents/mcp/mcp.json` | User-global tool-agnostic MCP config |
| `.mcp.json` | Project-local shared MCP config |
| `<Pi agent dir>/mcp.json` | Pi's own MCP config; read on Pi 0.99 and later (see below) |
| `<Pi agent dir>/mcp-adapter.json` | Global adapter settings, imports, and overrides (`~/.pi/agent/mcp-adapter.json` by default) |
| `.pi/mcp.json` | Pi's own project MCP config; read on Pi 0.99 and later (see below) |
| `.pi/mcp-adapter.json` | Project adapter settings and overrides |

For local stdio servers, a leading `~/` is expanded to the current user's home
directory in `command`, `args`, and `cwd`. On Windows, the equivalent `~\\`
form is supported too; on POSIX, backslashes remain literal filename
characters. Bare commands such as
`node`, `bunx`, or `git` continue to resolve through `PATH`.
Built-in Agent Plugin arguments remain literal; this path expansion applies to native and shared MCP configuration.

Pi-specific files are the write targets for imported or shared global servers when Pi needs to persist adapter-only settings such as `directTools`.

Preferred user-global shared config: `~/.config/mcp/mcp.json` (for all projects). Pi also reads the tool-agnostic global paths `~/.agents/mcp.json` and `~/.agents/mcp/mcp.json` as compatibility inputs.

On Pi 0.99 and later, the adapter also reads Pi's own `<Pi agent dir>/mcp.json` and `.pi/mcp.json`, so servers added with `pi mcp add` work here. It reads only their `mcpServers` and translates each entry:

| Pi field | Adapter field |
|---|---|
| `command`, `args`, `env`, `cwd`, `url`, `headers`, `description` | same |
| `type: "stdio"`, `"http"`, `"streamable-http"` | dropped |
| `enabled: false` | `disabled: true` |
| `timeout` (seconds) | `requestTimeoutMs` |
| `oauth.clientId`, `clientSecret`, `scope`, `clientName` | same |
| `oauth.callbackPort` | `oauth.redirectUri: "http://127.0.0.1:<port>/callback"` |
| `oauth.callbackUrl` | `oauth.redirectUri`; without a port it gets `callbackPort`, or `{port}` |
| `exposure: "direct"` / `"deferred"` / `"codemode"` / `"hidden"` | `directTools: true` / `directTools: "search"` / proxy only / `disabled: true` |
| `toolExposure` exact names set to `"direct"` | `directTools: [names]` |
| `toolExposure` entries set to `"hidden"` | `excludeTools`, which can hide more than Pi's `hidden` |

Entries with `type: "sse"` or `auth: { "provider": ... }`, and entries Pi rejects, are skipped. Other settings without an exact equivalent, such as a per-tool `codemode` or `deferred`, are ignored, and the server keeps its server-level setting. Top-level `settings`, `imports`, `claudePlugins`, and `mcp-servers` come from old adapter configs; they are ignored too and belong in `mcp-adapter.json`. Everything skipped or ignored is reported once per file at startup, and a loaded server's ignored settings are also listed under it in `/mcp-adapter`.

A server in `.pi/mcp.json` replaces the same-named server from `<Pi agent dir>/mcp.json` as a whole, as in Pi. The adapter never writes Pi's files; changes such as direct tools go to the `mcp-adapter.json` in the same folder. `.pi/mcp.json` servers need project trust and approval like `.mcp.json` servers. Exclusive mode reads neither file.

On Pi 0.84 to 0.87, the adapter does not read either file. If you used one with this adapter, rename it to `mcp-adapter.json` (merge the files if the target exists).

Host-specific configs are detected and shown by `/mcp-adapter setup` and `pi-mcp-adapter init`, but they are compatibility inputs rather than normal setup paths and are not loaded automatically. The normal `/mcp-adapter` panel does not scan host-specific files when `settings.hostConfigDiscovery` is `"off"`. To explicitly opt in to host-config fallback discovery, set `settings.hostConfigDiscovery` to `"on"` or run `pi-mcp-adapter init --discover-host-configs`. The default is `"off"`; `"prompt"` is available for integrations that want detection without activation. Host configs are lower precedence than every normal config source, and `/mcp-adapter setup` continues to offer explicit import adoption. Discovery reports source paths, provenance, and same-name conflicts; it never writes to external host files or silently launches commands from them.

## Precedence

Precedence is (later entries win):

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `<Pi agent dir>/mcp.json` (Pi 0.99 and later)
5. `<Pi agent dir>/mcp-adapter.json`
6. opted-in ancestors, farthest first: `.mcp.json`, `.pi/mcp-adapter.json`
7. `.mcp.json`
8. `.pi/mcp.json` (Pi 0.99 and later)
9. `.pi/mcp-adapter.json`

Ancestor discovery is off by default. To opt in, set `settings.ancestorConfigRoots` in a user-global source (`~/.config/mcp/mcp.json`, either `~/.agents` MCP file, or the global `mcp-adapter.json`) or in the explicitly selected `--mcp-config`/`configPath` file, for example `"ancestorConfigRoots": ["~/work/team"]`. Each root must be an explicit absolute path or `~/...` and resolve to an existing directory under `$HOME`. Roots that do not contain the canonical cwd are ignored. If several roots match, only the nearest (deepest) is used. Project files cannot enable discovery or extend the boundary.

Within the selected root, `.mcp.json` and `<configDir>/mcp-adapter.json` load from the root through parent(cwd), farthest first. Nearer directories override farther ones, adapter config overrides shared config within each directory, and cwd files win over ancestors. Search never goes above the configured root or `$HOME`; the boundary limits discovery but is not a file-ownership or symlink-target sandbox. Only configure roots whose project files you trust.

`/mcp-adapter disable <server>` and `/mcp-adapter enable <server>` persist only the `disabled` field in the project-local `.pi/mcp-adapter.json`, the highest-precedence adapter layer. The source file is never rewritten and credentials are never copied. Run `/reload` after changing the flag so registered tool surfaces are refreshed. Supplied in-memory `createMcpAdapter({ config })` configurations are isolated and do not read or write this project override; the commands are unavailable in that mode.

## Project Config

Prefer `.mcp.json` for project-local shared MCP config and `~/.config/mcp/mcp.json` for user-global shared MCP config. Use `.pi/mcp-adapter.json` for adapter-specific project overrides. Pi `mcp.json` files are not adapter inputs; project files override user-global sources.

## Import Existing Configs

Shared MCP files are loaded automatically. Use `imports` only for host-specific config formats that are not already covered by `.mcp.json` or `~/.config/mcp/mcp.json`.

```json
{
  "imports": ["cursor", "claude-code", "claude-desktop", "opencode"],
  "mcpServers": { }
}
```

Supported compatibility imports: `cursor`, `claude-code`, `claude-desktop`, `opencode`, `vscode`, `windsurf`, `codex`

`pi-mcp-adapter init` detects these host-specific configs and adds missing imports to the Pi agent dir config for you. The `opencode` import reads OpenCode V1 `mcp` entries from both `~/.config/opencode/opencode.json` and the project `opencode.json`, with project fields taking precedence. It is explicit-import only; OpenCode V2, inline content, managed configs, and remote discovery are not supported.

## Project server trust

Servers defined or changed by project-scoped MCP files (`.mcp.json`, `.pi/mcp-adapter.json`, and opted-in ancestor project files) do not run merely because a repository was opened. This includes servers brought in through project `imports`, `claudePlugins`, `settings.agentPluginPaths`, repo-local host config files (even when imports or discovery are enabled globally), or Pi packages listed in project `.pi/settings.json`. If Pi reports the project as untrusted, the adapter blocks them. In a trusted interactive session, the adapter shows the source file and command or URL and asks once before the first connection. The approval is stored under the Pi agent directory and is tied to the canonical project path, server name, and complete effective definition; changing the definition requires a new approval. Git worktrees of one repository share approvals for the same folder, so a new worktree only asks when its definition differs. This covers regular, bare, and `--separate-git-dir` repositories; the one exception is the main checkout of a `--separate-git-dir` repository, which git records no link to, so it asks once on its own. Blocked servers are identified in the panel, while MCP status includes the required trust or approval action.

In print, JSON, and RPC sessions, an unapproved project server is skipped. To intentionally allow project servers in trusted headless sessions, set `"projectServers": "allow"` in the **user-global** `settings` object. The default is `"ask"`; project files cannot change this policy. Explicit config files, programmatic configuration, global/import/plugin servers, and runtime registrations retain their existing behavior. Project servers are always excluded from extension-load initialization and are admitted only after `session_start` supplies Pi's trust context.

## Check servers from a shell

`pi-mcp-adapter doctor` loads the config a session in the current directory would (including Pi's own `mcp.json` files when `pi --version` reports 0.99 or later), gives each enabled server 15 seconds to connect, and prints one line per server: name, state (`ok`, `failed`, `needs-auth`, `blocked`, or `disabled`), tool count, and the error or a hint. Secret commands (`!command` values) run with their own timeouts. `--json` prints the same report as a JSON array. It exits 1 when an enabled server fails or needs a sign-in; blocked and disabled servers don't count.

Project servers follow the trust and approval rules above as in a non-interactive session. If Pi can't be loaded from where the CLI is installed, the project is treated as untrusted. Doctor never starts OAuth: a server without a stored sign-in is reported as `needs-auth`; sign in with `/mcp-auth <server>` in Pi. Errors show only what the adapter can state itself, such as the HTTP status, network error code, or endpoint probe result; doctor never prints server output, response bodies, or configured secrets. Run a failing command directly to see its output.

## Lifecycle Modes

- **`lazy`** (default) — Don't connect at startup. Connect on first tool call. Disconnect after idle timeout. Cached metadata keeps search/list working without connections.
- **`eager`** — Connect at startup but don't auto-reconnect if the connection drops. No idle timeout by default (set `idleTimeout` explicitly to enable).
- **`keep-alive`** — Connect at startup. Remote HTTP servers refresh their tool catalog during health checks, before user input, and before adapter-triggered turns, reconnecting when the server reports that the session expired. No idle timeout. Use for servers you always need available.
- **`lazy-keep-alive`** — Don't connect at startup. Connect on first tool call (like `lazy`). Once spawned, never idle-shut down and use the same catalog refresh and reconnect checks as `keep-alive`. Use for servers that are expensive to start but should stay resident after their first use.

For remote HTTP keep-alive servers, the authoritative `tools/list` refresh is also the fallback when `list_changed` notifications are unavailable or their stream is lost. Each `tools/list` or `ping` request is capped at 5 seconds, up to 10 servers are checked concurrently, and transient failures use bounded backoff. A successful refresh updates metadata without reconnecting; a response proving that the HTTP session expired triggers a full reconnect and reinstalls the notification handlers. Dynamic direct-tool registration follows the refreshed metadata unless `freezeDirectTools` is enabled.

When any enabled server uses `eager` or `keep-alive`, initialization also starts when the extension loads. This supports hosts that embed Pi programmatically and never emit `session_start`; if a session does start later, the session-owned runtime supersedes the load-time runtime.

## Settings

```json
{
  "settings": {
    "toolPrefix": "server",
    "allowInstall": false,
    "idleTimeout": 10,
    "requestTimeoutMs": 30000,
    "deferWithMissingMetadata": false,
    "showStatusIcon": true,
    "mcpFooterStatus": "full",
    "toolResultRendering": "compact",
    "collapsedResultLines": 1,
    "notifyOnStartupConnect": true,
    "warnOnLargeDirectTools": true,
    "hostConfigDiscovery": "off",
    "projectServers": "ask",
    "approveTools": ["github_delete_*", "notion_update_*"],
    "oauthDir": ".pi/mcp-oauth",
    "trace": {
      "enabled": true,
      "file": ".pi/mcp-traces/mcp.jsonl",
      "maxBytes": 262144,
      "maxEvents": 10000
    }
  },
  "mcpServers": { }
}
```

| Setting | Description |
|---------|-------------|
| `toolPrefix` | `"server"` (default), `"short"` (strips `-mcp` suffix), `"none"`, or `"mcp"` (prefixes with `mcp__`, using server-mode normalization). Per-server `toolPrefix` overrides this for that server. |
| `allowInstall` | Allow URL installation through the `mcp` tool (default: `true`). Set to `false` to block it. |
| `idleTimeout` | Global idle timeout in minutes (default: 10, 0 to disable) |
| `requestTimeoutMs` | Global request timeout in milliseconds for live MCP calls (if omitted or `<= 0`, the MCP SDK default timeout is used) |
| `deferWithMissingMetadata` | Allow lazy startup to defer when persisted metadata is missing or invalid (default: `false`). See [Direct Tools](tools.md#direct-tools) for the startup tradeoff. |
| `showStatusIcon` | Show the plug icon in MCP status and connection text (default: `true`). Set to `false` for plain `MCP: ...` text. |
| `mcpFooterStatus` | MCP footer verbosity: `"full"` (default), `"compact"` for `MCP connected/enabled`, or `"off"` to clear the persistent footer status. `/mcp-adapter status` remains available. |
| `toolResultRendering` | MCP tool result row style: `"compact"` (default) uses self-rendered rows, or `"boxed"` restores the legacy Pi boxed tool row. |
| `collapsedResultLines` | Number of result text lines to show before expansion: `1`, `2`, or `3`. Defaults to `1` in compact mode and `3` in boxed mode. |
| `notifyOnStartupConnect` | Show successful startup connection notices (default: `true`). Set to `false` to suppress routine `MCP: N servers connected (M tools)` notices. Connection errors and authentication warnings remain visible. |
| `hostConfigDiscovery` | Host-specific config policy: `"off"` (default), `"prompt"` (detect/report only), or `"on"` (explicitly load detected host configs as the lowest-precedence fallback) |
| `projectServers` | Project-server admission policy for trusted headless sessions: `"ask"` (default, skip unapproved servers) or `"allow"`. Only user-global or explicitly selected config may set it; project files are ignored. |
| `ancestorConfigRoots` | Trusted absolute or `~/...` roots for opt-in ancestor config discovery. Only user-global or explicitly selected config may set it; roots outside cwd are ignored and the deepest matching root is used. |
| `agentPluginPaths` | Agent Plugins package directories to load MCP servers from. Relative paths resolve from the active project cwd. |
| `approveTools` | `true` to require approval before every MCP tool call, `"destructive"` to require it for tools the server does not mark read-only or non-destructive, or an array of glob patterns such as `["github_delete_*", "notion_update_*"]`. Per-server `approveTools` overrides this. |
| `oauthDir` | Legacy OAuth `tokens.json` import directory for this MCP config. Relative paths resolve from the active project cwd. `MCP_OAUTH_DIR` still wins when set. Persistent OAuth credentials are stored in the OS credential store, not this directory. |
| `oauthCredentialStore` | Set explicitly to `"encrypted-file"` for externally keyed AES-256-GCM storage (notably Windows OpenSSH network logons). Requires `PI_MCP_ADAPTER_OAUTH_FILE_KEY`; absent uses the OS credential store. |
| `mcpServers.<name>.oauth.authorizationParams` | Extra authorization URL parameters for provider-specific OAuth extensions. Flow-owned parameters such as `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `response_type`, and `resource` cannot be overridden. |
| `directTools` | Global default for all servers (default: false). `true`, `false`, or `"search"`. Per-server overrides this. |
| `namespaceProxyTools` | Register per-server `mcp__<server>` wrappers (default: true). Set to `false` to omit them from the model's tool list; `mcp`, `mcpScript`, and direct tools are unaffected. References such as `mcp:<server>` that rely on a wrapper will no longer resolve. Run `/reload` after changing this setting. |
| `strictDirectToolArguments` | Validate direct-tool inputs against their advertised schemas and recover one JSON string layer for object and array properties (default: false). |
| `directToolResultDetails` | Direct-tool result details: `"lean"` (default) or `"bounded"` to retain the guarded raw MCP result. |
| `warnOnLargeDirectTools` | Show the advisory when 75 or more direct tools resolve (default: `true`). Set to `false` to suppress only this advisory. |
| `freezeDirectTools` | Keep direct-tool registration stable after the initial sync so metadata updates and explicit reconnects do not rebuild the system prompt. Proxy/search/cache metadata still refreshes. Default: false. |
| `scriptMode` | Register the MCP-only `mcpScript` plain-JavaScript tool and its bundled skill (default: false). Read when Pi loads the adapter; run `/reload` after changing it. |
| `scriptSkill` | How the model finds the bundled `mcp-scripting` skill when `scriptMode` is on: `"manual"` (default) keeps it to `/skill:mcp-scripting`; `"model"` adds its path to the `mcpScript` description so the model reads it before writing a script. |
| `exposeResources` | Expose MCP resources as tools (default: `true`). Set to `false` to disable globally across all servers. Per-server `exposeResources` overrides this. |
| `jev` | Optional System One Jev settings. A valid System One key enables semantic search across every enabled MCP server by default; `semanticSearch: false` disables it. `scriptEvaluation` remains disabled by default and requires an `allowedServers` source allowlist when enabled. `jev: false` disables both. Run `/mcp-adapter jev setup` for guided configuration. |
| `disableProxyTool` | Hide the `mcp` proxy tool once configured direct tools are fully available from cache. Ignored while any server uses `directTools: "search"`, whose tools are registered inactive and can only be activated through the gateway (`mcp({ search })` or a successful `mcp({ tool })` call). |
| `autoAuth` | Auto-run OAuth on `connect`/tool calls when a server needs auth, then retry once (default: false). |
| `sampling` | Allow MCP servers to sample through Pi models, honoring `modelPreferences.hints` before current/default fallback (default: true when UI approval is available). |
| `samplingAutoApprove` | Skip sampling confirmation prompts. Required for sampling in non-UI sessions (default: false). |
| `elicitation` | Allow MCP servers to request user input through Pi dialogs (default: true when Pi UI is available). |
| `outputGuard` | Guard oversized MCP output: `true` (default), `false`, or `{ maxBytes, maxLines, detailsMaxBytes }`. See [Output Guard](tools.md#output-guard). |
| `trace` | Opt-in metadata-only protocol tracing. Set `{ enabled: true }` globally or `trace: true` on a server. The per-session JSONL file defaults to `.pi/mcp-traces/`; `file`, `maxBytes` (default 262144), and `maxEvents` (default 10000) can be set. Raw MCP payloads, prompts, tool arguments/results, auth data, and URLs are never persisted. |

Per-server `idleTimeout`, `requestTimeoutMs`, `approveTools`, and `exposeResources` override the global settings. `debug` remains stderr display and is unrelated to protocol tracing.
