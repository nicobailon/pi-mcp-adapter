import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We point HOME at a fresh temp dir for every test so the FileBackedOAuthProvider's
// disk layout (~/.pi/agent/mcp-oauth/<server>/) is fully isolated.
let tempHome: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-test-"));
  process.env.HOME = tempHome;
  // Reset module cache so the provider re-reads STORAGE_BASE with the new HOME.
  vi.resetModules();
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (tempHome && existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

async function loadProvider() {
  const mod = await import("../oauth-provider.js");
  return mod;
}

describe("FileBackedOAuthProvider", () => {
  describe("clientMetadata + redirectUrl", () => {
    it("uses the loopback redirect URL with the configured port", async () => {
      const { FileBackedOAuthProvider } = await loadProvider();
      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 54321,
        onRedirect: async () => {},
      });

      expect(provider.redirectUrl).toBe("http://127.0.0.1:54321/callback");
      const metadata = provider.clientMetadata;
      expect(metadata.redirect_uris).toEqual(["http://127.0.0.1:54321/callback"]);
      expect(metadata.token_endpoint_auth_method).toBe("none");
      expect(metadata.grant_types).toContain("authorization_code");
      expect(metadata.grant_types).toContain("refresh_token");
      expect(metadata.response_types).toEqual(["code"]);
      expect(metadata.client_name).toBe("pi-mcp-adapter");
    });

    it("forwards an explicit clientName and scope", async () => {
      const { FileBackedOAuthProvider } = await loadProvider();
      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 8080,
        clientName: "pi-mcp-adapter (supabase)",
        scope: "read:projects write:projects",
        onRedirect: async () => {},
      });

      expect(provider.clientMetadata.client_name).toBe("pi-mcp-adapter (supabase)");
      expect(provider.clientMetadata.scope).toBe("read:projects write:projects");
    });
  });

  describe("token persistence", () => {
    it("returns undefined when no tokens are saved", async () => {
      const { FileBackedOAuthProvider } = await loadProvider();
      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 1,
        onRedirect: async () => {},
      });
      await expect(provider.tokens()).resolves.toBeUndefined();
    });

    it("round-trips access/refresh tokens through disk", async () => {
      const { FileBackedOAuthProvider, getServerStorageDir } = await loadProvider();
      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 1,
        onRedirect: async () => {},
      });

      await provider.saveTokens({
        access_token: "AT-1",
        token_type: "Bearer",
        refresh_token: "RT-1",
        expires_in: 3600,
      });

      const tokens = await provider.tokens();
      expect(tokens?.access_token).toBe("AT-1");
      expect(tokens?.refresh_token).toBe("RT-1");
      expect(tokens?.expires_in).toBe(3600);

      // Persisted file should include an absolute expiry derived from expires_in.
      const stored = JSON.parse(
        readFileSync(join(getServerStorageDir("supabase"), "tokens.json"), "utf-8"),
      );
      expect(stored.expiresAt).toBeTypeOf("number");
      expect(stored.expiresAt).toBeGreaterThan(Date.now());
    });

    it("treats expired tokens as missing when there is no refresh_token", async () => {
      const { FileBackedOAuthProvider, getServerStorageDir } = await loadProvider();
      const dir = getServerStorageDir("supabase");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "tokens.json"),
        JSON.stringify({
          access_token: "AT-old",
          token_type: "Bearer",
          expiresAt: Date.now() - 60_000,
        }),
      );

      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 1,
        onRedirect: async () => {},
      });
      await expect(provider.tokens()).resolves.toBeUndefined();
    });

    it("returns expired tokens with refresh_token so the SDK can refresh them", async () => {
      const { FileBackedOAuthProvider, getServerStorageDir } = await loadProvider();
      const dir = getServerStorageDir("supabase");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "tokens.json"),
        JSON.stringify({
          access_token: "AT-old",
          token_type: "Bearer",
          refresh_token: "RT-1",
          expiresAt: Date.now() - 60_000,
        }),
      );

      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 1,
        onRedirect: async () => {},
      });
      const tokens = await provider.tokens();
      expect(tokens?.access_token).toBe("AT-old");
      expect(tokens?.refresh_token).toBe("RT-1");
    });

    it("is backwards compatible with the legacy hand-rolled token format", async () => {
      const { FileBackedOAuthProvider, getServerStorageDir } = await loadProvider();
      const dir = getServerStorageDir("supabase");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "tokens.json"),
        JSON.stringify({
          access_token: "AT-legacy",
          token_type: "bearer",
        }),
      );

      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 1,
        onRedirect: async () => {},
      });
      const tokens = await provider.tokens();
      expect(tokens?.access_token).toBe("AT-legacy");
      expect(tokens?.token_type).toBe("bearer");
    });
  });

  describe("dynamic client registration", () => {
    it("round-trips clientInformation through disk", async () => {
      const { FileBackedOAuthProvider } = await loadProvider();
      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 1,
        onRedirect: async () => {},
      });

      await expect(provider.clientInformation()).resolves.toBeUndefined();

      await provider.saveClientInformation({
        client_id: "client-123",
        client_id_issued_at: 1234,
        redirect_uris: ["http://127.0.0.1:1/callback"],
      } as any);

      const info = await provider.clientInformation();
      expect(info?.client_id).toBe("client-123");
    });
  });

  describe("PKCE verifier", () => {
    it("round-trips the code verifier", async () => {
      const { FileBackedOAuthProvider } = await loadProvider();
      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 1,
        onRedirect: async () => {},
      });

      await expect(provider.codeVerifier()).rejects.toThrow();
      await provider.saveCodeVerifier("a-very-long-code-verifier-string");
      await expect(provider.codeVerifier()).resolves.toBe("a-very-long-code-verifier-string");
    });
  });

  describe("invalidateCredentials", () => {
    it("removes only the requested scope", async () => {
      const { FileBackedOAuthProvider, getServerStorageDir } = await loadProvider();
      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 1,
        onRedirect: async () => {},
      });

      await provider.saveTokens({ access_token: "AT", token_type: "Bearer" });
      await provider.saveClientInformation({ client_id: "C1" } as any);
      await provider.saveCodeVerifier("V1");

      const dir = getServerStorageDir("supabase");
      expect(existsSync(join(dir, "tokens.json"))).toBe(true);
      expect(existsSync(join(dir, "client.json"))).toBe(true);
      expect(existsSync(join(dir, "verifier.txt"))).toBe(true);

      await provider.invalidateCredentials("tokens");
      expect(existsSync(join(dir, "tokens.json"))).toBe(false);
      expect(existsSync(join(dir, "client.json"))).toBe(true);
      expect(existsSync(join(dir, "verifier.txt"))).toBe(true);

      await provider.invalidateCredentials("all");
      expect(existsSync(join(dir, "tokens.json"))).toBe(false);
      expect(existsSync(join(dir, "client.json"))).toBe(false);
      expect(existsSync(join(dir, "verifier.txt"))).toBe(false);
    });
  });

  describe("redirectToAuthorization", () => {
    it("delegates to the onRedirect callback supplied at construction", async () => {
      const { FileBackedOAuthProvider } = await loadProvider();
      const seen: URL[] = [];
      const provider = new FileBackedOAuthProvider("supabase", {
        redirectPort: 1,
        onRedirect: async (url) => {
          seen.push(url);
        },
      });

      const authUrl = new URL("https://example.com/authorize?code_challenge=abc&state=xyz");
      await provider.redirectToAuthorization(authUrl);

      expect(seen).toHaveLength(1);
      expect(seen[0].toString()).toBe(authUrl.toString());
    });
  });
});
