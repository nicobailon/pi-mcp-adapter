// policy-allowlist.test.ts — RED phase: allowlist filtering functions (Slice 2)
import { describe, it, expect } from "vitest";
import {
  isToolAllowed,
  isResourceAllowed,
  isPromptAllowed,
  filterAllowedTools,
  filterAllowedResources,
  filterAllowedPrompts,
  type ServerPolicy,
} from "../policy.js";

// Minimal metadata shapes matching MCP SDK conventions
interface ToolMeta { name: string; description?: string }
interface ResourceMeta { uri: string; name?: string }
interface PromptMeta { name: string; description?: string }

// ---------------------------------------------------------------------------
// isToolAllowed
// ---------------------------------------------------------------------------
describe("isToolAllowed", () => {
  it("returns true when allowedTools is undefined", () => {
    const policy: ServerPolicy = {};
    expect(isToolAllowed(policy, "read_file")).toBe(true);
  });

  it("returns true when allowedTools is empty", () => {
    const policy: ServerPolicy = { allowedTools: [] };
    expect(isToolAllowed(policy, "read_file")).toBe(true);
  });

  it("returns true when tool is in allowedTools", () => {
    const policy: ServerPolicy = { allowedTools: ["read_file", "write_file"] };
    expect(isToolAllowed(policy, "read_file")).toBe(true);
  });

  it("returns false when tool is NOT in allowedTools", () => {
    const policy: ServerPolicy = { allowedTools: ["read_file"] };
    expect(isToolAllowed(policy, "delete_file")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isResourceAllowed
// ---------------------------------------------------------------------------
describe("isResourceAllowed", () => {
  it("returns true when allowedResources is undefined", () => {
    const policy: ServerPolicy = {};
    expect(isResourceAllowed(policy, "file:///readme.md")).toBe(true);
  });

  it("returns true when allowedResources is empty", () => {
    const policy: ServerPolicy = { allowedResources: [] };
    expect(isResourceAllowed(policy, "file:///readme.md")).toBe(true);
  });

  it("returns true when resource URI is in allowedResources", () => {
    const policy: ServerPolicy = { allowedResources: ["file:///readme.md", "file:///src/index.ts"] };
    expect(isResourceAllowed(policy, "file:///readme.md")).toBe(true);
  });

  it("returns false when resource URI is NOT in allowedResources", () => {
    const policy: ServerPolicy = { allowedResources: ["file:///readme.md"] };
    expect(isResourceAllowed(policy, "file:///secret.txt")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPromptAllowed
// ---------------------------------------------------------------------------
describe("isPromptAllowed", () => {
  it("returns true when allowedPrompts is undefined", () => {
    const policy: ServerPolicy = {};
    expect(isPromptAllowed(policy, "summarize")).toBe(true);
  });

  it("returns true when allowedPrompts is empty", () => {
    const policy: ServerPolicy = { allowedPrompts: [] };
    expect(isPromptAllowed(policy, "summarize")).toBe(true);
  });

  it("returns true when prompt is in allowedPrompts", () => {
    const policy: ServerPolicy = { allowedPrompts: ["summarize", "translate"] };
    expect(isPromptAllowed(policy, "summarize")).toBe(true);
  });

  it("returns false when prompt is NOT in allowedPrompts", () => {
    const policy: ServerPolicy = { allowedPrompts: ["summarize"] };
    expect(isPromptAllowed(policy, "generate_code")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterAllowedTools
// ---------------------------------------------------------------------------
describe("filterAllowedTools", () => {
  const tools: ToolMeta[] = [
    { name: "read_file", description: "Read a file" },
    { name: "write_file", description: "Write a file" },
    { name: "delete_file", description: "Delete a file" },
  ];

  it("returns all tools when allowedTools is undefined", () => {
    const policy: ServerPolicy = {};
    expect(filterAllowedTools(policy, tools)).toEqual(tools);
  });

  it("returns all tools when allowedTools is empty", () => {
    const policy: ServerPolicy = { allowedTools: [] };
    expect(filterAllowedTools(policy, tools)).toEqual(tools);
  });

  it("returns only allowed tools", () => {
    const policy: ServerPolicy = { allowedTools: ["read_file", "write_file"] };
    expect(filterAllowedTools(policy, tools)).toEqual([tools[0], tools[1]]);
  });

  it("returns empty array when no tools match allowedTools", () => {
    const policy: ServerPolicy = { allowedTools: ["bash"] };
    expect(filterAllowedTools(policy, tools)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterAllowedResources
// ---------------------------------------------------------------------------
describe("filterAllowedResources", () => {
  const resources: ResourceMeta[] = [
    { uri: "file:///readme.md", name: "README" },
    { uri: "file:///src/index.ts", name: "Index" },
    { uri: "file:///secret.txt", name: "Secret" },
  ];

  it("returns all resources when allowedResources is undefined", () => {
    const policy: ServerPolicy = {};
    expect(filterAllowedResources(policy, resources)).toEqual(resources);
  });

  it("returns all resources when allowedResources is empty", () => {
    const policy: ServerPolicy = { allowedResources: [] };
    expect(filterAllowedResources(policy, resources)).toEqual(resources);
  });

  it("returns only allowed resources", () => {
    const policy: ServerPolicy = { allowedResources: ["file:///readme.md"] };
    expect(filterAllowedResources(policy, resources)).toEqual([resources[0]]);
  });

  it("returns empty array when no resources match allowedResources", () => {
    const policy: ServerPolicy = { allowedResources: ["file:///other.txt"] };
    expect(filterAllowedResources(policy, resources)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterAllowedPrompts
// ---------------------------------------------------------------------------
describe("filterAllowedPrompts", () => {
  const prompts: PromptMeta[] = [
    { name: "summarize", description: "Summarize text" },
    { name: "translate", description: "Translate text" },
    { name: "generate_code", description: "Generate code" },
  ];

  it("returns all prompts when allowedPrompts is undefined", () => {
    const policy: ServerPolicy = {};
    expect(filterAllowedPrompts(policy, prompts)).toEqual(prompts);
  });

  it("returns all prompts when allowedPrompts is empty", () => {
    const policy: ServerPolicy = { allowedPrompts: [] };
    expect(filterAllowedPrompts(policy, prompts)).toEqual(prompts);
  });

  it("returns only allowed prompts", () => {
    const policy: ServerPolicy = { allowedPrompts: ["summarize", "translate"] };
    expect(filterAllowedPrompts(policy, prompts)).toEqual([prompts[0], prompts[1]]);
  });

  it("returns empty array when no prompts match allowedPrompts", () => {
    const policy: ServerPolicy = { allowedPrompts: ["review"] };
    expect(filterAllowedPrompts(policy, prompts)).toEqual([]);
  });
});
