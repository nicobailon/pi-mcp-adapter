/**
 * MCP OAuth Callback Server
 * 
 * HTTP server that handles OAuth callbacks from the authorization server.
 * Uses Node.js http module for compatibility.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http"
import {
  OAUTH_CALLBACK_PATH,
  getConfiguredOAuthCallbackPort,
  getOAuthCallbackPort,
  setOAuthCallbackPort,
} from "./mcp-oauth-provider.ts"

// HTML templates for callback responses
const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Pi.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${error}</div>
  </div>
</body>
</html>`

/** Pending authorization request */
interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** Server singleton state */
let server: Server | undefined
const pendingAuths = new Map<string, PendingAuth>()

/** Timeout for callback completion (5 minutes) */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

/** Whether process exit handlers have been registered */
let exitHandlersRegistered = false

/**
 * Register process signal/exit handlers to ensure the callback server is
 * cleaned up even when the process is terminated abnormally (SIGTERM, SIGINT,
 * SIGHUP, etc.). Without this, the HTTP server keeps the port occupied after
 * the parent process is killed, eventually exhausting the entire port range.
 */
function registerExitHandlers(): void {
  if (exitHandlersRegistered) return
  exitHandlersRegistered = true

  const cleanup = (): void => {
    if (server) {
      try { server.close() } catch { /* best effort */ }
      server = undefined
    }
  }

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const listeners = process.listeners(signal)
    // Only register if no other listener has claimed the signal
    if (listeners.length === 0) {
      process.once(signal, () => {
        cleanup()
        process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1))
      })
    } else {
      // Prepend our cleanup so it runs before existing handlers
      process.prependOnceListener(signal, cleanup)
    }
  }

  // Also handle normal process exit (covers cases where node exits cleanly
  // but the extension shutdown hook didn't fire)
  process.on("exit", cleanup)
}

interface EnsureCallbackServerOptions {
  strictPort?: boolean
}

/**
 * Handle incoming HTTP requests to the callback server.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", `http://${req.headers.host}`)

  // Only handle the callback path
  if (url.pathname !== OAUTH_CALLBACK_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("Not found")
    return
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  // Enforce state parameter presence for CSRF protection
  if (!state) {
    const errorMsg = "Missing required state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(HTML_ERROR(errorMsg))
    return
  }

  // Handle OAuth errors
  if (error) {
    const errorMsg = errorDescription || error
    // Send HTTP response first before rejecting promise
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(HTML_ERROR(errorMsg))
    // Reject promise after response is sent (defer to allow test to attach handler)
    if (pendingAuths.has(state)) {
      const pending = pendingAuths.get(state)!
      clearTimeout(pending.timeout)
      pendingAuths.delete(state)
      setTimeout(() => pending.reject(new Error(errorMsg)), 0)
    }
    return
  }

  // Require authorization code
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(HTML_ERROR("No authorization code provided"))
    return
  }

  // Validate state parameter
  if (!pendingAuths.has(state)) {
    const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(HTML_ERROR(errorMsg))
    return
  }

  const pending = pendingAuths.get(state)!

  // Clear timeout and resolve the pending promise
  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  pending.resolve(code)

  res.writeHead(200, { "Content-Type": "text/html" })
  res.end(HTML_SUCCESS)
}

/**
 * Ensure the callback server is running.
 * If strictPort is true, requires binding on the configured callback port.
 * If strictPort is false, uses port 0 to let the OS assign a free ephemeral port.
 */
export async function ensureCallbackServer(options: EnsureCallbackServerOptions = {}): Promise<void> {
  const configuredPort = getConfiguredOAuthCallbackPort()
  const strictPort = options.strictPort === true

  if (server) {
    if (!strictPort || getOAuthCallbackPort() === configuredPort) return

    if (pendingAuths.size > 0) {
      throw new Error(
        `OAuth callback server is running on port ${getOAuthCallbackPort()}, but strict callback port ${configuredPort} is required and cannot be switched while authorizations are pending`
      )
    }

    await stopCallbackServer()
  }

  const candidateServer = createServer(handleRequest)

  if (strictPort) {
    // Pre-registered OAuth clients require an exact redirect URI.
    try {
      await new Promise<void>((resolve, reject) => {
        candidateServer.once("error", reject)
        candidateServer.listen(configuredPort, "localhost", () => resolve())
      })
    } catch (error) {
      await new Promise<void>((resolve) => { candidateServer.close(() => resolve()) })
      throw new Error(
        `OAuth callback port ${configuredPort} is already in use. Pre-registered OAuth clients require an exact redirect URI; set MCP_OAUTH_CALLBACK_PORT to your registered port or free port ${configuredPort}`,
        { cause: error instanceof Error ? error : new Error(String(error)) }
      )
    }
    server = candidateServer
    server.unref()
    setOAuthCallbackPort(configuredPort)
    registerExitHandlers()
    return
  }

  // Non-strict: let the OS assign a guaranteed-free ephemeral port.
  // This eliminates port scanning and scales to any number of concurrent sessions.
  const assignedPort = await new Promise<number>((resolve, reject) => {
    candidateServer.once("error", reject)
    candidateServer.listen(0, "localhost", () => {
      const addr = candidateServer.address()
      resolve(typeof addr === "object" && addr ? addr.port : configuredPort)
    })
  })

  server = candidateServer
  server.unref()
  setOAuthCallbackPort(assignedPort)
  registerExitHandlers()
}

/**
 * Wait for a callback with the given OAuth state.
 * Returns a promise that resolves with the authorization code.
 */
export function waitForCallback(oauthState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState)
        reject(new Error("OAuth callback timeout - authorization took too long"))
      }
    }, CALLBACK_TIMEOUT_MS)

    pendingAuths.set(oauthState, { resolve, reject, timeout })
  })
}

/**
 * Cancel a pending authorization by state.
 */
export function cancelPendingCallback(oauthState: string): void {
  const pending = pendingAuths.get(oauthState)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingAuths.delete(oauthState)
    pending.reject(new Error("Authorization cancelled"))
  }
}

/**
 * Stop the callback server and reject all pending authorizations.
 */
export async function stopCallbackServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        resolve()
      })
    })
    server = undefined
  }

  setOAuthCallbackPort(getConfiguredOAuthCallbackPort())

  // Reject all pending auths (defer to allow any pending operations to complete)
  const pendingList = Array.from(pendingAuths.entries())
  pendingAuths.clear()
  setTimeout(() => {
    for (const [, pending] of pendingList) {
      clearTimeout(pending.timeout)
      pending.reject(new Error("OAuth callback server stopped"))
    }
  }, 0)
}

/**
 * Check if the callback server is running.
 */
export function isCallbackServerRunning(): boolean {
  return server !== undefined
}

/**
 * Get the number of pending authorizations.
 */
export function getPendingAuthCount(): number {
  return pendingAuths.size
}
