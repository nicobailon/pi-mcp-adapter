# Vision

## What pi-mcp-adapter is

pi-mcp-adapter lets Pi use MCP servers without paying for every tool definition in the context window.
It serves a single Pi operator first: one person who wants the useful parts of the MCP ecosystem inside their session without giving up context, speed, or control.
It stays flexible enough for other people, other hosts, and embedding apps, but it does not redesign itself around them.
It owns the bridge between Pi and MCP: config loading, connections and lifecycle, tool discovery and exposure, auth for MCP servers, and delivery of results back to Pi.

## Context is the budget

The adapter exists because MCP tool definitions are expensive.
One small proxy tool, lazy connections, cached metadata, and opt-in direct tools are the core of the product, not optimizations on top of it.
A change that puts more text in front of the model by default needs a clear reason and owner approval.
Anything the model sees on every turn, such as tool names, descriptions, guidance, and status text, is a hot path for tokens.

## The operator decides what runs

MCP servers run code and reach external services in the operator's name.
Servers come from config the operator wrote or approved.
Project config does not start servers until Pi trusts the project and the operator approves them.
Tool calls respect approval settings, and `mcpScript` runs in a sandbox with no file, network, or process access of its own.
When trust, approval, or ownership cannot be proven, the adapter fails closed and says why.

## Standard config first

The adapter reads the standard MCP config files and imports configs from other hosts, so people don't have to redo work they already did.
Adapter-only settings live in the adapter's own file.
A new config key is justified only when the standard format and existing settings cannot express the need.

## Neutral about servers

The adapter is a bridge, not a directory of MCP servers.
It does not favor one vendor's server over another, and it does not grow features for one server.
The `/mcp-adapter setup` presets are a short list of general servers that work without signing up for anything new: no account, or OAuth to an account most developers already have.
A server that needs its own paid API key, or a preset proposed by the vendor that sells the server, does not get a preset.
Any server can still be added as an ordinary config entry, and the README can show how.

## Follow the protocol and the SDK

Protocol behavior comes from the MCP spec and the official SDK.
When the SDK already implements a feature, the adapter uses it instead of reimplementing it.
The adapter adds only what Pi needs on top: exposure, caching, lifecycle, approval, and rendering.

## Compose before inventing

Existing primitives come first.
Before adding anything, name the existing path that produces the same outcome: a config value, a server entry, a command, or a setting that already exists.
If that path exists and costs the operator one ordinary action, the request is already satisfied and the change does not fit.
Convenience alone is not enough; every parallel path adds docs, status text, tests, and a new way for behavior to disagree with configuration.

## Compatibility is explicit

Default to hard cutovers when replacing a tool, option, behavior, or config format.
Do not keep aliases, migration shims, or legacy code paths unless the owner asks for them or the release contract requires them.
When an old path is removed, say so plainly and tell people how to move.
Tests prove the current contract, not removed behavior.

## Scope must earn size

Pull requests should be narrow enough to review with confidence.
A large diff is a warning sign, not proof of rigor.
Changes to startup, the tool surface, persistence, auth, or the sandbox need approval before they spread, and a proposal that touches them without it gets adversarial review and reduction.
Each PR should prove one clear invariant and stop there.

## Performance is a product constraint

Pi startup, every turn's tool surface, and each tool call are hot paths.
Servers should not start, connect, or block a prompt before they are needed.
A change that makes those paths slower needs proof or explicit owner approval.

## What this project refuses

It does not add presets, docs sections, or code paths that promote one vendor's MCP server.
It does not add a preset for a server that needs a new account or paid API key.
It does not add special handling for a single server when a config entry or a server-side fix would do.
It does not become an MCP server registry, marketplace, or installer.
It does not reimplement protocol features the SDK already provides.
It does not start untrusted project servers or widen what a tool call may do beyond the operator's config and approvals.
It does not put more text in the model's context by default without a measured reason.
It does not add a second path to an outcome the operator can already reach with one ordinary action.

## How to judge a change

A change fits when it lets one operator use MCP servers in Pi with the same or lower context cost, and the same or better control and speed.
A change fits when it works the same for any MCP server that follows the spec.
A change fits when no existing config, command, or setting already gives the operator the same outcome, or it shows why that path fails.
A change does not fit when it favors one vendor, adds context or startup cost without proof, weakens trust or approval, or grows the adapter toward a server catalog.
When a proposal is in doubt, ask whether it makes MCP in Pi cheaper, safer, or more reliable for the person whose name it runs under.
