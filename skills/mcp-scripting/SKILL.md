---
name: mcp-scripting
description: Write mcpScript JavaScript for discovering, inspecting, and calling MCP tools.
disable-model-invocation: true
---

# MCP scripting

For multi-call MCP work, write ordinary JavaScript with loops, filtering, chaining, fan-out, or other logic between calls. Run that source with `mcpScript`; it is the primary MCP orchestration surface. For a single MCP search, describe, status check, auth action, or tool call, use `mcp` instead.

Write the source naturally, then pass it as `mcpScript`'s `code` argument:

```js
const { items } = await tools.search({ query: "search issues", server: "github" });
const candidate = items[0];
if (!candidate) return { error: "No matching tool" };

const details = await tools.describe({ path: candidate.path });
if (details.error) return details;

const result = await tools.call(details.path, { query: "is:open label:bug" });
if (!result.ok) return result;
emit({ tool: details.path, completed: true });
return result.data;
```

## Workflow

1. Find candidate tools with `await tools.search({ query, server?, limit?, offset? })`.
2. Inspect the exact returned path with `await tools.describe({ path })`.
3. Call it with `tools.call(path, args)`.

Descriptors include `inputTypeScript` (a compact parameter shape, or formatted schema fallback). When a compact shape would omit documented fields, `inputGuidance` preserves their descriptions, including formats and units. Undocumented inputs stay compact.

When advertised by the server, `outputSchema` is the original JSON Schema and `outputSchemaTarget` is `"data.structuredContent"`: it describes structured output inside the successful `{ ok: true, data }` call envelope, not the envelope itself. Inspect this schema for result fields and constraints; unsupported constructs remain intact rather than being presented as an approximate TypeScript type. Both output fields are absent when no output schema is advertised. Discovery and cache refresh preserve these optional schemas; old cache entries gain them on the next server metadata refresh. Ordinary search results do not include schemas.

Calls resolve to `{ ok: true, data }` or `{ ok: false, error }`; handle failed calls instead of expecting them to stop the script. `emit(value)` adds user-visible output before the final `return` value. `console` output is captured too.

On success, `data` may still be the raw MCP `CallToolResult` envelope rather than the domain payload. Check `data.structuredContent` for the fields your script expects; if they are absent, inspect text blocks in `data.content` too (some servers emit newline-delimited JSON). If neither shape is understood, return or emit the envelope for inspection instead of coercing it to `[]` or `{}`.

`tools` is a non-enumerable proxy: `Object.keys(tools)` throws. Always use `tools.search` for discovery. When a known flat path is a valid identifier, direct calls such as `tools.github_search_issues(args)` are supported; use bracket syntax for hyphenated names: `tools["server_tool-name"](args)`. `search`, `call`, `describe`, and promise/serialization names (`then`, `catch`, `finally`, `toJSON`, `toString`, `valueOf`) are reserved on the proxy; if a flat path collides with one, call it via `tools.call("exact-path", args)`.

Successful intermediate data is not presentation-truncated, summarized, or spilled by the output guard. A fixed **16 MiB cumulative UTF-8 JSON transfer budget per script** covers successful data across sequential and parallel calls. A result exceeding the remaining budget resolves to `{ ok: false, error: { code: "intermediate_result_too_large", message } }` and a failed call trace. Rejected bytes do not consume the budget; handle the error and continue, request less data, or start a new script. There is no cap configuration. Resource calls still return transformed text (or `"(empty resource)"`). Only values you emit, log, or return become script output, which retains the normal final output guard; ordinary MCP calls remain guarded.

Upstream tools execute before budget rejection and may already have side effects. The budget does not bound total memory: SDK objects, serialization of even rejected results, copies, concurrent responses, and script-created values still allocate memory. Synchronous serialization can delay deadline handling.

`tools.search` and `tools.describe` are asynchronous and must be awaited. The default script timeout is 30 seconds; the worker is terminated at the deadline, including for infinite loops. Every invocation still uses normal lazy connection, authentication, and approval gates. Result details contain a concise `calls` trace with every search, describe, and call operation; each entry includes its query or path, outcome, and duration.

Use plain JavaScript loops and Promise utilities for composition. Fluent helpers such as `tools.find(...).one()`, `tools.parallel(...)`, and `tools.retry(...)` are not provided.
