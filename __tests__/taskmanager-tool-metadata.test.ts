import { describe, expect, it } from "vitest";
import { buildToolMetadata } from "../tool-metadata.ts";
import { isTaskManagerClaimTool } from "../taskmanager-claim-vault.ts";

describe("TaskManager model-facing metadata", () => {
  it("projects vaulted lifecycle claim_token fields to opaque claim_handle fields", () => {
    const { metadata } = buildToolMetadata([
      {
        name: "renew_task_claim",
        description: "Renew using the claim_token returned by claim_task.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            claim_token: { type: "string", description: "Raw claim token" },
          },
          required: ["task_id", "claim_token"],
        },
      },
    ] as any, [], {}, "taskmanager", "server");

    const tool = metadata[0]!;
    const schema = tool.inputSchema as any;
    expect(tool.description).toContain("claim_handle");
    expect(tool.description).not.toContain("claim_token");
    expect(schema.properties.claim_handle).toEqual({ type: "string", description: "Raw claim handle" });
    expect(schema.properties.claim_token).toBeUndefined();
    expect(schema.required).toEqual(["task_id", "claim_handle"]);
  });

  it("does not mutate the upstream schema and classifies every capability-producing operation", () => {
    const schema = { type: "object", properties: { claim_token: { type: "string" } } };
    const { metadata } = buildToolMetadata([
      { name: "resolve_and_claim_task", description: "Acquire a claim_token.", inputSchema: schema },
      { name: "resolve_blocker_and_claim_task", description: "Acquire a claim_token.", inputSchema: schema },
    ] as any, [], {}, "nexus", "server");

    expect(metadata.map(tool => (tool.inputSchema as any).properties)).toEqual([
      { claim_handle: { type: "string" } },
      { claim_handle: { type: "string" } },
    ]);
    expect(schema.properties.claim_token).toBeDefined();
    expect(isTaskManagerClaimTool("taskmanager", "resolve_and_claim_task")).toBe(true);
    expect(isTaskManagerClaimTool("nexus", "resolve_blocker_and_claim_task")).toBe(true);
  });

  it("preserves an existing claim_handle when an upstream schema has both names", () => {
    const { metadata } = buildToolMetadata([{
      name: "renew_task_claim",
      inputSchema: {
        type: "object",
        properties: {
          claim_token: { type: "string" },
          claim_handle: { type: "string", description: "Preferred handle" },
        },
        required: ["claim_token", "claim_handle"],
      },
    }] as any, [], {}, "taskmanager", "server");
    const schema = metadata[0]!.inputSchema as any;
    expect(schema.properties.claim_handle).toEqual({ type: "string", description: "Preferred handle" });
    expect(schema.properties.claim_token).toBeUndefined();
    expect(schema.required).toEqual(["claim_handle"]);
  });

  it("leaves unrelated server schemas unchanged", () => {
    const schema = { type: "object", properties: { claim_token: { type: "string" } } };
    const { metadata } = buildToolMetadata([
      { name: "renew_task_claim", description: "claim_token", inputSchema: schema },
    ] as any, [], {}, "demo", "server");
    expect(metadata[0]!.inputSchema).toBe(schema);
    expect(metadata[0]!.description).toBe("claim_token");
  });
});
