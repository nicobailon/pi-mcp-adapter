import { describe, expect, it } from "vitest";
import { parseJsonWithComments } from "../utils.ts";

describe("parseJsonWithComments", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "  \n\t  \r\n"],
    ["line comment only", "// no config here\n"],
    ["block comment only", "/* no config here */"],
    ["whitespace and comments", "  // c1\n /* c2 */ \t\n"],
  ])("returns undefined for blank input (%s)", (_name, input) => {
    expect(parseJsonWithComments(input)).toBeUndefined();
  });

  it("parses JSON with comments and trailing commas", () => {
    expect(parseJsonWithComments('{ // leading\n"mcpServers": {} /* trailing */ }')).toEqual({
      mcpServers: {},
    });
    expect(parseJsonWithComments('{"a": [1, 2,],}')).toEqual({ a: [1, 2] });
  });

  it("parses plain JSON values unchanged", () => {
    expect(parseJsonWithComments("{}")).toEqual({});
    expect(parseJsonWithComments("[1, 2]")).toEqual([1, 2]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonWithComments("{")).toThrow();
    expect(() => parseJsonWithComments('{"a": }')).toThrow();
  });
});
