import { describe, expect, it, vi } from "vitest";
import {
  applyConfidentialToolFilters,
  createConfidentialCallExecutor,
  getConfidentialWorkflowSpec,
  executeConfidentialToolCall,
  MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD,
  McpConfidentialError,
} from "../confidential-workflow.ts";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";

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
      {
        store_id: "lehrermaterial",
        locale: "de",
        filename: "lesson.pdf",
        size_bytes: 12,
      },
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

  it("reuses the normal approval broker and fails closed before manager.callTool", async () => {
    const requests: McpToolApprovalRequest[] = [];
    const state = createState({
      config: {
        mcpServers: {
          "eproduct-catalog": {
            url: "https://catalog.example/mcp",
            approveTools: true,
          },
        },
      },
      approvalEvents: {
        emit: vi.fn((channel: string, request: unknown) => {
          expect(channel).toBe(MCP_TOOL_APPROVAL_REQUEST_EVENT);
          const approvalRequest = request as McpToolApprovalRequest;
          requests.push(approvalRequest);
          expect(Object.isFrozen(approvalRequest.args)).toBe(true);
          expect(approvalRequest.claim(() => "deny")).toBe(true);
        }),
      },
    });

    await expect(executeConfidentialToolCall(
      state,
      "eproduct-catalog",
      "presign_file_upload",
      {
        store_id: "lehrermaterial",
        locale: "de",
        filename: "lesson.pdf",
        size_bytes: 12,
      },
    )).rejects.toMatchObject({ code: "approval_denied" });
    expect(requests[0]).toMatchObject({
      serverName: "eproduct-catalog",
      originalToolName: "presign_file_upload",
      args: {
        store_id: "lehrermaterial",
        locale: "de",
        filename: "lesson.pdf",
        size_bytes: 12,
      },
      origin: "proxy",
    });
    expect(state.manager.callTool).not.toHaveBeenCalled();

    const headless = createState({
      config: {
        mcpServers: {
          "eproduct-catalog": {
            url: "https://catalog.example/mcp",
            approveTools: true,
          },
        },
      },
    });
    await expect(executeConfidentialToolCall(
      headless,
      "eproduct-catalog",
      "presign_file_upload",
      {
        store_id: "lehrermaterial",
        locale: "de",
        filename: "lesson.pdf",
        size_bytes: 12,
      },
    )).rejects.toMatchObject({ code: "approval_required" });
    expect(headless.manager.callTool).not.toHaveBeenCalled();

    const allowed = createState({
      config: {
        mcpServers: {
          "eproduct-catalog": {
            url: "https://catalog.example/mcp",
            approveTools: true,
          },
        },
      },
      approvalEvents: {
        emit: vi.fn((_channel: string, request: unknown) => {
          expect((request as McpToolApprovalRequest).claim(() => "allow_once")).toBe(true);
        }),
      },
    });
    await expect(executeConfidentialToolCall(
      allowed,
      "eproduct-catalog",
      "presign_file_upload",
      {
        store_id: "lehrermaterial",
        locale: "de",
        filename: "lesson.pdf",
        size_bytes: 12,
      },
    )).resolves.toBeDefined();
    expect(allowed.manager.callTool).toHaveBeenCalledOnce();
  });

  it("validates the complete catalog broker argument contract before connecting", async () => {
    const state = createState({
      config: { mcpServers: { "eproduct-catalog": { url: "https://catalog.example/mcp" } } },
    });
    const valid = {
      store_id: "lehrermaterial",
      locale: "de",
      filename: "lesson.pdf",
      size_bytes: 12,
    };
    const invalidPresignArgs: unknown[] = [
      {},
      { ...valid, store_id: "../catalog" },
      { ...valid, locale: "de/../en" },
      { ...valid, filename: "/tmp/lesson.pdf" },
      { ...valid, filename: "lesson.PDF" },
      { ...valid, size_bytes: "12" },
      { ...valid, size_bytes: 0 },
      { ...valid, size_bytes: 100 * 1024 * 1024 + 1 },
      { ...valid, size_bytes: Number.NaN },
      new Uint8Array([1, 2, 3]),
      [valid],
    ];

    for (const args of invalidPresignArgs) {
      await expect(executeConfidentialToolCall(
        state,
        "eproduct-catalog",
        "presign_file_upload",
        args as Record<string, unknown>,
      )).rejects.toMatchObject({ code: "invalid_request" });
    }

    const invalidConfirmArgs: unknown[] = [
      { upload_id: "upload/1", store_id: "lehrermaterial", filename: "lesson.pdf", locale: "de" },
      { upload_id: "upload-1", store_id: "lehrermaterial", filename: "lesson.pdf", locale: "de", path: "hidden" },
      { upload_id: "upload-1", store_id: "lehrermaterial", filename: "lesson.pdf", locale: { value: "de" } },
    ];
    for (const args of invalidConfirmArgs) {
      await expect(executeConfidentialToolCall(
        state,
        "eproduct-catalog",
        "confirm_file_upload",
        args as Record<string, unknown>,
      )).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(state.manager.connect).not.toHaveBeenCalled();
    expect(state.manager.callTool).not.toHaveBeenCalled();
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
      {
        store_id: "lehrermaterial",
        locale: "de",
        filename: "lesson.pdf",
        size_bytes: 12,
      },
    )).rejects.toMatchObject({ code: "call_failed" });
    try {
      await executeConfidentialToolCall(state, "eproduct-catalog", "presign_file_upload", {
        store_id: "lehrermaterial",
        locale: "de",
        filename: "lesson.pdf",
        size_bytes: 12,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfidentialError);
      expect(String(error)).not.toContain("private.example");
      expect(String(error)).not.toContain("secret");
    }
  });
});
