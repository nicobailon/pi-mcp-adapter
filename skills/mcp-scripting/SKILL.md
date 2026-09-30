---
name: mcp-scripting
description: Read before writing mcpScript code. Covers tool discovery, the shape of call results (including JSON returned as text), and script limits.
disable-model-invocation: true
---

# MCP scripting

Use `mcpScript` when a request needs several MCP calls with logic between them, or when one call's output should go straight into another call. For a single search, describe, status check, auth action, or call, use `mcp`.

Only what the script emits, logs, or returns enters the conversation, so keep intermediate data in variables and return a small result:

```js
const found = await tools.search({ query: "list issues", server: "github" });
const path = found.items[0]?.path;
if (!path) return { error: "No matching tool" };

const result = await tools.call(path, { state: "open" });
if (!result.ok) return result;
const issues = result.data.structuredContent ?? JSON.parse(result.data.content[0].text);
return issues.filter((issue) => issue.comments === 0).map((issue) => issue.number);
```

## API

- `await tools.search({ query, server?, limit?, offset? })` returns `{ items: [{ path, name, server, description? }], total, hasMore, nextOffset }`.
- `await tools.describe({ path })` returns `inputTypeScript` (plus `inputGuidance` when documented fields would otherwise be lost) and optional `annotations`. When the server declares an `outputSchema`, it describes `data.structuredContent`. Otherwise, once the tool has returned JSON (in this or an earlier `mcpScript` session), `observedOutput` gives `{ target, typeScript }`: where the JSON is, and the field names and types seen so far. It is a hint, not a contract.
- `await tools.call(path, args)` returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. A failed call does not stop the script.
- Known paths can be called directly and resolve the same `{ ok, data }` way: `tools.github_search_issues(args)`, or `tools["server_tool-name"](args)` for hyphenated names. `tools` cannot be enumerated. `search`, `call`, `describe`, `then`, `catch`, `finally`, `toJSON`, `toString`, and `valueOf` are reserved; call a colliding path with `tools.call`.
- `emit(value)` adds output before the final `return` value; `console` output is captured too.

## Reading results

A tool call's `data` is the raw MCP `CallToolResult` (`{ content, structuredContent?, isError? }`), not the domain payload; resource reads return text. Use `data.structuredContent` when present. Otherwise most JSON APIs return their payload as text, so parse `data.content[0].text` (some servers emit newline-delimited JSON). If neither shape is understood, emit the envelope for inspection instead of coercing it to `[]` or `{}`.

Write the real script first instead of spending a turn looking at a result. Use `observedOutput` when describe has it; otherwise use the tool description and the field names the API most likely uses. Before a loop that writes (comments, closes, creates), check that the first item has the fields you filter on and throw if it does not, so a wrong guess stops before it changes anything. When a script throws, times out, or returns `[]`, `{}`, `null`, or `""`, its result lists the fields seen from the tools it called; fix the script from that. Never emit a whole list to inspect it.

## Limits

- Scripts time out after 30 seconds by default (`timeoutMs` changes it). The worker is stopped at the deadline, including infinite loops.
- Intermediate results share a fixed 16 MiB transfer budget per script. A result that does not fit returns `{ ok: false, error: { code: "intermediate_result_too_large" } }`, and the upstream call may still have had side effects.
- Every call goes through the normal connection, auth, and approval gates. The result details list each search, describe, and call with its outcome and duration.
- There are no fluent helpers such as `tools.find`, `tools.parallel`, or `tools.retry`; use loops and `Promise.all`.

When `settings.jev.scriptEvaluation` is enabled, read [references/jev.md](references/jev.md) before calling `jev.evaluate`.
