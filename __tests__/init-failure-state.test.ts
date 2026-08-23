import { afterEach, describe, expect, it, vi } from "vitest";
import { clearFailure, getFailureAgeSeconds, getFailureMessage, recordFailure } from "../init.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";

describe("MCP failure state", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds messages and removes diagnostics after the backoff TTL", () => {
    vi.useFakeTimers();
    const state = {
      owner: { isActive: () => true },
      failureTracker: new Map<string, number>(),
      failureMessages: new Map<string, string>(),
    } as any;

    recordFailure(state, "demo", "x".repeat(100_000));

    expect(state.failureMessages.get("demo")).toHaveLength(8 * 1024);
    expect(getFailureAgeSeconds(state, "demo")).toBe(0);
    expect(getFailureMessage(state, "demo")).toHaveLength(8 * 1024);

    vi.advanceTimersByTime(60_000);

    expect(state.failureTracker.has("demo")).toBe(false);
    expect(state.failureMessages.has("demo")).toBe(false);
    expect(getFailureAgeSeconds(state, "demo")).toBeNull();
  });

  it("clears a prior expiry timer when a failure recovers", () => {
    vi.useFakeTimers();
    const state = {
      owner: { isActive: () => true },
      failureTracker: new Map<string, number>(),
      failureMessages: new Map<string, string>(),
    } as any;

    recordFailure(state, "demo", "failed");
    clearFailure(state, "demo");
    vi.advanceTimersByTime(60_000);

    expect(state.failureTracker.size).toBe(0);
    expect(state.failureMessages.size).toBe(0);
  });

  it("notifies discovery surfaces when failure backoff starts and expires", () => {
    vi.useFakeTimers();
    const onToolMetadataUpdated = vi.fn();
    const state = {
      failureTracker: new Map<string, number>(),
      failureMessages: new Map<string, string>(),
      config: { mcpServers: { demo: { command: "demo" } } },
      manager: { getConnection: () => undefined },
      toolMetadata: new Map(),
      owner: { isActive: () => true },
      statusEvents: { emit: vi.fn() },
      onToolMetadataUpdated,
    } as any;

    recordFailure(state, "demo", "failed");
    expect(onToolMetadataUpdated).toHaveBeenCalledWith("demo", "failure-backoff-started");

    vi.advanceTimersByTime(60_001);

    expect(onToolMetadataUpdated).toHaveBeenCalledWith("demo", "failure-backoff-expired");
    vi.useRealTimers();
  });

  it("notifies recovery surfaces only after clearing active backoff", () => {
    vi.useFakeTimers();
    let state: any;
    const onToolMetadataUpdated = vi.fn(() => {
      expect(getFailureAgeSeconds(state, "demo")).toBeNull();
    });
    state = {
      failureTracker: new Map<string, number>(),
      failureMessages: new Map<string, string>(),
      owner: { isActive: () => true },
      statusEvents: { emit: vi.fn() },
      onToolMetadataUpdated,
    } as any;

    recordFailure(state, "demo", "failed");
    onToolMetadataUpdated.mockClear();
    expect(clearFailure(state, "demo", "health-restored")).toBe(true);

    expect(onToolMetadataUpdated).toHaveBeenCalledWith("demo", "health-restored");
  });

  it("does not publish failure expiry after the runtime owner stops", async () => {
    vi.useFakeTimers();
    const owner = createMcpRuntimeOwner();
    const state = {
      owner,
      failureTracker: new Map<string, number>(),
      failureMessages: new Map<string, string>(),
      statusEvents: { emit: vi.fn() },
    } as any;

    recordFailure(state, "demo", "failed");
    await owner.stop("session shutdown");
    vi.advanceTimersByTime(60_000);

    expect(state.statusEvents.emit).not.toHaveBeenCalled();
  });
});
