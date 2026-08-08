import { describe, expect, it } from "vitest";
import { renderTsShape } from "../ts-shape.ts";

describe("renderTsShape", () => {
  it("renders required and optional object properties", () => {
    expect(renderTsShape({
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      required: ["query"],
    })).toBe("{ query: string; limit?: number; }");
  });

  it("renders enum unions", () => {
    expect(renderTsShape({ enum: ["fast", "safe", null] })).toBe('"fast" | "safe" | null');
  });

  it("renders nested objects and arrays", () => {
    expect(renderTsShape({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" } } },
          required: ["tags"],
        },
      },
      required: ["config"],
    })).toBe("{ config: { tags: string[]; }; }");
  });

  it("hoists local references as named definitions", () => {
    expect(renderTsShape({
      type: "object",
      properties: { address: { $ref: "#/$defs/Address" } },
      required: ["address"],
      $defs: {
        Address: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    })).toBe("type Address = { city: string; };\n\n{ address: Address; }");
  });

  it("ignores unsupported unreferenced definitions", () => {
    expect(renderTsShape({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      $defs: {
        Unused: { if: { type: "string" }, then: { type: "number" } },
      },
    })).toBe("{ query: string; }");
  });

  it("renders closed objects with referenced union variants", () => {
    expect(renderTsShape({
      type: "object",
      additionalProperties: false,
      properties: {
        blocks: { type: "array", items: { $ref: "#/$defs/block" } },
      },
      required: ["blocks"],
      $defs: {
        text: {
          type: "object",
          additionalProperties: false,
          properties: { type: { const: "text" }, text: { type: "string" } },
          required: ["type", "text"],
        },
        qr: {
          type: "object",
          additionalProperties: false,
          properties: { type: { const: "qr" }, data: { type: "string" } },
          required: ["type", "data"],
        },
        block: {
          oneOf: [
            { $ref: "#/$defs/text" },
            { $ref: "#/$defs/qr" },
          ],
        },
      },
    })).toBe([
      'type block = text | qr;',
      'type text = { type: "text"; text: string; };',
      'type qr = { type: "qr"; data: string; };',
      "",
      "{ blocks: block[]; }",
    ].join("\n"));
  });

  it("returns null for exotic schemas", () => {
    expect(renderTsShape({ if: { type: "string" }, then: { type: "number" } })).toBeNull();
    expect(renderTsShape({ $ref: "https://example.com/schema" })).toBeNull();
  });
});
