# Deduplicate transient keep-alive warnings

## Rotator-backed transient recovery (2026-08-20)

### Plan

- [x] Remove Pi's nested immediate HTTP 503 connection retry.
- [x] Preserve the bounded availability diagnosis without shape probing.
- [x] Keep cached metadata active while lifecycle recovery backs off.
- [x] Verify transient refresh failures stay silent and later recovery clears health state.
- [x] Run targeted RED/GREEN, typecheck, full source tests, and diff review.

### Acceptance criteria

- One Pi connection attempt produces one gateway connection attempt.
- HTTP 503 never falls back to SSE or triggers the non-MCP shape probe.
- Keep-alive refresh 503s retain cached tools and retry after 30 seconds, then exponentially up to 5 minutes.
- Non-transient failures remain visible once per outage.

### Review

Pi now performs one Streamable HTTP connection attempt, keeps 503 failures typed
as temporary availability errors, and relies on the existing keep-alive cache
plus 30-second-to-5-minute recovery cadence. Transient refresh errors stay
silent; health state and one-warning-per-outage behavior remain intact.

Verification:

- RED: both connection tests observed four attempts before the change.
- GREEN: targeted lifecycle/HTTP suites passed, 30/30; typecheck passed.
- Source suite excluding two unrelated failing files passed, 1147/1147.
- Default suite: 1160 passed; two missing ignored visualizer artifacts and two
  pre-existing request-header helper timing failures remain outside this task.
- Live: `pi list` resolves this checkout; headless Pi exited 0 with `OK` and
  refreshed the MCP cache through successful Context7, Firecrawl, and Tavily handshakes.

## Plan

- [x] Confirm Firecrawl remains configured as a remote keep-alive server.
- [x] Trace repeated terminal output to lifecycle retry reporting.
- [x] Add regression coverage for one warning per outage.
- [x] Deduplicate terminal warnings while preserving retries and health state.
- [x] Run targeted tests, typecheck, full tests, and inspect the final diff.

## Acceptance criteria

- A keep-alive outage emits one terminal warning while retries continue.
- Typed HTTP 503 refresh failures remain silent while cached tools stay usable.
- Health callbacks continue receiving failures and recovery.
- A later non-transient failure during the same outage emits one warning.
- A later independent outage emits a new warning.
- Existing retry timing and transport behavior remain unchanged.

## Review

Implemented outage-state terminal logging in `lifecycle.ts`. Repeated retries
still update failure state and preserve exponential backoff. Typed HTTP 503
refresh failures stay off stderr; a later non-transient failure escalates once.
Recovery clears the outage, so a later outage reports normally.

Verification:

- RED: lifecycle test failed with two warnings before implementation.
- GREEN: lifecycle tests passed, 24/24.
- Full source suite passed serially, 1162/1162; typecheck passed.
- `pi install ../../Projects/open-source/tools/pi-mcp-adapter` refreshed Pi's
  local package registration; `pi list` resolves this checkout and settings
  contains exactly one adapter entry.
- The complete default suite additionally expects gitignored visualizer `dist/`
  artifacts that are absent in this checkout; its two fixture tests were excluded
  from the source-suite run.
