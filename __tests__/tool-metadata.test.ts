import { describe, expect, it } from "vitest";
import { formatSchema } from "../tool-metadata.ts";

describe("formatSchema", () => {
  it("keeps simple object schemas compact", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term", default: "all" },
        limit: { type: ["number", "null"] },
        mode: { enum: ["fast", "safe"] },
      },
      required: ["query"],
    };

    expect(formatSchema(schema)).toBe([
      "  query (string) *required* - Search term [default: \"all\"]",
      "  limit (number | null)",
      "  mode (enum: \"fast\", \"safe\")",
    ].join("\n"));
  });

  it("expands union branches with const discriminator fields", () => {
    const schema = {
      type: "object",
      properties: {
        document: {
          anyOf: [
            {
              type: "object",
              properties: {
                type: { const: "text" },
                content: { type: "string", minLength: 1 },
              },
              required: ["type", "content"],
            },
            {
              type: "object",
              properties: {
                type: { const: "file" },
                path: { type: "string", minLength: 1 },
              },
              required: ["type", "path"],
            },
          ],
        },
      },
      required: ["document"],
    };

    expect(formatSchema(schema)).toBe([
      "  document *required*",
      "    anyOf:",
      "      - object",
      "        type (const \"text\") *required*",
      "        content (string) *required* [minLength: 1]",
      "      - object",
      "        type (const \"file\") *required*",
      "        path (string) *required* [minLength: 1]",
    ].join("\n"));
  });

  it("formats oneOf branches", () => {
    const schema = {
      type: "object",
      properties: {
        target: {
          oneOf: [
            { const: "draft" },
            { const: "published" },
          ],
        },
      },
    };

    expect(formatSchema(schema)).toBe([
      "  target",
      "    oneOf:",
      "      - const \"draft\"",
      "      - const \"published\"",
    ].join("\n"));
  });

  it("formats nested object properties and array items", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            tags: {
              type: "array",
              items: { enum: ["alpha", "beta"] },
              minItems: 1,
            },
          },
          required: ["enabled"],
        },
      },
      required: ["config"],
    };

    expect(formatSchema(schema)).toBe([
      "  config (object) *required*",
      "    enabled (boolean) *required*",
      "    tags (array) [minItems: 1]",
      "      items (enum: \"alpha\", \"beta\")",
    ].join("\n"));
  });
});
