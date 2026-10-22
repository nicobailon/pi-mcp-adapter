# MCP scripting

Semantic tool search with Jev, and scripts that call MCP tools through Pi's `codemode`.

## Jev semantic search

A valid System One key makes semantic search available across every enabled MCP server; it does not run Jev searches automatically. A search uses Jev only when `searchMode: "semantic"` is explicitly requested. Jev ranks matching tools but never executes them. Requests use the pinned model from `settings.jev.model` (`jev-1.13.0` by default) against the endpoint in `SYSTEMONE_ENDPOINT`, which defaults to TypeSafe at `https://api.typesafe.ai/v1/systemone`. Review your provider's current legal terms — for TypeSafe, [legal terms](https://docs.typesafe.ai/legal), including privacy and retention; a no-training commitment does not mean zero retention.

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

`SYSTEMONE_API_KEY` is for CI/headless use and overrides the keyring. Stdio MCP subprocesses inherit the host environment by default, so set `inheritEnv: false` where they must not receive it.

### Choosing a provider endpoint

System One decisions are the same API at different origins, so pointing at another provider needs an endpoint and, usually, a model:

| Provider | `SYSTEMONE_ENDPOINT` | Model |
| --- | --- | --- |
| TypeSafe (default) | `https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` |
| OpenCode Zen | `https://opencode.ai/zen/v1/systemone` | `jev-1.13` |
| Command Code | `https://api.commandcode.ai/provider/v1/systemone` | `typesafe/jev` |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` |
| Local server | `http://127.0.0.1:8080/v1/systemone` | the model your server serves |

These are example configurations, subject to each provider's current documentation ([OpenCode Zen](https://opencode.ai/docs/zen/), [Command Code](https://commandcode.ai/docs/provider), [OpenRouter](https://openrouter.ai/docs/guides/community/jev), [TypeSafe](https://docs.typesafe.ai/)).

With `SYSTEMONE_ENDPOINT` pointed at OpenRouter, an existing `OPENROUTER_API_KEY` works as the key and the model defaults to `typesafe/jev-1.13`. `OPENROUTER_API_KEY` is never sent to any other endpoint, and `SYSTEMONE_API_KEY` takes precedence over it.

The endpoint must be an absolute `https` URL with a path; plain `http` is accepted only on `localhost`, `127.0.0.0/8`, or `[::1]`, so the key and payload never leave the machine unencrypted. A local server that ignores keys still needs some non-empty `SYSTEMONE_API_KEY`, because Jev does not run without a key. A set-but-invalid `SYSTEMONE_ENDPOINT` disables Jev instead of falling back to the default. Treat the endpoint as trusted configuration: it receives the API key and the judgment payload. Credentials are stored per endpoint, so switching endpoints does not overwrite a saved key. Set the model with:

```json
{ "settings": { "jev": { "model": "jev-1.13" } } }
```

The older `TYPESAFE_API_KEY` variable still works for the default TypeSafe endpoint and is never sent to any other endpoint.

Semantic search sends the query text, server names, normalized and original tool names, tool paths, and descriptions to the configured endpoint. It does not send tool results. `allowedServers` restricts semantic search to named servers.

Request semantic discovery explicitly with `mcp({ search: "triage customer reports", searchMode: "semantic" })`. Regex is incompatible. Timeout, rate-limit, and service failures return marked lexical fallback; credential, policy, configuration, and response failures do not. If no allowed server has cached tools, search explains how to connect a server or update the allowlist; if Jev decides no tool fits, the result says that Jev abstained.

Optional `jev` settings bound the timeout and retries, the request size (`maxStateBytes`, `maxQuestionsPerRequest`), the number of semantic candidates (at most 127), and the minimum probability. The endpoint is set by `SYSTEMONE_ENDPOINT`; headers and SDK logging are not configurable.

`allowedServers` only covers the Jev calls the adapter makes, which are semantic searches. A codemode script can pass MCP results to a classifier such as Jev with `models.classify()`. Those calls use Pi's credentials and don't go through the adapter, so `allowedServers` doesn't apply to them.

Semantic search sends your request and the available tool descriptions to Jev, which works out which tools best match what you’re trying to do. In a live test with 12 everyday requests and 95 tools and resources, Jev chose the expected result first in 10 of 11 answerable cases and placed it second once. Regular text search found the expected result first in 5 cases. Jev also correctly returned no result for an unrelated request. This was a small test using one local setup, so results will vary with different tools and queries.

## Scripting MCP calls with Pi's codemode

Pi's `codemode` tool (Pi 0.99 and later) runs a JavaScript script that calls other tools, and only the script's output reaches the model. Use it to loop over, filter, chain, or fan out MCP calls in one step. For a single call, search, describe, status check, or auth action, use `mcp`.

Pi turns `codemode` on by itself only for its built-in MCP servers, and the adapter replaces those, so turn it on yourself. Add it to `defaultTools` in `~/.pi/agent/settings.json` or a project's `.pi/settings.json`:

```json
{ "defaultTools": ["+codemode"] }
```

For one run, use `pi --tools +codemode`. See Pi's [Enable codemode](https://pi.dev/docs/latest/cli#enable-codemode).

Every cached adapter tool is callable from a script as `tools.mcp__<server>__<tool>(args)`. Characters that aren't valid in a JavaScript identifier become `_`, so `mcp__dev-radius__search` is `tools.mcp__dev_radius__search`. A tool with a direct or search-mode registration keeps its own name. [Codemode and tool_search](tools.md#codemode-and-tool_search) explains the names in full.

These tools aren't listed in the `codemode` description, so a script finds them with `searchTools(query, { namespace: "mcp__<server>" })`, reads a tool's TypeScript declaration with `describeTool(name)`, and gets a server's tool names and instructions with `describeNamespace("mcp__<server>")`. `ALL_TOOLS` lists every callable tool. Pi's [codemode docs](https://pi.dev/docs/latest/codemode#globals) describe these globals and the rest of the script API.

A call resolves to the MCP `CallToolResult`: `content`, `structuredContent` when the server sent it, and `isError`. Use `structuredContent` when it's there; otherwise most JSON APIs put their payload in `content[0].text`, so parse it. Text in `content` is bounded by the adapter's [output guard](tools.md#output-guard). A call that fails at the server or is denied by the adapter resolves with `isError: true`, so check it. A call that Pi blocks before it runs, for example through a permission extension, rejects with an `Error`; `Promise.allSettled()` keeps the results of the other calls.

```js
const found = await searchTools("search issues", { namespace: "mcp__github" });
if (!found.some((tool) => tool.name === "mcp__github__search_issues")) return found;

const result = await tools.mcp__github__search_issues({ query: "is:open label:bug" });
if (result.isError) return result.content;
return result.structuredContent ?? JSON.parse(result.content[0].text);
```

Each call from a script is a Pi tool call under the tool's registered name, with the `codemode` call as its parent, so Pi's `tool_call` hooks and permission extensions see it. The adapter's own gates still run once per call: `approveTools` and the approval broker ([Tool approval](tools.md#tool-approval)). A call connects its server first when it isn't connected yet, and on Pi 1.2 and later a script that names a server whose tools aren't registered yet connects that server before it runs.

Scripts run in Pi's QuickJS sandbox, with no file system, network, timers, or Node APIs of their own; they reach the outside world only through tools. Pi's [limits](https://pi.dev/docs/latest/codemode#limits) apply. To classify results, call `models.classify()` with a classifier such as Jev, as described in Pi's [Models](https://pi.dev/docs/latest/codemode#models).

## Moving from the adapter's own script tool

The adapter used to ship its own script tool. It's gone, and Pi's `codemode` replaces it. A config that still sets that tool's settings loads as before and shows a notice that names the file and the keys to remove; then add `"+codemode"` to `defaultTools`. Scripts written for the old tool need small changes: find tools with `searchTools()` and `describeTool()`, call them as `tools.mcp__<server>__<tool>(args)`, read the `CallToolResult` instead of an `{ ok, data }` wrapper, and classify with `models.classify()`.

The recipe for a tool-restricted subagent, a child Pi whose only tool was the old script tool, is gone too. A child with `codemode` can also reach the session's other tools, so there is no MCP-only equivalent.
