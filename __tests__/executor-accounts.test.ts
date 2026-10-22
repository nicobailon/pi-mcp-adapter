import { describe, expect, it } from "vitest";
import { findAccountGap } from "../executor-accounts.ts";

type Calls = { path: string; input: unknown } | Array<{ path: string; input: unknown }>;

function request(calls: Calls) {
  return { name: "call", arguments: { calls } };
}

function failed(path: string, code?: string) {
  return {
    path,
    ok: false,
    error: {
      kind: "ToolFailure",
      message: "This app needs an account, and none is linked to it for you.",
      ...(code ? { response: { code, status: 409, message: "This app needs an account.", retryable: false } } : {}),
    },
  };
}

function completed(value: unknown, toolCalls: Array<{ name: string; outcome: string }> = []) {
  return {
    content: [{ type: "text", text: "{}" }],
    structuredContent: { status: "completed", execution: { ok: true, value, toolCalls }, unavailableApps: [] },
  };
}

const single = request({ path: 'tools["needs-account"].read', input: {} });

describe("findAccountGap", () => {
  it("names the app from the request path of a single call with no linked account", () => {
    expect(findAccountGap(single, completed(failed('tools["needs-account"].read', "AppAccountRequired"))))
      .toEqual({ code: "AppAccountRequired", slug: "needs-account", retrySafe: true });
  });

  it("reads the slug from the caller's path, not Executor's echo, when binding an account fails", () => {
    const result = completed(failed("tools.other.read", "AccountRequired"), [{ name: "tools.github.issues.list", outcome: "failure" }]);
    expect(findAccountGap(request({ path: " github.issues.list ", input: {} }), result))
      .toEqual({ code: "AccountRequired", slug: "github", retrySafe: true });
  });

  it.each([
    ["a tool call that succeeded", [{ name: "tools.a.b", outcome: "success" }]],
    ["a tool call that may have run", [{ name: "tools.a.b", outcome: "interrupted" }]],
    ["a tool call awaiting approval", [{ name: "tools.a.b", outcome: "awaiting-approval" }]],
    ["two failed tool calls", [{ name: "tools.a.b", outcome: "failure" }, { name: "tools.a.c", outcome: "failure" }]],
  ])("is not retry-safe after %s", (_label, toolCalls) => {
    expect(findAccountGap(single, completed(failed("x", "AccountRequired"), toolCalls))?.retrySafe).toBe(false);
  });

  it("names the failing call's app in a batch with no success, and never retries a batch", () => {
    const calls = [{ path: "tools.broken.read", input: {} }, { path: "needs-account.read", input: {} }];
    const result = completed([failed("tools.broken.read"), failed("needs-account.read", "AppAccountRequired")]);
    expect(findAccountGap(request(calls), result)).toEqual({ code: "AppAccountRequired", slug: "needs-account", retrySafe: false });
  });

  it.each([
    ["an execute result", { name: "execute", arguments: { code: "x" } }, {
      structuredContent: {
        status: "completed",
        execution: { ok: false, error: { kind: "ToolFailure", message: "m", response: { code: "AppAccountRequired" } }, toolCalls: [] },
        unavailableApps: [],
      },
    }],
    ["a successful call", single, completed({ path: "x", ok: true, value: 1 })],
    ["another error code", single, completed(failed("x", "Forbidden"))],
    ["a failure with no response", single, completed(failed("x"))],
    ["a batch where another call succeeded", request([{ path: "a.b", input: {} }, { path: "c.d", input: {} }]),
      completed([{ path: "a.b", ok: true, value: null }, failed("c.d", "AppAccountRequired")])],
    ["a failed call execution", single, {
      structuredContent: { status: "completed", execution: { ok: false, error: { kind: "TimeoutExceeded", message: "m" }, toolCalls: [] } },
    }],
    ["a result that is not completed", single, { structuredContent: { status: "busy", requestId: "r" } }],
    ["a result with no structured content", single, { content: [{ type: "text", text: "boom" }], isError: true }],
  ])("finds no gap in %s", (_label, params, result) => {
    expect(findAccountGap(params, result)).toBeUndefined();
  });

  it.each([
    ["an execution that is neither shape", { structuredContent: { status: "completed", execution: { ok: "yes", toolCalls: [] } } }],
    ["an execution without toolCalls", { structuredContent: { status: "completed", execution: { ok: true, value: null } } }],
    ["an unknown tool call outcome", completed(failed("x", "AppAccountRequired"), [{ name: "a", outcome: "skipped" }])],
    ["an outcome without a path", completed({ ok: false, error: { kind: "ToolFailure", message: "m" } })],
    ["a response without a code", completed({ path: "x", ok: false, error: { kind: "ToolFailure", message: "m", response: {} } })],
    ["a batch answer to a single call", completed([failed("x", "AppAccountRequired")])],
  ])("throws on %s", (_label, result) => {
    expect(() => findAccountGap(single, result)).toThrow("Executor returned a malformed call result");
  });

  it("throws when the request path names no app", () => {
    expect(() => findAccountGap(request({ path: "tools", input: {} }), completed(failed("tools", "AppAccountRequired"))))
      .toThrow("which names no app");
  });
});
