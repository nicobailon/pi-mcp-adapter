// policy.test.ts — RED phase: config/types validation for the generic policy layer (Slice 1)
import { describe, it, expect } from "vitest";
import {
  validateServerPolicy,
  type ServerPolicy,
  type ToolPolicy,
} from "../policy.js";

// ---------------------------------------------------------------------------
// Acceptance — empty / omitted allowlists mean "allow all"
// ---------------------------------------------------------------------------
describe("allowlists: empty or omitted means allow all", () => {
  it("accepts a server entry with no policy fields at all", () => {
    expect(() => validateServerPolicy({})).not.toThrow();
  });

  it("accepts empty allowedTools array (allow all tools)", () => {
    expect(() => validateServerPolicy({ allowedTools: [] })).not.toThrow();
  });

  it("accepts empty allowedResources array (allow all resources)", () => {
    expect(() => validateServerPolicy({ allowedResources: [] })).not.toThrow();
  });

  it("accepts empty allowedPrompts array (allow all prompts)", () => {
    expect(() => validateServerPolicy({ allowedPrompts: [] })).not.toThrow();
  });

  it("accepts empty toolPolicies object (no per-tool overrides)", () => {
    expect(() => validateServerPolicy({ toolPolicies: {} })).not.toThrow();
  });

  it("accepts non-empty allowedTools without toolPolicies", () => {
    expect(() =>
      validateServerPolicy({ allowedTools: ["read_file", "write_file"] })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation (1): toolPolicies key must appear in a non-empty allowedTools
// ---------------------------------------------------------------------------
describe("validation: toolPolicies vs allowedTools", () => {
  it("rejects toolPolicies entry for a tool absent from non-empty allowedTools", () => {
    const policy: ServerPolicy = {
      allowedTools: ["read_file"],
      toolPolicies: {
        write_file: {}, // NOT in allowedTools → invalid
      },
    };
    expect(() => validateServerPolicy(policy)).toThrow(/write_file/);
  });

  it("accepts toolPolicies entry whose key is listed in allowedTools", () => {
    const policy: ServerPolicy = {
      allowedTools: ["read_file", "write_file"],
      toolPolicies: {
        write_file: {},
      },
    };
    expect(() => validateServerPolicy(policy)).not.toThrow();
  });

  it("accepts toolPolicies when allowedTools is omitted (allow all)", () => {
    const policy: ServerPolicy = {
      toolPolicies: {
        any_tool: {},
      },
    };
    expect(() => validateServerPolicy(policy)).not.toThrow();
  });

  it("accepts toolPolicies when allowedTools is empty (allow all)", () => {
    const policy: ServerPolicy = {
      allowedTools: [],
      toolPolicies: {
        any_tool: {},
      },
    };
    expect(() => validateServerPolicy(policy)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation (2): same key in both forbidKeys and requireKeys
// ---------------------------------------------------------------------------
describe("validation: forbidKeys vs requireKeys", () => {
  it("rejects a key present in both forbidKeys and requireKeys", () => {
    const toolPolicy: ToolPolicy = {
      forbidKeys: ["dangerous"],
      requireKeys: ["dangerous"],
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).toThrow(/dangerous/);
  });

  it("accepts distinct forbidKeys and requireKeys", () => {
    const toolPolicy: ToolPolicy = {
      forbidKeys: ["dangerous"],
      requireKeys: ["safe"],
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation (3): same key in both forbidPerItemKeys and requirePerItemKeys
// ---------------------------------------------------------------------------
describe("validation: forbidPerItemKeys vs requirePerItemKeys", () => {
  it("rejects a key present in both forbidPerItemKeys and requirePerItemKeys", () => {
    const toolPolicy: ToolPolicy = {
      forbidPerItemKeys: ["id"],
      requirePerItemKeys: ["id"],
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).toThrow(/id/);
  });

  it("accepts distinct forbidPerItemKeys and requirePerItemKeys", () => {
    const toolPolicy: ToolPolicy = {
      forbidPerItemKeys: ["secret"],
      requirePerItemKeys: ["name"],
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation (4): same key in both defaults and forbidKeys
// ---------------------------------------------------------------------------
describe("validation: defaults vs forbidKeys", () => {
  it("rejects a key present in both defaults and forbidKeys", () => {
    const toolPolicy: ToolPolicy = {
      defaults: { mode: "strict" },
      forbidKeys: ["mode"],
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).toThrow(/mode/);
  });

  it("accepts defaults and forbidKeys with no overlapping keys", () => {
    const toolPolicy: ToolPolicy = {
      defaults: { mode: "strict" },
      forbidKeys: ["other"],
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation (5): same key in both injectIntoEachItem and forbidPerItemKeys
// ---------------------------------------------------------------------------
describe("validation: injectIntoEachItem vs forbidPerItemKeys", () => {
  it("rejects a key present in both injectIntoEachItem and forbidPerItemKeys", () => {
    const toolPolicy: ToolPolicy = {
      injectIntoEachItem: { tag: "auto" },
      forbidPerItemKeys: ["tag"],
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).toThrow(/tag/);
  });

  it("accepts injectIntoEachItem and forbidPerItemKeys with no overlap", () => {
    const toolPolicy: ToolPolicy = {
      injectIntoEachItem: { tag: "auto" },
      forbidPerItemKeys: ["secret"],
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation (6): non-primitive values in allowedValues / allowedValuesEach
// ---------------------------------------------------------------------------
describe("validation: allowedValues and allowedValuesEach must contain only primitives", () => {
  it("rejects an object value inside allowedValues", () => {
    const toolPolicy: ToolPolicy = {
      allowedValues: {
        mode: [{ nested: true } as unknown as string | number | boolean | null],
      },
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).toThrow(/allowedValues/);
  });

  it("rejects an array value inside allowedValues", () => {
    const toolPolicy: ToolPolicy = {
      allowedValues: {
        tags: [["a", "b"] as unknown as string | number | boolean | null],
      },
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).toThrow(/allowedValues/);
  });

  it("accepts only primitive values inside allowedValues", () => {
    const toolPolicy: ToolPolicy = {
      allowedValues: {
        mode: ["read", "write", null],
        count: [1, 2, 3],
        flag: [true, false],
      },
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).not.toThrow();
  });

  it("rejects an object value inside allowedValuesEach", () => {
    const toolPolicy: ToolPolicy = {
      allowedValuesEach: {
        items: [{ id: 1 } as unknown as string | number | boolean | null],
      },
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).toThrow(/allowedValuesEach/);
  });

  it("accepts only primitive values inside allowedValuesEach", () => {
    const toolPolicy: ToolPolicy = {
      allowedValuesEach: {
        kind: ["file", "dir"],
      },
    };
    expect(() =>
      validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Multiple violations reported together
// ---------------------------------------------------------------------------
describe("validation: reports all violations, not just the first", () => {
  it("reports both a forbidKeys/requireKeys clash and a defaults/forbidKeys clash", () => {
    const toolPolicy: ToolPolicy = {
      defaults: { level: "high" },
      forbidKeys: ["level", "shared"],
      requireKeys: ["shared"],
    };
    const err = (() => {
      try {
        validateServerPolicy({ toolPolicies: { my_tool: toolPolicy } });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/level/);
    expect(err!.message).toMatch(/shared/);
  });
});
