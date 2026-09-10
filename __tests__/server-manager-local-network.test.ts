import { afterEach, describe, expect, it, vi } from "vitest";
import { SseError } from "@modelcontextprotocol/client";
import { McpServerManager } from "../server-manager.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function connectFailure(host: string, code = "EHOSTUNREACH", platform = "darwin") {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
  const detail = Object.assign(new Error("connect https://user:secret@192.168.10.7/mcp?token=secret"), { code });
  const duplicate = Object.assign(new Error("Authorization: Bearer secret"), { code });
  const original = new TypeError("fetch failed", { cause: new AggregateError([detail, duplicate], "connect attempts failed") });
  detail.cause = original;
  const fetch = vi.fn().mockRejectedValue(original);
  vi.stubGlobal("fetch", fetch);
  const manager = new McpServerManager();
  try {
    await manager.connect("lan", { url: `https://${host}/mcp`, oauth: false });
    throw new Error("connection unexpectedly succeeded");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return { error: error as Error, original, fetch };
  } finally {
    await manager.closeAll();
  }
}

describe("macOS LAN connection diagnostics", () => {
  it.each([
    ["darwin", "192.168.10.7", "EHOSTUNREACH", true],
    ["darwin", "192.168.10.7", "ENETUNREACH", true],
    ["darwin", "192.168.10.7", "EACCES", true],
    ["darwin", "192.168.10.7", "ECONNREFUSED", false],
    ["darwin", "8.8.8.8", "EHOSTUNREACH", false],
    ["darwin", "127.0.0.1", "EHOSTUNREACH", false],
    ["linux", "192.168.10.7", "EHOSTUNREACH", false],
  ] as const)("enriches only qualifying SSE failures: %s / %s / %s", async (platform, host, code, qualifies) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const original = new TypeError("fetch failed", {
      cause: Object.assign(new Error("network detail"), { code }),
    });
    const fetch = vi.fn().mockRejectedValue(original);
    vi.stubGlobal("fetch", fetch);
    const manager = new McpServerManager();
    try {
      await manager.connect("lan", {
        url: `https://${host}/mcp`, oauth: false, httpTransport: "sse",
      });
      expect.fail("connection unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      if (!qualifies) {
        expect(error).toBeInstanceOf(SseError);
        expect(error.message).toBe("SSE error: TypeError: fetch failed: network detail");
        expect(error.cause).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(2);
        return;
      }
      expect(error.message).toContain("macOS Local Network Privacy may be blocking access");
      expect(error.message).toContain(code);
      expect(error.cause).toBeInstanceOf(AggregateError);
      if (!(error.cause instanceof AggregateError)) throw error;
      const [sdkError, fetchError] = error.cause.errors;
      expect(sdkError).toBeInstanceOf(SseError);
      expect(error.message.startsWith(`${sdkError.message} — `)).toBe(true);
      expect(fetchError).toBe(original);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await manager.closeAll();
    }
  });

  it.each([
    ["192.168.10.7", "EHOSTUNREACH"], ["10.0.0.2", "ENETUNREACH"],
    ["172.16.0.1", "EACCES"], ["172.31.255.254", "EHOSTUNREACH"],
    ["169.254.1.2", "EHOSTUNREACH"], ["[fd00::1]", "EHOSTUNREACH"],
    ["[fc00::1]", "EHOSTUNREACH"], ["[fe80::1]", "EHOSTUNREACH"],
    ["[febf::1]", "EHOSTUNREACH"], ["[::ffff:192.168.10.7]", "EHOSTUNREACH"],
    ["user:secret@192.168.10.7", "EHOSTUNREACH"],
  ])("adds a tentative diagnostic for %s / %s without probing", async (host, code) => {
    const { error, original, fetch } = await connectFailure(host, code);
    expect(error.message).toContain("fetch failed");
    expect(error.message.split(code)).toHaveLength(2);
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("https://");
    expect(error.message).toContain("macOS Local Network Privacy may be blocking access");
    expect(error.message).toContain("System Settings > Privacy & Security > Local Network");
    expect(error.message).toContain("Terminal.app or SSH");
    expect(error.cause).toBe(original);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["192.168.10.7", "EHOSTUNREACH", "linux"],
    ["192.168.10.7", "EHOSTUNREACH", "win32"],
    ["192.168.10.7", "ECONNREFUSED", "darwin"],
    ["192.168.10.7", "ETIMEDOUT", "darwin"],
    ["192.168.10.7", "CERT_HAS_EXPIRED", "darwin"],
    ...["8.8.8.8", "127.0.0.1", "172.15.255.255", "172.32.0.1", "[::1]",
      "[2001:4860::8888]", "[fec0::1]", "[::ffff:127.0.0.1]", "localhost", "mcp.local", "example.com"]
      .map(host => [host, "EHOSTUNREACH", "darwin"]),
  ])("does not suggest privacy for %s / %s / %s", async (host, code, platform) => {
    const { error } = await connectFailure(host, code, platform);
    expect(error.message).not.toContain("Local Network Privacy");
    expect(error.message).toContain("fetch failed");
  });
});
