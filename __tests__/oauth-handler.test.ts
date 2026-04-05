import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-"));
  vi.stubEnv("HOME", tempHome);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tempHome, { recursive: true, force: true });
});

describe("oauth-handler", () => {
  it("persists tokens with refresh metadata and reads them back", async () => {
    const mod = await import("../oauth-handler.ts");

    const path = mod.persistOAuthTokens(
      "test-server",
      {
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: 3600,
      },
      {
        client_id: "client-1",
        token_endpoint: "https://example.com/token",
        token_endpoint_auth_method: "none",
      },
    );

    expect(path).toContain("test-server/tokens.json");

    const stored = mod.readStoredTokens("test-server");
    expect(stored?.access_token).toBe("access-1");
    expect(stored?.refresh_token).toBe("refresh-1");
    expect(stored?.client_id).toBe("client-1");
    expect(stored?.token_endpoint).toBe("https://example.com/token");
    expect(stored?.expiresAt).toBeTypeOf("number");
  });

  it("refreshes expired tokens in ensureStoredTokens", async () => {
    const mod = await import("../oauth-handler.ts");

    mod.persistOAuthTokens(
      "test-server",
      {
        access_token: "expired-access",
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: -1,
      },
      {
        client_id: "client-1",
        token_endpoint: "https://example.com/token",
        token_endpoint_auth_method: "none",
      },
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        access_token: "access-2",
        refresh_token: "refresh-2",
        token_type: "bearer",
        expires_in: 1200,
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const ensured = await mod.ensureStoredTokens("test-server");
    expect(ensured?.access_token).toBe("access-2");
    expect(ensured?.refresh_token).toBe("refresh-2");

    const stored = mod.readStoredTokens("test-server");
    expect(stored?.access_token).toBe("access-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when refresh fails", async () => {
    const mod = await import("../oauth-handler.ts");

    mod.persistOAuthTokens(
      "test-server",
      {
        access_token: "expired-access",
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: -1,
      },
      {
        client_id: "client-1",
        token_endpoint: "https://example.com/token",
        token_endpoint_auth_method: "none",
      },
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const ensured = await mod.ensureStoredTokens("test-server");
    expect(ensured).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
