import { describe, expect, it } from "vitest";
import { formatSchema } from "../tool-metadata.ts";

describe("formatSchema", () => {
  it("keeps simple object schemas compact", () => {
    expect(formatSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "integer", default: 10 },
      },
      required: ["query"],
    })).toBe([
      "  query (string) *required* - Search query",
      "  limit (integer) [default: 10]",
    ].join("\n"));
  });

  it("expands union branches with const discriminator values", () => {
    const output = formatSchema({
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
    });

    expect(output).toContain("  document (union) *required*");
    expect(output).toContain("    anyOf:");
    expect(output).toContain("      - object");
    expect(output).toContain("        type (const: \"text\") *required*");
    expect(output).toContain("        content (string) *required* [minLength: 1]");
    expect(output).toContain("        type (const: \"file\") *required*");
    expect(output).toContain("        path (string) *required* [minLength: 1]");
  });

  it("expands array item schemas", () => {
    const output = formatSchema({
      type: "object",
      properties: {
        records: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { enum: ["a", "b"] },
              id: { type: "string" },
            },
            required: ["kind", "id"],
          },
        },
      },
    });

    expect(output).toContain("  records (array)");
    expect(output).toContain("    items:");
    expect(output).toContain("      - object");
    expect(output).toContain("        kind (enum: \"a\", \"b\") *required*");
    expect(output).toContain("        id (string) *required*");
  });
});
