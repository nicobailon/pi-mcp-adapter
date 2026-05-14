/**
 * Tests for proxy-modes.ts - regex-mode ReDoS guard.
 */

import { describe, it } from "node:test"
import assert from "node:assert"

import { executeSearch } from "./proxy-modes.ts"
import type { McpExtensionState } from "./state.ts"

// `executeSearch` only reads `state.toolMetadata`. A minimal stub is enough.
function makeState(): McpExtensionState {
  return {
    toolMetadata: new Map(),
  } as unknown as McpExtensionState
}

describe("executeSearch regex-mode ReDoS guard", () => {
  it("rejects regex queries longer than the 256-char cap", () => {
    const longQuery = "a".repeat(257)
    const result = executeSearch(makeState(), longQuery, true)
    assert.strictEqual(
      (result.details as Record<string, unknown>).error,
      "query_too_long",
    )
  })

  it("reports invalid_pattern for malformed regex (not unsafe_pattern)", () => {
    // `[` is a syntax error; the recheck step would otherwise mask it.
    const result = executeSearch(makeState(), "[", true)
    assert.strictEqual(
      (result.details as Record<string, unknown>).error,
      "invalid_pattern",
    )
  })


  // Patterns recheck identifies as having exponential / super-linear matching
  // complexity. These are the genuine catastrophic-backtracking shapes that
  // older heuristic checkers (safe-regex) miss.
  const vulnerablePatterns = [
    "(a|a)*b",
    "(a|ab)*c",
    "^(a|aa)+$",
    "(.|.)+a$",
  ]

  for (const pat of vulnerablePatterns) {
    it(`rejects catastrophic-backtracking pattern ${pat}`, () => {
      const result = executeSearch(makeState(), pat, true)
      assert.strictEqual(
        (result.details as Record<string, unknown>).error,
        "unsafe_pattern",
        `expected ${pat} to be rejected as unsafe`,
      )
    })
  }

  it("accepts a benign anchored pattern", () => {
    const result = executeSearch(makeState(), "^foo[0-9]+bar$", true)
    const error = (result.details as Record<string, unknown>).error
    assert.notStrictEqual(error, "unsafe_pattern")
    assert.notStrictEqual(error, "query_too_long")
    assert.notStrictEqual(error, "invalid_pattern")
  })

  it("non-regex mode is unaffected by the length cap (terms are escaped)", () => {
    // A long string in non-regex mode is split into terms and escaped, so the
    // length cap deliberately does not apply.
    const longText = "search terms ".repeat(40)
    const result = executeSearch(makeState(), longText, false)
    assert.notStrictEqual(
      (result.details as Record<string, unknown>).error,
      "query_too_long",
    )
  })
})
