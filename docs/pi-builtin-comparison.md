# pi-mcp-adapter vs Pi's built-in MCP

How the adapter differs from the MCP support built into Pi ([Pi's MCP docs](https://pi.dev/docs/latest/mcp)), as of Pi 1.3.0. Both read Pi's `mcp.json` files. On Pi 0.99 and later, installing the adapter replaces the built-in in sessions, except when a host supplies its own config through `createMcpAdapter()`; see [Pi's built-in MCP](configuration.md#pis-built-in-mcp).

## In short

What you get with the adapter:

- **Idle servers cost nothing.** The built-in starts every enabled server in every Pi session and keeps it running until the session ends. By default, the adapter starts a server when the model first calls it and stops it after 10 idle minutes. With 100 servers installed and their tools cached, that's 7.0 GB of server memory against none at session start ([measurements](#measured-with-100-servers)).
- **More servers work fully.** Servers can ask you questions through forms, show interactive UIs, offer prompt templates as slash commands, ask the model for a reply, and run long jobs as MCP Tasks (with `"protocolVersion": "auto"`). The built-in supports none of these.
- **Sign-in tokens go in your OS keychain** by default (an encrypted file is opt-in), not in a plain JSON file.
- **Find tools by what you mean.** The built-in's `tool_search` only matches words. With a System One key, the adapter's semantic search ranks tools by meaning: in a test of 12 everyday requests across 95 tools, it put the right tool first in 10 of 11, where word search did in 5 ([Jev semantic search](scripting.md#jev-semantic-search)).
- **Adding servers is easier.** Give the agent a server's URL and it installs it and checks its tools in the same session, opening sign-in first if the server needs it. Configs from Cursor, Claude Code, Codex, VS Code, and other clients can be imported with `/mcp-adapter setup`, which also adds presets.

What only the built-in has: `codemode` turns on by itself when a server connects. With the adapter, add `"+codemode"` to `defaultTools` in Pi's settings ([MCP scripting](scripting.md#scripting-mcp-calls-with-pis-codemode)). Bulk work across many records also costs less with the built-in: the adapter cost up to 5.5× as much without scripts, where every record passes through the model, and up to 2.9× with `codemode` turned on. Everyday calls cost about the same with both: a single lookup cost 1.8 cents against 2.1 ([measurements](#measured-token-cost)).

Pi's `codemode` scripts work with both. Sign-ins made with the built-in can be imported into the adapter; see [Import a sign-in from Pi's built-in MCP](auth.md#import-a-sign-in-from-pis-built-in-mcp).

## Running servers

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| When servers start and stop | Pi 1.3.0 connects every enabled server in the background when a session starts and keeps it connected until the session ends; there is no idle stop. The first prompt waits up to 10 seconds only for servers with `direct` tools ([Diagnose connection problems](https://pi.dev/docs/latest/mcp#diagnose-connection-problems)). On Pi 0.99.2, with 100 local test servers, all 100 were still running after 15 minutes ([measurements](#measured-with-100-servers)) | Started on first use and stopped after 10 idle minutes (the default). Calls in progress, approvals, and open MCP UI pages keep a server running. When a session starts, servers without cached tools, such as new ones, are started 10 at a time to read their tools, and plain `lazy` servers stop again right after; a server whose discovery failed isn't retried at startup until its command, URL, or another setting that defines it changes. `eager` and `keep-alive` servers start with the session and stay up ([How idle shutdown works](configuration.md#how-idle-shutdown-works), [Lifecycle modes](configuration.md#lifecycle-modes)) |

## Adding and configuring servers

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Add a server | `pi mcp add` and `pi mcp remove` in a shell, then `/reload` in a running session ([Quick setup](https://pi.dev/docs/latest/mcp#quick-setup)) | In a session: give the agent the URL, and `mcp({ action: "install", url })` connects the server and checks its tools without `/reload`. For an OAuth server it first opens the sign-in page, then checks the tools once you approve. Or use `/mcp-adapter setup`. There's no shell command for adding, but servers added with `pi mcp add` are read ([Install from one URL](servers.md#install-from-one-url)) |
| Guided setup | None. `/mcp` inspects servers, signs in, reconnects, changes exposure, and turns configured servers on or off; outside the TUI, `/mcp login`, `/mcp logout`, and `/mcp reconnect` act directly, and `pi mcp login` and `pi mcp logout` work from a shell. New servers are added by hand or with `pi mcp add` ([Inspect or change a server](https://pi.dev/docs/latest/mcp#inspect-or-change-a-server)) | The `/mcp-adapter setup` overlay picks where new servers go, imports configs found on the machine, scaffolds a config, and adds presets: Figma (desktop) when the Figma app is installed, RepoPrompt when its MCP server is installed locally, and GitHub, Notion, Context7, DeepWiki, Parallel Search, Tavily Search, and Chrome DevTools. Every write shows the exact file diff first ([Setup panel](configuration.md#setup-panel)) |
| Configs from other clients | Convert entries by hand ([Migrate configuration](https://pi.dev/docs/latest/mcp#migrate-configuration-from-another-client)) | `imports` reads Cursor, Claude Code, Claude Desktop, OpenCode, VS Code, Windsurf, and Codex configs; `/mcp-adapter setup` and `pi-mcp-adapter init` find them ([Import existing configs](configuration.md#import-existing-configs)) |
| Config files | `~/.pi/agent/mcp.json` and `.pi/mcp.json` ([Configure servers](https://pi.dev/docs/latest/mcp#configure-servers)) | Pi's two files, plus `.mcp.json`, `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, and `mcp-adapter.json` ([File layout](configuration.md#file-layout)) |
| Check servers from a shell | `pi mcp list`, which exits with status 1 when a server fails ([Diagnose connection problems](https://pi.dev/docs/latest/mcp#diagnose-connection-problems)) | `pi-mcp-adapter doctor [--json]`, which exits with status 1 when a server fails or needs sign-in, and never starts OAuth ([Check servers from a shell](configuration.md#check-servers-from-a-shell)) |

## What servers can do

"No" means Pi 1.3.0's MCP client doesn't support it: it declares only the `roots` capability and never lists or fetches prompts.

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Prompts (templates a server offers) | No | Slash commands `/mcp__<server>__<prompt>` ([MCP prompts](prompts-and-ui.md#mcp-prompts)) |
| Elicitation (a server asks you for input) | No | Forms through Pi dialogs, and URL mode in the TUI ([MCP elicitation](prompts-and-ui.md#mcp-elicitation)) |
| Sampling (a server asks the model for a reply) | No | Text only, with a confirmation prompt ([Settings](configuration.md#settings), [Limitations](../README.md#limitations)) |
| Tasks (long-running tool calls) | No | Supported when the server advertises the Tasks extension on an MCP 2026-07-28 connection, which needs `protocolVersion: "auto"` or `"2026-07-28"` ([Task-augmented tool calls](servers.md#task-augmented-tool-calls), [Protocol version negotiation](servers.md#protocol-version-negotiation)) |
| MCP UI (interactive tool pages) | UI resources are left out ([Use resources](https://pi.dev/docs/latest/mcp#use-resources)) | Tool UIs open in a native macOS window or the browser and can call tools ([MCP UI integration](prompts-and-ui.md#mcp-ui-integration)) |
| Resources (data a server exposes) | `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` tools ([Use resources](https://pi.dev/docs/latest/mcp#use-resources)) | Resources exposed as tools, on by default (`exposeResources`) ([Settings](configuration.md#settings)) |
| Roots (the session directory, sent to servers) | Sent | Sent; `"roots": false` turns it off for one server ([Fields](servers.md#fields)) |
| Server log messages | Appended to `~/.pi/agent/mcp.log` | Appended to the same file, in the same format |

## How the model finds and calls tools

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Tool search | `tool_search` finds and loads tools with `deferred` exposure, ranked by words (BM25). A server's `exposure` and per-tool `toolExposure` decide which tools it covers, and a server's `description` helps rank its tools ([Control tool exposure](https://pi.dev/docs/latest/mcp#control-tool-exposure), [Tool search](https://pi.dev/docs/latest/cli#tool-search)) | On Pi 0.99 and later, every cached MCP tool is a Pi deferred tool, so `tool_search` finds them all; tools of servers set to `directTools: "search"` keep their own names. `mcp({ search })` also ranks tools by words or matches them by regex. With a System One API key, `searchMode: "semantic"` has the Jev model rank tools by meaning; it's used only when a search asks for it ([Codemode and tool_search](tools.md#codemode-and-tool_search), [Jev semantic search](scripting.md#jev-semantic-search)) |
| Scripts that call many tools | Pi's `codemode` tool, turned on when a server with the default `codemode` exposure connects; `autoEnableCodemode: false` stops that, and `codemode.mode` decides how other tools are presented. Scripts call MCP tools by name, and any other Pi tool such as `bash` or `read` ([Control tool exposure](https://pi.dev/docs/latest/mcp#control-tool-exposure)) | Pi's `codemode` is the only way to script MCP calls, and it isn't turned on automatically: add `"+codemode"` to `defaultTools` in Pi's settings. On Pi 0.99 and later, scripts call every cached MCP tool by name as `mcp__<server>__<tool>`, direct tools by their own names, and other Pi tools as usual. Pi before 0.99 has no `codemode`, so there are no scripts there ([MCP scripting](scripting.md#scripting-mcp-calls-with-pis-codemode), [Codemode and tool_search](tools.md#codemode-and-tool_search)) |
| Saved workflows as tools | No. A `codemode` script runs once, and the model writes it again each time | `scriptTools` saves a script as a tool with its own name, description and input schema. It runs in Pi's `codemode`, calls MCP and Pi tools, and is found by search and called like any other tool. Pi 0.99.0 or later ([Script tools](scripting.md#script-tools)) |
| Executor app tools | Only the six tools Executor itself lists; the model reaches app tools through Executor's `search` and `call` | On Executor's default URL, each app tool is a Pi deferred tool named `mcp__<server>__<app>_<tool>`, up to 1,000 per Executor server, found by `tool_search` and `mcp({ search })` and called by name with `approveTools` matching its path. Nothing is added to the model's tool list. Pi 0.99.0 or later ([Executor app tools](prompts-and-ui.md#executor-app-tools)) |

## Security

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| OAuth token storage | A JSON file, `~/.pi/agent/mcp-auth.json`, created with mode 0600 ([OAuth](https://pi.dev/docs/latest/mcp#authenticate-with-oauth)) | The OS credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service. No plaintext fallback; an encrypted file store is opt-in ([Token storage](auth.md#token-storage)) |
| Asking before risky tools | Every MCP call goes through Pi's tool pipeline, so permission extensions see each tool and its annotations ([Permissions](https://pi.dev/docs/latest/mcp#permissions)) | `approveTools` asks before matching tools run. On Pi 0.99 and later, calls through `mcp` and `mcp__<server>` and from `codemode` scripts also run as Pi tool calls under the tool's own name, so permission extensions see each tool and its annotations; direct tools are seen under their own names. A call that stays inside the proxy, such as under `MCP_DIRECT_TOOLS=__none__`, is one call to `mcp`, and a call from another extension through the runtime tool-call event reaches no Pi hook; an extension that wants those MCP calls uses the adapter's approval broker event ([Tool approval](tools.md#tool-approval), [Codemode and tool_search](tools.md#codemode-and-tool_search)) |

## Connections

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Transports | stdio and streamable HTTP; SSE is rejected ([Configuration rules](https://pi.dev/docs/latest/mcp#configuration-rules)) | stdio and streamable HTTP, with fallback to legacy SSE, plus an `rmcp-mux` Unix-domain socket ([Fields](servers.md#fields), [rmcp-mux](servers.md#shared-mcp-processes-with-rmcp-mux)) |
| Servers from other extensions | `pi.registerMcpServer()` ([Add servers from extensions](https://pi.dev/docs/latest/mcp#add-servers-from-extensions)) | Connects those servers on Pi 0.99 and later, through the proxy only ([Runtime registration](extension-api.md#runtime-registration-from-other-extensions)) |

## Measured with 100 servers

Measured on Pi 0.99.2. 100 local test servers with 50 tools each, Node 25.2.1, Apple M4 Pro, macOS 15.6. The adapter had cached tools from an earlier session, and 3 servers were used.

| | Pi 0.99.2 built-in | pi-mcp-adapter |
|---|---|---|
| Servers running at session start | 100 | 0 |
| Servers running while 3 are used | 100 | 3 |
| Servers running after the idle timeout | 100 (checked after 15 minutes) | 0 |
| Server memory at session start | 7.0 GB | 0 |
| Server memory after 15 minutes | 5.9 GB | 0 once idle servers stop |

- **First session, no cached tools:** the adapter starts servers 10 at a time to read their tools and stops each one right after. The session was ready in about 2 s with 0 servers running.
- **Starting a stopped server:** a test server took 0.19–0.27 s on its next call. The real `@modelcontextprotocol/server-everything` 2026.8.31 started in 0.11–0.15 s and used about 74 MB.
- **Memory** is the sum of each server process's RSS. Pages shared between processes are counted in each one, so treat it as an estimate; the process counts are exact.
- **Local stdio servers only.** Closing an HTTP or `rmcp-mux` connection doesn't stop the remote service. To share one server process across Pi sessions, use [rmcp-mux](servers.md#shared-mcp-processes-with-rmcp-mux).
- **Not a memory cap.** Calls in progress, approvals, open MCP UI pages, and keep-alive settings keep a server running ([How idle shutdown works](configuration.md#how-idle-shutdown-works)).
- **To reproduce:** `node bench/server-memory.mjs --scenario 1,2,3 --hold-minutes 15`; the comment at its top explains each scenario.

## Measured token cost

Measured on this release's code with Pi 1.3.0, headless (`pi -p`), and two local test servers: an issue tracker (150 issues, 70 pull requests) and a notes service. The model was `claude-sonnet-5` through the pi-claude bridge (`pi-claude/claude-sonnet-5`), with medium thinking. GPT wasn't measured this time. Each task ran 3 times per setup, and every answer was checked against the servers' data and write log. The built-in used its default `codemode` exposure. The adapter used its defaults, and for the bulk tasks also ran with Pi's `codemode` turned on (`-e builtin:codemode --tools +codemode`).

Median cost per run, in US cents:

| Task | Pi's built-in | pi-mcp-adapter | Adapter with `codemode` |
|---|---|---|---|
| Look up one issue's title | 2.1 | 1.8 | |
| Answer a question from the docs | 1.9 | 1.9 | |
| Find 15 old bugs with no linked PR | 5.6 | 7.4 | 5.8 |
| Close and comment on 23 stale issues | 3.9 | 21.5 | 11.0 |
| Copy a 15 KB transcript into a new note | 5.5 | 15.7 | 15.8 |

- **Single calls:** the adapter's default is one JSON call to the `mcp` tool, while the built-in's default writes a script for every call. They cost about the same, though the adapter's fixed part of each turn (system prompt and tool definitions) was larger: about 4,250 tokens against 3,300.
- **Bulk work:** without scripts, every record passes through the model, which costs more. Turning on `codemode` adds about 900 tokens to each turn. It cut the bug search to about the built-in's cost and halved the cost of closing the stale issues, which still cost 2.8× the built-in.
- **Copying the transcript:** with the adapter, Claude read the transcript and wrote the note through the model in all 3 runs, with or without `codemode`, instead of using a script. That's the model's choice, not a limit, and it's why both adapter setups cost about 3× the built-in here.
- **Accuracy:** 39 of 39 runs were correct.
- Costs are computed from token counts at Sonnet prices: $3 per million input tokens, $3.75 for cache writes, $0.30 for cache reads, and $15 for output.
- **To reproduce:** `node bench/token-cost/run.mjs --model claude=pi-claude/claude-sonnet-5 --extension <pi-claude-bridge checkout>`; the comment at the top of `run.mjs` explains the setups, models, and options. Model output varies between runs, so expect medians close to these, not identical.
