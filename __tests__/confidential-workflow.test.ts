import { describe, expect, it, vi } from "vitest";
import {
  applyConfidentialToolFilters,
  createConfidentialCallExecutor,
  getConfidentialWorkflowSpec,
  executeConfidentialToolCall,
  MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD,
  McpConfidentialError,
} from "../confidential-workflow.ts";

function createState(overrides: Record<string, unknown> = {}) {
  const owner = { signal: new AbortController().signal };
  return {
    owner,
    config: { mcpServers: { catalog: { url: "https://catalog.example/mcp" } } },
    manager: {
      getConnection: vi.fn(() => ({ status: "connected" })),
      connect: vi.fn(),
      callTool: vi.fn(async () => ({
        content: [{ type: "text", text: "{\"url\":\"https://private.example/upload\"}" }],
      })),
    },
    ...overrides,
  } as any;
}

describe("confidential MCP workflow boundary", () => {
  it("exposes only the reviewed catalog workflow allowlist", () => {
    expect(getConfidentialWorkflowSpec(MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD)).toEqual({
      serverName: "eproduct-catalog",
      tools: ["presign_file_upload", "confirm_file_upload"],
    });
    expect(getConfidentialWorkflowSpec("arbitrary-workflow")).toBeUndefined();
  });

  it("maps an already-aborted trusted call to a stable error", async () => {
    const state = createState({
      config: { mcpServers: { "eproduct-catalog": { url: "https://catalog.example/mcp" } } },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(executeConfidentialToolCall(
      state,
      "eproduct-catalog",
      "presign_file_upload",
      {},
      controller.signal,
    )).rejects.toMatchObject({ code: "aborted" });
    expect(state.manager.callTool).not.toHaveBeenCalled();
  });

  it("adds tool exclusions without changing the MCP server transport definition", () => {
    const config = {
      mcpServers: {
        catalog: { url: "https://catalog.example/mcp", headers: { "X-Test": "ok" } },
      },
    };

    applyConfidentialToolFilters(config, {
      catalog: ["presign_file_upload", "confirm_file_upload"],
    });

    expect(config.mcpServers.catalog).toEqual({
      url: "https://catalog.example/mcp",
      headers: { "X-Test": "ok" },
      excludeTools: ["presign_file_upload", "confirm_file_upload"],
    });
  });

  it("only calls tools explicitly registered by the trusted workflow", async () => {
    const state = createState({
      config: { mcpServers: { "eproduct-catalog": { url: "https://catalog.example/mcp" } } },
    });
    const executor = createConfidentialCallExecutor(
      () => state,
      (server, tool) => server === "eproduct-catalog" && tool === "presign_file_upload",
    );

    const result = await executor.callTool("eproduct-catalog", "presign_file_upload", {
      store_id: "store",
      locale: "de",
      filename: "lesson.pdf",
      size_bytes: 12,
    });
    expect(result.content).toHaveLength(1);
    expect(state.manager.callTool).toHaveBeenCalledWith(
      "eproduct-catalog",
      "presign_file_upload",
      expect.objectContaining({ filename: "lesson.pdf" }),
      expect.anything(),
    );

    await expect(executor.callTool("eproduct-catalog", "confirm_file_upload", {}))
      .rejects.toMatchObject({ code: "tool_not_registered" });
    await expect(executeConfidentialToolCall(state, "eproduct-catalog", "list_products", {}))
      .rejects.toMatchObject({ code: "tool_not_registered" });
    await expect(executeConfidentialToolCall(state, "eproduct-catalog", "presign_file_upload", {
      bytes: "never accepted",
    }))
      .rejects.toMatchObject({ code: "invalid_request" });
  });

  it("does not copy upstream connection errors into the broker error", async () => {
    const state = createState({
      config: { mcpServers: { "eproduct-catalog": { url: "https://catalog.example/mcp" } } },
    });
    state.manager.getConnection.mockReturnValue(undefined);
    state.manager.connect.mockRejectedValue(new Error("https://private.example/signed?token=secret"));

    await expect(executeConfidentialToolCall(
      state,
      "eproduct-catalog",
      "presign_file_upload",
      {},
    )).rejects.toMatchObject({ code: "call_failed" });
    try {
      await executeConfidentialToolCall(state, "eproduct-catalog", "presign_file_upload", {});
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfidentialError);
      expect(String(error)).not.toContain("private.example");
      expect(String(error)).not.toContain("secret");
    }
  });
});
