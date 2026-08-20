import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { McpServerManager } from "../server-manager.ts";
import { startUiServer, type UiServerOptions, type UiServerHandle } from "../ui-server.ts";
import type { ConsentManager } from "../consent-manager.ts";
import {
  UI_STREAM_HOST_CONTEXT_KEY,
  UI_STREAM_STRUCTURED_CONTENT_KEY,
  SERVER_STREAM_RESULT_PATCH_METHOD,
  getVisualizationStreamEnvelope,
  getUiStreamHostContext,
  serverStreamResultPatchNotificationSchema,
  type UiResourceContent,
  type VisualizationStreamEnvelope,
} from "../types.ts";

// Helper to connect to SSE and collect events
function connectSSE(
  url: string,
  onEvent: (name: string, data: unknown, eventId?: string) => void,
  headers: Record<string, string> = {}
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
                onEvent(eventName, JSON.parse(line.slice(6)), eventId);
              } catch {
                onEvent(eventName, line.slice(6), eventId);
              }
              eventName = "message";
              eventId = undefined;
            }
          }
        });
        resolve({ close: () => req.destroy() });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function createMockResource(): UiResourceContent {
  return {
    uri: "ui://test/widget",
    html: "<h1>Test</h1>",
    mimeType: "text/html",
    meta: { permissions: {} },
  };
}

function createServerOptions(overrides: Partial<UiServerOptions> = {}): UiServerOptions {
  return {
    serverName: "test-server",
    toolName: "test_tool",
    toolArgs: { key: "value" },
    resource: createMockResource(),
    manager: {} as McpServerManager,
    consentManager: {} as ConsentManager,
    ...overrides,
  };
}

describe("UI Streaming", () => {
  describe("getUiStreamHostContext", () => {
    it("returns undefined for missing host context", () => {
      expect(getUiStreamHostContext(undefined)).toBeUndefined();
      expect(getUiStreamHostContext({})).toBeUndefined();
    });

    it("returns undefined for invalid stream context", () => {
      expect(getUiStreamHostContext({ [UI_STREAM_HOST_CONTEXT_KEY]: "invalid" })).toBeUndefined();
      expect(getUiStreamHostContext({ [UI_STREAM_HOST_CONTEXT_KEY]: { mode: "invalid" } })).toBeUndefined();
    });

    it("parses valid eager stream context", () => {
      const context = getUiStreamHostContext({
        [UI_STREAM_HOST_CONTEXT_KEY]: {
          mode: "eager",
          streamId: "abc-123",
          intermediateResultPatches: false,
          partialInput: false,
        },
      });
      expect(context).toEqual({
        mode: "eager",
        streamId: "abc-123",
        intermediateResultPatches: false,
        partialInput: false,
      });
    });

    it("parses valid stream-first context", () => {
      const context = getUiStreamHostContext({
        [UI_STREAM_HOST_CONTEXT_KEY]: {
          mode: "stream-first",
          streamId: "xyz-789",
          intermediateResultPatches: true,
          partialInput: false,
        },
      });
      expect(context).toEqual({
        mode: "stream-first",
        streamId: "xyz-789",
        intermediateResultPatches: true,
        partialInput: false,
      });
    });
  });

  describe("getVisualizationStreamEnvelope", () => {
    it("returns undefined for non-object input", () => {
      expect(getVisualizationStreamEnvelope(undefined)).toBeUndefined();
      expect(getVisualizationStreamEnvelope(null)).toBeUndefined();
      expect(getVisualizationStreamEnvelope("string")).toBeUndefined();
      expect(getVisualizationStreamEnvelope([])).toBeUndefined();
    });

    it("returns undefined when envelope key is missing", () => {
      expect(getVisualizationStreamEnvelope({})).toBeUndefined();
      expect(getVisualizationStreamEnvelope({ other: "data" })).toBeUndefined();
    });

    it("returns undefined for invalid envelope", () => {
      expect(getVisualizationStreamEnvelope({
        [UI_STREAM_STRUCTURED_CONTENT_KEY]: { streamId: "abc" }, // missing required fields
      })).toBeUndefined();
    });

    it("parses valid envelope", () => {
      const envelope = getVisualizationStreamEnvelope({
        [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
          streamId: "stream-1",
          sequence: 0,
          frameType: "patch",
          phase: "shell",
          status: "ok",
        },
      });
      expect(envelope).toEqual({
        streamId: "stream-1",
        sequence: 0,
        frameType: "patch",
        phase: "shell",
        status: "ok",
      });
    });

    it("parses envelope with optional fields", () => {
      const envelope = getVisualizationStreamEnvelope({
        [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
          streamId: "stream-2",
          sequence: 5,
          frameType: "checkpoint",
          phase: "detail",
          status: "ok",
          message: "Checkpoint ready",
          spec: { kind: "mermaid" },
          checkpoint: { kind: "mermaid", code: "graph LR" },
        },
      });
      expect(envelope?.message).toBe("Checkpoint ready");
      expect(envelope?.spec).toEqual({ kind: "mermaid" });
      expect(envelope?.checkpoint).toEqual({ kind: "mermaid", code: "graph LR" });
    });
  });

  describe("McpServerManager stream listeners", () => {
    function attachNotificationHandler(manager: McpServerManager, serverName = "test-server") {
      const setNotificationHandler = vi.fn();
      const client = { setNotificationHandler };
      (manager as unknown as {
        attachAdapterNotificationHandlers: (
          serverName: string,
          client: { setNotificationHandler: (...args: unknown[]) => void },
        ) => void;
      }).attachAdapterNotificationHandlers(serverName, client);
      expect(setNotificationHandler).toHaveBeenCalledOnce();
      expect(setNotificationHandler.mock.calls[0][0]).toBe(SERVER_STREAM_RESULT_PATCH_METHOD);
      const handler = setNotificationHandler.mock.calls[0][2] as (params: {
        streamToken: string;
        result: { content?: unknown[]; structuredContent?: Record<string, unknown> };
      }) => void;
      return (notification: {
        method: string;
        params: {
          streamToken: string;
          result: { content?: unknown[]; structuredContent?: Record<string, unknown> };
        };
      }) => handler(notification.params);
    }

    it("routes notifications to the matching listener", () => {
      const manager = new McpServerManager();
      const listener = vi.fn();
      const handleNotification = attachNotificationHandler(manager, "server-a");

      manager.registerUiStreamListener("token-123", listener);
      const notification = {
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: "token-123",
          result: { content: [{ type: "text", text: "patch" }] },
        },
      };

      handleNotification(notification);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("server-a", notification.params);
    });

    it("does not call removed listeners", () => {
      const manager = new McpServerManager();
      const listener = vi.fn();
      const handleNotification = attachNotificationHandler(manager);

      manager.registerUiStreamListener("token-456", listener);
      manager.removeUiStreamListener("token-456");

      handleNotification({
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: "token-456",
          result: { content: [{ type: "text", text: "patch" }] },
        },
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("keeps multiple listeners isolated by stream token", () => {
      const manager = new McpServerManager();
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const handleNotification = attachNotificationHandler(manager, "server-b");

      manager.registerUiStreamListener("token-1", listener1);
      manager.registerUiStreamListener("token-2", listener2);

      handleNotification({
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: "token-2",
          result: { content: [{ type: "text", text: "patch-2" }] },
        },
      });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledWith("server-b", {
        streamToken: "token-2",
        result: { content: [{ type: "text", text: "patch-2" }] },
      });
    });
  });

  describe("UiServer SSE streaming", () => {
    let handle: UiServerHandle | null = null;

    afterEach(() => {
      if (handle) {
        handle.close("test-cleanup");
        handle = null;
      }
    });

    it("sends result-patch events with stream envelope", async () => {
      handle = await startUiServer(createServerOptions({
        hostContext: {
          [UI_STREAM_HOST_CONTEXT_KEY]: {
            mode: "stream-first",
            streamId: "test-stream",
            intermediateResultPatches: true,
            partialInput: false,
          },
        },
      }));

      const events: Array<{ name: string; data: unknown; id?: string }> = [];
      const sse = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (name, data, id) => events.push({ name, data, id })
      );

      // Send a result patch
      handle.sendResultPatch({
        content: [{ type: "text", text: "Streaming..." }],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "test-stream",
            sequence: 1,
            frameType: "patch",
            phase: "shell",
            status: "ok",
            message: "Building shell",
          },
        },
      });

      // Wait for event propagation
      await new Promise((r) => setTimeout(r, 50));
      sse.close();

      const patchEvents = events.filter((e) => e.name === "result-patch");
      expect(patchEvents).toHaveLength(1);

      const envelope = getVisualizationStreamEnvelope(
        (patchEvents[0].data as { structuredContent?: unknown })?.structuredContent
      );
      expect(envelope?.frameType).toBe("patch");
      expect(envelope?.phase).toBe("shell");
    });

    it("assigns sequential event IDs", async () => {
      handle = await startUiServer(createServerOptions());

      const eventIds: string[] = [];
      const sse = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (_name, _data, id) => { if (id) eventIds.push(id); }
      );

      handle.sendResultPatch({ content: [] });
      handle.sendResultPatch({ content: [] });
      handle.sendResultPatch({ content: [] });

      await new Promise((r) => setTimeout(r, 50));
      sse.close();

      const ids = eventIds.map(Number).filter((n) => !Number.isNaN(n));
      expect(ids).toHaveLength(3);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      }
    });

    it("replays events from Last-Event-ID", async () => {
      handle = await startUiServer(createServerOptions());

      // First connection to send some events
      const firstEvents: Array<{ name: string; id?: string }> = [];
      const sse1 = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (name, _data, id) => firstEvents.push({ name, id })
      );

      handle.sendResultPatch({ content: [{ type: "text", text: "patch-1" }] });
      handle.sendResultPatch({ content: [{ type: "text", text: "patch-2" }] });
      handle.sendResultPatch({ content: [{ type: "text", text: "patch-3" }] });

      await new Promise((r) => setTimeout(r, 50));
      sse1.close();

      // Get the ID of the first patch event
      const patchEvents = firstEvents.filter((e) => e.name === "result-patch");
      expect(patchEvents.length).toBe(3);
      const firstPatchId = patchEvents[0].id;
      expect(firstPatchId).toBeDefined();

      // Second connection with Last-Event-ID should replay from that point
      const replayedEvents: Array<{ name: string; id?: string }> = [];
      const sse2 = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (name, _data, id) => replayedEvents.push({ name, id }),
        { "Last-Event-ID": firstPatchId! }
      );

      await new Promise((r) => setTimeout(r, 50));
      sse2.close();

      // Should replay events AFTER the provided ID
      const replayedPatches = replayedEvents.filter((e) => e.name === "result-patch");
      expect(replayedPatches.length).toBe(2); // patch-2 and patch-3
    });

    it("replays from latest checkpoint for fresh connections", async () => {
      handle = await startUiServer(createServerOptions());

      // Send patches and a checkpoint
      const sse1 = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        () => {}
      );

      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "s1", sequence: 0, frameType: "patch", phase: "shell", status: "ok",
          },
        },
      });
      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "s1", sequence: 1, frameType: "checkpoint", phase: "detail", status: "ok",
          },
        },
      });
      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "s1", sequence: 2, frameType: "patch", phase: "detail", status: "ok",
          },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      sse1.close();

      // Fresh connection (no Last-Event-ID) should start from checkpoint
      const freshEvents: Array<{ data: unknown }> = [];
      const sse2 = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (_name, data) => freshEvents.push({ data })
      );

      await new Promise((r) => setTimeout(r, 50));
      sse2.close();

      // Should have replayed checkpoint and subsequent patches
      const envelopes = freshEvents
        .map((e) => getVisualizationStreamEnvelope((e.data as { structuredContent?: unknown })?.structuredContent))
        .filter(Boolean) as VisualizationStreamEnvelope[];

      expect(envelopes).toHaveLength(2);
      expect(envelopes.map((envelope) => envelope.frameType)).toEqual(["checkpoint", "patch"]);
    });

    it("keeps latest checkpoint replay after pruning the event log", async () => {
      handle = await startUiServer(createServerOptions());

      for (let sequence = 0; sequence < 140; sequence += 1) {
        handle.sendResultPatch({
          content: [],
          structuredContent: {
            [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
              streamId: "pruned-stream",
              sequence,
              frameType: sequence === 130 ? "checkpoint" : "patch",
              phase: "detail",
              status: "ok",
            },
          },
        });
      }

      const replayedSequences: number[] = [];
      const sse = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (_name, data) => {
          const envelope = getVisualizationStreamEnvelope(
            (data as { structuredContent?: unknown })?.structuredContent,
          );
          if (envelope) replayedSequences.push(envelope.sequence);
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      sse.close();

      expect(replayedSequences).toEqual([130, 131, 132, 133, 134, 135, 136, 137, 138, 139]);
    });

    it("tracks stream summary", async () => {
      handle = await startUiServer(createServerOptions({
        hostContext: {
          [UI_STREAM_HOST_CONTEXT_KEY]: {
            mode: "stream-first",
            streamId: "summary-test",
            intermediateResultPatches: true,
            partialInput: false,
          },
        },
      }));

      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "summary-test", sequence: 0, frameType: "patch", phase: "shell", status: "ok",
          },
        },
      });
      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "summary-test", sequence: 1, frameType: "patch", phase: "structure", status: "ok",
          },
        },
      });
      handle.sendToolResult({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "summary-test", sequence: 2, frameType: "final", phase: "settled", status: "ok",
            message: "Complete",
          },
        },
      });

      const summary = handle.getStreamSummary();
      expect(summary).toBeDefined();
      expect(summary?.streamId).toBe("summary-test");
      expect(summary?.mode).toBe("stream-first");
      expect(summary?.frames).toBe(3);
      expect(summary?.phases).toContain("shell");
      expect(summary?.phases).toContain("structure");
      expect(summary?.phases).toContain("settled");
      expect(summary?.finalStatus).toBe("ok");
      expect(summary?.lastMessage).toBe("Complete");
    });
  });

  describe("Server stream result patch notification schema", () => {
    it("validates correct notification format", () => {
      const notification = {
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: "token-123",
          result: {
            content: [{ type: "text", text: "test" }],
            structuredContent: { data: "value" },
          },
        },
      };

      const parsed = serverStreamResultPatchNotificationSchema.safeParse(notification);
      expect(parsed.success).toBe(true);
    });

    it("rejects notification with wrong method", () => {
      const notification = {
        method: "wrong/method",
        params: {
          streamToken: "token-123",
          result: { content: [] },
        },
      };

      const parsed = serverStreamResultPatchNotificationSchema.safeParse(notification);
      expect(parsed.success).toBe(false);
    });

    it("rejects notification with missing streamToken", () => {
      const notification = {
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          result: { content: [] },
        },
      };

      const parsed = serverStreamResultPatchNotificationSchema.safeParse(notification);
      expect(parsed.success).toBe(false);
    });
  });
});
