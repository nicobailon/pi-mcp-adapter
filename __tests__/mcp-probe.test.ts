import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMcpEndpoint } from "../mcp-probe.ts";

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function mockFetch(...responses: Response[]): void {
  for (const response of responses) {
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await response.text();
      let body = text;
      try {
        const payload = JSON.parse(text);
        if (payload.jsonrpc === "2.0") payload.id = JSON.parse(await request.text()).id;
        body = JSON.stringify(payload);
      } catch { /* Non-JSON fixture. */ }
      return new Response(body, { status: response.status, headers: response.headers });
    });
  }
  vi.stubGlobal("fetch", fetchMock);
}

describe("MCP endpoint shape probe", () => {
  it("classifies an HTML 200 response as not MCP", async () => {
    mockFetch(new Response("<html>Welcome</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({
      isMcp: false,
      classification: expect.stringContaining("HTML (200)"),
    });
  });

  it("classifies a GraphQL-style JSON error as not MCP", async () => {
    mockFetch(
      new Response(JSON.stringify({ errors: [{ message: "Cannot query field" }] }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ errors: [{ message: "Cannot query field" }] }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(probeMcpEndpoint("https://example.test/graphql")).resolves.toMatchObject({
      isMcp: false,
      classification: expect.stringContaining("application/json (400)"),
    });
  });

  it("reports a transient server error without claiming the URL is not MCP", async () => {
    mockFetch(new Response(JSON.stringify({
      error: "temporarily_unavailable",
      error_description: "Credential validation is temporarily unavailable",
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));

    const result = await probeMcpEndpoint("https://example.test/mcp");

    expect(result).toMatchObject({
      isMcp: false,
      classification: expect.stringContaining("temporarily unavailable"),
    });
    expect(result.classification).not.toContain("does not appear to speak MCP");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an accepted response without claiming the URL is not MCP", async () => {
    mockFetch(new Response("Accepted", {
      status: 202,
      headers: { "content-type": "application/json" },
    }));

    const result = await probeMcpEndpoint("https://example.test/mcp");

    expect(result).toMatchObject({
      isMcp: false,
      classification: "endpoint returned application/json (202) — MCP endpoint shape could not be determined",
    });
    expect(result.classification).not.toContain("does not appear to speak MCP");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 7_000);

  it("reports an unauthenticated response without claiming the URL is not MCP", async () => {
    mockFetch(
      new Response("Unauthorized", { status: 401, headers: { "content-type": "application/json" } }),
      new Response("Unauthorized", { status: 401, headers: { "content-type": "application/json" } }),
    );

    const result = await probeMcpEndpoint("https://example.test/mcp");

    expect(result).toMatchObject({
      isMcp: false,
      classification: "endpoint returned application/json (401) — authentication may be required; MCP endpoint shape could not be determined",
    });
    expect(result.classification).not.toContain("does not appear to speak MCP");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an earlier unauthenticated probe classification when fallbacks are inconclusive", async () => {
    mockFetch(
      new Response("Unauthorized", { status: 401, headers: { "content-type": "application/json" } }),
      new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } }),
      new Response("Method Not Allowed", { status: 405, headers: { "content-type": "text/plain" } }),
    );

    const result = await probeMcpEndpoint("https://example.test/mcp");

    expect(result).toMatchObject({
      isMcp: false,
      classification: "endpoint returned application/json (401) — authentication may be required; MCP endpoint shape could not be determined",
    });
    expect(result.classification).not.toContain("does not appear to speak MCP");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recognizes a modern stateless server/discover response", async () => {
    mockFetch(new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { supportedVersions: ["2026-07-28"], capabilities: {}, ttlMs: 0, cacheScope: "private", resultType: "complete" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({
      isMcp: true,
      classification: expect.stringContaining("stateless MCP 2026-07-28"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({
      jsonrpc: "2.0", method: "server/discover", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      } },
    });
    const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
    expect(request.method).toBe("POST");
    expect(Object.fromEntries(request.headers)).toMatchObject({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    });
  });

  it("recognizes a modern Bearer JSON-RPC authentication error", async () => {
    mockFetch(new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Unauthorized" },
    }), {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    }));

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({
      isMcp: true,
      classification: "endpoint requires Bearer authentication during MCP 2026-07-28 server/discover probing",
    });
  });

  it("falls back to legacy when server/discover returns method not found", async () => {
    mockFetch(
      new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({
      isMcp: true,
      classification: "endpoint responded with a JSON-RPC 2.0 envelope",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to legacy when server/discover returns a different protocol version", async () => {
    mockFetch(
      new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({
      isMcp: true,
      classification: "endpoint responded with a JSON-RPC 2.0 envelope",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recognizes an SSE response after the modern probe gets a legacy-style 400", async () => {
    mockFetch(
      new Response("Method not supported", { status: 400 }),
      new Response("event: message\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({ isMcp: true });
  });

  it("retries GET after a POST 405", async () => {
    mockFetch(
      new Response("Method Not Allowed", { status: 405 }),
      new Response("Method Not Allowed", { status: 405 }),
      new Response("event: message\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({ isMcp: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ headers: { Accept: "text/event-stream" } });
    expect(fetchMock.mock.calls[2]?.[1]?.signal).not.toBe(fetchMock.mock.calls[1]?.[1]?.signal);
  });
});
