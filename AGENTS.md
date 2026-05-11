# AGENTS.md · pi-mcp-adapter (Tutoria fork)

## What this repo is

This is Tutoria's fork of `pi-mcp-adapter`, package version `2.5.4-tutoria.1`. It lets Pi use MCP servers without loading every MCP tool definition into context: servers are discovered and connected on demand, with optional direct-tool registration for selected tools.

Tutoria-specific fork invariant: preserve the `routeViaSubagent` behavior in the adapter path; do not regress upstream-compatible MCP behavior while maintaining that flag.

## Where to read

- `README.md` — user-facing behavior, config precedence, lifecycle modes, OAuth, direct tools, proxy usage.
- `package.json` — package version, Pi compatibility, scripts, and published `files` manifest.
- `index.ts` — Pi extension entrypoint, tool/command registration, session lifecycle, direct-tool bootstrap.
- `config.ts` — MCP config loading, merge order, env interpolation, and server option parsing.
- `server-manager.ts` and `lifecycle.ts` — lazy/eager/keep-alive server startup, shutdown, and idle behavior.
- `proxy-modes.ts` — proxy tool modes: status/list/search/describe/connect/tool/ui-messages.
- `direct-tools.ts` and `tool-registrar.ts` — direct MCP tool exposure and registration semantics.
- `subagent-dispatch.ts` — Tutoria subagent routing behavior.
- `mcp-auth.ts`, `mcp-auth-flow.ts`, `mcp-oauth-provider.ts`, `mcp-callback-server.ts`, `oauth-handler.ts` — bearer/OAuth/client-credentials auth flows.
- `sampling-handler.ts` and `consent-manager.ts` — sampling approval and consent behavior.
- `metadata-cache.ts` and `tool-metadata.ts` — cached tool metadata for discovery without live server startup.

## Commands

```bash
npm test                    # run Vitest test suite
npm run test:watch          # run Vitest in watch mode
npm run test:coverage       # run Vitest with coverage
npm run test:oauth-provider # run OAuth provider node test
```

## Validation

- After any context-only edit in this repo, run `npm test` when dependencies are available.
- After behavior changes, add or update focused tests near the touched subsystem and run the relevant script above.
- Keep package compatibility aligned with Pi `0.74.x` dependencies declared in `package.json`.

## Safety rules

- Preserve lazy MCP lifecycle: servers must not connect until needed unless configured as `eager` or `keep-alive`.
- Preserve config precedence documented in `README.md`: `~/.config/mcp/mcp.json`, Pi global override, `.mcp.json`, then `.pi/mcp.json`.
- Preserve the proxy tool contract: `mcp({ tool, args })` expects `args` as a JSON string, not an object.
- Preserve direct-tools semantics: `directTools` may be `true`, a string list, or `false`/omitted, and must not force unwanted tool bloat.
- Preserve OAuth, bearer, and client-credentials flows; do not make interactive OAuth mandatory for machine auth.
- Preserve sampling approval behavior; do not silently bypass consent unless `samplingAutoApprove` or equivalent explicit config allows it.
- Preserve metadata-cache discovery so search/describe can work without live server connections.
- Preserve the `package.json` `files` manifest when adding runtime files, or packaged installs will miss them.
- Do not deploy, publish, push, or tag from this repo unless explicitly requested.
