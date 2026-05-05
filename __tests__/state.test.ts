import { describe, expect, it } from "vitest";
import { buildMcpRequestMeta } from "../state.ts";

describe("buildMcpRequestMeta", () => {
  it("adds Pi session id to request metadata", () => {
    expect(buildMcpRequestMeta("pi-session-123")).toEqual({
      "pi/session_id": "pi-session-123",
    });
  });

  it("preserves existing request metadata and owns the Pi session id", () => {
    expect(buildMcpRequestMeta("pi-session-123", {
      "pi-mcp-adapter/stream-token": "stream-token",
      "pi/session_id": "caller-supplied",
    })).toEqual({
      "pi-mcp-adapter/stream-token": "stream-token",
      "pi/session_id": "pi-session-123",
    });
  });
});
