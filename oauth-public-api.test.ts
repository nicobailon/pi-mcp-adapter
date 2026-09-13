/**
 * Tests for the public OAuth token reuse API.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";

const {
  getMcpOAuthTokensForUrl,
  inspectMcpOAuthTokensForUrl,
  updateMcpOAuthTokensForUrl,
} = await import("pi-mcp-adapter/oauth");
const {
  getAuthForUrl,
  resetTestAuthSecretStore,
  saveAuthEntry,
} = await import("./mcp-auth.ts");

describe("public OAuth token API", () => {
  beforeEach(() => {
    resetTestAuthSecretStore();
  });

  it("reads and updates URL-bound tokens through the package export", async () => {
    const expiresAt = Date.now() / 1000 + 3600;
    updateMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp", {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt,
      scope: "read write",
    });

    assert.deepStrictEqual(await getMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp"), {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt,
      scope: "read write",
    });
    assert.deepStrictEqual(inspectMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp"), {
      status: "present",
      tokens: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt,
        scope: "read write",
      },
    });
  });

  it("does not return tokens for a different URL", async () => {
    updateMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp", { accessToken: "access-1" });

    assert.strictEqual(await getMcpOAuthTokensForUrl("jira", "https://other.example.com/mcp"), undefined);
    assert.deepStrictEqual(inspectMcpOAuthTokensForUrl("jira", "https://other.example.com/mcp"), {
      status: "absent",
    });
  });

  it("does not expose client info or OAuth flow secrets", () => {
    saveAuthEntry("jira", {
      tokens: { accessToken: "access-1" },
      clientInfo: { clientId: "client-1", clientSecret: "secret-1" },
      codeVerifier: "verifier-1",
      oauthState: "state-1",
      serverUrl: "https://jira.example.com/mcp",
    }, "https://jira.example.com/mcp");

    const status = inspectMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp");
    assert.deepStrictEqual(status, { status: "present", tokens: { accessToken: "access-1" } });
    assert(!("entry" in status));
  });

  it("does not return refreshable expired tokens as valid when refresh cannot complete", async () => {
    const expiresAt = Date.now() / 1000 - 3600;
    saveAuthEntry("jira", {
      tokens: {
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        expiresAt,
      },
      clientInfo: { clientId: "config-client", configPreRegistered: true },
      serverUrl: "https://jira.example.com/mcp",
    }, "https://jira.example.com/mcp");

    assert.strictEqual(await getMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp"), undefined);
    assert.deepStrictEqual(inspectMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp"), {
      status: "present",
      tokens: {
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        expiresAt,
      },
    });
  });

  it("fails closed when the secure credential store is unavailable", async () => {
    const previous = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    resetTestAuthSecretStore();
    try {
      await assert.rejects(
        () => getMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp"),
        /Failed to read OAuth credentials.*OS secure credential store/,
      );
      const status = inspectMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp");
      assert.strictEqual(status.status, "unavailable");
    } finally {
      if (previous === undefined) {
        delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
      } else {
        process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = previous;
      }
      resetTestAuthSecretStore();
    }
  });

  it("clears stale URL-bound state when tokens move to another URL", async () => {
    saveAuthEntry("jira", {
      tokens: { accessToken: "old-token" },
      clientInfo: { clientId: "old-client" },
      codeVerifier: "old-verifier",
      oauthState: "old-state",
      serverUrl: "https://old.example.com/mcp",
    }, "https://old.example.com/mcp");

    updateMcpOAuthTokensForUrl("jira", "https://new.example.com/mcp", { accessToken: "new-token" });

    assert.strictEqual(await getMcpOAuthTokensForUrl("jira", "https://old.example.com/mcp"), undefined);
    assert.deepStrictEqual(await getMcpOAuthTokensForUrl("jira", "https://new.example.com/mcp"), {
      accessToken: "new-token",
    });
    const privateEntry = getAuthForUrl("jira", "https://new.example.com/mcp");
    assert.strictEqual(privateEntry?.clientInfo, undefined);
    assert.strictEqual(privateEntry?.codeVerifier, undefined);
    assert.strictEqual(privateEntry?.oauthState, undefined);
  });
});
