# MCP scripting

Semantic tool search with Jev, the opt-in `mcpScript` tool, and composable search from scripts.

## Jev semantic search and opt-in script evaluation

A valid System One key makes semantic search available across every enabled MCP server; it does not run Jev searches automatically. A search uses Jev only when `searchMode: "semantic"` is explicitly requested. Jev ranks matching tools but never executes them. Script evaluation remains disabled until `scriptEvaluation: true` is configured. Requests use the pinned model from `settings.jev.model` (`jev-1.13.0` by default) against the endpoint in `SYSTEMONE_ENDPOINT`, which defaults to TypeSafe at `https://api.typesafe.ai/v1/systemone`. Review your provider's current legal terms — for TypeSafe, [legal terms](https://docs.typesafe.ai/legal), including privacy and retention; a no-training commitment does not mean zero retention.

```text
Normal search
mcp({ search: "calendar" })
        │
        └── local lexical search
            no Jev request

Explicit semantic search
mcp({ search: "calendar", searchMode: "semantic" })
        │
        └── Jev ranks matching tools
            no tool is executed
```

The quickest desktop setup is:

```sh
pi-mcp-adapter key set systemone
```

That is enough to use semantic search across all enabled MCP tools. Run `/mcp-adapter jev setup` in Pi when you want to restrict which enabled servers may share semantic-search data. The command saves a project-scoped allowlist and reloads Pi automatically. Verify the stored credential at any time with `pi-mcp-adapter key status systemone`.

`SYSTEMONE_API_KEY` is for CI/headless use and overrides the keyring. Stdio MCP subprocesses inherit the host environment by default, so set `inheritEnv: false` where they must not receive it. The script worker receives no key, SDK, endpoint, headers, or environment.

### Choosing a provider endpoint

System One decisions are the same API at different origins, so pointing at another provider needs an endpoint and, usually, a model:

| Provider | `SYSTEMONE_ENDPOINT` | Model |
| --- | --- | --- |
| TypeSafe (default) | `https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` |
| OpenCode Zen | `https://opencode.ai/zen/v1/systemone` | `jev-1.13` |
| Command Code | `https://api.commandcode.ai/provider/v1/systemone` | `typesafe/jev` |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` |

These are example configurations, subject to each provider's current documentation ([OpenCode Zen](https://opencode.ai/docs/zen/), [Command Code](https://commandcode.ai/docs/provider), [OpenRouter](https://openrouter.ai/docs/guides/community/jev), [TypeSafe](https://docs.typesafe.ai/)).

With `SYSTEMONE_ENDPOINT` pointed at OpenRouter, an existing `OPENROUTER_API_KEY` works as the key and the model defaults to `typesafe/jev-1.13`. `OPENROUTER_API_KEY` is never sent to any other endpoint, and `SYSTEMONE_API_KEY` takes precedence over it.

The endpoint must be an absolute `https` URL with a path. A set-but-invalid `SYSTEMONE_ENDPOINT` disables Jev instead of falling back to the default. Treat the endpoint as trusted configuration: it receives the API key and the judgment payload. Credentials are stored per endpoint, so switching endpoints does not overwrite a saved key. Set the model with:

```json
{ "settings": { "jev": { "model": "jev-1.13" } } }
```

The older `TYPESAFE_API_KEY` variable still works for the default TypeSafe endpoint and is never sent to any other endpoint.

Semantic search sends the query text, server names, normalized and original tool names, tool paths, and descriptions to the configured endpoint. It does not send tool results. `allowedServers` restricts semantic search to named servers. `scriptEvaluation` is a separate opt-in that may send the state and MCP-derived results declared in each evaluation; when enabled, it requires an explicit source allowlist.

```json
{
  "settings": {
    "jev": {
      "scriptEvaluation": true,
      "allowedServers": ["github"],
      "maxEvaluationTokensPerScript": 32768
    }
  }
}
```

Request semantic discovery explicitly with `mcp({ search: "triage customer reports", searchMode: "semantic" })` or `tools.search({ query: "triage customer reports", searchMode: "semantic" })`. Regex is incompatible. Timeout, rate-limit, and service failures return marked lexical fallback; credential, policy, configuration, and response failures do not. If no allowed server has cached tools, search explains how to connect a server or update the allowlist; if Jev decides no tool fits, the result says that Jev abstained.

Optional `jev` controls bound timeout/retries, request and script budgets, semantic candidates (at most 127), and minimum probability. The cumulative token budget uses provider-reported input plus output usage. Exact pre-response admission is unavailable without the provider tokenizer, so byte/question/state limits bound requests before dispatch; a response that exceeds the remaining token budget is discarded and exhausts it. The endpoint is set by `SYSTEMONE_ENDPOINT`; headers and SDK logging are not configurable.

`await jev.evaluate({ state, questions, sources })` returns `{ ok, data }` or `{ ok: false, error }`. `sources` must name every MCP server represented in `state`. The host also conservatively taints the whole script with every server-attributed MCP call result or error: declared and observed sources must all be enabled and in `allowedServers`, so copying data or omitting/mislabeling `sources` cannot bypass policy. The taint remains for later direct evaluations and semantic searches even when the script did not retain the call result. Direct and semantic provider attempts share the per-script count, UTF-8 request-byte, token, and deadline budgets; later `tools.call` operations still require normal authentication and approval. See `examples/jev-semantic-filter.mjs` and `examples/jev-accessibility-loop.mjs`.

Semantic search sends your request and the available tool descriptions to Jev, which works out which tools best match what you’re trying to do. In a live test with 12 everyday requests and 95 tools and resources, Jev chose the expected result first in 10 of 11 answerable cases and placed it second once. Regular text search found the expected result first in 5 cases. Jev also correctly returned no result for an unrelated request. This was a small test using one local setup, so results will vary with different tools and queries.

For multi-call MCP work, write ordinary JavaScript: discover, inspect, call, loop, filter, chain, or fan out, then return one result. Run that code with the `mcpScript` tool, which is off by default; set `settings.scriptMode` to `true` to register it and its bundled skill. For a single MCP call, search, describe, status check, or auth action, use `mcp` instead.

The bundled `mcp-scripting` skill is manual-only: use `/skill:mcp-scripting`, or set `settings.scriptSkill` to `"model"` so the `mcpScript` description tells the model where to read it.

For example, this is the JavaScript passed as the `code` argument to `mcpScript`:

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

For tool calls, successful `result.data` is the raw MCP `CallToolResult`, not the domain payload; resource reads return text. Use `result.data.structuredContent` when present. Otherwise most JSON APIs return their payload as text, so parse `result.data.content[0].text`. If neither shape is understood, return the envelope for inspection instead of coercing it to an empty collection.

## Composable tool search

Use JavaScript to filter, sort, or combine search results before describing or calling tools. This adds no model context until a script runs.

```js
const found = await tools.search({ query: "issue", server: "github", limit: 50 });
if (found.error) return found.error;

const readOnly = [];
for (const hit of found.items) {
  const details = await tools.describe({ path: hit.path, server: hit.server });
  if (details.annotations?.readOnlyHint) readOnly.push(hit.path);
}
return readOnly;
```

- `tools.search` runs the same search as `mcp({ search })`: ranked words by default, `regex: true` for a pattern, or `searchMode: "semantic"` for Jev. An empty `query` with a `server` lists that server's tools. Results come one page at a time (`limit` defaults to 12); follow `nextOffset` for the rest.
- Every hit carries its `server`. Pass it on with `tools.describe({ path, server })` and `tools.call(path, args, { server })`, so the script reaches the tool it found even when two servers expose the same name, as with `toolPrefix: "none"`.
- A search that cannot run returns `items: []` with `error: { code, message }`, using the same codes as `mcp({ search })`, such as `empty_query`, `server_disabled`, `server_backoff`, and `invalid_pattern`.
- Annotations are the server's own hints, not guarantees. Script searches never activate `directTools: "search"` tools, and every call still goes through the normal approval gate.

See the bundled `mcp-scripting` skill for the complete workflow guide. The API is `await tools.search({ query, server?, regex?, searchMode?, limit?, offset? })`, `await tools.describe({ path, server? })`, `tools.call(path, args, { server }?)`, direct flat calls, `emit(value)`, and a captured `console`. Use ordinary JavaScript loops and Promise utilities for composition; fluent helpers such as `tools.find(...).one()`, `tools.parallel(...)`, and `tools.retry(...)` are not provided. MCP calls return `{ ok: true, data }` or `{ ok: false, error: { code, message } }`, so a failed call does not stop the rest of the script. Result details include a concise `calls` trace with each operation, its path or query, outcome, and duration. Emitted values and console output appear before the script's final return value, and the combined result uses the normal MCP output guard. The default timeout is 30 seconds; each script runs in a worker thread that is terminated at the deadline, including for infinite loops.

Successful intermediate results reach the script without presentation truncation, details summaries, or output-guard spill files. Each script has a fixed **16 MiB cumulative UTF-8 JSON transfer budget** for successful intermediate data, shared by sequential and parallel calls. A result that cannot fit returns `{ ok: false, error: { code: "intermediate_result_too_large", message } }` and a failed call trace; rejected bytes do not consume the budget, and the script can continue. Request less data or start a new script; there is no configuration option for this cap. Resource calls retain their text-result semantics. Only script-selected output (`emit`, captured console, and `return`) reaches the final output guard; ordinary MCP calls remain guarded as before.

The upstream tool executes before this check and may already have side effects. This is a transfer budget, not a total-memory limit: SDK responses, JSON serialization (including rejected results), copies, concurrent responses, and script-created values still allocate memory. Synchronous serialization can delay deadline handling.

For a tool-restricted subagent, launch the child Pi with its tool allowlist set to `["mcpScript"]`. Have the parent discover MCP tool names with `mcp({ search: "..." })` and include the relevant prefixed names in the child's task; the child can then loop, filter, and chain those MCP calls without filesystem, shell, or edit tools. The adapter's ordinary lazy connection, authentication, abort handling, and approval gates still apply to every call.

`mcpScript` runs in an isolated QuickJS/WASM VM with a 64 MiB memory cap, a 16 MiB serialized output-block budget, and no Node.js, filesystem, network, timer, or process globals. Script error messages are capped at 64 KiB. MCP tool calls can still have external side effects and remain subject to the adapter's normal approval gates. It is distinct from Pi's code-mode skill: Pi's skill batches general Pi tools, while `mcpScript` exposes MCP calls only and can be the child's sole tool.
