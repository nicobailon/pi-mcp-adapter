# Extension API, plugins, and SDK

For extension authors, plugin authors, and apps that embed Pi: loading servers from plugins and packages, registering or calling servers at runtime, SDK configuration, host-managed embedding, and status events.

## Agent Plugins

The adapter can load MCP servers from [Agent Plugins](https://agent-plugins.org/) packages when you list plugin directories in `settings.agentPluginPaths`:

```json
{
  "settings": {
    "agentPluginPaths": ["./plugins/acme-tools"]
  },
  "mcpServers": {}
}
```

Each directory must contain a valid Agent Plugins 1.0 `plugin.json`. If it also has a root `mcp.json`, the adapter loads its `mcpServers` entries and prefixes them as `<plugin>__<server>`. The loader uses the Agent Plugins transport declared by each server `type` and skips invalid entries without blocking other servers. For stdio plugin servers, `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded only in `args`, `env`, and `cwd`; the adapter sets both variables for the child process and stores plugin data under the Pi agent directory.

`inheritEnv` is an adapter-specific field, not an Agent Plugins or OpenCode schema field. Do not add it to a plugin's strict `mcp.json`; to opt a plugin stdio server out of host-environment inheritance, set `inheritEnv: false` in an `mcp-adapter.json` override using the translated `<plugin>__<server>` name:

```json
{
  "mcpServers": {
    "acme_tools__local": { "inheritEnv": false }
  }
}
```

Agent Plugins is a portable package format. Native adapter config remains `.mcp.json`, `~/.config/mcp/mcp.json`, and `mcp-adapter.json` overrides.

## Local Claude plugin bundles

The adapter can opt into MCP servers and Pi skills from explicitly configured local [Claude plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) directories:

```json
{
  "claudePlugins": [
    { "path": "./plugins/acme-tools", "mcp": true, "skills": true }
  ],
  "mcpServers": {}
}
```

Each entry needs a non-empty `path` and must enable `mcp`, `skills`, or both. The root-level field can be set in any normal adapter config source; normal config-source precedence applies, and a higher-precedence `claudePlugins` array replaces a lower one. Relative paths in file-based config resolve from the active project cwd. For `createMcpAdapter({ config })`, relative plugin paths are normalized against `process.cwd()` when the factory is created; this explicit API-boundary snapshot keeps early registration and session startup on the same local bundle even when the host's context cwd differs. `mcp: true` reads only the plugin's root `.mcp.json`; `skills: true` discovers `skills/**/SKILL.md` inside the plugin and passes those files through Pi's normal resource discovery, including startup and `/reload`. A `.claude-plugin/plugin.json` manifest is optional, matching Claude's plugin format, but when present it must be valid JSON with a kebab-case `name` and valid standard field types. Manifest path overrides are intentionally not followed.

Claude plugin MCP server names are used as written. The first explicitly listed plugin wins same-name conflicts between plugin bundles, while every normal Pi MCP config source overrides these plugin defaults. `${CLAUDE_PLUGIN_ROOT}` is expanded in plugin MCP server fields, and stdio servers receive it in their environment. Skills use Pi's existing skill parsing and conflict handling.

This is an explicit local trust boundary: the adapter does not discover, download, install, or update plugins; execute plugin hooks; or fetch skills from MCP instructions. It resolves plugin components inside each configured directory and rejects component symlinks that escape it. Config and skills are read during discovery, but MCP commands are still lazy and run only when normal adapter lifecycle/tool use connects that server. Enable `mcp` only for plugin directories whose commands and configuration you trust.

## Pi package manifests

A Pi package can ship MCP servers for the installed adapter without requiring a separate MCP config file. Declare a package-relative config in its `package.json`:

```json
{
  "pi": {
    "mcp": "./mcp.json"
  }
}
```

`pi.mcp` can also be an array of package-relative paths. Each file uses the normal `mcpServers` object shape, but package manifests load only server entries: package `settings` and `imports` are ignored. Server names are prefixed with the sanitized package name, such as `acme_tools__docs`, and user/global/project MCP config has higher precedence. The adapter loads only Pi packages listed in Pi settings; it does not scan `node_modules`.

## Runtime registration from other extensions

On Pi 0.99 and later, an extension can add a server with Pi's own API, and the adapter connects it:

```ts
export default function plugin(pi) {
  pi.registerMcpServer("acme__docs", { url: "https://mcp.example.com/mcp" });
}
```

The config uses the format of Pi's `mcp.json` and is translated the same way as that file (see [configuration](configuration.md#file-layout)); a server the adapter can't run, such as an SSE server, is not connected and is reported. Registrations made while extensions load connect with the session; registering or unregistering later applies right away. Registering a name again with a different config replaces the server (the same config keeps the existing connection, as in Pi's built-in MCP), and `pi.unregisterMcpServer(name)` disconnects it.

These servers are proxy-tool-only, like the adapter's own runtime registrations below. Of Pi's exposure settings only `"exposure": "hidden"` and `"enabled": false` apply, both as `disabled: true`; `direct` and `deferred` exposure are ignored and reported. A config entry with the same name wins, and so does an earlier registration through the adapter's event below; the other registration is reported as overridden.

The adapter's own registration event still works on every supported Pi version, for example for a plugin host that discovers plugins after load:

```ts
const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";
type RuntimeRegistrationRequest = {
  version: 1;
  name: string;
  definition: { url: string };
  result?:
    | { ok: true; registration: { dispose(): Promise<void> } }
    | { ok: false; error: Error };
};

export default function pluginHost(pi) {
  let registration: { dispose(): Promise<void> } | undefined;

  pi.on("session_start", () => {
    if (registration) return;
    const request: RuntimeRegistrationRequest = {
      version: 1,
      name: "acme__docs",
      definition: { url: "https://mcp.example.com/mcp" },
    };
    pi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
    if (!request.result) throw new Error("pi-mcp-adapter is not installed");
    if (!request.result.ok) throw request.result.error;
    registration = request.result.registration;
  });

  pi.on("session_shutdown", async () => {
    const current = registration;
    registration = undefined;
    await current?.dispose();
  });
}
```

Cross-extension registration uses Pi's shared event bus and does not require a runtime import from `pi-mcp-adapter`. Emit during `session_start` or later so the adapter listener is installed. The adapter writes `request.result` synchronously; the first adapter listener to respond wins.

Runtime registrations are session scoped and never written to config files. Duplicate server names fail closed against configured servers and other registrations. Registered servers use the normal lazy connection, OAuth, approval, and shutdown behavior, but they are proxy-tool-only and their tools become visible at the next tool sync. To change a definition, dispose the registration and register again.

## Runtime tool calls from other extensions

An extension can call a configured MCP tool from its own code, without a model turn:

```ts
const MCP_RUNTIME_TOOL_CALL_EVENT = "pi-mcp-adapter:runtime-tool-call:v1";
type RuntimeToolCallRequest = {
  version: 1;
  tool: string;
  args?: Record<string, unknown>;
  server?: string;
  result?: Promise<
    | { ok: true; result: { content: unknown[]; details?: unknown } }
    | { ok: false; error: Error }
  >;
};

const request: RuntimeToolCallRequest = { version: 1, tool: "search", args: { query: "mcp" } };
pi.events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);
if (!request.result) throw new Error("pi-mcp-adapter is not installed");
const outcome = await request.result;
if (!outcome.ok) throw outcome.error;
```

`tool` and `server` resolve the same way as `mcp({ tool, server })`, and approval settings and disabled servers apply as they do for that call. The adapter sets `request.result` to a promise during `emit()`; await it. A tool error or denied approval resolves with `ok: false`. Emit during `session_start` or later; calls fail after the session shuts down.

## SDK configuration

Use `createMcpAdapter` when an SDK or server integration already owns its MCP configuration:

```ts
import { createMcpAdapter } from "pi-mcp-adapter";

const extension = createMcpAdapter({
  config: {
    mcpServers: {
      docs: {
        url: "https://mcp.example.com/mcp",
        lifecycle: "eager",
      },
    },
  },
});

// Register `extension` with the host SDK.
```

The package ships TypeScript source for Pi's source-loader and SDK integrations. Use a TypeScript-capable loader/toolchain (for example `node --import tsx`) when importing the package from a standalone Node process; raw Node ESM does not execute the `.ts` entry directly.

A supplied `config` is a complete, isolated snapshot. It is not merged with files, imports, global config, project config, or `--mcp-config`, and it is never mutated. Explicit `claudePlugins` entries are the sole exception to file isolation: their configured local directories are read because they are part of that supplied snapshot. Relative programmatic plugin paths are normalized against `process.cwd()` when `createMcpAdapter` creates the factory, so the early model-facing surface, load-time initialization, and later session runtime all use the same bundle. Each adapter factory and session receives its own clone, so separate integrations can use different servers and settings safely. In this mode, server status, reconnect, explicit `/mcp-auth <server>`, proxy calls, and direct tools continue to work; setup and no-argument auth/status panels report the limitation instead of discovering or writing ambient config.

With `configPath` and no `config`, the adapter keeps normal file merge behavior, and that path takes precedence over argv and `--mcp-config`. The default export keeps the normal file-based behavior. OAuth credentials are stored in the operating system credential store and keyed by the configured server name; URL binding prevents credentials from being accepted for a different server URL. `settings.oauthDir` and `MCP_OAUTH_DIR` are used only as legacy plaintext import locations for older `tokens.json` files, not as credential namespaces. CSRF state and PKCE verifiers are flow-local, so concurrent authorization flows do not share transient secrets.

Cooperating Pi extensions can use `pi-mcp-adapter/oauth` to reuse URL-bound OAuth tokens without deep-importing private files:

```ts
import { getMcpOAuthTokensForUrl, updateMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth";

const tokens = await getMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp");
await updateMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp", { accessToken: "..." });
```

The public subpath exposes only token read/update helpers plus a status helper. The async read path uses the adapter's refresh logic before it returns tokens. For a service-protected endpoint or a pre-registered OAuth client, pass the explicit refresh configuration as `getMcpOAuthTokensForUrl(name, url, { definition: { headers, oauth } })`. This optional configuration is never loaded from ambient config or stored with the tokens; headers are bound to the supplied MCP URL's origin. The helpers keep secure-store storage, URL binding, refresh persistence, chunk handling, legacy import, and fail-closed credential-store errors. They do not expose client registration secrets, PKCE verifiers, or OAuth state.

## Host-managed embedding

Use `pi-mcp-adapter/host-managed` when an application embeds Pi and owns the MCP connection itself: it builds the transports, holds the credentials, records each call before it runs, and decides when the adapter starts and stops. For an ordinary integration that only supplies MCP configuration, use `createMcpAdapter` instead.

```ts
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHostManagedMcpAdapter } from "pi-mcp-adapter/host-managed";

const adapter = createHostManagedMcpAdapter({
  servers: {
    github: {
      createTransport: () => new StreamableHTTPClientTransport(new URL(url), { fetch: guardedFetch }),
      tools: ["search_issues", "get_issue"], // omit to expose every listed tool
    },
  },
  async onToolCall(call) {
    await journal.record(call.toolCallId, call.server, call.tool, call.arguments);
    return await call.dispatch();
  },
});

await adapter.ready(); // connects, lists tools, and freezes the catalog
const loader = new DefaultResourceLoader({ extensionFactories: [adapter.extensionFactory] });
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader });
await adapter.close(); // after the session settles
```

Nothing connects until `ready()`, which calls each `createTransport` once. It rejects and closes the adapter if a server fails to start, a requested tool is missing, or two tools map to the same Pi name (`<server>_<tool>`). `extensionFactory` registers only the selected tools and throws before `ready()` resolves or after `close()`. `close()` refuses new calls, aborts in-flight ones, and closes every transport within five seconds. A dropped connection is never reopened.

Every call goes through the approval broker (`pi-mcp-adapter:tool-approval-request` on `pi.events`, origin `direct`). Only `allow_once` or `allow_for_session` lets it run. A denial, an `abstain`, or no handler at all refuses the call before `onToolCall` sees it. `onToolCall` receives the frozen arguments and input schema, the Pi tool-call id, an opaque `connectionId`, and a `dispatch()` that sends `tools/call` at most once. The result it returns goes through the normal output guard, whether raw or changed (for example after importing images). An `isError: true` result reaches the model as a tool error. `dispatch()` rejects with `HostManagedMcpError`. The raw error is kept only as its `cause`, and the model sees fixed text.

| `delivery` | Meaning |
|---|---|
| `not_sent` | The request never left the adapter; the tool did not run. |
| `may_have_run` | The request was sent and the outcome is unknown (timeout, cancellation, lost connection, HTTP error). The agent is told not to retry automatically. |
| `server_error` | The server answered with a JSON-RPC error (`protocolCode`). |
| `invalid_result` | The server answered, but the result failed validation, including the tool's `outputSchema`. The tool may have run. |

On `notifications/tools/list_changed` the adapter lists the server's tools again. A selected tool that changed or disappeared is retired for the life of the adapter; if the re-list fails, every selected tool on that server is retired. Calls wait for a running re-list and are refused as `not_sent` both before `onToolCall` and inside `dispatch()`. The model is told to start a new session.

After `dispatch()` resolves, `call.linkedResource(uri)` prepares a read of a `resource_link` from that result. The read needs its own broker approval (origin `resource`, args `{ uri }`) and uses the same connection. It returns a `readId` and a single-use `dispatch()`, so you can record the read before it happens. A URI that is not linked throws, and a read is refused as `not_sent` once the parent call has settled.

Supplied transports must not carry an OAuth `authProvider` or any retry or replay behavior. The adapter sends each `tools/call` at most once at its own layer. It turns off the SDK's multi-round-trip auto-fulfilment, passes the tool definition so the SDK cannot resend on a header mismatch, and never recovers a session or reconnects. This mode does not read config files, use OAuth or the credential store, register commands, UI, or the `mcp` proxy tool, expose resource tools or prompts, or answer sampling or elicitation requests.

## Runtime status snapshots

Extensions can subscribe to the adapter's versioned shared event-bus channel instead of parsing `/mcp-adapter` or `mcp({})` output:

```ts
import { MCP_STATUS_EVENT, type McpStatusSnapshot } from "pi-mcp-adapter";

pi.events.on(MCP_STATUS_EVENT, (snapshot) => {
  const status = snapshot as McpStatusSnapshot;
  // status.servers contains connected, cached, failed, needs-auth,
  // not-connected, or disabled entries.
});
```

The snapshot is read-only machine-readable data with copied per-server entries. It includes `totalTools`, `totalResources`, `connectedCount`, and `disabledCount`; each server includes `name`, `status`, `toolCount`, `directToolCount` (the number of tools currently registered directly with Pi, including direct resource tools), and `disabled`, with `resourceCount` when known and `failedAgoSeconds` only for an active failure. Reading status never connects a lazy server, starts authentication, or exposes SDK clients, transports, credentials, or server definitions. An initial snapshot is emitted after initialization, updates are emitted for status and metadata changes, and an empty snapshot is emitted when the session shuts down. Initialization withholds that first snapshot until authoritative metadata has been reconciled into Pi's active direct-tool registry. A `connected` snapshot therefore follows model-facing tool-surface synchronization, including removal of stale cached tools when the authoritative catalog is empty.
