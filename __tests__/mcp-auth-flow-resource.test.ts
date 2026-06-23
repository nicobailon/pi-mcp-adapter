import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SERVER_URL = "https://portal.mcp.cfdata.org/mcp?codemode=search_and_execute";
const CANONICAL_RESOURCE = "https://portal.mcp.cfdata.org/mcp";
const AUTH_SERVER = "https://auth.example.com";

describe("mcp-auth-flow OAuth protected-resource metadata", () => {
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-resource-"));
    process.env.MCP_OAUTH_DIR = authDir;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { shutdownOAuth } = await import("../mcp-auth-flow.ts");
    await shutdownOAuth();
    rmSync(authDir, { recursive: true, force: true });
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
  });

  it("trusts the MCP SDK to use metadata.resource for OAuth while keeping the queryful transport URL", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });

      if (url === "https://portal.mcp.cfdata.org/.well-known/oauth-protected-resource/mcp?codemode=search_and_execute") {
        return Response.json({
          resource: CANONICAL_RESOURCE,
          authorization_servers: [AUTH_SERVER],
        });
      }

      if (url === `${AUTH_SERVER}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: AUTH_SERVER,
          authorization_endpoint: `${AUTH_SERVER}/authorize`,
          token_endpoint: `${AUTH_SERVER}/token`,
          registration_endpoint: `${AUTH_SERVER}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }

      if (url === `${AUTH_SERVER}/register`) {
        const registration = JSON.parse(String(init?.body));
        return Response.json({
          client_id: "client-from-registration",
          redirect_uris: registration.redirect_uris,
        }, { status: 201 });
      }

      return new Response("not found", { status: 404 });
    }));

    const { startAuth } = await import("../mcp-auth-flow.ts");
    const { getAuthEntry } = await import("../mcp-auth.ts");

    const result = await startAuth("cf-portal-codemode", SERVER_URL, {
      url: SERVER_URL,
      auth: "oauth",
    });

    expect(requests[0]).toEqual({
      url: "https://portal.mcp.cfdata.org/.well-known/oauth-protected-resource/mcp?codemode=search_and_execute",
      method: "GET",
    });

    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.searchParams.get("resource")).toBe(CANONICAL_RESOURCE);
    expect(getAuthEntry("cf-portal-codemode")?.serverUrl).toBe(SERVER_URL);
  });
});
