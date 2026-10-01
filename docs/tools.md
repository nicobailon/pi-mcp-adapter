# Using MCP tools

The `mcp` proxy tool, search, direct tools, approval prompts, and output limits.

## The `mcp` tool

| Mode | Example |
|------|---------|
| Status | `mcp({ })` |
| List server | `mcp({ server: "name" })` |
| Search | `mcp({ search: "screenshot navigate", limit: 12, offset: 0 })` |
| Describe | `mcp({ describe: "tool_name" })` |
| Instructions | `mcp({ instructions: "name" })` |
| Call | `mcp({ tool: "...", args: { key: "value" } })` |
| Connect | `mcp({ connect: "server-name" })` |
| UI messages | `mcp({ action: "ui-messages" })` |
| Auth start | `mcp({ action: "auth-start", server: "name" })` |
| Auth complete | `mcp({ action: "auth-complete", server: "name", args: { redirectUrl: "..." } })` |

`args` can be a JSON object or a JSON string. Prefer the object form when your model handles it reliably; the string form remains supported for providers that need simpler schemas.

`mcp({ connect: "server-name" })` refreshes an already connected server, so new tools, resources, prompts, and instructions can load without restarting Pi.

MCP proxy and direct-tool results use compact self-rendered rows by default. Collapsed success output shows the call title, a bounded one-line input preview when arguments exist, and the first result line, with a `Ctrl+O to expand` hint when more text is hidden. The full result remains available when expanded and is still returned unchanged to the model. Set `settings.toolResultRendering` to `"boxed"` to restore the legacy boxed Pi row, or set `settings.collapsedResultLines` to `2` or `3` when you want more collapsed text.

Search covers MCP tools only. Space-separated words are ranked by weighted matches across name, server, description, the server's configured `description`, and any configured `searchKeywords`, then returned one page at a time (`limit` defaults to 12). Use `details.nextOffset` for the next page. Regex search is still available with `regex: true`, but regex results are paginated without ranking.

Tool names are fuzzy-matched on hyphens and underscores — `context7_resolve_library_id` finds `context7_resolve-library-id`. When `describe` or `tool` cannot resolve a name, the result includes top suggestions so the agent can correct a typo or missing prefix in the same turn.

When a server declares MCP tool annotations, `describe` adds a `Hints:` line such as `Hints: read-only, idempotent`, `tools.describe` in `mcpScript` returns them as `annotations`, and the approval prompt says when a tool is marked destructive or read-only. They are the server's own hints, not guarantees, and never appear in search results or direct-tool descriptions.

When `includeSchemas` is enabled, search and describe render common JSON Schema parameters as compact TypeScript shapes like `{ query: string; limit?: number; }`, with the older schema formatter retained as a fallback for unsupported schemas.

Most tools declare no output schema. After such a tool returns structured content or a JSON text result, `describe` (and `tools.describe` in `mcpScript`) also shows the output shape seen so far: field names and types only, never values, labeled as observed, not a contract. A wide object that appears more than once, such as a user under `user`, `assignee`, and `assignees`, is written once as a named type. With `scriptMode` on, shapes are also saved in `mcp-cache.json`, so later sessions can write a script without calling the tool first. A shape is used only while the tool's description and input schema stay the same, and a saved one is dropped when they or the server's config change.

When an `mcpScript` run throws, times out, or returns `[]`, `{}`, `null`, `""`, or nothing, its result ends with the shapes seen from the schemaless tools it called, so the model can fix a wrong field guess without a separate look at the data.

For HTTP servers, Pi reports HTTP 503 as temporary unavailability and does not add another immediate retry loop. Keep-alive servers keep cached metadata available and retry after 30 seconds, backing off to 5 minutes. Other failed connects run a one-request shape probe that can turn opaque transport errors into setup hints such as `endpoint returned HTML (200) — this URL does not appear to speak MCP`. Healthy connections are not probed.

Servers that provide usage guidance via the MCP `instructions` field surface it through discovery paths: `mcp({ server: "name" })` includes a preview (after the server's configured `description`, if any), and `mcp({ instructions: "name" })` returns the full text. Instructions are captured at connect time and cached alongside tool metadata, so they stay available without a live connection.

## Search keywords

Search uses literal matching so a tool whose name and description use different vocabulary than the query won't be found. Per-server `searchKeywords` adds extra vocabulary for matching tools:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "searchKeywords": {
        "search_code": ["grep"],
        "*": ["gh"]
      }
    }
  }
}
```

With this config, `mcp({ search: "grep" })` finds `github_search_code` even though neither its name nor description contains that word. Similarly, `mcp({ search: "gh" })` finds all tools provided by the github server.

Keys match a tool's original name, prefixed name, or a glob (`*` applies to every tool on the server) and all matching entries combine. Keywords are weighted like description text, with an extra boost when the query exactly matches a configured phrase. They affect ranked and regex search only (including `tools.search` in `mcpScript`): they never appear in tool schemas, `describe` output, direct-tool registration, or the metadata cache, and search with keywords works offline from cached metadata.

## MCP output schemas

Advertised tool `outputSchema` values support JSON Schema draft-07 and 2020-12. Unstamped schemas use the SDK's 2020-12 default. Returned `structuredContent` is validated against the advertised schema for both proxy and direct-tool calls.

## Direct Tools

By default, all MCP tools are accessed through the single `mcp` proxy tool. This keeps context small but means the LLM has to discover MCP tools via proxy search. If you want specific tools to show up directly in the agent's tool list — alongside `read`, `bash`, `edit`, etc. — add `directTools` to your config.

Per-server:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.6.0"],
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

## Search-activated direct tools

`directTools: true` puts every tool's definition in front of the model on every turn. Past a few dozen tools that costs context and, on smaller models, accuracy — the advisory at 75 exists for that reason. `directTools: "search"` is the middle path: the tools are registered as real direct tools with real schemas, but **inactive**, and `mcp({ search })` activates the matches additively.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "directTools": "search"
    }
  }
}
```

A successful `mcp({ search })` activates matching search-mode tools additively for the rest of the session and reports newly activated names in `addedToolNames`. A successful `mcp({ tool })` call for a held search-mode tool activates it the same way, so the next call uses its real schema; a failed call (lookup, approval, or tool error) activates nothing. Before Pi 0.99, a restart or resumed session starts with them inactive again. Selecting `directTools: true` activates held tools, while switching back to `"search"` holds them again. Search-mode tools do not count toward the 75-tool advisory.

On Pi 0.99 and later, search-mode tools are Pi deferred tools, grouped per server in the `mcp__<server>` namespace with the server's `description` and instructions:

- Pi's `tool_search` finds and activates them too, and Pi owns their activation: it is recorded on the session branch, so activated tools stay active after a resume or `/tree`.
- They carry the server's tool annotations, which permission extensions read with `pi.getAllTools()`.
- Codemode scripts can call them while inactive and get the MCP `CallToolResult` (`content`, `structuredContent`, `isError`); `isError` is also set when the adapter could not run the call.
- Calls still go through the adapter: lazy connect, `approveTools`, and output limits.
- Pi cannot unregister tools, so a tool whose server is removed or disabled, or that `includeTools`/`excludeTools` now filter out, is registered again as hidden.

To expose only a subset of a noisy server, add `includeTools` on the server. Values can be exact original names, generated resource names such as `read_<resource>`, prefixed names, or simple glob patterns:

```json
{
  "mcpServers": {
    "dokploy": {
      "url": "http://localhost:3845/mcp",
      "directTools": true,
      "includeTools": ["get_*", "dokploy_list_apps"]
    }
  }
}
```

To hide specific tools while still using `directTools: true`, add `excludeTools` on the server. `excludeTools` is applied after `includeTools`:

```json
{
  "mcpServers": {
    "figma": {
      "url": "http://127.0.0.1:3845/mcp",
      "directTools": true,
      "excludeTools": ["read_figjam", "figma_get_code_connect_map"]
    }
  }
}
```

`includeTools` and `excludeTools` filter direct tools, proxy search/list/describe, and the `/mcp-adapter` panel view.

Each direct tool costs ~150-300 tokens in the system prompt (name + description + schema). Good for targeted sets of 5-20 tools. For servers with 75+ tools, stick with the proxy or pick specific tools with a `string[]`. If 75+ direct tools resolve, the adapter prints an advisory but still registers the tools you configured. Set `settings.warnOnLargeDirectTools` to `false` to suppress this advisory.

Direct tools register from the metadata cache in the Pi agent dir (`~/.pi/agent/mcp-cache.json` by default, or `$PI_CODING_AGENT_DIR/mcp-cache.json` when set), so no server connections are needed at startup. On the first session after adding `directTools` to a new server, the cache won't exist yet — tools fall back to proxy-only while the cache populates, then the extension hot-loads the refreshed direct tools into the current session. When `mcp({ connect: "<server>" })` is what discovers them, the connect result lists the new tools in `addedToolNames`, so Pi can load their definitions from that point in the transcript instead of rewriting the active tool list. Servers that advertise MCP list-change notifications refresh the current session when their tool or resource list changes. On Pi versions that expose `pi.unregisterTool()`, stale direct tools are removed from the registry during refresh; older Pi versions still deactivate them from the active tool set. To force a refresh: `/mcp-adapter reconnect <server>`.

Cached metadata does not expire with age. An entry stays valid until the server's config changes or a TTL the server declared (`ttlMs`) runs out, and it is refreshed whenever the server connects, so servers you rarely use stay searchable without being started.

For faster startup, set `settings.deferWithMissingMetadata` to `true`. Servers with missing or invalid metadata (expired, mismatched, or non-cacheable) then contribute no tools, prompts, resources, or search entries until the first MCP operation starts the runtime and loads live metadata; the `mcp` gateway stays available. Because Pi cannot unregister slash commands, cached prompt commands also wait for live metadata under this setting. `eager`/`keep-alive` servers and cold `MCP_DIRECT_TOOLS` selections still start immediately.

After discovery, each runtime retains its own schema-bearing tool and resource catalogue. Another session overwriting the shared disk cache, a server-declared TTL running out (including `ttlMs: 0`), cache deletion, or an idle disconnect does not revoke that runtime's tools. Disk TTLs still govern reuse at startup; session catalogues are not persisted with extended TTLs. A failed resource discovery preserves that runtime's previously discovered resources for the same server configuration, whereas a successful empty resource list removes them. Current server identity, disabled state, tool filters and failure backoff still apply, and an authoritative empty discovery removes the tools. Replacing the runtime requires fresh discovery or valid disk metadata.

Models sometimes encode an object or array argument as a JSON string. Set `settings.strictDirectToolArguments` to `true` to recover one such layer for schema-declared object and array properties, then validate the complete input against the advertised schema before execution.

Set `settings.directToolResultDetails` to `"bounded"` when an extension needs structured MCP result fields in Pi's direct-tool result details. The same output guard limits apply. Small leading structured fields stay available, while large fields receive bounded summaries and the complete guarded result follows the output guard's spill-file policy. The default `"lean"` mode keeps the existing server and tool metadata only.

If prompt-cache stability matters more than direct-tool hot-loading, set `settings.freezeDirectTools` to `true`. The initial direct-tool sync still runs, but later metadata updates and explicit reconnects keep the registered tool surface unchanged while proxy/search/cache metadata refreshes normally.

When you change direct-tool toggles in `/mcp-adapter`, the extension updates direct tool registration in the current session. Broader setup writes from `/mcp-adapter setup` still use Pi's normal reload flow because they can add or restructure MCP config files.

**Subagent integration:** If you use the subagent extension, agents can request direct MCP tools in their frontmatter with `mcp:server-name` syntax. See the subagent README for details.

## Tool Approval

Use `approveTools` when a tool should stay visible but not run without confirmation. This is useful for destructive or high-cost actions where hiding the tool would make planning harder, but running it silently is too risky.

```json
{
  "settings": {
    "approveTools": ["github_delete_*", "notion_update_*"]
  },
  "mcpServers": {
    "github": { "approveTools": ["delete_*", "merge_pull_request"] },
    "docs": { "approveTools": false }
  }
}
```

To be asked before any tool that may change or delete data, set `"approveTools": "destructive"` globally or per server. A tool then runs without a prompt only when its server marks it read-only (`readOnlyHint: true`) or non-destructive (`destructiveHint: false`); tools with no such hints, including those restored from an older metadata cache, are gated. Resource reads are never gated by this value. Any other string requires approval for every tool.

When a matching tool is called from the proxy tool, a direct MCP tool, a resource call, or an MCP UI iframe, Pi asks: **Allow once**, **Allow for session**, **Allow server for this session**, or **Deny**. **Allow for session** tool grants and MCP UI iframe consent decisions (including denials) persist as non-LLM custom entries on the active Pi session branch and restore on resume or branch navigation. Entries store only server/tool names and deterministic definition/argument hashes; raw arguments, results, and secrets never persist. Tool grants and iframe consent remain separate gates. In headless sessions, matching calls fail closed with an `approval_required` result; denials, abstentions, **Allow once**, and approval-required paths do not create tool grant records. `excludeTools` still removes tools entirely; `approveTools` only gates visible tools at call time.

**Allow server for this session** permits all tools and argument combinations on the selected server, including tools discovered later. It does not approve other servers. This broad grant stays in memory only: reload, session replacement, resume, and branch navigation clear it. A changed or replaced server configuration also invalidates it. It is never saved to session entries or configuration. Broker denials, tool exclusions, host security guards, and the separate MCP UI iframe consent gate still apply. Use **Allow for session** instead to approve only the displayed tool definition and arguments.

`pi-mcp-adapter/status/v1` is the documented, versioned public channel for cross-extension status. By contrast, `mcp-approval-v1` entries are adapter-owned persistence state, not a supported cross-extension contract; consumers should use documented package exports and event APIs instead.

Permission extensions can broker these decisions by listening on `pi-mcp-adapter:tool-approval-request` and claiming the request synchronously:

```ts
import {
  MCP_TOOL_APPROVAL_REQUEST_EVENT,
  type McpToolApprovalRequest,
} from "pi-mcp-adapter";

pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (request: McpToolApprovalRequest) => {
  request.claim(async () => {
    return "allow_once"; // "allow_for_session" | "deny" | "abstain"
  });
});
```

The request includes `serverName`, `originalToolName`, `prefixedToolName`, `args`, `origin`, and optional `signal`. The first synchronous claim wins. Brokered approval runs for every resolved MCP call reaching the approval gate, including calls matching session grants restored from the active branch, regardless of `approveTools` configuration, across proxy, direct, `mcpScript`, resource, and iframe origins. `allow_once` permits only the current call; `allow_for_session` updates the same session-scoped approval cache and persistence path as the built-in dialog; `deny` blocks the current MCP call even if cached, without revoking its grant. Only `abstain` or no claim consults the cache, then the configured approval/UI fallback above if no matching grant exists. With no broker listener, fallback behavior is unchanged.

Pi's `tool_call` hooks see a call to `mcp` or `mcpScript` as one call with its arguments. They don't see the MCP tools that call runs, so permission extensions that want each MCP call should use the broker event above. `approveTools` applies to every MCP call, whether it comes from `mcp`, `mcpScript`, or a direct tool. If another extension also asks before `mcp` or `mcpScript` runs, one action can show two prompts.

## Output Guard

Oversized MCP tool/resource results are guarded by default so a single huge response can't blow up the model context window or the session file:

- Inline text output is capped at **50 KiB / 2,000 lines** (matching Pi's built-in `bash` guard). Larger output is truncated to a head preview and the full text is saved to a temp file whose path is included in the result, so the agent can `read`/`grep` it.
- **Image content blocks pass through unchanged** — only text output is guarded. Images are delivered to the provider as native image content.
- Binary resource blobs up to **10 MiB** are decoded to private temp files and replaced with file references. Each session is limited to **100 MiB** and **10,000 files**. The files are removed at session teardown.
- In proxy mode, `details.mcpResult` is kept raw when its JSON is **≤ 16 KiB**; larger results are replaced with a compact summary (block counts, sizes, key previews) and the raw JSON is saved to a temp file. Direct tools keep lean details unless `settings.directToolResultDetails` is set to `"bounded"`, which applies the same guarded `mcpResult` limit.

Extensions consuming `details.mcpResult` must check for `omitted === true` on both the result and its `structuredContent` before treating either value as an original payload. For omitted object `structuredContent`, `preservedFields` is only a partial preview; `summary.keyCount` is the original cardinality, while `preservedCount` and `droppedCount` account for retention. Under tiny limits, the whole result may compact to an omission marker without spill metadata.

Tune the text and details limits with the object form:

```json
{
  "settings": {
    "outputGuard": { "maxBytes": 51200, "maxLines": 2000, "detailsMaxBytes": 16384 }
  }
}
```

Set `"outputGuard": false` — or the env kill switch `MCP_OUTPUT_GUARD=0` — to disable text and details guarding. Binary resource materialization and its safety limits remain active. Output-guard spill files are created with mode `0600` under the system temp directory and are not cleaned up automatically; note that spilled MCP output may contain sensitive data.
