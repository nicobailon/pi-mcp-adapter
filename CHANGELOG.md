# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Refined MCP elicitation and sampling handler TypeScript contracts without changing runtime behavior.

### Fixed
- Rendered closed JSON Schema object shapes that use `additionalProperties: false`. Thanks @giuseppecrj for PR #313.
- Restored MCP sampling builds with current Pi AI releases by using its compatibility entry point. Thanks @eric-kansas for issue #308.
- Simplified empty MCP form elicitation to one confirmation dialog. Thanks @shardulbee for issue #309.

## [2.21.0] - 2026-08-06

### Added
- Added MCP 2026-07-28 endpoint probing and defaulted curated remote setup presets to automatic protocol negotiation for stateless MCP servers.
- Added `resolveServerFromToolName` so permission brokers can map prefixed MCP tool names back to their owning server. Thanks @jagaliano for PR #295.
- Added per-server `oauth.skipIssuerMetadataValidation` for known-misconfigured OAuth servers. Thanks @embik for issue #297.
- Added a configurable `mcp.panel.save` keybinding for the MCP panel Save action. Thanks @tim-hilde for issue #299.
- Added `settings.agentPluginPaths` to load MCP servers from Agent Plugins 1.0 packages.

### Changed
- Refined MCP endpoint probing internals with typed strategies while preserving request order, fallback behavior, and diagnostics.

### Fixed
- Rejected Agent Plugin command paths that escape the plugin directory and skipped normalized server-name collisions instead of overwriting servers.
- Stopped `/mcp` from inspecting host-specific config files when host config discovery is disabled. Thanks @rtfmkiesel for issue #292.
- Stopped optional numeric `mcp` and `mcpScript` tool parameters from leaking TypeBox internal markers into serialized schemas. Thanks @RainbowXie for issue #289 and PR #290.
- Forwarded RFC 9207 OAuth callback issuers to the MCP SDK during manual authorization completion. Thanks @tkoenig for issue #293 and PR #294, and @ugur-murat-alt for independent live verification.
- Kept `mcpScript` `tools.describe()` from omitting parameter information when TypeScript shape rendering falls back. Thanks @sheurich for issue #288.
- Reduced repeated collapsed MCP result rendering allocation after large or truncated tool outputs. Thanks @cp-yu for issue #291.

## [2.20.1] - 2026-08-04

### Fixed
- Stopped server-side MCP app helper imports from requiring the legacy `@modelcontextprotocol/sdk` peer at extension load time, fixing peerless Pi installs of 2.20.0. Thanks @aryzing for issue #285 and @DevDominic, @Shinkicast, and @marceloid for confirmations.

## [2.20.0] - 2026-08-04

### Added
- Added an MCP tool approval broker event so permission extensions can allow, deny, or abstain on proxy, direct, `mcpScript`, resource, and iframe-originated MCP calls before the built-in `approveTools` prompt runs. Thanks @geshido for issue #279.
- Added opt-in per-server MCP protocol selection with `protocolVersion: "legacy" | "auto" | "2026-07-28"`. Legacy remains the default; auto negotiates the modern era with conservative legacy fallback, while the pinned mode fails instead of falling back. Thanks @mjfaga for PR #272.
- Added a strict TypeScript typecheck command and CI gate.

### Changed
- Migrated the MCP client from the monolithic SDK v1 package to the stable modular `@modelcontextprotocol/client` and `@modelcontextprotocol/core` v2 packages. The stable release restores conservative legacy discovery fallback and declared JSON Schema dialect support while retaining strict OAuth issuer validation.

### Fixed
- Renamed the MCP scripting tool to camel-case `mcpScript` because Anthropic rejects the previous underscore-form name. Thanks @ritvij14 for issue #278 and @wierdbytes for confirmation and the workaround.
- Pinned the Chrome DevTools setup preset and README examples to `chrome-devtools-mcp@1.6.0` instead of `@latest`, so reviewed scaffolded commands stay stable. Thanks @fitchmultz for issue #274.
- Removed the adapter's throwaway Streamable HTTP initialize probe. HTTP connections now initialize once on the real client and use narrowly classified SSE fallback, avoiding duplicate sessions and preventing authentication, cancellation, timeout, negotiation, and server failures from being misclassified as transport incompatibility.
- Stopped tokenless discovery requests, sandboxed MCP app documents, unrelated child windows, and app-opened popups from gaining session authority; discovery now serves a non-sensitive landing page, app HTML loads with a separate resource-only token, host messages accept only the app frame as their source, and the app response enforces sandboxing even when opened as a top-level page.

## [2.19.0] - 2026-08-03

### Added
- `mcp_script` now records each search, describe, and call with its input, outcome, and duration in result details; emitted, returned, and console values retain readable Maps, Sets, cycles, functions, symbols, and BigInts. Its docs now lead with the plain JavaScript agents write and position it as the primary MCP multi-call workflow surface.
- Documented how to hide the bundled `mcp-scripting` Pi skill while keeping the adapter extension installed. Thanks @aryzing for issue #267.
- Documented Linux revoked-keyring recovery in the OAuth guide and `_meta.ui.visibility` behavior in the MCP UI guide.

### Changed
- `mcp_script` is now registered by default for trusted JavaScript MCP multi-call workflows, while `mcp` remains the right tool for status, discovery, auth, and single calls. Set `settings.scriptMode` to `false` to hide the tool.

### Fixed
- `mcp_script` traces now include missing describe attempts, and shared acyclic values no longer render as circular in script output formatting.

## [2.18.0] - 2026-08-02

### Added
- Added `settings.freezeDirectTools` to keep direct MCP tool registration stable after initial sync while preserving explicit reconnect refreshes. Thanks @ddfourtwo for PR #254.
- Added best-effort Linux OAuth credential recovery when Pi inherits a revoked session keyring, allowing explicit re-authentication through a fresh `keyctl` session helper. Thanks @anthod0 for issue #248 and the validation prototype.
- Ranked, paginated MCP tool search: best matches come first in a short page of 12 instead of an unranked dump of every match with full schemas, so the model stops guessing and each search costs a fraction of the tokens. Misses on describe/call now return top-5 "Did you mean" suggestions, letting the model self-correct a typo or missing prefix in the same turn instead of burning a round trip.
- Optional `approveTools` patterns (global and per-server) add the missing middle tier between "tool runs instantly" and "tool hidden entirely": flag risky tools and Pi asks before running them — Allow once / Allow for session / Deny — across proxy, direct, resource, and iframe-originated calls. Safe tools keep full speed; a deny is a normal result the model adapts to, not a crash.
- Opt-in `mcp_script` trusted JavaScript MCP scripting turns N-step jobs into one call: loop, filter, and chain tools for tool-restricted subagents where every round trip costs child context. Scripts discover tools with `await tools.search({ query })`, inspect exact shapes with `await tools.describe({ path })`, and call them with `tools.call(path, args)` — no more guessing names from outside the script. A runaway script can never freeze Pi itself: scripts run isolated from the main process and are force-stopped at their time limit, even if stuck in an infinite loop. Result details include a `calls` trace of every invoked path and outcome, and a bundled `mcp-scripting` skill teaches the full workflow on demand. Every scripted call still goes through auth, output guarding, and the approval gate.
- HTTP connection failures are now probe-classified into a plain-language diagnosis (for example "endpoint returned HTML (200) — this URL does not appear to speak MCP") instead of an opaque "fetch failed", so setup mistakes are fixed in seconds. Healthy connections are never probed.
- Tool parameters render as compact TypeScript shapes (`{ query: string; limit?: number }`) in describe and search, replacing multi-line schema dumps — the model reads less and acts sooner, with the previous formatting kept as a fallback for exotic schemas.
- `/mcp setup` gained curated one-click presets (DeepWiki, Context7, Notion, GitHub, Chrome DevTools): pick, preview the exact config write, confirm — new servers in under a minute with no hand-typed setup.

The ranked search scoring, did-you-mean suggestions, approval patterns, endpoint shape probe, TypeScript-shaped schemas, and codemode design in this release are adapted from [Executor](https://github.com/UsefulSoftwareCo/executor) by Rhys Sullivan (@RhysSullivan). Thanks Rhys.

### Fixed
- Brought MCP Apps UI hosting in line with the current spec: provider HTML now runs in a real sandbox, gets a restrictive default CSP even when the resource omits one, and `_meta.ui.visibility` is honored so app-only tools stay out of the model tool list while model-only tools cannot be called from the UI.
- MCP Apps UI sessions are now easier to open from Moshi and remote terminals: the local UI server uses Moshi-discoverable low ports, answers preview discovery probes, serves a loopback-only landing shell, prints Moshi/SSH access hints for remote sessions, and fits the host shell better in narrow in-app browsers. UI-submitted model context is now captured as a bounded handoff, wakes the agent like prompts and intents, and remains available through `mcp({ action: "ui-messages" })` after the UI closes.

## [2.17.0] - 2026-07-31

### Added
- Added `settings.mcpFooterStatus` to compact or hide the persistent MCP footer status. Thanks @jwintz for issue #5.
- Added per-server OAuth `authorizationParams` for provider-specific authorization URL parameters such as Google's `access_type=offline`, while rejecting OAuth flow-owned parameter overrides. Thanks @hank-warren for issue #238.

### Fixed
- Added a best-effort absolute-path fallback for loading the `@napi-rs/keyring` native binding when compiled Pi/Bun cannot resolve the package loader. Thanks @sgiath for issue #230.
- Bound collapsed MCP tool result rendering by character count as well as line count, preventing huge single-line results from slowing long TUI sessions. Thanks @Whisperfall for issue #249.
- Let configured `oauth.scope` override OAuth discovery scopes during authorization flows. Thanks @viggy28 for issue #225 and @adity982 for PR #226.

## [2.16.0] - 2026-07-30

### Added
- Added an optional per-server `toolPrefix` override for direct MCP tools, prompts, and proxy summaries, falling back to the global prefix when unset. Thanks @FurryWolfX for issue #229.
- Added an advisory warning when resolved direct tools pass the documented 75-tool threshold, with no cap or enforcement. Thanks @JasonLandbridge for issue #240.

### Changed
- Restored the MCP SDK v1 client for compatibility with deployed MCP servers and OAuth providers. This rollback temporarily removes SDK v2-only protocol negotiation while retaining OAuth issuer binding and callback issuer validation. Thanks @hyknerf for PR #237 and issue #236, @leonfox28 for issue #227, and @JorelLatraille for issue #241.

### Fixed
- Avoided a double-close race when disconnecting MCP connections by letting the SDK client own transport shutdown. Thanks Szymon Wiszczuk (@golota60) for PR #235.
- Prevented `/mcp` and `/mcp-auth` from crashing when the OS OAuth credential store is unavailable.
- Stored oversized OAuth credential payloads as secure-store manifests plus chunks, so Windows Credential Manager value limits no longer block OAuth completion for large token records. Thanks @LysanderdeJong for issue #223.
- Stored OAuth credential payloads as compact JSON, so multiline secrets no longer corrupt gnome-keyring plaintext keyrings. Thanks @hank-warren for issue #239.
- Kept collapsed MCP tool results from re-wrapping full multi-10KB payloads on repeated TUI renders, avoiding composer keystroke lag after large MCP dumps. Thanks @hyknerf for PR #233 and @chapmanb for the held-Text follow-up fix.

## [2.15.0] - 2026-07-25

### Added
- Added native `rmcp-mux` Unix-socket connections for explicitly sharing external MCP server processes across Pi sessions. Thanks j0e1 (@pWoLiAn) for issue #76.
- Added connection-time command resolution for HTTP bearer tokens and headers, OAuth client secrets, and stdio environment values, with `!!` escaping and fail-closed execution. Thanks @estrizhok for issue #221.

### Fixed
- Treated null optional server URLs as absent and cleaned unpublished runtimes after initialization failures, preventing `not_initialized` sessions with surviving MCP children. Thanks @autopeasant for the diagnosis in issue #222.
- Registered env-selected direct MCP tools before child `agent_start` when their metadata cache must be populated first. Thanks @peedrr for the original report in pi-subagents issue #638 and issue #219.

## [2.14.0] - 2026-07-25

### Added
- Added the global `settings.showStatusIcon` opt-out for plain `MCP: ...` status and connection text while keeping the plug icon enabled by default. Thanks @vaultboy001 for issue #216.

### Fixed
- Deferred implicit OAuth credential-store access until an HTTP server actually challenges for authentication, so unauthenticated remote Streamable HTTP servers work in headless environments. Thanks @vdom-1 for issue #218.
- Accepted draft-07 tool output schemas alongside JSON Schema 2020-12 while preserving structured-content validation. Thanks Daniel Marbach (@danielmarbach) for issue #217.

## [2.13.0] - 2026-07-25

### Added
- Added a versioned, sanitized MCP runtime status snapshot on Pi's shared event bus for extensions, without connecting lazy servers or exposing SDK internals. Thanks Ludev (@ludevdot) for issue #110.
- Added opt-in host-specific MCP config discovery with source/provenance and conflict reporting. Standard shared and Pi-owned config precedence remains unchanged, and external host files are never written or silently executed. Thanks @lsmir2 for issue #169.
- Added opt-in metadata-only JSONL MCP protocol tracing with bounded per-session files and redaction. Thanks @66-firebat for issue #45.
- Added per-server `includeTools` allowlists with exact-name and glob matching for proxy, direct-tool, and `/mcp` panel surfaces. Thanks Finn (@finnvyrn) for issue #136.
- Made `mcp({ connect: "server" })` refresh an already connected server instead of reusing stale tool metadata. Thanks Sebastiano Poggi (@rock3r) for issue #28 and @theflysurfer for the refresh analysis.
- Added a plug icon prefix to MCP footer status text. Thanks Felipe Cadal (@cadal-cw) for issue #145.
- Discovered user-global MCP configs from `~/.agents/mcp.json` and `~/.agents/mcp/mcp.json`. Thanks David Jadczyk (@davidjadczyk) for issue #117.
- Accepted JSONC-style comments and trailing commas in MCP JSON config files. Thanks @GoCoder7 for issue #124.

### Changed
- Measured and spilled oversized raw MCP result details as compact JSON instead of pretty-printed JSON, reducing hot-path allocation and event-loop work. Thanks José Maia (@glitch-ux) for issue #214 and PR #215.
- Renamed generated MCP resource tools from `get_<resource>` to `read_<resource>` to match the MCP `resources/read` operation. Thanks @vdom-1 for issue #185.

### Security
- Moved persistent OAuth credentials from plaintext `tokens.json` files into the operating system credential store, with one-way legacy import and fail-closed behavior when secure storage is unavailable. Thanks Sam Atkins (@atkinsam) for issue #180.

### Fixed
- Skipped `resources/list` for MCP servers that do not advertise the `resources` capability, matching the existing prompt discovery gate and silencing the SDK v2 debug line that tools-only servers printed on every connect. Thanks Aleksandr Davydenko (@kotuke) for PR #213.
- Made the MCP footer show enabled configured servers as the primary count, with active connections as secondary state, so lazy servers no longer look broken before first use or after idle shutdown. Thanks blumlaut (@Blumlaut) for issue #93.
- Show the actual proxied MCP server/tool name in `mcp` tool results. Thanks Finn (@finnvyrn) and @dillontkh for issue #68.
- Removed the remaining TypeScript import cycles reported by `madge`. Thanks @av1155 for issue #101.

## [2.12.1] - 2026-07-24

### Fixed
- Restored the SDK v1 dependency required by the MCP Apps bridge during Pi managed installs, where peer dependencies are intentionally not auto-installed. Thanks Nikolai Ugelvik (@NikolaiUgelvik), @warmwaffles, and @max-miller1204 for issue #212.

## [2.12.0] - 2026-07-24

### Added
- Added MCP prompts support as Pi slash commands under the `mcp__<server>__<prompt>` namespace, with capability-gated discovery, cache-backed startup registration, argument validation, lazy dispatch, and `/mcp prompts` listing. Thanks to Egor Egorov (@ee92) for PR #203.
- Hot-loaded refreshed direct MCP tools after metadata reconnects, lazy connects, direct-tool panel changes, and MCP list-change notifications. Thanks Devin Bost (@devinbost) for PR #72.
- Migrated the MCP client and interactive visualizer to the exact-pinned MCP SDK v2 beta.5 packages, with automatic protocol negotiation and client conformance coverage. Thanks Matt Carey (@mattzcarey) for PR #210.
- Added disabled MCP server definitions plus `/mcp disable` and `/mcp enable` project-local overrides that preserve visibility while preventing execution. Thanks Ömer Ulusoy (@ulusoyomer) for PR #61.
- Added argument completions for `/mcp` subcommands and reconnect/logout server names. Thanks @sting8k for PR #8.
- Surfaced MCP connection failure reasons from bounded stdio diagnostics in status output and the `/mcp` panel, with a shortcut to copy the selected failure. Thanks @parkuman for PR #197.
- Added Codex MCP imports from `.codex/config.toml`, with fallback to the existing JSON config. Thanks @npo-mmenke for PR #31.
- Added explicit OpenCode V1 MCP imports from global and project `opencode.json` files, including nested config merging and environment interpolation. Thanks @NicoAvanzDev for PR #25.
- Added environment-variable interpolation for HTTP MCP server URLs, with missing URL variables failing closed before requests are sent. Thanks @ozeias for PR #206.
- Added `settings.oauthDir` to store MCP OAuth credentials in a project-specific directory, with `MCP_OAUTH_DIR` still taking precedence. Thanks @Termina1 for PR #105.
- Added `lazy-keep-alive` lifecycle mode for MCP servers that should start on first use and then stay resident with health-check reconnects. Thanks @ricardoraposo for PR #143.
- Added `MCP_UI_VIEWER=none` / `off` / `disabled` to suppress MCP UI browser or Glimpse windows while keeping inline tool results available. Thanks @stevekrouse for PR #172.
- Surfaced MCP server `instructions` from the initialize handshake: captured at connect time, cached alongside tool metadata, shown as a truncated head in the `mcp` proxy tool description, previewed in `mcp({ server: "name" })` listings, and available in full via the new `mcp({ instructions: "name" })` mode. Thanks @JeongJuhyeon for issue #188 and PR #189.
- Added `createMcpAdapter({ config, configPath })` for isolated SDK configuration and file-path overrides. Thanks @Cansiny0320 for PR #86.

### Changed
- Removed stale hot-loaded direct tools from Pi's registry when `pi.unregisterTool()` is available, while preserving active-tool deactivation fallback for older Pi hosts.
- Deferred loading the regex safety checker until regex search is used, improving startup time. Thanks @kaushikgopal for PR #175.
- Declared Pi host packages as optional peer dependencies with exact development pins, reducing extension install footprint and avoiding host version conflicts. Thanks @t0dorakis for PR #200.

### Fixed
- Started MCP initialization at extension load when any server is configured with `lifecycle: "eager"` or `"keep-alive"`, so hosts that drive Pi programmatically without `session_start` still connect startup servers. Thanks Brian Gebel (@ductiletoaster) for PR #170.
- Enforced normalized standard `_meta.ui.csp` and OpenAI-compatible `_meta["openai/widgetCSP"]` metadata with response headers while preserving provider HTML. Thanks @IdoHadar for PR #195.
- Avoided MCP renderer crashes without a TUI theme and preserved status-bar updates with plain fallback text. Thanks @fankangsong for PR #183.
- Abandoned MCP initialization quietly when a session is disposed during eager or keep-alive connection setup. Thanks @luisfontes for PR #192.
- Fenced MCP runtime ownership across Pi reloads so stale callbacks and late connections cannot outlive their session. Thanks @uuunk (Paul Lorsbach) for PR #202.
- Added `toolPrefix: "mcp"` support for `mcp__<server>_<tool>` names across direct and proxy MCP tool paths. Thanks @riicodespretty for PR #99.
- Sanitized dotted MCP tool names before registering them with Pi. Thanks @benjaminrickels for PR #190.
- Reconnected OAuth MCP servers automatically after successful panel or `/mcp-auth` authorization, and made panel reconnect force a fresh connection like `/mcp reconnect`. Thanks @mightymatth for issue #171.
- Recovered stale Streamable HTTP MCP sessions that report `-32000 Server not initialized` after a server restart. Thanks @vicary for issue #184.
- Kept npm cache lookups working on Windows by resolving `npm` through `cross-spawn`. Thanks @zeyadhost for PR #201.
- Kept direct MCP tool registration working when a host TypeBox shim does not expose `Type.Unsafe`. Thanks @RaviTharuma for PR #198.
- Kept exact `npx` package specs from reusing a different same-name package version from npm's `_npx` cache. Thanks @danhrahal for issue #178.
- Kept POST-only Streamable HTTP servers on the Streamable HTTP transport when the optional GET stream returns 405. Thanks @ramhaidar for issue #204.
- Kept manual OAuth `auth-start` / `auth-complete` flows from being invalidated by keep-alive health checks, and made reserved manual callback states show a manual completion page instead of a CSRF error. Thanks @oozle for issue #207.
- Accepted object-valued `mcp.args` in addition to JSON strings, avoiding double-encoded tool arguments while preserving provider-compatible string calls. Thanks @johnny-smitherson for issue #205.
- Collapsed long single-line MCP results according to terminal-wrapped visual lines. Thanks @xz-dev for PR #181 and @maxpaulus43 for PR #177.
- Recovered Streamable HTTP MCP sessions after a server restart invalidates the previous session ID. Thanks @damselem for PR #194.
- Used server-advertised OAuth protected-resource metadata during authorization so resource servers can point Pi at the correct authorization server. Thanks @jameswarren for issue #173 and PR #174.
- Dropped inherited HTTP auth when a higher-precedence MCP config repoints a server URL, while preserving explicit OAuth disable flags. Thanks @ductiletoaster for PR #182.

## [2.11.0] - 2026-07-03

### Changed
- Restored the tracked npm lockfile for reproducible installs and downstream packaging. Thanks @fmoda3 for issue #71.

### Added
- Added default-on MCP output guarding with temp-file spillover for oversized text results, compact summaries for large proxy result details, and `settings.outputGuard` tuning. Thanks @tmustier for PR #160.

### Fixed
- Defaulted stdio MCP servers without an explicit `cwd` to the Pi session cwd so relative server output lands in the workspace. Thanks @TimoFreiberg for PR #152.
- Kept multiline/control MCP panel metadata from corrupting rows and made Keep & Close save dirty changes. Thanks @gpmarques for issue/PR #14, @Vahor for issue #115, and @markokocic for issue #134/PR #135.
- Preserved `--` separators when resolving `npx` wrapper commands so subcommand flags are not consumed by tools like `dotenv-cli`. Thanks @sherif-fanous for issue #15.
- Merged partial per-server Pi overrides into imported MCP server definitions instead of replacing the full server entry. Thanks @cfbraun for issue #94.
- Fixed the `pi-mcp-adapter` bin entrypoint when invoked through installed symlinks, so `init` runs instead of silently exiting. Thanks @cfbraun for issue #95.
- Normalized direct MCP tool schemas so draft metadata and strict top-level additional properties do not break Pi registration. Thanks @marchellodev for issue #2/PR #3 and @comtihon for PR #144.
- Routed interactive `/mcp-auth` OAuth URLs through Pi UI notifications so long authorization links remain intact instead of being truncated by raw terminal output. Thanks @feoh for issue #147/PR #148.
- Respected configured HTTP headers before implicit OAuth auto-detection so API-key/custom-header MCP servers do not trigger OAuth DCR. Thanks @OnlyXianzo for issue #158.
- Propagated Pi abort signals into MCP connect, resource, and tool requests so cancelled calls settle promptly. Thanks @xz-dev for PR #159 and @murrayju for PR #149.
- Re-flagged failed MCP tool calls (`tool_error`/`call_failed`) as errors so they are recorded as failures (`isError: true`) instead of successes. Thanks @ishinder for PR #157.
- Honored configured `requestTimeoutMs` during MCP connection, discovery, tool, resource, and UI proxy requests. Thanks @mizuikki for PR #155 and @danecando for PR #62.
- Rendered successful MCP `structuredContent` when servers return it without `content`. Thanks @dovixman for PR #146.

## [2.10.0] - 2026-06-13

### Added
- Added manual remote/headless OAuth proxy actions for copying authorization URLs and completing pasted redirect URLs or codes. Thanks @Gabrielgvl for PR #120.

### Fixed
- Honored user `tui.select.*` keybindings in MCP management, setup, and auth panels. Thanks @owenniles for PR #138.
- Included configured OAuth scopes in authorization-code flows while preserving token endpoint authentication method selection. Thanks @carlosdagos for PR #140.
- Fixed MCP elicitation on stock Pi, including form dialogs with validation and review, consent-based URL handling, URL-required errors, completion notifications, and TUI-only browser navigation. Thanks @dmmulroy for PR #139.
- Expanded MCP schema formatting for nested `anyOf`/`oneOf` variants, `const` discriminators, nested object properties, and array items.

## [2.9.0] - 2026-06-04

### Added
- Added MCP elicitation support with Pi form prompts and browser-opening URL requests.

### Fixed
- Rejected non-http/https MCP URL elicitations before prompting or opening a browser.
- Preserved empty string form values for MCP string elicitations unless schema constraints reject them.

## [2.8.0] - 2026-05-25

### Added
- Added per-server OAuth `redirectUri`, `clientName`, and `clientUri` overrides for pre-registered callbacks and dynamic client metadata.

### Fixed
- Avoided OAuth callback port exhaustion by starting the callback server lazily and using OS-assigned ports for dynamic OAuth flows.
- Re-register dynamic OAuth clients before browser auth when cached redirect URI metadata is missing or no longer matches the active callback URI.

## [2.7.0] - 2026-05-22

### Added
- Added TUI call rendering for MCP proxy and direct tool inputs. Thanks @dmmulroy for PR #102.

### Fixed
- Hardened OAuth credential storage paths against server-name path traversal without rejecting valid configured server names.
- Rejected unsafe regex-mode MCP search patterns before executing them.

## [2.6.1] - 2026-05-13

### Added
- Added `/mcp logout <server>` to clear stored OAuth credentials and disconnect the server. Thanks @mattzcarey for PR #96.

### Fixed
- Cancel pending OAuth callbacks when logging out of an MCP server.

## [2.6.0] - 2026-05-10

### Added
- Added a no-argument `/mcp-auth` OAuth picker and in-panel auth shortcut for OAuth-capable MCP servers.
- Added compact collapsed rendering for MCP proxy and direct-tool result rows while keeping full tool results available when expanded.

### Changed
- Migrated Pi runtime dependencies and imports from deprecated `@mariozechner/*` packages to `@earendil-works/*` packages.

### Fixed
- Re-register dynamic OAuth clients during fresh auth when cached DCR client info exists without tokens, avoiding dead authorization URLs after server-side client invalidation.
- Kept OAuth tokens, dynamic client info, PKCE verifiers, and OAuth state bound to the server URL so stale credentials cannot be reused after a server URL changes.
- Kept the `/mcp-auth` OAuth picker search focused on OAuth server rows and prevented hidden panel shortcuts from unexpectedly launching auth.
- Kept long MCP error results expanded in compact tool result rendering.

## [2.5.4] - 2026-05-04

### Changed
- Ignored npm lockfiles and removed checked-in `package-lock.json` files.

### Fixed
- Resolved `${VAR}` and `$env:VAR` placeholders in HTTP bearer tokens.
- Honored MCP sampling `modelPreferences.hints` before falling back to the current/default model.

## [2.5.3] - 2026-05-01

### Added
- Added environment variable and `~` expansion for stdio server `cwd` values.

## [2.5.2] - 2026-04-29

### Fixed
- Respected `PI_CODING_AGENT_DIR` for Pi-owned MCP config and state files, including metadata cache, npx cache, onboarding state, OAuth credentials, and `pi-mcp-adapter init` writes.

## [2.5.1] - 2026-04-24

### Fixed
- Changed OAuth browser callbacks to `http://localhost:<port>/callback` for pre-registered clients such as Slack MCP. Thanks @shenal for PR #53.

## [2.5.0] - 2026-04-24

### Added
- Added MCP `sampling/createMessage` support with conservative human approval by default and opt-in `settings.samplingAutoApprove` for non-interactive flows.
- Added configured Vitest coverage for OAuth provider authorization fallback behavior.
- Added `test:oauth-provider` for running the root OAuth provider node test with the required TypeScript loader.

### Fixed
- Applied `settings.authRequiredMessage` to proxy and direct-tool auth-required paths, including non-UI `autoAuth` failures.
- Fixed `/mcp-auth <server>` reporting success for expired stored OAuth tokens without forcing the SDK refresh/re-auth flow.
- Kept `mcp` search focused on MCP tools and added a direct-call hint when native Pi tools are accidentally routed through the proxy.

## [2.4.2] - 2026-04-22

### Fixed
- Migrated extension tool schemas from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.

### Changed
- Replaced the legacy `@sinclair/typebox` runtime dependency with `typebox`.

## [2.4.1] - 2026-04-22

### Added
- Added standard-MCP-first config discovery: `~/.config/mcp/mcp.json` and project `.mcp.json` now load automatically, with Pi-owned files preserved as override layers.
- Added `pi-mcp-adapter init` as a native post-install helper that detects host-specific MCP configs and scaffolds Pi compatibility imports without using the old raw GitHub downloader flow.
- Added first-run onboarding inside the extension: `/mcp` now shows shared-config hints or actionable empty states, and `/mcp setup` opens a guided setup flow for compatibility imports, minimal `.mcp.json` scaffolding, detected config paths, RepoPrompt quick-add, and exact before/after write previews.
- Added automatic Pi-core reload after setup or direct-tool config changes, using the same flow as `/reload` so freshly configured direct tools can appear without a manual restart.
- Added a dedicated Pi-owned onboarding state file so shared-config hints behave as one-time guidance instead of repeating every session.

### Changed
- Updated config precedence to prefer shared MCP files first, then Pi overrides, with `.pi/mcp.json` acting as the final Pi-specific project override.
- Updated Claude Code compatibility probing to prefer modern Claude MCP config locations before legacy paths.
- Updated project scaffolding so generated `.mcp.json` files are safe minimal shells instead of fake placeholder servers that fail on first reload.
- Updated the setup panel and README for clearer first-run guidance, improved spacing, and a more digestible shared-MCP-first setup story.

## [2.4.0] - 2026-04-13

### Added
- `settings.disableProxyTool` to hide the `mcp` proxy tool once configured direct tools are fully available from cache. Thanks @tanavamsikrishna for PR #41.
- Per-server `excludeTools` to hide specific MCP tools/resources by original or prefixed name across direct tools, proxy discovery, and the `/mcp` panel. Thanks @ahmadaccino for issue #36.
- `settings.autoAuth` to optionally trigger OAuth automatically from proxy/direct tool usage, then rerun the original blocked connect/tool operation once after authentication succeeds. Thanks @unimonkiez for issue #34.

### Fixed
- Regenerated `package-lock.json` so the root lockfile metadata matches `package.json` again, including the declared `open`, `@types/bun`, `@types/open`, and `tsx` entries.
- Kept the `mcp` proxy tool available as a first-session fallback when configured direct tools are still missing cache metadata, avoiding no-tool startup gaps.

## [2.3.5] - 2026-04-13

### Fixed
- Session lifecycle now always tears down OAuth callback state on restart and shutdown, preventing callback-server leaks across session transitions.
- OAuth callback server now calls `unref()` after successful bind so it no longer keeps sub-agent processes alive by itself.
- Strict OAuth port mode now rebinds to the configured callback port when safe, while refusing to switch ports when authorizations are still pending.
- Added focused lifecycle/callback-server regression coverage for teardown, `unref()`, strict rebinding, and pending-auth guardrails.
- Thanks @blai for the investigation and PR #43 that surfaced the sub-agent hang/root lifecycle issues.

## [2.3.4] - 2026-04-12

### Fixed
- OAuth callback handling now allows dynamic-registration flows to fall back to a free local port when the preferred callback port is busy, while keeping pre-registered clients on their exact configured redirect port.
- Documented the new callback-port behavior and added focused auth-flow regression coverage.

## [2.3.3] - 2026-04-12

### Fixed
- Remove the blank footer status line when no MCP servers are configured by clearing the MCP status entry instead of setting it to an empty string. Thanks @HazAT for PR #27.

## [2.3.2] - 2026-04-11

### Added
- Optional `oauth.grantType: "client_credentials"` for non-interactive machine-to-machine OAuth on HTTP MCP servers.

### Fixed
- `/mcp-auth <server>` now handles `client_credentials` without browser/callback flow.
- MCP panel status no longer marks `client_credentials` servers as auth-blocked solely because no stored user tokens exist yet.
- OAuth auth flow now closes temporary transports consistently on success, refresh, and auth removal paths.
- Init paths now preserve debug-level context for previously silent direct-tool bootstrap and lazy-connect failures.

## [2.3.1] - 2026-04-11

### Fixed
- Removed `/mcp-auth-callback`. OAuth auth now hard-cuts to `/mcp-auth <server>` only.

## [2.3.0] - 2026-04-11

### Added
- OAuth callback server initialization on session start and a deprecated `/mcp-auth-callback` command that now points users to `/mcp-auth <server>`.

### Fixed
- OAuth `needs-auth` handling across `/mcp` status/panel, `mcp({ connect })`, `mcp({ tool })`, reconnect flow, lazy/direct tool execution, and startup bootstrap.
- OAuth callback cleanup now cancels by stored OAuth state and closes pending transports on failure/cancel paths.
- Callback server now fails fast when the OAuth callback port is occupied by another process.
- Package manifest test now ignores root `*.test.ts` files.

## [2.2.2] - 2026-04-03

### Fixed
- Session lifecycle teardown now handles repeated `session_start` transitions safely and prevents stale async init results from replacing newer state.
- Shutdown now still runs `gracefulShutdown()` even if metadata cache flushing throws, avoiding leaked MCP processes.
- Proxy/direct tool init error paths now preserve and surface underlying error messages instead of returning generic failures.
- Invalid `mcp` tool `args` now fail by throwing with parse/type context instead of returning non-failing tool payloads.
- Added focused lifecycle regressions tests for stale init cleanup and init-error visibility.

## [2.2.1] - 2026-03-23

### Fixed
- Added `promptSnippet` to MCP proxy tool and direct MCP tools so they appear in the system prompt's Available tools section (required since pi 0.59.0)

## [2.2.0] - 2026-03-16

### Added
- **MCP UI Integration** - Support for the [MCP UI](https://github.com/MCP-UI-Org/mcp-ui) standard. Tools with `_meta.ui.resourceUri` open interactive UIs:
  - Bidirectional AppBridge communication (tool calls, messages, context updates)
  - Works with both stdio and HTTP MCP servers
  - User consent management for tool calls from UI (configurable: never/once-per-server/always)
  - Keyboard shortcuts: Cmd/Ctrl+Enter to complete, Escape to cancel
  - UI prompts/intents trigger agent turns via `pi.sendMessage({ triggerTurn: true })`
  - `mcp({ action: "ui-messages" })` retrieves accumulated messages from UI sessions

- **Session reuse** - When the agent calls the same tool while its UI is already open, results push to the existing window instead of replacing it. Per-call stream IDs with independent sequences. Error results scoped to the individual call.

- **Glimpse integration** - MCP UI opens in a native macOS WKWebView window instead of a browser tab when [Glimpse](https://github.com/hazat/glimpse) is installed (`pi install npm:glimpseui`). Falls back to browser on non-macOS or when unavailable. Override with `MCP_UI_VIEWER=browser` or `MCP_UI_VIEWER=glimpse`.

- **Logger module** (`logger.ts`) - Centralized logging with levels (debug/info/warn/error), contextual child loggers, and `MCP_UI_DEBUG=1` env var.

- **Error types** (`errors.ts`) - Structured errors with recovery hints: `ResourceFetchError`, `ResourceParseError`, `BridgeConnectionError`, `ConsentError`, `SessionError`, `ServerError`, and `wrapError()` helper.

- **Test suite** - 178 tests covering consent manager, UI resource handler, host HTML template, logger, and error types.

- **Interactive visualizer example** (`examples/interactive-visualizer`) - Minimal MCP server demonstrating charts (bar/line/pie/doughnut via Chart.js), bidirectional messaging, and streaming.

### Fixed
- Host-iframe timing: bridge now connects before loading iframe, fixing `ui/initialize` timeout on first load
- All internal `log.info` calls demoted to `log.debug` to eliminate stdout noise during normal use

### Technical Notes
- Uses local minified AppBridge bundle (408KB) to avoid CDN Zod bundling issues
- Serves app HTML from `/ui-app` endpoint instead of blob URLs to avoid iframe issues
- SSE for real-time tool result streaming to browser

## [2.1.2] - 2026-02-03

### Changed
- Added demo video and `pi.video` field to package.json for pi package browser.

## [2.1.0] - 2026-02-02

### Added
- **Direct tool registration** - Promote specific MCP tools to first-class Pi tools via `directTools` config (per-server or global). Direct tools appear in the agent's tool list alongside builtins, so the LLM uses them without needing to search through the proxy first. Registers from cached metadata at startup — no server connections needed.
- **`/mcp` interactive panel** - New TUI overlay replacing the text-based status dump. Shows server connection status, tool lists with direct/proxy toggles, token cost estimates, inline reconnect, and auth notices. Changes written to config on save.
- **Auto-enriched proxy description** - The `mcp` proxy tool description now includes server names and tool counts from the metadata cache, so the LLM knows what's available without a search call (~30 extra tokens).
- **`MCP_DIRECT_TOOLS` env var** - Subagent processes receive their direct tool configuration via environment variable, keeping subagents lean by default.
- **First-run bootstrap** - Servers with `directTools` configured but no cache entry are connected during `session_start` to populate the cache. Direct tools become available after restart.
- Config provenance tracking for correct write-back to user/project/import sources
- Builtin name collision guard (skips direct tools that would shadow `read`, `write`, etc.)
- Cross-server name deduplication for `prefix: "none"` and `prefix: "short"` modes

## [2.0.1] - 2026-02-01

### Fixed
- Adapt execute signature to pi v0.51.0: add signal, onUpdate, ctx parameters

## [2.0.0] - 2026-01-29

### Changed
- **BREAKING: Lazy startup by default** - All servers now default to `lifecycle: "lazy"` and only connect when a tool call needs them. Previously all servers connected eagerly on session start. Set `lifecycle: "keep-alive"` or `lifecycle: "eager"` to restore the old behavior per-server.
- **Idle timeout** - Connected servers are automatically disconnected after 10 minutes of inactivity (configurable via `settings.idleTimeout` or per-server `idleTimeout`). Cached metadata keeps search/list working after disconnect. Set `idleTimeout: 0` to disable.
- `/mcp reconnect` accepts an optional server name to connect or reconnect a single server

### Added
- **Metadata cache** - Tool and resource metadata persisted to `~/.pi/agent/mcp-cache.json`. Enables search/list/describe without live connections. Per-server config hashing with 7-day staleness. Multi-session safe via read-merge-write with per-process tmp files.
- **npx binary resolution** - Resolves npx package binaries to direct paths, eliminating the ~143 MB npm parent process per server. Persistent cache at `~/.pi/agent/mcp-npx-cache.json` with 24h TTL.
- **`mcp({ connect: "server-name" })` mode** - Explicitly trigger connection and metadata refresh for a named server
- **Failure backoff** - Servers that fail to connect are skipped for 60 seconds to avoid repeated connection storms
- **In-flight tracking** - Active tool calls prevent idle timeout from shutting down a server mid-request
- **Prefix-match fallback** - Tool calls with unrecognized names try to match a server prefix and lazy-connect the matching server
- Lifecycle options: `lazy` (default), `eager` (connect at startup, no auto-reconnect), `keep-alive` (unchanged)
- Per-server `idleTimeout` override and global `settings.idleTimeout`
- First-run bootstrap: connects all servers on first session to populate the cache

### Fixed
- Connection close race condition: concurrent close + connect no longer orphans server processes
- **Fuzzy tool name matching** - Hyphens and underscores are treated as equivalent during tool lookup. MCP tools like `resolve-library-id` are now found when called as `resolve_library_id`, which LLMs naturally guess since the prefix separator is `_`.
- **Better "tool not found" errors** - When a server is identified (via prefix match or override) but the tool isn't found, the error now lists that server's available tools so the LLM can self-correct immediately instead of needing a separate list call

## [1.6.0] - 2026-01-29

### Added
- **Unified pi tool search** - `mcp({ search: "..." })` now searches both MCP tools and Pi tools (from installed extensions)
- Pi tools appear first in results with `[pi tool]` prefix
- Details object includes `server: "pi"` for pi tools
- Banner image for README

## [1.5.1] - 2026-01-26

### Changed
- Added `pi-package` keyword for npm discoverability (pi v0.50.0 package system)

## [1.5.0] - 2026-01-22

### Changed
- **BREAKING: `args` parameter is now a JSON string** - The `args` parameter which previously accepted an object now accepts a JSON string. This change was required for compatibility with Claude's Vertex AI API (`google-antigravity` provider) which rejects `patternProperties` in JSON schemas (generated by `Type.Record()`).

### Added
- **Type validation for args** - Parsed args are now validated to ensure they're a JSON object (not null, array, or primitive). Clear error messages for invalid input.
- **`isError: true` on error responses** - JSON parse errors and type validation errors now properly set `isError: true` to indicate failure to the LLM.

### Migration
```typescript
// Before (1.4.x)
mcp({ tool: "my_tool", args: { key: "value" } })

// After (1.5.0)
mcp({ tool: "my_tool", args: '{"key": "value"}' })
```

## [1.4.1] - 2026-01-19

### Changed

- Status bar shows server count instead of tool count ("MCP: 5 servers")

## [1.4.0] - 2026-01-19

### Changed

- **Non-blocking startup** - Pi starts immediately, MCP servers connect in background. First MCP call waits only if init isn't done yet.

### Fixed

- Tool metadata now includes `inputSchema` after `/mcp reconnect` (was missing, breaking describe and error hints)

## [1.3.0] - 2026-01-19

### Changed

- **Parallel server connections** - All MCP servers now connect in parallel on startup instead of sequentially, significantly faster with many servers

## [1.2.2] - 2026-01-19

### Fixed

- Installer now downloads from `main` branch (renamed from `master`)

## [1.2.1] - 2026-01-19

### Added

- **npx installer** - Run `npx pi-mcp-adapter` to install (downloads files, installs deps, configures settings.json)

## [1.1.0] - 2026-01-19

### Changed

- **Search includes schemas by default** - Search results now include parameter schemas, reducing tool calls needed (search + call instead of search + describe + call)
- **Space-separated search terms match as OR** - `"navigate screenshot"` finds tools matching either word (like most search engines)
- **Suppress server stderr by default** - MCP server logs no longer clutter terminal on startup
- Use `includeSchemas: false` for compact output without schemas
- Use `debug: true` per-server to show stderr when troubleshooting

## [1.0.0] - 2026-01-19

### Added

- **Single unified `mcp` tool** with token-efficient architecture (~200 tokens vs ~15,000 for individual tools)
- **Five operation modes:**
  - `mcp({})` - Show server status
  - `mcp({ server: "name" })` - List tools from a server
  - `mcp({ search: "query" })` - Search tools by name/description
  - `mcp({ describe: "tool_name" })` - Show tool details and parameter schema
  - `mcp({ tool: "name", args: {...} })` - Call a tool
- **Stdio transport** for local MCP servers (command + args)
- **HTTP transport** with automatic fallback (StreamableHTTP → SSE)
- **Config imports** from Cursor, Claude Code, Claude Desktop, VS Code, Windsurf, Codex
- **Resource tools** - MCP resources exposed as callable tools
- **OAuth support** - Token file-based authentication
- **Bearer token auth** - Static or environment variable tokens
- **Keep-alive connections** with automatic health checks and reconnection
- **Schema on-demand** - Parameter schemas shown in `describe` mode and error responses
- **Commands:**
  - `/mcp` or `/mcp status` - Show server status
  - `/mcp tools` - List all tools
  - `/mcp reconnect` - Force reconnect all servers
  - `/mcp-auth <server>` - Show OAuth setup instructions

### Architecture

- Tools stored in metadata map, not registered individually with Pi
- MCP server validates arguments (no client-side schema conversion)
- Reconnect callback updates metadata after auto-reconnect
- Human-readable schema formatting for LLM consumption
