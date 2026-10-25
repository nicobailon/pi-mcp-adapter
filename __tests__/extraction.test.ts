import { describe, expect, it } from "vitest";
import { parseExtractFields } from "../extraction.ts";

describe("parseExtractFields", () => {
  it("maps each type the agent writes to the field Clairic receives", () => {
    expect(parseExtractFields({
      a: "text",
      b: "integer",
      c: "duration.minutes",
      d: { type: "duration", unit: "hours", decimals: 1 },
      e: { type: "number", description: "Order total", unit: "USD", decimals: 2 },
      f: "list.number",
      g: { type: "list", description: "Item names" },
      h: "datetime",
    })).toEqual({
      ok: true,
      fields: {
        a: { type: "text", spec: { type: "text", null_threshold: 0.5 } },
        b: { type: "integer", spec: { type: "number", integer: true, null_threshold: 0.5 } },
        c: { type: "duration.minutes", spec: { type: "duration", unit: "minutes", null_threshold: 0.5 } },
        d: { type: "duration", spec: { type: "duration", unit: "hours", decimals: 1, null_threshold: 0.5 } },
        e: { type: "number", spec: { type: "number", instructions: "Order total", unit: "USD", decimals: 2, null_threshold: 0.5 } },
        f: { type: "list.number", spec: { type: "list", items: "number" } },
        g: { type: "list", spec: { type: "list", items: "text", instructions: "Item names" } },
        h: { type: "datetime", spec: { type: "datetime", null_threshold: 0.5 } },
      },
    });
  });

  it.each([
    ["a non-object", [], "extract must be an object of field names to types"],
    ["no fields", {}, "extract needs 1 to 16 fields"],
    ["17 fields", Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, "text"])), "extract needs 1 to 16 fields"],
    ["a bad name", { "1st": "text" }, "field names must start with a letter or underscore and use only letters, digits, _, . or - (64 characters at most)"],
    ["an unknown type", { a: "colour" }, 'field "a" has an unknown type'],
    ["an unknown option", { a: { type: "text", format: "x" } }, 'field "a" has an unsupported option (use type, description, unit or decimals)'],
    ["unit on text", { a: { type: "text", unit: "USD" } }, 'field "a": unit applies only to number and duration fields'],
    ["a second duration unit", { a: { type: "duration.minutes", unit: "hours" } }, 'field "a": unit is already part of its type'],
    ["an unknown duration unit", { a: { type: "duration", unit: "fortnights" } }, 'field "a": a duration unit must be one of seconds, minutes, hours, days, weeks, months, years'],
    ["decimals on a date", { a: { type: "date", decimals: 2 } }, 'field "a": decimals applies only to number, duration and list.number fields'],
    ["decimals out of range", { a: { type: "number", decimals: 7 } }, 'field "a": decimals must be an integer from 0 to 6'],
  ])("refuses %s", (_label, value, message) => {
    expect(parseExtractFields(value)).toEqual({ ok: false, message });
  });
});
