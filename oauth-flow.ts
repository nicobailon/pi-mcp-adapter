// oauth-flow.ts - OAuth helper plumbing: loopback callback server + browser open
//
// Used by the OAuth-aware HTTP transport path in server-manager.ts.
// Stays deliberately small and dependency-free so it can be reasoned about
// in isolation.

import { spawn } from "node:child_process";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { platform } from "node:os";

export interface CallbackResult {
  code: string;
  state?: string;
}

export interface CallbackServer {
  /** Loopback TCP port the server is listening on. */
  readonly port: number;
  /** Full callback URL: `http://127.0.0.1:<port>/callback`. */
  readonly redirectUri: string;
  /**
   * Wait for the OAuth provider to redirect back here with `?code=...`.
   * Resolves with the captured code (and state, if any).
   * Rejects if the provider returns `?error=...` or if the timeout expires.
   */
  waitForCode(timeoutMs?: number): Promise<CallbackResult>;
  /** Stop listening. Idempotent. */
  close(): void;
}

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Authorization complete</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      max-width: 32rem;
      margin: 4rem auto;
      padding: 0 1.5rem;
      text-align: center;
      line-height: 1.5;
    }
    h1 { color: #16a34a; margin-bottom: 0.5rem; }
    p  { color: #525252; margin: 0.25rem 0; }
    code { background: rgba(127,127,127,0.15); padding: 0.1rem 0.35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>&#10003; Authorization complete</h1>
  <p>You can close this tab and return to your terminal.</p>
  <p><small>pi-mcp-adapter</small></p>
  <script>setTimeout(function () { window.close(); }, 1500);</script>
</body>
</html>
`;

function errorHtml(message: string): string {
  const safe = message.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Authorization failed</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      max-width: 32rem;
      margin: 4rem auto;
      padding: 0 1.5rem;
      text-align: center;
      line-height: 1.5;
    }
    h1 { color: #dc2626; margin-bottom: 0.5rem; }
    p  { color: #525252; margin: 0.25rem 0; }
  </style>
</head>
<body>
  <h1>&#10007; Authorization failed</h1>
  <p>${safe}</p>
  <p><small>pi-mcp-adapter</small></p>
</body>
</html>
`;
}

/**
 * Bind a single-shot HTTP server on 127.0.0.1:<random ephemeral port>.
 *
 * The server only handles `GET /callback`; everything else gets a 404.
 * Use `waitForCode()` to grab the OAuth code that the user-agent posts back.
 */
export async function startCallbackServer(): Promise<CallbackServer> {
  // The HTTP handler runs synchronously inside the Node http server's
  // emit loop, but the consumer's `await waitForCode()` may not have a
  // chance to attach handlers before the result lands. To avoid spurious
  // "unhandled rejection" warnings we don't allocate a Promise upfront;
  // we buffer the result and let `waitForCode()` either read it directly
  // (if the request landed first) or attach pending listeners (if it
  // hasn't yet).
  type Stored =
    | { kind: "pending" }
    | { kind: "resolved"; value: CallbackResult }
    | { kind: "rejected"; error: Error };
  let stored: Stored = { kind: "pending" };
  const pendingResolvers: Array<(result: CallbackResult) => void> = [];
  const pendingRejecters: Array<(err: Error) => void> = [];

  function resolveCallback(value: CallbackResult): void {
    if (stored.kind !== "pending") return;
    stored = { kind: "resolved", value };
    const resolvers = pendingResolvers.splice(0);
    pendingRejecters.length = 0;
    for (const fn of resolvers) fn(value);
  }
  function rejectCallback(error: Error): void {
    if (stored.kind !== "pending") return;
    stored = { kind: "rejected", error };
    const rejecters = pendingRejecters.splice(0);
    pendingResolvers.length = 0;
    for (const fn of rejecters) fn(error);
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res);
  });

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? "/", `http://127.0.0.1`);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad request");
      return;
    }

    if (!parsed.pathname.startsWith("/callback")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const error = parsed.searchParams.get("error");
    const errorDescription = parsed.searchParams.get("error_description");
    if (error) {
      const message = errorDescription ? `${error}: ${errorDescription}` : error;
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(errorHtml(message));
      rejectCallback(new Error(`OAuth authorization failed: ${message}`));
      return;
    }

    const code = parsed.searchParams.get("code");
    if (!code) {
      const message = "No authorization code received";
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(errorHtml(message));
      rejectCallback(new Error(message));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(SUCCESS_HTML);
    const state = parsed.searchParams.get("state") ?? undefined;
    resolveCallback({ code, state });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine OAuth callback server port");
  }
  const port = address.port;

  return {
    port,
    redirectUri: `http://127.0.0.1:${port}/callback`,
    waitForCode(timeoutMs = 5 * 60 * 1000): Promise<CallbackResult> {
      // If the result already landed (e.g. in tests, or if the user
      // completes consent before we get here), settle synchronously.
      if (stored.kind === "resolved") {
        return Promise.resolve(stored.value);
      }
      if (stored.kind === "rejected") {
        return Promise.reject(stored.error);
      }
      const promise = new Promise<CallbackResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          rejectCallback(new Error(
            `OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s`,
          ));
        }, timeoutMs);
        timer.unref?.();
        pendingResolvers.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
        pendingRejecters.push((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      // Pre-attach a no-op rejection handler so the promise is *always*
      // observed from the moment it's returned, even if the OAuth provider
      // races us and the request lands before the caller awaits the result.
      // The caller's own `await` chain still observes the rejection normally.
      promise.catch(() => { /* observed by caller */ });
      return promise;
    },
    close(): void {
      try {
        server.close();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Open `url` in the user's default browser. Best-effort, fire-and-forget.
 *
 * Falls back gracefully if no opener is available; the caller will still
 * see the URL in the log line that pi-mcp-adapter prints just before this is
 * called, and can paste it manually if needed.
 */
export async function openBrowser(url: string): Promise<void> {
  // Allow overriding the opener for headless environments / SSH sessions.
  // PI_MCP_BROWSER=none disables auto-open entirely.
  const override = process.env.PI_MCP_BROWSER;
  if (override === "none") return;

  const { command, args } = resolveOpener(url, override);
  if (!command) return;

  await new Promise<void>((resolve) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => resolve());
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}

function resolveOpener(url: string, override?: string): { command: string | undefined; args: string[] } {
  if (override && override !== "none") {
    return { command: override, args: [url] };
  }
  const plat = platform();
  if (plat === "darwin") return { command: "open", args: [url] };
  if (plat === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  // Linux / *BSD
  return { command: "xdg-open", args: [url] };
}
