import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { cleanupMaterializedBinaryResources } from "../tool-registrar.ts";
import type { DirectToolSpec, ToolMetadata } from "../types.ts";

const initMocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(async () => true),
  getFailureAgeSeconds: vi.fn(() => null),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: initMocks.lazyConnect,
  getFailureAgeSeconds: initMocks.getFailureAgeSeconds,
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  updateStatusBar: vi.fn(),
  clearFailure: vi.fn(),
  recordFailure: vi.fn(),
  markKeepAliveAfterConnect: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
}));

const resourceUri = "file://binary-resource";
const blob = Buffer.from("binary resource content").toString("base64");

function createState() {
  const metadata: ToolMetadata = {
    name: "demo_read_binary_resource",
    originalName: "read_binary_resource",
    description: "Read binary resource",
    resourceUri,
  };
  const readResource = vi.fn(async () => ({
    contents: [{ uri: resourceUri, mimeType: "application/octet-stream", blob }],
  }));
  const connection = {
    status: "connected",
    client: { readResource, callTool: vi.fn() },
  };

  return {
    metadata,
    readResource,
    state: {
      config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
      toolMetadata: new Map([["demo", [metadata]]]),
      manager: {
        getConnection: vi.fn(() => connection),
        getRequestOptions: vi.fn(() => undefined),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: undefined,
      completedUiSessions: [],
    } as any,
  };
}

function materializedPath(text: string): string {
  const path = text.match(/Binary content saved to (.+)/)?.[1];
  expect(path).toBeDefined();
  return path!;
}

afterEach(() => {
  cleanupMaterializedBinaryResources();
  vi.clearAllMocks();
});

describe("resource tool binary materialization", () => {
  it("materializes binary proxy resource results", async () => {
    const { state, metadata, readResource } = createState();

    const result = await executeCall(state, metadata.name, {}, "demo");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const path = materializedPath(text);

    expect(text).toContain("[Resource: file://binary-resource]");
    expect(text).not.toContain(blob);
    expect(readFileSync(path, "utf8")).toBe("binary resource content");
    expect(readResource).toHaveBeenCalledWith({ uri: resourceUri }, undefined);
  });

  it("materializes binary direct resource results", async () => {
    const { state, metadata, readResource } = createState();
    const execute = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", prefixedName: metadata.name, description: metadata.description, originalName: metadata.originalName, resourceUri } satisfies DirectToolSpec,
    );

    const result = await execute("call-1", {}, undefined as any, undefined, undefined as any);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const path = materializedPath(text);

    expect(text).toContain("[Resource: file://binary-resource]");
    expect(text).not.toContain(blob);
    expect(readFileSync(path, "utf8")).toBe("binary resource content");
    expect(readResource).toHaveBeenCalledWith({ uri: resourceUri }, undefined);
  });
});
