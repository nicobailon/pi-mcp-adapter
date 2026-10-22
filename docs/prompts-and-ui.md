# Prompts, elicitation, and MCP UI

Features that go beyond tool calls: server prompt templates, servers asking the user for input, and interactive MCP UI windows.

## MCP Prompts

MCP servers can advertise prompt templates alongside tools and resources. The adapter registers cached prompt definitions as Pi slash commands under `/mcp__<server>__<prompt>`, and refreshes their metadata whenever a server connects. Arguments support positional and `key=value` forms with quoting; required arguments are validated before `prompts/get` is called.

```text
/mcp__agent_board__create_plan "harden retry policy"
/mcp__agent_board__review_pipeline status=paused
/mcp-adapter prompts
```

Prompt results are flattened into one user message, preserving `[user]` and `[assistant]` role markers for multi-message results. Servers without the `prompts` capability are not probed.

## MCP Elicitation

When Pi exposes dialog-capable UI, the adapter advertises form elicitation support. Forms use Pi's stock `select()` and `input()` dialogs, validate the response, and provide a review/edit step before submission. Empty forms use one confirmation dialog. Explicit refusal maps to MCP `decline`; dismissing a dialog maps to `cancel`.

URL mode is advertised only in TUI mode. The adapter displays the requesting server, target host, and full URL, and always requires consent before opening the browser. It also handles URL-required tool errors (`-32042`) and completion notifications; after completing the browser interaction, retry the original tool call.

Time spent answering a server's prompt does not count against its tool calls' `requestTimeoutMs` (or the SDK's 60-second default). The timeout pauses while a prompt from that server is open and resumes with the time that was left. Task-backed calls are unchanged: their timeout applies to each task request, not to the whole task.

### Executor approvals

On its default URL, [Executor](https://executor.sh) pauses a program when an app tool needs your approval or input and hands the pause to the model, which could then approve it without asking you. The adapter answers these pauses itself: it shows Executor's form in Pi's dialogs, sends your answer with Executor's `resume`, and gives the model only the final result. The model never sees the request ID, and the adapter refuses a `resume` call from the model. In a session that can't show dialogs (headless, or `settings.elicitation: false`), the call fails with a message that it needs an interactive Pi session. Executor's `execute` and `call` get a 6-minute timeout, which covers its 5-minute program limit, unless the server entry sets `requestTimeoutMs`. Executor's browser mode, where you answer in the browser, is left alone.

### Executor accounts

When a single Executor `call` fails because no account is linked to the app for you, Pi helps you connect one and runs the call again. The adapter gets Executor's own connection link and shows it with the same browser consent prompt as URL elicitation. The link is never shown to the model. Finish connecting in the browser, then choose Continue in Pi. Pi checks the connection once and retries the call once; if the connection is still pending, the model is told to try the call again. Only a single `call` where nothing has run yet is retried. A batch of calls, `execute`, a headless or non-TUI session, a declined prompt, or an app with more than one missing account all return Executor's own message unchanged. Opening the link is TUI-only, like URL mode above.

## MCP UI Integration

MCP servers can ship interactive UIs via the [MCP UI](https://github.com/MCP-UI-Org/mcp-ui) standard. When you call a tool that has a UI resource, the adapter opens it in a native macOS window via [Glimpse](https://github.com/hazat/glimpse) if available, otherwise falls back to the browser.

**How it works:**

1. Agent calls a tool like `launch_dashboard`
2. The tool's metadata includes `_meta.ui.resourceUri` pointing to a UI resource
3. pi-mcp-adapter fetches the UI HTML and opens it in an iframe
4. The UI can call MCP tools and send messages back to the agent

**Native rendering:** On macOS, if [Glimpse](https://github.com/hazat/glimpse) is installed (`pi install npm:glimpseui`), UIs open in a native WKWebView window instead of a browser tab. Set `MCP_UI_VIEWER=browser` to force the browser, `MCP_UI_VIEWER=glimpse` to require native rendering, `MCP_UI_VIEWER=orca` to open in the [Orca](https://github.com/orca) built-in browser (falls back to the system browser if Orca is unavailable), or `MCP_UI_VIEWER=none` (also accepts `off` / `disabled`) to suppress the window entirely — the tool still runs and its inline result is returned to the agent, but no browser or native window opens. This is useful for headless setups, CI, or users who want the tool output delivered inline as text only. When suppressed, a one-line info notification shows the UI URL so it can still be opened manually if needed.

To turn off UIs for one server only, set `"openUi": false` on its entry. The adapter stops telling that server it supports MCP Apps, so a tool that would hand off to an MCP App form, such as a write tool waiting for you to confirm, runs and returns its result inline instead. No window opens and no UI session starts. Other servers keep opening UIs. This differs from `MCP_UI_VIEWER=none`, which applies to every server and only hides the window: servers still see a UI-capable host and the UI session still starts, so you can open its URL yourself. Changing `openUi` to or from `false` makes the adapter fetch that server's tool list again, because a server may offer different tools to a host without UI.

**Bidirectional communication:** The UI talks back. When it sends a prompt or intent, the message is stored and `triggerTurn()` wakes the agent. The agent retrieves messages via `mcp({ action: "ui-messages" })` and responds, enabling conversational UIs where the app and agent collaborate in real-time.

**Session reuse:** When the agent calls the same tool again while its UI is already open, the adapter pushes the new result to the existing window instead of replacing it. This enables live updates — the agent can refine a chart, add data, or respond to user input without losing the current view. Different tools still replace the session as before.

**Message types from UI:**

| Type | Purpose |
|------|---------|
| `prompt` | User message that triggers an agent response |
| `intent` | Structured action with name + params |
| `notify` | Fire-and-forget notification |
| `message` | Generic message payload |
| (custom) | Any other type forwarded as intent |

**Retrieving UI messages:**

```
mcp({ action: "ui-messages" })
```

Returns accumulated messages from UI sessions. Each message includes `type`, `sessionId`, `serverName`, `toolName`, and `timestamp`. Prompt messages include `prompt`, intent messages include `intent` and `params`.

**Browser controls:**

- **Cmd/Ctrl+Enter** — Complete and close
- **Escape** — Cancel and close
- **Done/Cancel buttons** — Same as keyboard shortcuts

**Technical notes:**

- Tool consent gates whether UIs can call MCP tools (never/once-per-server/always)
- `_meta.ui.visibility` controls audience: tools marked app-only stay out of the model tool list, and tools marked model-only cannot be called from the UI iframe.
- Works with both stdio and HTTP MCP servers
- Uses a local 408KB AppBridge bundle (MCP SDK + Zod) for browser↔server communication
- Enforces CSP from standard `_meta.ui.csp` and OpenAI-compatible `_meta["openai/widgetCSP"]` metadata in the response header while preserving provider HTML.

## Local Example: Interactive Visualizer

A minimal MCP UI example at `examples/interactive-visualizer` demonstrating charts, bidirectional messaging, and streaming. From that directory:

```bash
npm install
npm run build
npm run install-local
```

Restart pi, then ask the agent to show a chart — it calls `show_chart` and opens the UI in Glimpse (macOS) or the browser. Use `npm run uninstall-local` to remove the MCP entry.
