# MCP scripting

Semantic tool search with Jev, scripts that call MCP tools through Pi's `codemode`, and script tools that save a script as a tool.

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

A call resolves to the MCP `CallToolResult`: `content`, `structuredContent` when the server sent it, and `isError`. Use `structuredContent` when it's there; otherwise most JSON APIs put their payload in `content[0].text`, so parse it. Results returned to a script are not truncated by the adapter's [output guard](tools.md#output-guard); Pi limits what the script returns to the model, to 10,000 tokens by default (`max_output_tokens`), and saves longer output to a temp file. A call that fails at the server or is denied by the adapter resolves with `isError: true`, so check it. A call that Pi blocks before it runs, for example through a permission extension, rejects with an `Error`; `Promise.allSettled()` keeps the results of the other calls.

```js
const found = await searchTools("search issues", { namespace: "mcp__github" });
if (!found.some((tool) => tool.name === "mcp__github__search_issues")) return found;

const result = await tools.mcp__github__search_issues({ query: "is:open label:bug" });
if (result.isError) return result.content;
return result.structuredContent ?? JSON.parse(result.content[0].text);
```

Each call from a script is a Pi tool call under the tool's registered name, with the `codemode` call as its parent, so Pi's `tool_call` hooks and permission extensions see it. The adapter's own gates still run once per call: `approveTools` and the approval broker ([Tool approval](tools.md#tool-approval)). A call connects its server first when it isn't connected yet, and on Pi 1.2 and later a script that names a server whose tools aren't registered yet connects that server before it runs.

Scripts run in Pi's QuickJS sandbox, with no file system, network, timers, or Node APIs of their own; they reach the outside world only through tools. Pi's [limits](https://pi.dev/docs/latest/codemode#limits) apply. To classify results, call `models.classify()` with a classifier such as Jev, as described in Pi's [Models](https://pi.dev/docs/latest/codemode#models).

## Script tools

A workflow you repeat, such as checking a repository for stale issues, can be saved as a script tool: a codemode script with a name, a description and fixed inputs. The model calls it like any other tool instead of writing the script again, a subagent can be limited to it by name, and a permission extension can match that name. Script tools need Pi 0.99.0 or later; on older Pi none are loaded, and a warning says so. You don't need to turn `codemode` on for the model to use them.

Add a `scriptTools` object to an adapter config file, such as `~/.pi/agent/mcp-adapter.json`:

```json
{
  "scriptTools": {
    "stale_issues": {
      "description": "List a repository's open issues with no activity for the given number of days",
      "file": "scripts/stale-issues.js",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repo": { "type": "string", "description": "owner/name" },
          "days": { "type": "number" }
        },
        "required": ["repo", "days"]
      }
    }
  }
}
```

A relative `file` is relative to the folder of the config file that sets it, so this one is `~/.pi/agent/scripts/stale-issues.js`. [Script tools](configuration.md#script-tools) in the configuration docs lists every field. The adapter reads the file on every call, so an edit applies to the next call without `/reload`. A file that is missing, empty or larger than 1 MiB isn't run.

The file is an ordinary codemode script, as described above. The call's arguments are in `input`, after Pi checks them against `inputSchema`; a tool without `inputSchema` takes no arguments and gets `{}`. What the script returns is the tool's result, and it goes through the [output guard](tools.md#output-guard) like any MCP result that goes to the model.

```js
const since = new Date(Date.now() - input.days * 86_400_000).toISOString().slice(0, 10);
const result = await tools.mcp__github__search_issues({ query: `repo:${input.repo} is:issue is:open updated:<${since}` });
if (result.isError) return result.content;
return result.structuredContent ?? JSON.parse(result.content[0].text);
```

The adapter defines `input` by adding one line to the start of the script. A `// @options:` line stays first, so a script tool can still set its own limits there. Because of the added line, line numbers in a script's errors are one higher than in the file. Pi's `codemode.mode` and `codemode.inlineBudget` settings change how Pi offers `codemode` to the model; they don't affect script tools. Like any codemode script, a script tool can call `models.classify()` and `models.generateImages()`, which use the session's credentials and are billed to the session.

A script tool is a Pi tool named `mcp__script__<name>`, so the one above is `mcp__script__stale_issues`. Like the adapter's other MCP tools, it isn't in the model's tool list: `mcp({ search })`, `tool_search` and codemode's `searchTools()` find it, and `mcp({ tool: "stale_issues", args })` calls it. In `mcp({ search })`, word and regex search find script tools, and semantic search ranks MCP tools only. Set `"declare": true` to put it in the model's tool list from the start instead, which adds its description and schema to every turn. When a script tool has the same name as an MCP tool, `mcp({ tool })` runs the script tool, and its result says how to call the MCP tool with `mcp({ tool, server })`. An MCP server named `script` shares the `mcp__script` namespace, so codemode's `searchTools()` and `describeNamespace("mcp__script")` list its tools together with the script tools; all of them stay callable. Under `MCP_DIRECT_TOOLS=__none__` no script tool is registered, but `mcp` still finds and runs them.

A script tool can't run inside another script, including a `codemode` script the model wrote, because Pi doesn't let a script start a second one. Such a call returns `Script tool "<name>" cannot run inside another script. Pi does not let a codemode script start another script, so call this tool directly.` Call it directly or through `mcp({ tool })`.

Each tool call inside a script tool is a nested Pi tool call under the script tool, so Pi's `tool_call` hooks, permission extensions and `approveTools` each see it once. `approveTools` matches the MCP calls inside a script tool, never the script tool itself; a permission extension can match the script tool as `mcp__script__<name>`. When `mcp` runs the script itself, under `MCP_DIRECT_TOOLS=__none__` or once `freezeDirectTools` has frozen the tool surface, the MCP results the script gets go through the output guard, so a large result reaches the script cut short.

Script tools set in a project file, such as `.pi/mcp-adapter.json`, follow the [project server trust](configuration.md#project-server-trust) rules. They load only when Pi trusts the project, and Pi asks when the session starts, showing the config file and the script's path; the prompt starts on "Don't allow". In print, JSON and RPC sessions they are skipped unless `"projectServers": "allow"` or `--mcp-project-servers allow` is set, which admits project script tools as well as project servers. The approval covers the entry as configured, not the script file's contents, so the file can change without Pi asking again. A relative `file` resolves to a different path in each git worktree, so each worktree asks once. When a project entry that isn't approved has the same name as a global script tool, neither is loaded.

An invalid entry, a name another tool already has, and a project entry that isn't approved each show a warning once per session and are listed in `/mcp-adapter`. When a script tool can't run, its result says why, and `details.error` names the reason: `script_file_missing`, `script_file_unreadable`, `script_file_empty`, `script_file_too_large`, `nested_script_tool`, or `codemode_unavailable` when the Pi build doesn't let extensions run codemode. Through `mcp`, a call that Pi blocks or rejects before the script runs, for example in a `tool_call` hook, returns `nested_call_failed`. A script that throws returns codemode's own error output.

### Saving a script as a tool

When the model has written a script worth keeping, it can save it as a script tool with `mcp({ action: "save-script", args: { name, description, code, inputSchema } })`. `name`, `description` and `inputSchema` are the entry's fields described above, and `code` is the script. `target` is `"global"`, the default, or `"project"`, and can go in `args` or next to `action`. Any other key in `args` is refused, `declare` included.

Pi asks you twice before anything is written. The first dialog is a summary: the tool name, the script file and the config file, each marked new or replaced, a diff of the config change, and a diff of the script when the save replaces one. It also says when the name already runs a script from another config file, which the new entry replaces, and when the config file's comments and formatting will be rewritten. The diffs show the changed lines with three lines around them, up to 60 lines and 8 KB each. A diff too large to work out, such as between two long scripts, is replaced by a line that says so, and you read the new script in the editor. The dialog starts on "Don't save", so a stray Enter writes nothing. If you choose "Review the script", the whole script opens in Pi's editor. You can change it there, and what you save is what gets written; the result tells the model when you edited it. Escape writes nothing.

`target: "global"` writes the script to `~/.pi/agent/mcp-scripts/<name>.js` and the entry to `~/.pi/agent/mcp-adapter.json`. With `--mcp-config`, the entry goes to that file and the script to an `mcp-scripts` folder beside it. `target: "project"` writes `.pi/mcp-scripts/<name>.js` and `.pi/mcp-adapter.json`. If `mcp-scripts` is a link, for example into a dotfiles repository, the summary also names the folder the script is written to. The entry's `file` is `mcp-scripts/<name>.js`, relative to the config file, so a project save works in every git worktree. A save never sets `declare`, so a saved tool adds nothing to the model's prompt. If the config write fails, the save removes the script file it wrote, or restores the one it replaced.

The saved tool works right away as `mcp__script__<name>`, without `/reload`. Once `freezeDirectTools` has frozen the tool surface, it works after `/reload`. Under `MCP_DIRECT_TOOLS=__none__`, call it with `mcp({ tool: "<name>", args })`. If the tool list can't be refreshed after the files are written, the save still succeeds, and the result says the tool works after `/reload`.

Some saves are refused before Pi asks anything. Saving needs an interactive terminal session, so print, JSON and RPC sessions and subagents are refused, and it can't be requested from inside another tool, such as a `codemode` script. It needs Pi 0.99.0 or later. A name another tool already has is refused, and so is a global save of a name a project config file defines, because the project entry would win. A project save needs project trust, and `PI_MCP_CONFIG_MODE=exclusive` refuses it. When you approve a project save, the adapter records the approval, so the next session doesn't ask again; as for any project script tool, the approval doesn't cover later edits to the script file.

If the script file or its config entry changed after you approved the save, nothing is written. A refused save returns a message and a `details.error` code. That case, a config file that can't be read, a script path that isn't a regular file, an existing script file larger than 1 MiB, an `mcp-scripts` that isn't a folder, and a failed write return `script_save_failed`, which is reported as an error. Other refusals, such as `declined`, `headless` or `name_unavailable`, are plain results. Set `settings.allowScriptToolSave` to `false` to refuse every save; that also removes the action's line from the `mcp` tool description.

## Moving from the adapter's own script tool

The adapter used to ship its own script tool. It's gone, and Pi's `codemode` replaces it. A config that still sets that tool's settings loads as before and shows a notice that names the file and the keys to remove; then add `"+codemode"` to `defaultTools`. Scripts written for the old tool need small changes: find tools with `searchTools()` and `describeTool()`, call them as `tools.mcp__<server>__<tool>(args)`, read the `CallToolResult` instead of an `{ ok, data }` wrapper, and classify with `models.classify()`.

The recipe for a tool-restricted subagent, a child Pi whose only tool was the old script tool, is gone too. A child with `codemode` can also reach the session's other tools, so there is no MCP-only equivalent.
