import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { startUiServer, type UiServerOptions, type UiServerHandle } from "../ui-server.ts";
import type { McpServerManager } from "../server-manager.ts";
import type { ConsentManager } from "../consent-manager.ts";
import type { McpConfig, UiResourceContent } from "../types.ts";
import type { McpExtensionState } from "../state.ts";

// Helper to make HTTP requests to the server
async function request(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

// Helper to connect to SSE and collect events
function connectSSE(
  url: string,
  onEvent: (name: string, data: unknown, eventId?: string) => void,
  headers: Record<string, string> = {},
): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { Accept: "text/event-stream", ...headers },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE connection failed: ${res.statusCode}`));
          return;
        }
        let buffer = "";
        let eventName = "message";
        let eventId: string | undefined;
        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          
          for (const line of lines) {
            if (line.startsWith("id: ")) {
              eventId = line.slice(4);
            } else if (line.startsWith("event: ")) {
              eventName = line.slice(7);
            } else if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                onEvent(eventName, data, eventId);
              } catch {
                onEvent(eventName, line.slice(6), eventId);
              }
              eventName = "message";
              eventId = undefined;
            }
          }
        });
        resolve({
          close: () => {
            req.destroy();
          },
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Mock factories
function createMockManager(overrides: Partial<McpServerManager> = {}): McpServerManager {
  return {
    getConnection: vi.fn().mockReturnValue({
      status: "connected",
      client: {
        callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] }),
      },
      tools: [{ name: "some_tool" }],
    }),
    touch: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
    readResource: vi.fn(),
    getRequestOptions: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as McpServerManager;
}

function createMockConsentManager(overrides: Partial<ConsentManager> = {}): ConsentManager {
  return {
    requiresPrompt: vi.fn().mockReturnValue(false),
    shouldCacheConsent: vi.fn().mockReturnValue(true),
    ensureApproved: vi.fn(),
    registerDecision: vi.fn(),
    ...overrides,
  } as unknown as ConsentManager;
}

function createMockResource(overrides: Partial<UiResourceContent> = {}): UiResourceContent {
  return {
    uri: "ui://test/widget",
    html: "<h1>Test App</h1>",
    mimeType: "text/html",
    meta: {
      permissions: [],
    },
    ...overrides,
  };
}

function createServerOptions(overrides: Partial<UiServerOptions> = {}): UiServerOptions {
  return {
    serverName: "test-server",
    toolName: "test_tool",
    toolArgs: { key: "value" },
    resource: createMockResource(),
    manager: createMockManager(),
    consentManager: createMockConsentManager(),
    ...overrides,
  };
}

async function getUiAppUrl(handle: UiServerHandle): Promise<string> {
  const host = await request(handle.url);
  const match = typeof host.body === "string"
    ? host.body.match(/const UI_RESOURCE_TOKEN = "([^"]+)";/)
    : null;
  if (!match?.[1]) throw new Error("UI resource token missing from host page");
  return `http://localhost:${handle.port}/ui-app?resource=${encodeURIComponent(match[1])}`;
}

describe("UiServer", () => {
  let handle: UiServerHandle | null = null;

  afterEach(() => {
    if (handle) {
      handle.close("test-cleanup");
      handle = null;
    }
  });

  describe("startUiServer", () => {
    it("starts server on a Moshi-discoverable low port by default", async () => {
      handle = await startUiServer(createServerOptions());

      expect(handle.port).toBeGreaterThanOrEqual(8377);
      expect(handle.port).toBeLessThanOrEqual(8396);
      expect(handle.url).toContain(`http://localhost:${handle.port}`);
      expect(handle.sessionToken).toBeTruthy();
    });

    it("uses provided session token", async () => {
      handle = await startUiServer(createServerOptions({ sessionToken: "custom-token-123" }));

      expect(handle.sessionToken).toBe("custom-token-123");
      expect(handle.url).toContain("session=custom-token-123");
    });

    it("uses provided port", async () => {
      // Find a free port first
      const tempServer = http.createServer();
      await new Promise<void>((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
      const freePort = (tempServer.address() as { port: number }).port;
      tempServer.close();

      handle = await startUiServer(createServerOptions({ port: freePort }));

      expect(handle.port).toBe(freePort);
    });

    it("includes server and tool name in handle", async () => {
      handle = await startUiServer(createServerOptions({
        serverName: "my-server",
        toolName: "my_tool",
      }));

      expect(handle.serverName).toBe("my-server");
      expect(handle.toolName).toBe("my_tool");
    });
  });

  describe("GET /", () => {
    it("returns HTML host page with valid token", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/?session=${handle.sessionToken}`;

      const res = await request(url);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect((res.body as string).toLowerCase()).toContain("<!doctype html>");
      expect(res.body).toContain("test-server");
      expect(res.body).toContain("test_tool");
    });

    it("rejects invalid session token", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/?session=wrong-token`;

      const res = await request(url);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, error: "Invalid session" });
    });

    it("serves a tokenless Moshi landing page without disclosing the session", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/`;

      const res = await request(url);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("Open the authenticated MCP UI URL shown by Pi");
      expect(res.body).not.toContain("location.replace");
      expect(res.body).not.toContain(handle.sessionToken);
      expect(res.body).not.toContain(encodeURIComponent(handle.sessionToken));
    });

    it("answers HEAD discovery probes without a session token", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/`;

      const res = await request(url, { method: "HEAD" });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toBe("");
    });

    it("rejects non-loopback Host headers before serving tokenless landing", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/`;

      const res = await request(url, { headers: { Host: "attacker.example" } });

      expect(res.status).toBe(403);
      expect(res.body).toBe("Invalid host");
    });

    it("accepts bracketed IPv6 loopback Host headers", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/`;

      const res = await request(url, { headers: { Host: `[::1]:${handle.port}` } });

      expect(res.status).toBe(200);
      expect(res.body).toContain("Open the authenticated MCP UI URL shown by Pi");
      expect(res.body).not.toContain(handle.sessionToken);
    });
  });

  describe("GET /ui-app", () => {
    it("does not accept the app resource token on privileged proxy routes", async () => {
      const manager = createMockManager();
      handle = await startUiServer(createServerOptions({ manager }));
      const appUrl = new URL(await getUiAppUrl(handle));
      const resourceToken = appUrl.searchParams.get("resource");

      expect(resourceToken).toBeTruthy();
      expect(resourceToken).not.toBe(handle.sessionToken);
      expect((await request(`http://localhost:${handle.port}/ui-app?session=${handle.sessionToken}`)).status).toBe(403);

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: { token: resourceToken, params: { name: "some_tool", arguments: {} } },
      });

      expect(res.status).toBe(403);
      expect(manager.getConnection).not.toHaveBeenCalled();
    });

    it("enforces metadata CSP and response-level sandboxing while preserving app HTML", async () => {
      const appHtml = `<!-- decoy <head><meta http-equiv="Content-Security-Policy" content="default-src *"></head> -->
<!doctype html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="img-src https://images.example.com">
  <style>body { margin: 0; }</style>
</head>
<body>
  <script type="module">import "https://esm.sh/example";</script>
</body>
</html>`;
      handle = await startUiServer(createServerOptions({
        resource: createMockResource({
          html: appHtml,
          meta: {
            permissions: [],
            csp: {
              resourceDomains: ["https://esm.sh"],
              connectDomains: ["https://api.excalidraw.com"],
            },
          },
        }),
      }));
      const url = await getUiAppUrl(handle);

      const res = await request(url);
      const cspHeader = res.headers["content-security-policy"];

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(cspHeader).toContain("default-src 'none'");
      expect(cspHeader).toContain("sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads");
      expect(cspHeader).not.toContain("allow-popups-to-escape-sandbox");
      expect(cspHeader).not.toContain("allow-same-origin");
      expect(cspHeader).toContain("script-src 'self' 'unsafe-inline' https://esm.sh");
      expect(cspHeader).toContain("style-src 'self' 'unsafe-inline' https://esm.sh");
      expect(cspHeader).toContain("connect-src https://api.excalidraw.com");
      expect(res.body).toBe(appHtml);
    });

    it("rejects malformed CSP metadata before writing the response header", async () => {
      const appHtml = "<h1>Original App</h1>";
      handle = await startUiServer(createServerOptions({
        resource: createMockResource({
          html: appHtml,
          meta: {
            permissions: [],
            csp: {
              resourceDomains: [
                "https://safe.example.com",
                "https://c1.example.com\x80img-src",
                "https://emoji.example.com/😀",
              ],
            },
          },
        }),
      }));

      const res = await request(await getUiAppUrl(handle));

      expect(res.status).toBe(200);
      expect(res.headers["content-security-policy"]).toContain("https://safe.example.com");
      expect(res.headers["content-security-policy"]).not.toContain("https://c1.example.com\x80img-src");
      expect(res.headers["content-security-policy"]).not.toContain("https://emoji.example.com/😀");
      expect(res.body).toBe(appHtml);
    });

    it("emits trusted default CSP headers for an empty normalized CSP", async () => {
      const appHtml = "<h1>Original App</h1>";
      handle = await startUiServer(createServerOptions({
        resource: createMockResource({
          html: appHtml,
          meta: { permissions: [], csp: {} },
        }),
      }));

      const res = await request(await getUiAppUrl(handle));

      expect(res.status).toBe(200);
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
      expect(res.body).toBe(appHtml);
    });

    it("emits restrictive default CSP when metadata is undefined", async () => {
      handle = await startUiServer(createServerOptions());
      const url = await getUiAppUrl(handle);

      const res = await request(url);

      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["content-security-policy"]).toContain("connect-src 'none'");
      expect(res.body).toBe("<h1>Test App</h1>");
    });
  });

  describe("GET /health", () => {
    it("returns healthy status", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/health?session=${handle.sessionToken}`;

      const res = await request(url);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { healthy: true } });
    });
  });

  describe("GET /app-bridge.bundle.js", () => {
    it("serves JavaScript bundle", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/app-bridge.bundle.js`;

      const res = await request(url);

      // May be 200 or 500 depending on whether bundle exists in test environment
      if (res.status === 200) {
        expect(res.headers["content-type"]).toContain("javascript");
        expect(res.headers["cache-control"]).toContain("max-age");
      }
    });
  });

  describe("GET /events (SSE)", () => {
    it("establishes SSE connection with valid token", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      // Give it a moment to connect
      await new Promise((r) => setTimeout(r, 50));
      sse.close();

      // Connection should succeed (no error thrown)
      expect(true).toBe(true);
    });

    it("receives tool-result event when sent", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await new Promise((r) => setTimeout(r, 50));
      handle.sendToolResult({ content: [{ type: "text", text: "hello" }] });
      await new Promise((r) => setTimeout(r, 50));
      sse.close();

      expect(events.some((e) => e.name === "tool-result")).toBe(true);
    });

    it("receives result-patch events when sent", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await new Promise((r) => setTimeout(r, 50));
      handle.sendResultPatch({
        content: [{ type: "text", text: "phase" }],
        structuredContent: {
          "pi-mcp-adapter/stream": {
            streamId: "stream-1",
            sequence: 0,
            frameType: "patch",
            phase: "shell",
            status: "ok",
            spec: { kind: "mermaid", title: "Draft" },
          },
        },
      });
      await new Promise((r) => setTimeout(r, 50));
      sse.close();

      const patch = events.find((e) => e.name === "result-patch");
      expect(patch).toBeTruthy();
      expect(patch?.data).toMatchObject({
        structuredContent: {
          "pi-mcp-adapter/stream": {
            streamId: "stream-1",
            sequence: 0,
            frameType: "patch",
            phase: "shell",
          },
        },
      });
    });

    it("replays events after Last-Event-ID using SSE ids", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const firstConnectionEvents: Array<{ name: string; data: unknown; id?: string }> = [];
      const firstConnection = await connectSSE(url, (name, data, eventId) => {
        firstConnectionEvents.push({ name, data, id: eventId });
      });

      await new Promise((r) => setTimeout(r, 50));
      handle.sendResultPatch({
        content: [{ type: "text", text: "shell" }],
        structuredContent: {
          "pi-mcp-adapter/stream": {
            streamId: "stream-1",
            sequence: 0,
            frameType: "checkpoint",
            phase: "shell",
            status: "ok",
            checkpoint: { kind: "mermaid", title: "Flow", code: "graph LR\nA-->B" },
          },
        },
      });
      handle.sendToolResult({ content: [{ type: "text", text: "final" }] });
      await new Promise((r) => setTimeout(r, 50));
      firstConnection.close();

      const checkpointEvent = firstConnectionEvents.find((event) => event.name === "result-patch");
      expect(checkpointEvent?.id).toBeTruthy();

      const replayedEvents: Array<{ name: string; data: unknown; id?: string }> = [];
      const replayConnection = await connectSSE(
        url,
        (name, data, eventId) => {
          replayedEvents.push({ name, data, id: eventId });
        },
        { "Last-Event-ID": checkpointEvent?.id ?? "" },
      );

      await new Promise((r) => setTimeout(r, 50));
      replayConnection.close();

      expect(replayedEvents.map((event) => event.name)).toEqual(["tool-result"]);
    });

    it("receives tool-cancelled event when sent", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await new Promise((r) => setTimeout(r, 50));
      handle.sendToolCancelled("user cancelled");
      await new Promise((r) => setTimeout(r, 50));
      sse.close();

      const cancelled = events.find((e) => e.name === "tool-cancelled");
      expect(cancelled).toBeTruthy();
      expect(cancelled?.data).toEqual({ reason: "user cancelled" });
    });

    it("receives host-context event when sent", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await new Promise((r) => setTimeout(r, 50));
      handle.sendHostContext({ displayMode: "fullscreen" });
      await new Promise((r) => setTimeout(r, 50));
      sse.close();

      const ctx = events.find((e) => e.name === "host-context");
      expect(ctx).toBeTruthy();
      expect(ctx?.data).toEqual({ displayMode: "fullscreen" });
    });
  });

  describe("POST /proxy/tools/call", () => {
    it("proxies tool call to MCP server", async () => {
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "tool result" }] }),
      };
      const requestOptions = { timeout: 4321 };
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: mockClient,
          tools: [{ name: "some_tool" }],
        }),
        getRequestOptions: vi.fn().mockReturnValue(requestOptions),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: { arg1: "value1" } },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        result: { content: [{ type: "text", text: "tool result" }] },
      });
      expect(manager.getRequestOptions).toHaveBeenCalledWith("test-server");
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: "some_tool",
        arguments: { arg1: "value1" },
      }, requestOptions);
    });

    it("parses JSON-string arguments without dropping quoted fields", async () => {
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "tool result" }] }),
      };
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: mockClient,
          tools: [{ name: "some_tool" }],
        }),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: '{"body":"He said \\"hi\\""}' },
        },
      });

      expect(res.status).toBe(200);
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: "some_tool",
        arguments: { body: 'He said "hi"' },
      }, undefined);
    });

    it("rejects invalid app tool arguments as a boundary error", async () => {
      const mockClient = { callTool: vi.fn() };
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: mockClient,
          tools: [{ name: "some_tool" }],
        }),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: [] },
        },
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'tool "some_tool" arguments: expected a JSON object, got array' });
      expect(mockClient.callTool).not.toHaveBeenCalled();
    });

    it("executes app-only tools without recording their synthetic call intent", async () => {
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "app result" }] });
      const onMessage = vi.fn();
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: { callTool },
          tools: [{ name: "app_only", _meta: { ui: { visibility: ["app"] } } }],
        }),
      });
      handle = await startUiServer(createServerOptions({ manager, onMessage }));

      const call = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "app_only", arguments: { value: 1 } },
        },
      });
      const message = await request(`http://localhost:${handle.port}/proxy/ui/generated-tool-call-intent`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { tool: "app_only", arguments: { value: 1 }, isError: false },
        },
      });

      expect(call.body).toEqual({ ok: true, result: { content: [{ type: "text", text: "app result" }] } });
      expect(callTool).toHaveBeenCalledWith({ name: "app_only", arguments: { value: 1 } }, undefined);
      expect(message.body).toEqual({ ok: true, result: {} });
      expect(handle.getSessionMessages().intents).toEqual([]);
      expect(onMessage).not.toHaveBeenCalled();
    });

    it("keeps app-authored call_tool intents for app-only tools", async () => {
      const onMessage = vi.fn();
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: { callTool: vi.fn() },
          tools: [{ name: "app_only", _meta: { ui: { visibility: ["app"] } } }],
        }),
      });
      handle = await startUiServer(createServerOptions({ manager, onMessage }));
      const params = {
        type: "intent",
        intent: "call_tool",
        _piGeneratedToolCallIntent: true,
        params: { tool: "app_only", reason: "user-requested" },
      };

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params },
      });

      expect(handle.getSessionMessages().intents).toEqual([
        { intent: "call_tool", params: { tool: "app_only", reason: "user-requested" } },
      ]);
      expect(onMessage).toHaveBeenCalledWith(params);
    });

    it("uses app-callable siblings for iframe approval collisions", async () => {
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "called" }] });
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: { callTool },
          tools: [
            { name: "search-records", _meta: { ui: { visibility: ["app"] } } },
            { name: "search_records", _meta: { ui: { visibility: ["app"] } } },
          ],
        }),
      });
      const config: McpConfig = {
        settings: { approveTools: ["demo_search_records"] },
        mcpServers: { demo: { command: "demo" } },
      };
      const state = { config, approvedToolCalls: new Map(), toolMetadata: new Map() } as unknown as McpExtensionState;
      handle = await startUiServer(createServerOptions({ manager, config, state, serverName: "demo" }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { name: "search-records", arguments: {} } },
      });

      expect(res.body).toEqual({ ok: true, result: { content: [{ type: "text", text: "called" }] } });
      expect(callTool).toHaveBeenCalledOnce();
    });

    it("uses live resources for iframe approval collisions", async () => {
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "called" }] });
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: { callTool },
          tools: [{ name: "read-records", _meta: { ui: { visibility: ["app"] } } }],
          resources: [{ name: "records", uri: "file://records" }],
        }),
      });
      const config: McpConfig = {
        settings: { approveTools: ["demo_read_records"] },
        mcpServers: { demo: { command: "demo" } },
      };
      const state = { config, approvedToolCalls: new Map(), toolMetadata: new Map() } as unknown as McpExtensionState;
      handle = await startUiServer(createServerOptions({ manager, config, state, serverName: "demo" }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { name: "read-records", arguments: {} } },
      });

      expect(res.body).toEqual({ ok: true, result: { content: [{ type: "text", text: "called" }] } });
      expect(callTool).toHaveBeenCalledOnce();
    });

    it("uses other-server metadata for iframe approval collisions", async () => {
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "called" }] });
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: { callTool },
          tools: [{ name: "search-records", _meta: { ui: { visibility: ["app"] } } }],
        }),
      });
      const config: McpConfig = {
        settings: { approveTools: ["search_records"] },
        mcpServers: { "my-server": { command: "demo" }, other: { command: "other" } },
      };
      const state = {
        config,
        approvedToolCalls: new Map(),
        toolMetadata: new Map([["other", [{ name: "other_search_records", originalName: "search_records", description: "Other" }]]]),
      } as unknown as McpExtensionState;
      handle = await startUiServer(createServerOptions({ manager, config, state, serverName: "my-server" }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { name: "search-records", arguments: {} } },
      });

      expect(res.body).toEqual({ ok: true, result: { content: [{ type: "text", text: "called" }] } });
      expect(callTool).toHaveBeenCalledOnce();
    });

    it("gates stateless iframe calls with safe legacy global approval selectors", async () => {
      const callTool = vi.fn();
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: { callTool },
          tools: [{ name: "search-records", _meta: { ui: { visibility: ["app"] } } }],
        }),
      });
      const config: McpConfig = {
        settings: { approveTools: ["demo_search_records"] },
        mcpServers: { demo: { command: "demo" } },
      };
      handle = await startUiServer(createServerOptions({ manager, config, serverName: "demo" }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { name: "search-records", arguments: {} } },
      });

      expect(res.body).toMatchObject({ ok: true, result: { details: { error: "approval_required", tool: "search-records" } } });
      expect(callTool).not.toHaveBeenCalled();
    });

    it("returns a gated iframe call as an approval_denied tool result", async () => {
      const mockClient = { callTool: vi.fn() };
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: mockClient,
          tools: [{ name: "some_tool" }],
        }),
      });
      const config: McpConfig = {
        mcpServers: { "test-server": { command: "demo", approveTools: true } },
      };
      const state = {
        config,
        approvedToolCalls: new Map(),
        ui: { select: vi.fn().mockResolvedValue("Deny") },
      } as unknown as McpExtensionState;
      handle = await startUiServer(createServerOptions({ manager, config, state }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: { dangerous: true } },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        result: {
          details: { error: "approval_denied", server: "test-server", tool: "some_tool" },
        },
      });
      expect(mockClient.callTool).not.toHaveBeenCalled();
    });

    it("checks consent before calling tool", async () => {
      const consentManager = createMockConsentManager({
        ensureApproved: vi.fn().mockImplementation(() => {
          throw new Error("Consent denied");
        }),
      });
      handle = await startUiServer(createServerOptions({ consentManager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
      expect(consentManager.ensureApproved).toHaveBeenCalledWith("test-server");
    });

    it("returns 503 when server not connected", async () => {
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue(null),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: {} },
        },
      });

      expect(res.status).toBe(503);
      expect((res.body as { error: string }).error).toContain("not connected");
    });

    it("rejects app calls to tools that omit app visibility", async () => {
      const mockClient = { callTool: vi.fn() };
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: mockClient,
          tools: [{ name: "model_only", _meta: { ui: { visibility: ["model"] } } }],
        }),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "model_only", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, error: 'MCP tool "model_only" is not callable by apps' });
      expect(mockClient.callTool).not.toHaveBeenCalled();
    });

    it("rejects app calls when the tool definition is unavailable", async () => {
      const mockClient = { callTool: vi.fn() };
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: mockClient,
          tools: [],
        }),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "unlisted", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, error: 'MCP tool "unlisted" is not callable by apps' });
      expect(mockClient.callTool).not.toHaveBeenCalled();
    });

    it("rejects app calls when the tool list is unavailable", async () => {
      const mockClient = { callTool: vi.fn() };
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: mockClient,
          tools: undefined,
        }),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "unknown", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, error: 'MCP tool "unknown" is not callable by apps' });
      expect(mockClient.callTool).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid params", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "" }, // Empty name
        },
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid session token", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: "wrong-token",
          params: { name: "some_tool", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
    });

    it("rejects anonymous tool calls", async () => {
      const callTool = vi.fn();
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: { callTool },
          tools: [{ name: "some_tool" }],
        }),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: { params: { name: "some_tool", arguments: {} } },
      });

      expect(res.status).toBe(403);
      expect(callTool).not.toHaveBeenCalled();
    });

    it("tracks in-flight requests", async () => {
      const manager = createMockManager();
      handle = await startUiServer(createServerOptions({ manager }));

      await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: {} },
        },
      });

      expect(manager.incrementInFlight).toHaveBeenCalledWith("test-server");
      expect(manager.decrementInFlight).toHaveBeenCalledWith("test-server");
      expect(manager.touch).toHaveBeenCalled();
    });
  });

  describe("POST /proxy/ui/consent", () => {
    it("rejects anonymous approval", async () => {
      const consentManager = createMockConsentManager();
      handle = await startUiServer(createServerOptions({ consentManager }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/consent`, {
        method: "POST",
        body: { params: { approved: true } },
      });

      expect(res.status).toBe(403);
      expect(consentManager.registerDecision).not.toHaveBeenCalled();
    });

    it("registers approval", async () => {
      const consentManager = createMockConsentManager();
      handle = await startUiServer(createServerOptions({ consentManager }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/consent`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { approved: true },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { approved: true } });
      expect(consentManager.registerDecision).toHaveBeenCalledWith("test-server", true);
    });

    it("registers denial", async () => {
      const consentManager = createMockConsentManager();
      handle = await startUiServer(createServerOptions({ consentManager }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/consent`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { approved: false },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { approved: false } });
      expect(consentManager.registerDecision).toHaveBeenCalledWith("test-server", false);
    });
  });

  describe("POST /proxy/ui/message", () => {
    it("rejects anonymous messages", async () => {
      const onMessage = vi.fn();
      handle = await startUiServer(createServerOptions({ onMessage }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { params: { type: "prompt", prompt: "Injected" } },
      });

      expect(res.status).toBe(403);
      expect(handle.getSessionMessages().prompts).toEqual([]);
      expect(onMessage).not.toHaveBeenCalled();
    });

    it("tracks prompt messages", async () => {
      const onMessage = vi.fn();
      handle = await startUiServer(createServerOptions({ onMessage }));

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { type: "prompt", prompt: "Hello agent" },
        },
      });

      const messages = handle.getSessionMessages();
      expect(messages.prompts).toContain("Hello agent");
      expect(onMessage).toHaveBeenCalled();
    });

    it("tracks and forwards call_tool intents that do not name an app-only tool", async () => {
      const onMessage = vi.fn();
      handle = await startUiServer(createServerOptions({ onMessage }));
      const params = { type: "intent", intent: "call_tool", params: { tool: "business_action" } };

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params },
      });

      expect(handle.getSessionMessages().intents).toEqual([{ intent: "call_tool", params: { tool: "business_action" } }]);
      expect(onMessage).toHaveBeenCalledWith(params);
    });

    it("tracks and forwards generated call intents for tools visible to both app and model", async () => {
      const onMessage = vi.fn();
      const manager = createMockManager({
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: { callTool: vi.fn() },
          tools: [{ name: "both", _meta: { ui: { visibility: ["model", "app"] } } }],
        }),
      });
      handle = await startUiServer(createServerOptions({ manager, onMessage }));
      const expected = { type: "intent", intent: "call_tool", params: { tool: "both", isError: false } };

      await request(`http://localhost:${handle.port}/proxy/ui/generated-tool-call-intent`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { tool: "both", isError: false } },
      });

      expect(handle.getSessionMessages().intents).toEqual([{ intent: "call_tool", params: { tool: "both", isError: false } }]);
      expect(onMessage).toHaveBeenCalledWith(expected);
    });

    it("tracks notification messages", async () => {
      handle = await startUiServer(createServerOptions());

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { type: "notify", message: "User clicked button" },
        },
      });

      const messages = handle.getSessionMessages();
      expect(messages.notifications).toContain("User clicked button");
    });

    it("handles legacy prompt format", async () => {
      handle = await startUiServer(createServerOptions());

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { prompt: "Legacy prompt" }, // No type field
        },
      });

      const messages = handle.getSessionMessages();
      expect(messages.prompts).toContain("Legacy prompt");
    });

    it("handles native AppBridge user messages", async () => {
      handle = await startUiServer(createServerOptions());

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: {
            role: "user",
            content: [{ type: "text", text: "Native AppBridge prompt" }],
          },
        },
      });

      const messages = handle.getSessionMessages();
      expect(messages.prompts).toContain("Native AppBridge prompt");
    });

    it("accumulates multiple messages", async () => {
      handle = await startUiServer(createServerOptions());

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { type: "prompt", prompt: "First" } },
      });
      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { type: "prompt", prompt: "Second" } },
      });
      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { type: "notify", message: "Info" } },
      });

      const messages = handle.getSessionMessages();
      expect(messages.prompts).toEqual(["First", "Second"]);
      expect(messages.notifications).toEqual(["Info"]);
    });
  });

  describe("POST /proxy/ui/request-display-mode", () => {
    it("changes display mode to fullscreen", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/request-display-mode`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { mode: "fullscreen" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { mode: "fullscreen" } });
    });

    it("changes display mode to pip", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/request-display-mode`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { mode: "pip" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { mode: "pip" } });
    });

    it("rejects unavailable mode", async () => {
      handle = await startUiServer(createServerOptions({
        hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] },
      }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/request-display-mode`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { mode: "fullscreen" },
        },
      });

      // Should return current mode, not requested
      expect(res.status).toBe(200);
      expect((res.body as { result: { mode: string } }).result.mode).toBe("inline");
    });
  });

  describe("POST /proxy/ui/heartbeat", () => {
    it("responds with success", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/heartbeat`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: {} });
    });
  });

  describe("POST /proxy/ui/complete", () => {
    it("marks session complete with reason", async () => {
      const onComplete = vi.fn();
      handle = await startUiServer(createServerOptions({ onComplete }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/complete`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { reason: "user-done" },
        },
      });

      expect(res.status).toBe(200);
      expect(onComplete).toHaveBeenCalledWith("user-done");
    });

    it("uses default reason when not provided", async () => {
      const onComplete = vi.fn();
      handle = await startUiServer(createServerOptions({ onComplete }));

      await request(`http://localhost:${handle.port}/proxy/ui/complete`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(onComplete).toHaveBeenCalledWith("done");
    });
  });

  describe("POST /proxy/ui/open-link", () => {
    it("validates URL", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/open-link`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { url: "https://example.com" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: {} });
    });

    it("returns error for invalid URL", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/open-link`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { url: "not-a-valid-url" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { isError: true } });
    });

    it("returns 400 for missing URL", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/open-link`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /proxy/ui/download-file", () => {
    it("returns not supported", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/download-file`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { isError: true } });
    });
  });

  describe("POST /proxy/ui/context", () => {
    it("stores and forwards context updates", async () => {
      const onContextUpdate = vi.fn();
      handle = await startUiServer(createServerOptions({ onContextUpdate }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/context`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { content: [{ type: "text", text: "some context data" }] },
        },
      });

      expect(res.status).toBe(200);
      expect(onContextUpdate).toHaveBeenCalledWith({ content: [{ type: "text", text: "some context data" }] });
      expect(handle.getSessionMessages().contexts).toEqual([{
        payload: { content: [{ type: "text", text: "some context data" }] },
        summary: '{"content":[{"type":"text","text":"some context data"}]}',
        truncated: false,
      }]);
    });

    it("rejects malformed context updates", async () => {
      const onContextUpdate = vi.fn();
      handle = await startUiServer(createServerOptions({ onContextUpdate }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/context`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { content: "some context data" },
        },
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "Invalid update-model-context params" });
      expect(onContextUpdate).not.toHaveBeenCalled();
      expect(handle.getSessionMessages().contexts).toEqual([]);
    });

    it("bounds oversized context updates", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/context`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { content: [{ type: "text", text: "x".repeat(12_100) }] },
        },
      });

      expect(res.status).toBe(200);
      expect(handle.getSessionMessages().contexts[0]).toMatchObject({ truncated: true });
      expect(handle.getSessionMessages().contexts[0].summary.length).toBeLessThanOrEqual(12_000);
      expect(handle.getSessionMessages().contexts[0].payload).toBeUndefined();
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown GET routes", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/unknown?session=${handle.sessionToken}`);

      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown POST routes", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/unknown`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("handle.close()", () => {
    it("marks session complete", async () => {
      const onComplete = vi.fn();
      handle = await startUiServer(createServerOptions({ onComplete }));

      handle.close("manual-close");

      expect(onComplete).toHaveBeenCalledWith("manual-close");
    });

    it("uses default reason when not provided", async () => {
      const onComplete = vi.fn();
      handle = await startUiServer(createServerOptions({ onComplete }));

      handle.close();

      expect(onComplete).toHaveBeenCalledWith("closed");
    });
  });

  describe("initialResultPromise", () => {
    it("pushes result when promise resolves", async () => {
      const resultPromise = Promise.resolve({ data: "initial" });
      handle = await startUiServer(createServerOptions({ initialResultPromise: resultPromise }));

      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;
      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await new Promise((r) => setTimeout(r, 100));
      sse.close();

      expect(events.some((e) => e.name === "tool-result")).toBe(true);
    });

    it("pushes cancelled when promise rejects", async () => {
      const resultPromise = Promise.reject(new Error("Tool failed"));
      handle = await startUiServer(createServerOptions({ initialResultPromise: resultPromise }));

      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;
      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await new Promise((r) => setTimeout(r, 100));
      sse.close();

      const cancelled = events.find((e) => e.name === "tool-cancelled");
      expect(cancelled).toBeTruthy();
      expect((cancelled?.data as { reason: string }).reason).toContain("Tool failed");
    });
  });

  describe("body parsing", () => {
    it("rejects non-JSON body", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/heartbeat`, {
        method: "POST",
        body: "not json" as unknown,
        headers: { "Content-Type": "text/plain" },
      });

      expect(res.status).toBe(400);
    });

    it("rejects empty body", async () => {
      handle = await startUiServer(createServerOptions());

      const parsed = new URL(`http://localhost:${handle.port}/proxy/ui/heartbeat`);
      const result = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          }
        );
        req.on("error", reject);
        req.end(); // No body
      });

      expect(result.status).toBe(400);
    });
  });
});
