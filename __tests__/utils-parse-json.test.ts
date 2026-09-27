import { describe, expect, it } from "vitest";
import { parseJsonWithComments } from "../utils.ts";

describe("parseJsonWithComments", () => {
  it("accepts a leading UTF-8 BOM without changing string contents", () => {
    expect(parseJsonWithComments('\uFEFF{"value":"\uFEFFinside"}')).toEqual({ value: "\uFEFFinside" });
  });

  it.each(["", "  \n\t", "// comment only\n", "/* comment only */"])('keeps blank input strict: %j', (input) => {
    expect(() => parseJsonWithComments(input)).toThrow(SyntaxError);
  });
});
