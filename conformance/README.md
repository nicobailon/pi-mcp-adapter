# MCP client conformance tests

This directory runs the official `@modelcontextprotocol/conformance` client suite against pi-mcp-adapter.

The driver uses the adapter's own code rather than constructing a bare SDK client:

```text
conformance referee
  -> conformance/driver.sh (isolated token store and callback port)
  -> conformance/driver.ts
  -> McpServerManager
  -> mcp-auth-flow + McpOAuthProvider + localhost callback server
  -> referee MCP and OAuth servers
```

It covers the four core client scenarios and the full OAuth matrix shipped by conformance 0.1.16, 26 scenarios in total. The OAuth driver follows the referee's authorization redirect into the adapter's real callback server, then completes the pending flow through `completeAuthFromInput()`.

## Run the tests

From the repository root:

```sh
npm run test:conformance
```

Run one scenario while developing:

```sh
bash conformance/run.sh --scenario initialize
bash conformance/run.sh --scenario auth/metadata-default --verbose
```

Results are written to `conformance/results/` and ignored by git. Set `CONFORMANCE_RESULTS_DIR` to use another directory, or `CONFORMANCE_TIMEOUT_MS` to change the 90-second per-scenario timeout.

The full runner is sequential. The upstream CLI's `--suite` mode runs scenarios in parallel, but pre-registered OAuth clients bind an exact localhost callback port. Parallel runs can therefore fail because another scenario briefly owns that port, which tests port contention rather than MCP behavior.

## Expected failures

`baseline-client.yml` lists known adapter or SDK gaps. A failure in that file keeps the suite green; an unexpected failure or a baseline entry that starts passing fails the run.

Current gaps:

| Scenario | Reason |
| --- | --- |
| `auth/basic-cimd` | The adapter does not yet publish an HTTPS Client ID Metadata Document; omitted `oauth.clientId` falls back to Dynamic Client Registration when the server supports it. |
| `auth/scope-step-up` | Pi's user-gated OAuth flow cannot yet resume the SDK's in-call 403 scope challenge with the widened scope. |
| `auth/2025-03-26-oauth-metadata-backcompat` | The SDK rejects authorization metadata whose issuer differs from the identifier used to fetch it; the adapter keeps the strict RFC 8414 mix-up protection. |
| `auth/client-credentials-jwt` | Private-key JWT client authentication is not configured by the adapter. |
| `auth/cross-app-access-complete-flow` | The adapter does not implement SEP-990 token exchange and JWT bearer grants. |

Baseline comments contain the protocol-level details. Do not add a failure caused by the driver, callback-port contention, or test setup.
