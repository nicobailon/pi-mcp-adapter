# pi-mcp-adapter vs Pi's built-in MCP

How the adapter differs from the MCP support built into Pi ([Pi's MCP docs](https://pi.dev/docs/latest/mcp)), as of Pi 0.99.2. Both read Pi's `mcp.json` files. On Pi 0.99 and later, installing the adapter replaces the built-in in sessions, except when a host supplies its own config through `createMcpAdapter()`; see [Pi's built-in MCP](configuration.md#pis-built-in-mcp).

## In short

What you get with the adapter:

- **Idle servers cost nothing.** The built-in starts every enabled server in every Pi session and keeps it running until the session ends. By default, the adapter starts a server when the model first calls it and stops it after 10 idle minutes. With 100 servers installed and their tools cached, that's 6.5 GiB of server memory against none at session start ([measurements](#measured-with-100-servers)).
- **More servers work fully.** Servers can ask you questions through forms, show interactive UIs, offer prompt templates as slash commands, ask the model for a reply, and run long jobs as MCP Tasks (with `"protocolVersion": "auto"`). The built-in supports none of these.
- **Sign-in tokens go in your OS keychain** by default (an encrypted file is opt-in), not in a plain JSON file.
- **Adding servers is easier.** Give the agent a server's URL and it installs it and checks its tools in the same session, opening sign-in first if the server needs it. Configs from Cursor, Claude Code, Codex, VS Code, and other clients can be imported with `/mcp-adapter setup`, which also adds presets.

What only the built-in has: Pi's permission extensions see each MCP call as its own tool call without changes, and the session directory is sent to servers as a root.

Pi's `codemode` scripts work with both. Sign-ins made with the built-in can be imported into the adapter; see [Import a sign-in from Pi's built-in MCP](auth.md#import-a-sign-in-from-pis-built-in-mcp).

## Running servers

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| When servers start and stop | Pi 0.99.2 connects every enabled server in the background when a session starts and keeps it connected until the session ends; there is no idle stop ([Diagnose connection problems](https://pi.dev/docs/latest/mcp#diagnose-connection-problems)). With 100 local test servers, all 100 were still running after 15 minutes ([measurements](#measured-with-100-servers)) | Started on first use and stopped after 10 idle minutes (the default). Calls in progress, approvals, and open MCP UI pages keep a server running. When a session starts, servers without cached tools, such as new ones, are started 10 at a time to read their tools, and plain `lazy` servers stop again right after; a server whose discovery failed isn't retried at startup until its command, URL, or another setting that defines it changes. `eager` and `keep-alive` servers start with the session and stay up ([How idle shutdown works](configuration.md#how-idle-shutdown-works), [Lifecycle modes](configuration.md#lifecycle-modes)) |

## Adding and configuring servers

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Add a server | `pi mcp add` and `pi mcp remove` in a shell, then `/reload` in a running session ([Quick setup](https://pi.dev/docs/latest/mcp#quick-setup)) | In a session: give the agent the URL, and `mcp({ action: "install", url })` connects the server and checks its tools without `/reload`. For an OAuth server it first opens the sign-in page, then checks the tools once you approve. Or use `/mcp-adapter setup`. There's no shell command for adding, but servers added with `pi mcp add` are read ([Install from one URL](servers.md#install-from-one-url)) |
| Guided setup | None. `/mcp` inspects servers, signs in, reconnects, changes exposure, and turns configured servers on or off; new servers are added by hand or with `pi mcp add` ([Quick setup](https://pi.dev/docs/latest/mcp#quick-setup)) | The `/mcp-adapter setup` overlay picks where new servers go, imports configs found on the machine, scaffolds a config, and adds presets: Figma (desktop) when the Figma app is installed, RepoPrompt when its MCP server is installed locally, and GitHub, Notion, Context7, DeepWiki, Parallel Search, and Chrome DevTools. Every write shows the exact file diff first ([Setup panel](configuration.md#setup-panel)) |
| Configs from other clients | Convert entries by hand ([Migrate configuration](https://pi.dev/docs/latest/mcp#migrate-configuration-from-another-client)) | `imports` reads Cursor, Claude Code, Claude Desktop, OpenCode, VS Code, Windsurf, and Codex configs; `/mcp-adapter setup` and `pi-mcp-adapter init` find them ([Import existing configs](configuration.md#import-existing-configs)) |
| Config files | `~/.pi/agent/mcp.json` and `.pi/mcp.json` ([Configure servers](https://pi.dev/docs/latest/mcp#configure-servers)) | Pi's two files, plus `.mcp.json`, `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, and `mcp-adapter.json` ([File layout](configuration.md#file-layout)) |
| Check servers from a shell | `pi mcp list`, which exits with status 1 when a server fails ([Diagnose connection problems](https://pi.dev/docs/latest/mcp#diagnose-connection-problems)) | `pi-mcp-adapter doctor [--json]`, which exits with status 1 when a server fails or needs sign-in, and never starts OAuth ([Check servers from a shell](configuration.md#check-servers-from-a-shell)) |

## What servers can do

"No" means Pi 0.99.2's MCP client doesn't support it: it declares only the `roots` capability and never lists or fetches prompts.

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Prompts (templates a server offers) | No | Slash commands `/mcp__<server>__<prompt>` ([MCP prompts](prompts-and-ui.md#mcp-prompts)) |
| Elicitation (a server asks you for input) | No | Forms through Pi dialogs, and URL mode in the TUI ([MCP elicitation](prompts-and-ui.md#mcp-elicitation)) |
| Sampling (a server asks the model for a reply) | No | Text only, with a confirmation prompt ([Settings](configuration.md#settings), [Limitations](../README.md#limitations)) |
| Tasks (long-running tool calls) | No | Supported when the server advertises the Tasks extension on an MCP 2026-07-28 connection, which needs `protocolVersion: "auto"` or `"2026-07-28"` ([Task-augmented tool calls](servers.md#task-augmented-tool-calls), [Protocol version negotiation](servers.md#protocol-version-negotiation)) |
| MCP UI (interactive tool pages) | UI resources are left out ([Use resources](https://pi.dev/docs/latest/mcp#use-resources)) | Tool UIs open in a native macOS window or the browser and can call tools ([MCP UI integration](prompts-and-ui.md#mcp-ui-integration)) |
| Resources (data a server exposes) | `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` tools ([Use resources](https://pi.dev/docs/latest/mcp#use-resources)) | Resources exposed as tools, on by default (`exposeResources`) ([Settings](configuration.md#settings)) |
| Roots (the session directory, sent to servers) | Sent | Not declared ([Task-augmented tool calls](servers.md#task-augmented-tool-calls)) |

## How the model finds and calls tools

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Tool search | `tool_search` finds and loads tools with `deferred` exposure, ranked by words (BM25) ([Control tool exposure](https://pi.dev/docs/latest/mcp#control-tool-exposure), [Tool search](https://pi.dev/docs/latest/cli#tool-search)) | On Pi 0.99 and later, tools of servers set to `directTools: "search"` are Pi deferred tools, so `tool_search` finds them. Other tools are found with `mcp({ search })`, ranked by words or matched by regex. With a System One API key, `searchMode: "semantic"` has the Jev model rank tools by meaning; it's used only when a search asks for it ([Search-activated direct tools](tools.md#search-activated-direct-tools), [Jev semantic search](scripting.md#jev-semantic-search-and-opt-in-script-evaluation)) |
| Scripts that call many tools | Pi's `codemode` tool, turned on when a server with the default `codemode` exposure connects. Scripts call MCP tools by name, and any other Pi tool such as `bash` or `read` ([Control tool exposure](https://pi.dev/docs/latest/mcp#control-tool-exposure)) | Pi's `codemode` also works with the adapter, but isn't turned on automatically: add `"+codemode"` to `defaultTools` in Pi's settings. Scripts call the proxy through `tools.mcp(...)`, direct tools by name, and other Pi tools as usual ([Search-activated direct tools](tools.md#search-activated-direct-tools)). The adapter also has its own `mcpScript` tool, off by default (`settings.scriptMode`). It calls MCP tools only, with search, describe, and call across servers, optional Jev semantic search, and a 16 MiB transfer budget per script. It also works on Pi before 0.99, which has no `codemode` ([MCP scripting](scripting.md)) |

## Security

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| OAuth token storage | A JSON file, `~/.pi/agent/mcp-auth.json`, created with mode 0600 ([OAuth](https://pi.dev/docs/latest/mcp#authenticate-with-oauth)) | The OS credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service. No plaintext fallback; an encrypted file store is opt-in ([Token storage](auth.md#token-storage)) |
| Asking before risky tools | Every MCP call goes through Pi's tool pipeline, so permission extensions see each tool and its annotations ([Permissions](https://pi.dev/docs/latest/mcp#permissions)) | `approveTools` asks before matching tools run. Pi permission extensions see proxy calls as calls to the adapter's proxy tools and direct tools under their own names; an extension that wants each MCP call uses the adapter's approval broker event ([Tool approval](tools.md#tool-approval)) |

## Connections

| | Pi's built-in MCP | pi-mcp-adapter |
|---|---|---|
| Transports | stdio and streamable HTTP; SSE is rejected ([Configuration rules](https://pi.dev/docs/latest/mcp#configuration-rules)) | stdio and streamable HTTP, with fallback to legacy SSE, plus an `rmcp-mux` Unix-domain socket ([Fields](servers.md#fields), [rmcp-mux](servers.md#shared-mcp-processes-with-rmcp-mux)) |
| Servers from other extensions | `pi.registerMcpServer()` ([Add servers from extensions](https://pi.dev/docs/latest/mcp#add-servers-from-extensions)) | Connects those servers on Pi 0.99 and later, through the proxy only ([Runtime registration](extension-api.md#runtime-registration-from-other-extensions)) |

## Measured with 100 servers

100 local test servers with 50 tools each, Pi 0.99.2, Node 25.2.1, Apple M4 Pro, macOS 15.6. The adapter had cached tools from an earlier session, and 3 servers were used.

| | Pi 0.99.2 built-in | pi-mcp-adapter |
|---|---|---|
| Servers running at session start | 100 | 0 |
| Servers running while 3 are used | 100 | 3 |
| Servers running after the idle timeout | 100 (checked after 15 minutes) | 0 |
| Server memory at session start | 6.5 GiB | 0 |
| Server memory after 15 minutes | 5.5 GiB | 0 once idle servers stop |

- **First session, no cached tools:** the adapter starts servers 10 at a time to read their tools and stops each one right after. The session was ready in about 2 s with 0 servers running.
- **Starting a stopped server:** a test server took 0.19–0.27 s on its next call. The real `@modelcontextprotocol/server-everything` 2026.8.31 started in 0.11–0.15 s and used 70 MiB.
- **Memory** is the sum of each server process's RSS. Pages shared between processes are counted in each one, so treat it as an estimate; the process counts are exact.
- **Local stdio servers only.** Closing an HTTP or `rmcp-mux` connection doesn't stop the remote service. To share one server process across Pi sessions, use [rmcp-mux](servers.md#shared-mcp-processes-with-rmcp-mux).
- **Not a memory cap.** Calls in progress, approvals, open MCP UI pages, and keep-alive settings keep a server running ([How idle shutdown works](configuration.md#how-idle-shutdown-works)).
- **To reproduce:** `node bench/server-memory.mjs --scenario 1,2,3 --hold-minutes 15`; the comment at its top explains each scenario.
