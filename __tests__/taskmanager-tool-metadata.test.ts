import { describe, expect, it } from "vitest";
import { reconstructToolMetadata } from "../metadata-cache.ts";
import { buildToolMetadata } from "../tool-metadata.ts";

describe("TaskManager model-facing metadata", () => {
  const schema = {
    type: "object",
    properties: {
      task_id: { type: "string" },
      claim_token: { type: "string", description: "Opaque active claim token" },
    },
    required: ["task_id", "claim_token"],
  };

  it("preserves claim token fields for direct tools", () => {
    const { metadata } = buildToolMetadata([
      {
        name: "renew_task_claim",
        description: "Renew using the claim_token returned by claim_task.",
        inputSchema: schema,
      },
    ] as any, [], {}, "taskmanager", "server");

    const tool = metadata[0]!;
    expect(tool.description).toContain("claim_token");
    expect(tool.inputSchema).toBe(schema);
  });

  it("preserves claim token fields when reconstructing cached metadata", () => {
    const metadata = reconstructToolMetadata("taskmanager", {
      configHash: "unused",
      cachedAt: Date.now(),
      tools: [{
        name: "renew_task_claim",
        description: "Renew using the claim_token returned by claim_task.",
        inputSchema: schema,
      }],
    } as any, "server", {}, {} as any);

    const tool = metadata[0]!;
    expect(tool.description).toContain("claim_token");
    expect(tool.inputSchema).toBe(schema);
  });

  it("leaves unrelated server schemas unchanged", () => {
    const { metadata } = buildToolMetadata([
      { name: "renew_task_claim", description: "claim_token", inputSchema: schema },
    ] as any, [], {}, "demo", "server");
    expect(metadata[0]!.inputSchema).toBe(schema);
    expect(metadata[0]!.description).toBe("claim_token");
  });
});
