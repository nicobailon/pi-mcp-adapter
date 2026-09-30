# Server options

Every field a server entry accepts, transport and protocol details, shared processes, and installing a server from a URL. Authentication fields are covered in more depth in [Authentication](auth.md).

## Fields

In the configuration examples below, `30000` is illustrative only. If `requestTimeoutMs` is omitted or set to `<= 0`, the MCP SDK default timeout is used.

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "lifecycle": "lazy",
      "idleTimeout": 10,
      "requestTimeoutMs": 30000
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `command` | Executable for stdio transport; mutually exclusive with `url` and `socket` |
| `args` | Command arguments |
| `socket` | Explicit `rmcp-mux` Unix-domain socket path; supports `${VAR}`, `$env:VAR`, and `~` expansion and is mutually exclusive with `command` and `url` |
| `env` | Environment variables; supports `${VAR}` and `$env:VAR` interpolation. A value beginning with `!` runs a command when the stdio server connects; use `!!` for a literal leading `!`. |
| `inheritEnv` | Stdio only; defaults to `true` and preserves full host-environment inheritance. Set to `false` to exclude arbitrary host variables from the MCP child and SDK negotiation sibling while retaining SDK platform defaults and explicit `env` overlays. This is not an empty environment or an OS sandbox. |
| `cwd` | Working directory; supports `${VAR}`, `$env:VAR`, and `~` expansion |
| `url` | HTTP endpoint (StreamableHTTP with SSE fallback); supports raw `${VAR}` and `$env:VAR` interpolation, and missing URL variables fail before any request is sent |
| `headers` | HTTP headers; supports `${VAR}` and `$env:VAR` interpolation. A value beginning with `!` runs a command when the HTTP server connects or OAuth authenticates; use `!!` for a literal leading `!`. |
| `requestHeadersCommand` | Trusted executable run for every HTTP request. It receives a versioned JSON envelope containing `method`, `url`, and the exact `bodyBase64` on stdin, and must return a JSON object of headers on stdout. `command`, `args`, and `env` support environment interpolation. Use for caller-bound request signatures; failures stop the request. |
| `caFile` | HTTPS HTTP servers only: local PEM CA certificate/bundle, e.g. `"caFile": "~/certs/local-ca.pem"`. Replaces (does not add to) default roots for the resolved MCP origin. Supports environment interpolation and `~`; relative paths use the process working directory. Unreadable/invalid files fail closed; hostname and certificate-expiry verification remain enabled. |
| `auth` | `"bearer"` or `"oauth"` |
| `oauth.grantType` | `"authorization_code"` (default) or `"client_credentials"` for non-interactive machine auth |
| `oauth.clientId` | Pre-registered OAuth client ID. Takes precedence over `oauth.clientMetadataUrl` when both are set. |
| `oauth.clientSecret` | OAuth client secret for confidential clients; a value beginning with `!` runs a command when OAuth authenticates, while `!!` escapes a literal leading `!`. Combining it with `oauth.clientMetadataUrl` requires an explicit `oauth.clientId`. |
| `oauth.clientMetadataUrl` | Advanced opt-in for an operator-supplied public HTTPS Client ID Metadata Document (CIMD) URL with a non-root path. Used as the `client_id` when the authorization server advertises CIMD support; otherwise the adapter falls back to Dynamic Client Registration. The adapter does not provide or host a default document. |
| `oauth.scope` | Requested OAuth scopes |
| `oauth.redirectUri` | Redirect URI for browser OAuth. Dynamic clients normally omit it and use an OS-assigned port on the default `http://127.0.0.1:<port>/callback`. Local `http://` loopback URIs accept an explicit port or `{port}` for an OS-assigned port (for example, `http://localhost:{port}/callback` for a server registered only for `localhost`). Pre-registered `https://` callbacks use manual completion by pasting the full callback URL. |
| `oauth.clientName` | Client display name advertised during Dynamic Client Registration fallback |
| `oauth.clientUri` | Client homepage URI advertised during Dynamic Client Registration fallback. Defaults to `piConfig.clientUri` from the host's manifest when set, and is omitted rather than guessed under a rebranded host |
| `oauth.logoUri` | Client logo URL advertised during Dynamic Client Registration fallback (RFC 7591 `logo_uri`). Must be an absolute `http(s)` URL — consent screens fetch it server-side, so local paths render nothing. Omitted from the registration request when unset |
| `oauth.authServerMetadataUrl` | HTTPS URL of an OAuth/OIDC authorization-server metadata document. When set, this document is authoritative instead of MCP protected-resource discovery; its issuer remains validated by default |
| `oauth.skipIssuerMetadataValidation` | `true` disables the OAuth authorization-server metadata issuer check for this server. This weakens OAuth mix-up protection and should only be used for known-misconfigured internal servers while their metadata is being fixed. |
| `bearerToken` / `bearerTokenEnv` | Token or env var name; `bearerToken` supports `${VAR}` and `$env:VAR` interpolation. A leading `!` in `bearerToken` runs a command when the HTTP server connects; use `!!` for a literal leading `!`. |
| `bearerTokenStore` | Set to `true` to read a static bearer token from the adapter-owned OS credential store when `auth` is `"bearer"` and no `bearerToken` or `bearerTokenEnv` is configured. Stored records are keyed only by the server name, bind to the resolved server URL, and are never named by config. Store a token with `pi-mcp-adapter token set <server>`, which reads it from a masked prompt or stdin pipe and never from an argument. `/mcp-adapter token status <server>` and `/mcp-adapter token remove <server>` manage non-secret state inside Pi; `/mcp-adapter token set` stays disabled until Pi exposes masked secret input. |
| `lifecycle` | `"lazy"` (default), `"eager"`, `"keep-alive"`, or `"lazy-keep-alive"` |
| `idleTimeout` | Minutes before idle disconnect (overrides global) |
| `requestTimeoutMs` | Request timeout in milliseconds for live MCP calls (overrides global; if omitted or `<= 0`, the MCP SDK default timeout is used) |
| `protocolVersion` | `"legacy"` (default), `"auto"`, or `"2026-07-28"`; modern negotiation is opt-in |
| `tasks` | MCP Tasks extension support on 2026-07-28 connections (default: true; set `false` to opt out); see [Task-augmented tool calls](#task-augmented-tool-calls) |
| `exposeResources` | Expose MCP resources as tools (default: true) |
| `directTools` | `true`, `string[]`, or `false` — register tools individually instead of through proxy |
| `toolPrefix` | Override global `settings.toolPrefix` for this server (`"server"`, `"short"`, `"none"`, or `"mcp"`) |
| `includeTools` | `string[]` of tool names or glob patterns to expose (matches original names like `get_screenshot`, generated resource names like `read_figjam`, and prefixed names like `figma_get_screenshot`) |
| `excludeTools` | `string[]` of tool names or glob patterns to hide (applied after `includeTools`) |
| `searchKeywords` | `{ "tool-or-glob": ["keyword", ...] }` — extra keywords that boost `mcp({ search })` ranking for matching tools; never shown to the model |
| `debug` | Show server stderr (default: false) |
| `trace` | Enable metadata-only JSONL protocol tracing for this server; payloads, prompts, tool arguments/results, authorization data, and URLs are never persisted |
| `disabled` | Keep the server visible in config and status, but prevent connections, authentication, tools, and resource calls (only literal `true` disables it) |

### Custom HTTPS trust

`caFile` works with Streamable HTTP, SSE, and per-request header commands. Requests using this trust reject all redirects; configure the final HTTPS endpoint directly. Other origins and servers retain default trust. Layered configuration drops inherited trust when replacing the URL or switching away from HTTP. This option covers the MCP origin, including connection-owned OAuth requests to that exact origin, but not the separate interactive OAuth flow or private-CA authorization servers on other origins. Thanks to [@desmonna](https://github.com/desmonna) for #527.

### macOS local-network access

On macOS 15+, Local Network Privacy may deny access to a LAN MCP server depending on the app responsible for hosting Pi. For HTTP URLs with literal private/link-local IPv4 or IPv6 addresses, the adapter adds a hint to `EHOSTUNREACH`, `ENETUNREACH`, or `EACCES` connection errors while retaining the original cause. These codes can also mean routing or firewall trouble; the hint is not proof of a privacy denial. Hostnames are not resolved for this diagnostic.

Check **System Settings > Privacy & Security > Local Network** for the hosting app, enable access if listed, then restart that app and Pi. If it is absent or access still fails, try launching Pi directly from Apple Terminal.app or over SSH (contexts Apple documents as exempt). Permission is attributed to responsible code, not necessarily Node or Pi; signing an unsigned CLI alone does not guarantee a permission prompt or fix host attribution. See [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

### Protocol version negotiation

The adapter defaults to `protocolVersion: "legacy"`. Omitting the field uses the classic MCP initialize sequence without `server/discover` or 2026 headers, preserving compatibility with deployed 2025-era servers.

Use `"auto"` to probe for MCP 2026-07-28 and conservatively fall back to the classic handshake when the server provides legacy evidence. Set it for Cloudflare Workers `createMcpHandler` and other MCP SDK v2 stateless servers. The adapter keeps `"legacy"` as the global default for compatibility. For stdio servers, the SDK probes with a short-lived sibling process before starting the session process, so each fresh auto connection adds one process spawn and can wait for the configured request timeout. Explicit Unix sockets are custom transports and probe in place. HTTP auto negotiation uses the actual Streamable HTTP connection; the adapter falls back to legacy SSE only when the endpoint definitively rejects Streamable HTTP (for example 404/405/406/415), never for authentication failures, cancellation, timeouts, or server errors.

Use `"2026-07-28"` to pin that revision. Pinning has no legacy or SSE fallback and fails if the server does not offer the requested version.

### Task-augmented tool calls

The adapter supports the [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview) (`io.modelcontextprotocol/tasks`, SEP-2663), which lets long-running tools return a durable task handle instead of blocking the connection. Support is negotiated per connection and needs no configuration: the task session only activates when a 2026-07-28 connection's server advertises the extension, so nothing changes for servers without task support. Set `tasks: false` on a server to opt out and keep the plain synchronous call path. Legacy (2025-11-25) experimental tasks are not supported.

When active, tool calls keep their normal contract from the model's point of view:

- A tool that returns a task handle is transparently polled to completion, honoring the server's suggested poll interval; the final result is returned as if the call had been synchronous.
- If the task pauses for input (`input_required`), elicitation requests are routed through the same interactive elicitation UI as direct `elicitation/create` requests, and answers are delivered back via `tasks/update`.
- Cancelling the Pi tool call sends a cooperative `tasks/cancel` to the server.
- A task that fails with a JSON-RPC error surfaces as the same error a synchronous call would have produced; a tool result with `isError: true` is returned as a normal tool error.

Task traffic is dispatched on a dedicated raw channel below the SDK client (the published MCP SDK does not yet decode task result shapes itself), built on the official `@modelcontextprotocol/ext-tasks` requester package. The channel chains onto the connected transport's handlers without replacing the transport, and raw task frames appear in `/mcp-trace` in both directions. Task status notifications (`notifications/tasks`) are not consumed; polling is used exclusively. `requestTimeoutMs` applies per task request (the initiating call and each poll), not to the overall task duration — a task that runs for hours holds the Pi tool call for as long as the model waits for it.

One trade-off while tasks are active: every `tools/call` on that connection is dispatched through the task-aware path instead of `Client.callTool`, so the SDK's client-side output-schema validation of `structuredContent` and SEP-2243 `Mcp-Param-*` header mirroring do not run for those calls. Servers still validate their own results; only the client-side double-check is skipped.

The stable SDK handles era-specific request envelopes, result decoding, list-changed subscriptions, cancellation, and multi-round-trip sampling/elicitation. The SDK's embedded-input progress callback does not expose the originating tool or resource identity, so the adapter cannot maintain a durable per-tool waiting status row; interactive sessions keep the existing input dialog visible, and proxy calls show request progress when UI is available. The adapter keeps strict OAuth issuer validation in every mode. Adapter-level roots support, standard MCP logging presentation, and configuration/UI for protocol cache hints are not yet implemented.

### Stdio environment boundaries

`inheritEnv: false` applies only to the actual MCP stdio server process and, for `protocolVersion: "auto"` or `"2026-07-28"`, its disposable SDK negotiation sibling. It does not change the default for other servers: omitting the field or setting it to `true` preserves the existing full host-environment inheritance. With `false`, the SDK still supplies its platform defaults and configured `env` values remain explicit overlays; the result is not a literally empty environment and is not an OS sandbox.

Environment interpolation remains intentional. `${VAR}`, `$env:VAR`, and `{env:VAR}` values still read selected host variables and can place those values in the child. `literalEnv: true` keeps its existing behavior by treating configured stdio `env` values as literals. The following helper boundaries are unchanged and still retain the full host environment even when a server uses `inheritEnv: false`:

- npm/npx cache resolution and cache-population subprocesses;
- `!command` secret helpers used by stdio `env` (and other secret fields); and
- the HTTP `requestHeadersCommand` helper.

For tighter use, configure a direct executable instead of npm/npx and avoid `!command` secret helpers. This option limits stdio child inheritance only; it does not provide complete multi-agent or helper-process isolation.

## Shared MCP processes with rmcp-mux

To share one stdio MCP server across Pi sessions, run it under [`rmcp-mux`](https://github.com/VetCoders/rmcp-mux) and point each session at the service socket:

```json
{
  "mcpServers": {
    "memory": {
      "socket": "~/.rmcp-servers/rmcp-mux/sockets/memory.sock"
    }
  }
}
```

The adapter owns only its client socket and closes that connection when the Pi runtime stops. `rmcp-mux` owns the upstream process, request routing, initialization cache, restart policy, client limits, and socket permissions. Start and configure the mux separately; the adapter never discovers, starts, adopts, or stops its daemon. A socket is an explicit trusted local endpoint, so do not point unrelated projects or users at a mux service unless its tools, state, credentials, and filesystem access are intended to be shared.

## Install from one URL

Install an MCP endpoint without editing configuration:

```js
mcp({ action: "install", url: "https://example.com/mcp" })
```

Install validates and connects the endpoint. New entries use a name derived from the hostname and are saved to the global `mcp-adapter.json`; existing URL entries are reused without rewriting. Pass `server` to choose a name or `target: "project"` to save to the project's `.mcp.json`. Unsafe URLs, name collisions, and failed connections are not persisted.

Set `settings.allowInstall` to `false` in `mcp-adapter.json` or another adapter config source (not Pi's `mcp.json` or `settings.json`) to block `mcp({ action: "install" })` for constrained or headless agents. Connect, search, tool calls, authentication, runtime registration, and interactive setup are unaffected.

In exclusive config mode, a project target must be the active config path; otherwise use the global target. URL install cannot promote runtime-registered servers: save their complete definitions manually so required headers and transport/auth settings are retained.

Public servers are ready immediately. For OAuth servers, the same action opens the authorization page and watches a reachable loopback callback. After the user grants consent, an `mcp-oauth-status` message returns the agent to connect the server and verify its discovered tools. Remote/headless callbacks retain the [manual completion fallback](auth.md#remoteheadless-authentication).
