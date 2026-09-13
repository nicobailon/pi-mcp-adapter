import { describe, expect, it } from "vitest";
import { parseJsonWithComments } from "../utils.ts";

describe("parseJsonWithComments", () => {
  it.each(["", "  \n\t", "// comment only\n", "/* comment only */"])('keeps blank input strict: %j', (input) => {
    expect(() => parseJsonWithComments(input)).toThrow(SyntaxError);
  });
});
