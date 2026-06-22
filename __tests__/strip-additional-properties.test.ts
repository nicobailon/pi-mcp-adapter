import { describe, expect, it } from "vitest";
import { stripAdditionalProperties } from "../utils.ts";

describe("stripAdditionalProperties", () => {
  it("passes through a normal schema unchanged", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name"],
    };

    const result = stripAdditionalProperties(schema);

    expect(result).toEqual(schema);
  });

  it("strips additionalProperties: false from a strict schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    };

    const result = stripAdditionalProperties(schema);

    expect(result).not.toHaveProperty("additionalProperties");
    expect(result).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });
});
