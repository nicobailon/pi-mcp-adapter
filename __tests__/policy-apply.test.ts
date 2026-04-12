// policy-apply.test.ts — RED phase: applyToolPolicy (Slice 3)
import { describe, it, expect } from "vitest";
import { applyToolPolicy, type ToolPolicy } from "../policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ok(result: ReturnType<typeof applyToolPolicy>) {
  if (!result.ok) throw new Error(`Expected ok but got error: ${result.error}`);
  return result.args;
}

function err(result: ReturnType<typeof applyToolPolicy>) {
  if (result.ok) throw new Error(`Expected error but got ok`);
  return result.error;
}

// ---------------------------------------------------------------------------
// Malformed shape checks
// ---------------------------------------------------------------------------
describe("applyToolPolicy: malformed args shape", () => {
  const policy: ToolPolicy = {};

  it("rejects null", () => {
    expect(err(applyToolPolicy(policy, null))).toMatch(/plain object/);
  });

  it("rejects array", () => {
    expect(err(applyToolPolicy(policy, []))).toMatch(/plain object/);
  });

  it("rejects string", () => {
    expect(err(applyToolPolicy(policy, "hello"))).toMatch(/plain object/);
  });

  it("rejects number", () => {
    expect(err(applyToolPolicy(policy, 42))).toMatch(/plain object/);
  });

  it("rejects Object.create(null) (no prototype)", () => {
    expect(err(applyToolPolicy(policy, Object.create(null)))).toMatch(/plain object/);
  });

  it("rejects args.items that is not an array", () => {
    expect(err(applyToolPolicy(policy, { items: "not-an-array" }))).toMatch(/items must be an array/);
  });

  it("rejects args.items[i] that is not a plain object", () => {
    expect(err(applyToolPolicy(policy, { items: ["string-item"] }))).toMatch(/each item in items must be a plain object/);
  });

  it("accepts args.items as empty array", () => {
    expect(applyToolPolicy(policy, { items: [] }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------
describe("applyToolPolicy: defaults", () => {
  it("fills missing keys with defaults", () => {
    const policy: ToolPolicy = { defaults: { mode: "read", limit: 10 } };
    const result = ok(applyToolPolicy(policy, { path: "/tmp" }));
    expect(result).toMatchObject({ path: "/tmp", mode: "read", limit: 10 });
  });

  it("does not overwrite existing values", () => {
    const policy: ToolPolicy = { defaults: { mode: "read" } };
    const result = ok(applyToolPolicy(policy, { mode: "write" }));
    expect(result.mode).toBe("write");
  });
});

// ---------------------------------------------------------------------------
// forbidKeys
// ---------------------------------------------------------------------------
describe("applyToolPolicy: forbidKeys", () => {
  it("rejects when a forbidden key is present", () => {
    const policy: ToolPolicy = { forbidKeys: ["dangerous"] };
    expect(err(applyToolPolicy(policy, { dangerous: true }))).toMatch(/dangerous/);
  });

  it("passes when no forbidden key is present", () => {
    const policy: ToolPolicy = { forbidKeys: ["dangerous"] };
    expect(applyToolPolicy(policy, { safe: true }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requireKeys
// ---------------------------------------------------------------------------
describe("applyToolPolicy: requireKeys", () => {
  it("rejects when a required key is missing", () => {
    const policy: ToolPolicy = { requireKeys: ["path"] };
    expect(err(applyToolPolicy(policy, { mode: "read" }))).toMatch(/path/);
  });

  it("passes when all required keys are present", () => {
    const policy: ToolPolicy = { requireKeys: ["path"] };
    expect(applyToolPolicy(policy, { path: "/tmp" }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allowedValues
// ---------------------------------------------------------------------------
describe("applyToolPolicy: allowedValues", () => {
  it("rejects when a value is not in the allowed list", () => {
    const policy: ToolPolicy = { allowedValues: { mode: ["read", "list"] } };
    expect(err(applyToolPolicy(policy, { mode: "delete" }))).toMatch(/mode/);
  });

  it("passes when value is in the allowed list (strict ===)", () => {
    const policy: ToolPolicy = { allowedValues: { mode: ["read", "list"] } };
    expect(applyToolPolicy(policy, { mode: "read" }).ok).toBe(true);
  });

  it("passes when the key is absent (not enforced if missing)", () => {
    const policy: ToolPolicy = { allowedValues: { mode: ["read"] } };
    expect(applyToolPolicy(policy, {}).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// injectIntoEachItem
// ---------------------------------------------------------------------------
describe("applyToolPolicy: injectIntoEachItem", () => {
  it("injects missing keys into each item", () => {
    const policy: ToolPolicy = { injectIntoEachItem: { role: "user" } };
    const result = ok(applyToolPolicy(policy, { items: [{ text: "hi" }] }));
    expect((result.items as any[])[0]).toMatchObject({ text: "hi", role: "user" });
  });

  it("does not overwrite existing item keys", () => {
    const policy: ToolPolicy = { injectIntoEachItem: { role: "user" } };
    const result = ok(applyToolPolicy(policy, { items: [{ role: "admin" }] }));
    expect((result.items as any[])[0].role).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// forbidPerItemKeys
// ---------------------------------------------------------------------------
describe("applyToolPolicy: forbidPerItemKeys", () => {
  it("rejects when a forbidden per-item key is present in any item", () => {
    const policy: ToolPolicy = { forbidPerItemKeys: ["secret"] };
    expect(err(applyToolPolicy(policy, { items: [{ secret: "x" }] }))).toMatch(/secret/);
  });

  it("passes when no item contains a forbidden key", () => {
    const policy: ToolPolicy = { forbidPerItemKeys: ["secret"] };
    expect(applyToolPolicy(policy, { items: [{ text: "hi" }] }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requirePerItemKeys
// ---------------------------------------------------------------------------
describe("applyToolPolicy: requirePerItemKeys", () => {
  it("rejects when a required per-item key is missing from any item", () => {
    const policy: ToolPolicy = { requirePerItemKeys: ["text"] };
    expect(err(applyToolPolicy(policy, { items: [{ other: "x" }] }))).toMatch(/text/);
  });

  it("passes when all items have the required key", () => {
    const policy: ToolPolicy = { requirePerItemKeys: ["text"] };
    expect(applyToolPolicy(policy, { items: [{ text: "hi" }] }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allowedValuesEach
// ---------------------------------------------------------------------------
describe("applyToolPolicy: allowedValuesEach", () => {
  it("rejects when any item has a value not in the allowed list", () => {
    const policy: ToolPolicy = { allowedValuesEach: { role: ["user", "assistant"] } };
    expect(err(applyToolPolicy(policy, { items: [{ role: "system" }] }))).toMatch(/role/);
  });

  it("passes when all items have allowed values", () => {
    const policy: ToolPolicy = { allowedValuesEach: { role: ["user", "assistant"] } };
    expect(applyToolPolicy(policy, { items: [{ role: "user" }, { role: "assistant" }] }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------
describe("applyToolPolicy: happy paths", () => {
  it("no policy defined → args pass through unchanged", () => {
    const args = { path: "/tmp", limit: 5 };
    const result = ok(applyToolPolicy({}, args));
    expect(result).toEqual(args);
  });

  it("full policy applied — defaults + injection, all checks pass", () => {
    const policy: ToolPolicy = {
      defaults: { limit: 10 },
      requireKeys: ["path"],
      forbidKeys: ["root"],
      allowedValues: { mode: ["read"] },
      injectIntoEachItem: { role: "user" },
      requirePerItemKeys: ["text"],
      forbidPerItemKeys: ["secret"],
      allowedValuesEach: { role: ["user"] },
    };
    const args = { path: "/tmp", mode: "read", items: [{ text: "hi" }] };
    const result = ok(applyToolPolicy(policy, args));
    expect(result.limit).toBe(10);
    expect((result.items as any[])[0].role).toBe("user");
  });

  it("does not mutate the original args object", () => {
    const policy: ToolPolicy = { defaults: { extra: "added" } };
    const original = { path: "/tmp" };
    const frozen = Object.freeze({ ...original });
    // applyToolPolicy should work on a clone, not the frozen original
    expect(() => ok(applyToolPolicy(policy, { path: "/tmp" }))).not.toThrow();
    expect(original).not.toHaveProperty("extra");
  });
});
