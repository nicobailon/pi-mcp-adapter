import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEnv, resolveHeaders, toStringRecord } from "../utils.ts";

describe("toStringRecord", () => {
  it("returns undefined for null/undefined/non-object", () => {
    expect(toStringRecord(null)).toBeUndefined();
    expect(toStringRecord(undefined)).toBeUndefined();
    expect(toStringRecord("string")).toBeUndefined();
    expect(toStringRecord(42)).toBeUndefined();
    expect(toStringRecord([1, 2])).toBeUndefined();
  });

  it("extracts string values and drops non-strings", () => {
    expect(toStringRecord({ a: "hello", b: 42, c: true, d: "world" }))
      .toEqual({ a: "hello", d: "world" });
  });

  it("returns undefined for objects with no string values", () => {
    expect(toStringRecord({ a: 42, b: true })).toBeUndefined();
  });

  it("returns undefined for empty objects", () => {
    expect(toStringRecord({})).toBeUndefined();
  });

  it("returns all entries when all values are strings", () => {
    expect(toStringRecord({ KEY: "val", OTHER: "val2" }))
      .toEqual({ KEY: "val", OTHER: "val2" });
  });
});

describe("resolveEnv", () => {
  beforeEach(() => {
    process.env.TEST_VAR = "test-value";
    process.env.API_KEY = "sk-123";
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.API_KEY;
  });

  it("returns process.env when no custom env provided", () => {
    const result = resolveEnv();
    expect(result.TEST_VAR).toBe("test-value");
  });

  it("interpolates ${VAR} syntax", () => {
    const result = resolveEnv({ MY_KEY: "${TEST_VAR}" });
    expect(result.MY_KEY).toBe("test-value");
  });

  it("interpolates $env:VAR syntax", () => {
    const result = resolveEnv({ MY_KEY: "$env:TEST_VAR" });
    expect(result.MY_KEY).toBe("test-value");
  });

  it("interpolates {env:VAR} OpenCode syntax", () => {
    const result = resolveEnv({ MY_KEY: "{env:TEST_VAR}" });
    expect(result.MY_KEY).toBe("test-value");
  });

  it("interpolates {env:VAR} within a string", () => {
    const result = resolveEnv({ AUTH: "Bearer {env:API_KEY}" });
    expect(result.AUTH).toBe("Bearer sk-123");
  });

  it("resolves missing vars to empty string", () => {
    const result = resolveEnv({ MY_KEY: "{env:NONEXISTENT}" });
    expect(result.MY_KEY).toBe("");
  });

  it("handles multiple interpolations in one value", () => {
    const result = resolveEnv({ COMBINED: "{env:TEST_VAR}-${API_KEY}" });
    expect(result.COMBINED).toBe("test-value-sk-123");
  });

  it("passes through plain values unchanged", () => {
    const result = resolveEnv({ PLAIN: "literal-value" });
    expect(result.PLAIN).toBe("literal-value");
  });
});

describe("resolveHeaders", () => {
  beforeEach(() => {
    process.env.MY_TOKEN = "tok-abc";
  });

  afterEach(() => {
    delete process.env.MY_TOKEN;
  });

  it("returns undefined for undefined input", () => {
    expect(resolveHeaders(undefined)).toBeUndefined();
  });

  it("interpolates ${VAR} syntax", () => {
    const result = resolveHeaders({ Authorization: "Bearer ${MY_TOKEN}" });
    expect(result).toEqual({ Authorization: "Bearer tok-abc" });
  });

  it("interpolates $env:VAR syntax", () => {
    const result = resolveHeaders({ Authorization: "Bearer $env:MY_TOKEN" });
    expect(result).toEqual({ Authorization: "Bearer tok-abc" });
  });

  it("interpolates {env:VAR} OpenCode syntax", () => {
    const result = resolveHeaders({ Authorization: "Bearer {env:MY_TOKEN}" });
    expect(result).toEqual({ Authorization: "Bearer tok-abc" });
  });

  it("resolves missing vars to empty string", () => {
    const result = resolveHeaders({ "X-Key": "{env:MISSING}" });
    expect(result).toEqual({ "X-Key": "" });
  });

  it("passes through plain headers unchanged", () => {
    const result = resolveHeaders({ "Content-Type": "application/json" });
    expect(result).toEqual({ "Content-Type": "application/json" });
  });
});
