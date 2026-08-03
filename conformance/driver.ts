/**
 * Conformance client driver.
 *
 * Spawned by `@modelcontextprotocol/conformance` once per scenario (via
 * conformance/driver.sh, which provisions an isolated MCP_OAUTH_DIR):
 *
 *   MCP_CONFORMANCE_SCENARIO=<scenario> node --import tsx conformance/driver.ts <server-url>
 *
 * The MCP client under test is the adapter's real client stack:
 * McpServerManager (transport probe, StreamableHTTP/SSE fallback, needs-auth
 * detection, elicitation handler) plus mcp-auth-flow (SDK OAuth discovery,
 * DCR, PKCE, token exchange, the real localhost callback server).
 *
 * For OAuth scenarios this process also plays the role of the user's
 * browser: the conformance authorization endpoint auto-approves, so the
 * driver fetches the authorization URL with `redirect: "manual"`, follows
 * the Location into the adapter's real callback server, and then completes
 * the flow via completeAuthFromInput with the full redirect URL.
 *
 * Exit code: 0 = scenario steps completed, non-zero = client failure.
 * Grading itself is done server-side by the conformance harness.
 */

import { rmSync } from "node:fs"
import { UnauthorizedError } from "@modelcontextprotocol/client"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { McpServerManager } from "../server-manager.ts"
import {
  completeAuthFromInput,
  initializeOAuth,
  shutdownOAuth,
  startAuth,
} from "../mcp-auth-flow.ts"
import type { ServerEntry } from "../types.ts"

const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? ""
const serverUrl = process.argv[2] ?? ""
const authDir = process.env.MCP_OAUTH_DIR ?? ""

if (!scenario || !serverUrl || !authDir) {
  console.error(
    "Usage: MCP_OAUTH_DIR=<tmpdir> MCP_CONFORMANCE_SCENARIO=<scenario> driver.ts <server-url>",
  )
  process.exit(1)
}

interface ScenarioContext {
  name?: string
  client_id?: string
  client_secret?: string
  private_key_pem?: string
  signing_algorithm?: string
  [key: string]: unknown
}

const context: ScenarioContext = process.env.MCP_CONFORMANCE_CONTEXT
  ? JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT)
  : {}

// Keep this list explicit. If a later conformance release adds a scenario,
// the driver must learn its required action rather than passing from incidental
// initialize traffic.
const SUPPORTED_SCENARIOS = new Set([
  "initialize",
  "tools_call",
  "elicitation-sep1034-client-defaults",
  "sse-retry",
  "auth/metadata-default",
  "auth/metadata-var1",
  "auth/metadata-var2",
  "auth/metadata-var3",
  "auth/basic-cimd",
  "auth/scope-from-www-authenticate",
  "auth/scope-from-scopes-supported",
  "auth/scope-omitted-when-undefined",
  "auth/scope-step-up",
  "auth/scope-retry-limit",
  "auth/token-endpoint-auth-basic",
  "auth/token-endpoint-auth-post",
  "auth/token-endpoint-auth-none",
  "auth/pre-registration",
  "auth/2025-03-26-oauth-metadata-backcompat",
  "auth/2025-03-26-oauth-endpoint-fallback",
  "auth/resource-mismatch",
  "auth/offline-access-scope",
  "auth/offline-access-not-supported",
  "auth/client-credentials-jwt",
  "auth/client-credentials-basic",
  "auth/cross-app-access-complete-flow",
])

if (!SUPPORTED_SCENARIOS.has(scenario)) {
  console.error(`Unsupported MCP conformance scenario: ${scenario}`)
  process.exit(1)
}

/**
 * Scripted UI for elicitation: accept the request, take every field's
 * default, submit. Exercises the adapter's real form-elicitation handler.
 */
const scriptedUi = {
  select: async (_title: string, options: string[]) => {
    for (const preferred of ["Use default", "Submit", "Continue"]) {
      const match = options.find((option) => option === preferred)
      if (match) return match
    }
    return options[0]
  },
  input: async () => undefined,
  confirm: async () => true,
  notify: () => {},
} as unknown as ExtensionUIContext

const SERVER_NAME = "conformance"
const MAX_AUTH_ROUND_TRIPS = 3
const debugLog = (message: string): void => {
  if (process.env.CONFORMANCE_DRIVER_DEBUG) console.error(`[driver] ${message}`)
}

const definition: ServerEntry = { url: serverUrl }
if (context.client_id) {
  definition.oauth = {
    clientId: context.client_id,
    ...(context.client_secret ? { clientSecret: context.client_secret } : {}),
  }
}
if (scenario.startsWith("auth/client-credentials")) {
  definition.oauth = { ...(definition.oauth ?? {}), grantType: "client_credentials" }
}

const oauthRuntime = await initializeOAuth()
const manager = new McpServerManager(process.cwd())
manager.setOAuthRuntime(oauthRuntime)
manager.setElicitationConfig({ allowUrl: false, ui: scriptedUi })
manager.setDefaultRequestTimeoutMs(60_000)

/**
 * Run one OAuth round-trip through the adapter's real auth flow, playing
 * the browser headlessly: the conformance AS auto-approves a plain GET on
 * the authorization URL and 302s to the adapter's localhost callback.
 */
async function runAuthRoundTrip(): Promise<void> {
  debugLog("startAuth")
  const { authorizationUrl } = await startAuth(SERVER_NAME, serverUrl, definition, { runtime: oauthRuntime })
  debugLog(`authorizationUrl=${authorizationUrl || "(none)"}`)
  if (!authorizationUrl) return // e.g. client_credentials — already authorized

  const authResponse = await fetch(authorizationUrl, { redirect: "manual" })
  const location = authResponse.headers.get("location")
  if (!location) {
    throw new Error(
      `Authorization endpoint did not redirect (status ${authResponse.status}): ${await authResponse.text()}`,
    )
  }

  // Follow the redirect into the adapter's real callback server (it serves
  // the "return to terminal" page), then complete the flow with the full
  // redirect URL. The adapter validates state and exchanges the code.
  const callbackUrl = new URL(location, authorizationUrl).toString()
  const callbackResponse = await fetch(callbackUrl, { redirect: "manual" })
  if (callbackResponse.status >= 400) {
    throw new Error(
      `OAuth callback failed with ${callbackResponse.status}: ${await callbackResponse.text()}`,
    )
  }
  const status = await completeAuthFromInput(SERVER_NAME, callbackUrl, { runtime: oauthRuntime })
  if (status !== "authenticated") {
    throw new Error(`OAuth completion returned status: ${status}`)
  }
}

async function connectWithAuth() {
  for (let attempt = 0; attempt <= MAX_AUTH_ROUND_TRIPS; attempt++) {
    let needsAuth = false
    try {
      const connection = await manager.connect(SERVER_NAME, definition)
      debugLog(`connect attempt ${attempt}: status=${connection.status}`)
      if (connection.status === "connected") return connection
      if (connection.status !== "needs-auth") {
        throw new Error(`Unexpected connection status: ${connection.status}`)
      }
      needsAuth = true
    } catch (error) {
      // The HTTP transport probe throws UnauthorizedError out of connect()
      // when the server requires OAuth; the host treats this as needs-auth.
      debugLog(`connect attempt ${attempt}: threw ${(error as Error)?.constructor?.name}: ${(error as Error)?.message}`)
      // For auth scenarios, any other connect failure (e.g. the SSE-fallback
      // error seen on 2025-03-26 backcompat servers) is handled the way the
      // Pi host would: by offering manual authentication. If the auth flow
      // itself cannot proceed either, surface the original connect error.
      if (!(error instanceof UnauthorizedError) && !scenario.startsWith("auth/")) throw error
      needsAuth = true
    }
    if (!needsAuth || attempt === MAX_AUTH_ROUND_TRIPS) break
    await manager.close(SERVER_NAME)
    await runAuthRoundTrip()
  }
  throw new Error(`Gave up after ${MAX_AUTH_ROUND_TRIPS} OAuth round-trips`)
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  const message = error instanceof Error ? error.message : String(error)
  return /unauthorized|re-authentication required|insufficient_scope|invalid_token|\b40[13]\b/i.test(message)
}

async function callTool(toolName: string, args: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    const connection = await connectWithAuth()
    try {
      const result = await connection.client.callTool(
        { name: toolName, arguments: args },
        manager.getRequestOptions(SERVER_NAME),
      )
      if (result.isError) {
        throw new Error(`Tool ${toolName} returned an error result: ${JSON.stringify(result.content)}`)
      }
      return result
    } catch (error) {
      // Mid-session auth failure (e.g. scope step-up): re-run the OAuth
      // flow through the adapter and retry, capped like a real host would.
      if (attempt >= MAX_AUTH_ROUND_TRIPS - 1 || !isAuthFailure(error)) throw error
      await manager.close(SERVER_NAME)
      await runAuthRoundTrip()
    }
  }
}

async function runScenario(): Promise<void> {
  if (scenario === "initialize") {
    await connectWithAuth()
    return
  }
  if (scenario === "tools_call") {
    await callTool("add_numbers", { a: 5, b: 3 })
    return
  }
  if (scenario === "elicitation-sep1034-client-defaults") {
    await callTool("test_client_elicitation_defaults", {})
    return
  }
  if (scenario === "sse-retry") {
    await callTool("test_reconnection", {})
    return
  }
  if (scenario.startsWith("auth/")) {
    await callTool("test-tool", {})
    return
  }
  throw new Error(`Unsupported MCP conformance scenario: ${scenario}`)
}

let exitCode = 0
try {
  await runScenario()
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  exitCode = 1
} finally {
  try {
    await manager.closeAll()
  } catch {}
  try {
    await shutdownOAuth(oauthRuntime)
  } catch {}
  try {
    rmSync(authDir, { recursive: true, force: true })
  } catch {}
}
process.exit(exitCode)
