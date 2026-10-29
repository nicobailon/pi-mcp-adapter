import { describe, expect, it, vi } from "vitest";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { createJsonSchemaValidator } from "../json-schema-validator.ts";

const draft07 = "http://json-schema.org/draft-07/schema#";
const draft07Https = "https://json-schema.org/draft-07/schema#";

function validate(schema: Record<string, unknown>, value: unknown) {
  return createJsonSchemaValidator().getValidator(schema as JsonSchemaType)(value);
}

describe("createJsonSchemaValidator", () => {
  it.each([draft07, draft07Https])("routes %s to draft-07 semantics", schema => {
    const result = validate({
      $schema: schema,
      type: "object",
      properties: {
        values: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
          additionalItems: false,
        },
      },
      required: ["values"],
    }, { values: ["ok", 1] });

    expect(result).toMatchObject({ valid: true, data: { values: ["ok", 1] } });
    expect(validate({
      $schema: schema,
      type: "object",
      properties: {
        values: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
          additionalItems: false,
        },
      },
      required: ["values"],
    }, { values: ["ok", 1, true] }).valid).toBe(false);
  });

  it("enforces draft-07 formats", () => {
    const schema = {
      $schema: draft07,
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
    };

    expect(validate(schema, { email: "valid@example.com" }).valid).toBe(true);
    expect(validate(schema, { email: "not-an-email" }).valid).toBe(false);
  });

  it("keeps 2020-12 tuple semantics for explicit and unstamped schemas", () => {
    const schema = {
      type: "object",
      properties: {
        values: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
          items: false,
        },
      },
      required: ["values"],
    };

    for (const candidate of [schema, { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }]) {
      expect(validate(candidate, { values: ["ok", 1] }).valid).toBe(true);
      expect(validate(candidate, { values: ["ok", 1, true] }).valid).toBe(false);
    }
  });

  it("accepts unstamped schemas that use draft-07-compatible keywords", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
      additionalProperties: false,
    };

    expect(validate(schema, { name: "ok" }).valid).toBe(true);
    expect(validate(schema, { name: "" }).valid).toBe(false);
    expect(validate(schema, { name: "ok", extra: true }).valid).toBe(false);
  });

  it.each([draft07, draft07Https, "https://json-schema.org/draft/2020-12/schema", undefined])(
    "ignores unknown format annotations without writing to the terminal (%s)",
    $schema => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const schema = {
          ...($schema ? { $schema } : {}),
          type: "object",
          properties: {
            payload: { type: "string", format: "json", minLength: 1 },
            custom: { type: "string", format: "server-defined-format" },
            email: { type: "string", format: "email" },
          },
          required: ["payload", "email"],
          additionalProperties: false,
        };
        const check = createJsonSchemaValidator().getValidator(schema as JsonSchemaType);

        expect(check({ payload: "{}", custom: "opaque", email: "valid@example.com" }).valid).toBe(true);
        expect(check({ payload: 42, email: "valid@example.com" }).valid).toBe(false);
        expect(check({ payload: "", email: "valid@example.com" }).valid).toBe(false);
        expect(check({ payload: "{}", email: "not-an-email" }).valid).toBe(false);
        expect(check({ payload: "{}" }).valid).toBe(false);
        expect(check({ payload: "{}", email: "valid@example.com", extra: true }).valid).toBe(false);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each([draft07, undefined])("accepts schemars numeric formats without warnings (%s)", $schema => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const schema = {
        ...($schema ? { $schema } : {}),
        type: "object",
        properties: {
          limit: { type: "integer", format: "uint64", minimum: 0 },
          small: { type: "integer", format: "uint8", minimum: 0, maximum: 255 },
          offset: { type: "integer", format: "int32" },
        },
      };

      expect(validate(schema, { limit: 5, small: 255, offset: -1 }).valid).toBe(true);
      expect(validate(schema, { limit: -1 }).valid).toBe(false);
      expect(validate(schema, { limit: 1.5 }).valid).toBe(false);
      expect(validate(schema, { small: 256 }).valid).toBe(false);
      expect(validate(schema, { offset: 2 ** 40 }).valid).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not downgrade an unsupported explicit dialect", () => {
    expect(() => validate({
      $schema: "https://example.com/custom-schema",
      type: "object",
    }, {})).toThrow(/unsupported.*dialect|2020-12/i);
  });

  it("creates isolated validator providers", () => {
    const first = createJsonSchemaValidator();
    const second = createJsonSchemaValidator();
    const firstSchema = { $schema: draft07, $id: "https://example.com/shared-schema", type: "string" };
    const secondSchema = { $schema: draft07, $id: "https://example.com/shared-schema", type: "number" };

    expect(first.getValidator(firstSchema as JsonSchemaType)("ok").valid).toBe(true);
    expect(second.getValidator(secondSchema as JsonSchemaType)(42).valid).toBe(true);
  });
});
