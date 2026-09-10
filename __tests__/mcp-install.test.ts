import { describe, expect, it } from "vitest";
import { canonicalMcpServerUrl, normalizeMcpInstallRequest } from "../mcp-install.ts";

describe("single-URL MCP installation", () => {
  it("normalizes HTTPS endpoints and derives a stable server name", () => {
    expect(normalizeMcpInstallRequest({ url: " https://forex-dev.1above.io/mcp " })).toEqual({
      url: "https://forex-dev.1above.io/mcp",
      serverName: "forex-dev",
    });
  });

  it("accepts an explicit safe server name", () => {
    expect(normalizeMcpInstallRequest({
      url: "https://forex-dev.1above.io/mcp",
      serverName: "forex",
    }).serverName).toBe("forex");
  });

  it("allows loopback HTTP without allowing remote plaintext HTTP", () => {
    expect(normalizeMcpInstallRequest({ url: "http://127.0.0.1:3000/mcp" }).serverName).toBe("local-mcp");
    expect(() => normalizeMcpInstallRequest({ url: "http://example.com/mcp" })).toThrow("must use HTTPS");
  });

  it.each([
    "https://user:secret@example.com/mcp",
    "https://example.com/mcp#token",
    "file:///tmp/mcp.sock",
  ])("rejects unsafe endpoint %s", (url) => {
    expect(() => normalizeMcpInstallRequest({ url })).toThrow();
  });

  it("rejects unsafe explicit names", () => {
    expect(() => normalizeMcpInstallRequest({
      url: "https://example.com/mcp",
      serverName: "../../server",
    })).toThrow("server name");
  });

  it("canonicalizes comparable existing URLs", () => {
    expect(canonicalMcpServerUrl("https://example.com")).toBe("https://example.com/");
    expect(canonicalMcpServerUrl("not a URL")).toBeUndefined();
  });
});