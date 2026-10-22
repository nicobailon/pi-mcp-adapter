import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodemodeSource } from "../codemode-bridge.ts";

// Reads the `input` line back the way the sandbox does, without evaluating it.
function inputOf(line: string | undefined): unknown {
  const match = /^const input = JSON\.parse\(("[\s\S]*")\);$/.exec(line ?? "");
  expect(match, line).not.toBeNull();
  return JSON.parse(JSON.parse(match![1]!));
}

describe("buildCodemodeSource", () => {
  it("puts the input line first and the script after it", () => {
    const source = "const issues = input.repo;\nreturn issues;";
    const lines = buildCodemodeSource({ repo: "a/b" }, source).split("\n");

    expect(lines[0]).toBe('const input = JSON.parse("{\\"repo\\":\\"a/b\\"}");');
    expect(inputOf(lines[0])).toEqual({ repo: "a/b" });
    expect(lines.slice(1).join("\n")).toBe(source);
  });

  it("keeps a leading options line first and puts the input line second", () => {
    const options = '// @options: {"timeout_ms": 60000}';
    const lines = buildCodemodeSource({ repo: "a/b" }, `${options}\nreturn input.repo;\n`).split("\n");

    expect(lines[0]).toBe(options);
    expect(inputOf(lines[1])).toEqual({ repo: "a/b" });
    expect(lines.slice(2).join("\n")).toBe("return input.repo;\n");
  });

  it("finds the options line as codemode does, after leading whitespace and before a CRLF", () => {
    const options = '  // @options: {"max_output_tokens": 100}\r';
    const lines = buildCodemodeSource({}, `${options}\nreturn 1;`).split("\n");

    expect(lines[0]).toBe(options);
    expect(inputOf(lines[1])).toEqual({});
    expect(lines[2]).toBe("return 1;");
  });

  it("only treats the first line as options", () => {
    const source = 'return 1;\n// @options: {"timeout_ms": 60000}';
    const lines = buildCodemodeSource({}, source).split("\n");

    expect(inputOf(lines[0])).toEqual({});
    expect(lines.slice(1).join("\n")).toBe(source);
  });

  it("leaves an options line with no script after it for codemode to reject", () => {
    const source = '// @options: {"timeout_ms": 60000}\n  \n';
    expect(buildCodemodeSource({ repo: "a/b" }, source)).toBe(source);
  });

  it("encodes quotes, newlines, line separators, lone surrogates and nesting in one line", () => {
    const input = {
      quote: 'say "hi" \\ there',
      newline: "one\ntwo\r\nthree",
      separators: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`,
      loneSurrogate: "x\ud800y\udc00",
      nested: { list: [1, "two", { three: [true, null] }], empty: {} },
    };
    const lines = buildCodemodeSource(input, "return input;").split("\n");

    expect(lines).toHaveLength(2);
    expect(inputOf(lines[0])).toEqual(input);
  });
});

describe("runCodemodeScript", () => {
  type Execute = (...args: unknown[]) => Promise<unknown>;
  let piPackageLoads = 0;

  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
    vi.resetModules();
    vi.restoreAllMocks();
    piPackageLoads = 0;
  });

  // A fresh bridge whose `import("@earendil-works/pi-coding-agent")` gets `exports`.
  async function loadBridge(exports: () => Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("@earendil-works/pi-coding-agent", () => {
      piPackageLoads++;
      return exports();
    });
    return import("../codemode-bridge.ts");
  }

  // Stands in for Pi's factory: registers a codemode definition whose execute is `execute`.
  function registeringFactory(execute: Execute, read?: (pi: any) => void) {
    return vi.fn(() => (pi: any) => {
      read?.(pi);
      pi.registerTool({ name: "codemode", execute });
    });
  }

  function livePi() {
    return { registerTool: vi.fn(), getSettings: vi.fn(() => ({ codemode: { mode: "on" } })), getAllTools: vi.fn(() => []), appendEntry: vi.fn(), on: vi.fn() };
  }

  function run(bridge: Awaited<ReturnType<typeof loadBridge>>, pi: ReturnType<typeof livePi>, toolCallId = "st-1") {
    return bridge.runCodemodeScript({
      pi: pi as any, ctx: { cwd: "/" } as any, toolCallId, signal: undefined, onUpdate: undefined,
      tool: "close_stale", source: "return input.repo;", input: { repo: "a/b" },
    }) as Promise<any>;
  }

  const unavailable = {
    content: [{
      type: "text",
      text: 'Script tool "close_stale" cannot run: this Pi build does not expose codemode to extensions. Update Pi to 0.99.0 or later.',
    }],
    details: { mode: "script_tool", tool: "close_stale", error: "codemode_unavailable" },
  };

  it("loads Pi on the first run, not on import, and captures codemode once", async () => {
    const result = { content: [{ type: "text", text: "Script completed" }], details: { calls: [] } };
    const execute = vi.fn(async () => result);
    const factory = registeringFactory(execute);
    const bridge = await loadBridge(() => ({ createCodemodeExtension: factory }));
    const pi = livePi();

    expect(piPackageLoads).toBe(0);
    expect(bridge.CODEMODE_UNAVAILABLE).toBe("codemode_unavailable");

    await expect(run(bridge, pi)).resolves.toBe(result);
    await expect(run(bridge, pi, "st-2")).resolves.toBe(result);

    expect(piPackageLoads).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenNthCalledWith(1, "st-1", { code: buildCodemodeSource({ repo: "a/b" }, "return input.repo;") }, undefined, undefined, { cwd: "/" });
    expect(execute).toHaveBeenNthCalledWith(2, "st-2", expect.anything(), undefined, undefined, { cwd: "/" });
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("captures separately for each adapter install", async () => {
    const factory = registeringFactory(vi.fn(async () => ({ content: [] })));
    const bridge = await loadBridge(() => ({ createCodemodeExtension: factory }));

    await run(bridge, livePi());
    await run(bridge, livePi());

    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("reports codemode_unavailable when Pi does not export createCodemodeExtension", async () => {
    const bridge = await loadBridge(() => ({ createAgentSession: () => undefined }));
    const pi = livePi();

    await expect(run(bridge, pi)).resolves.toEqual(unavailable);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("reports codemode_unavailable when the factory does not register synchronously, and retries next time", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "Script completed" }] }));
    let late: Promise<void> | undefined;
    const factory = vi.fn(() => (shim: any) => {
      if (factory.mock.calls.length === 1) late = Promise.resolve().then(() => shim.registerTool({ name: "codemode", execute }));
      else shim.registerTool({ name: "codemode", execute });
    });
    const bridge = await loadBridge(() => ({ createCodemodeExtension: factory }));
    const pi = livePi();

    await expect(run(bridge, pi)).resolves.toEqual(unavailable);
    await late;
    expect(execute).not.toHaveBeenCalled();

    await expect(run(bridge, pi)).resolves.toEqual({ content: [{ type: "text", text: "Script completed" }] });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("gives the factory a pi with only the four members codemode reads, forwarded to the live pi", async () => {
    const reads: string[] = [];
    let shim: any;
    const factory = registeringFactory(vi.fn(async () => ({ content: [] })), (pi) => {
      shim = pi;
      pi.getSettings();
      pi.getAllTools();
      pi.appendEntry("codemode-store", { a: 1 });
      for (const member of ["on", "registerCommand", "exec", "events"]) {
        try {
          void pi[member];
        } catch (error) {
          reads.push((error as Error).message);
        }
      }
    });
    const bridge = await loadBridge(() => ({ createCodemodeExtension: factory }));
    const pi = livePi();

    await expect(run(bridge, pi)).resolves.toEqual(unavailable);

    expect(reads).toEqual([
      "Pi's codemode read pi.on, which the adapter does not provide",
      "Pi's codemode read pi.registerCommand, which the adapter does not provide",
      "Pi's codemode read pi.exec, which the adapter does not provide",
      "Pi's codemode read pi.events, which the adapter does not provide",
    ]);
    expect(pi.getSettings).toHaveBeenCalledTimes(1);
    expect(pi.getAllTools).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith("codemode-store", { a: 1 });
    expect(pi.on).not.toHaveBeenCalled();
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(() => shim.sendMessage).toThrow("pi.sendMessage");
  });

  it("reports codemode_unavailable and logs why when the factory throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const factory = vi.fn(() => (shim: any) => {
      shim.on("session_start", () => {});
    });
    const bridge = await loadBridge(() => ({ createCodemodeExtension: factory }));
    const pi = livePi();

    await expect(run(bridge, pi)).resolves.toEqual(unavailable);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("MCP: codemode is unavailable: Pi's codemode read pi.on, which the adapter does not provide");
    expect(pi.on).not.toHaveBeenCalled();
  });

  it("reports codemode_unavailable and logs why when Pi cannot be imported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = await loadBridge(() => { throw new Error("broken install"); });

    await expect(run(bridge, livePi())).resolves.toEqual(unavailable);
    expect(warn).toHaveBeenCalledTimes(1);
    // Vitest wraps the mock factory's error in its own message.
    expect(warn.mock.calls[0]![0]).toMatch(/^MCP: codemode is unavailable: \S/);
  });

  it("captures only the tool named codemode", async () => {
    const helper = vi.fn(async () => ({ content: [{ type: "text", text: "helper" }] }));
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "Script completed" }] }));
    const both = await loadBridge(() => ({
      createCodemodeExtension: () => (shim: any) => {
        shim.registerTool({ name: "codemode_helper", execute: helper });
        shim.registerTool({ name: "codemode", execute });
      },
    }));
    await expect(run(both, livePi())).resolves.toEqual({ content: [{ type: "text", text: "Script completed" }] });
    expect(helper).not.toHaveBeenCalled();

    const other = await loadBridge(() => ({
      createCodemodeExtension: () => (shim: any) => shim.registerTool({ name: "run_script", execute: helper }),
    }));
    await expect(run(other, livePi())).resolves.toEqual(unavailable);
    expect(helper).not.toHaveBeenCalled();
  });

  it("passes on codemode's error when it reads another pi member while running, and recaptures next time", async () => {
    let shim: any;
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) void shim.getActiveTools();
      return { content: [{ type: "text", text: "Script completed" }] };
    });
    const factory = registeringFactory(execute, (pi) => { shim = pi; });
    const bridge = await loadBridge(() => ({ createCodemodeExtension: factory }));
    const pi = livePi();

    await expect(run(bridge, pi)).rejects.toThrow("Pi's codemode read pi.getActiveTools, which the adapter does not provide");
    await expect(run(bridge, pi)).resolves.toEqual({ content: [{ type: "text", text: "Script completed" }] });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("returns codemode's own result when it swallows the shim's throw, and recaptures next time", async () => {
    let shim: any;
    const execute = vi.fn(async () => {
      try {
        void shim.getActiveTools;
      } catch {
        return { content: [{ type: "text", text: "Script failed" }] };
      }
      return { content: [] };
    });
    const factory = registeringFactory(execute, (pi) => { shim = pi; });
    const bridge = await loadBridge(() => ({ createCodemodeExtension: factory }));
    const pi = livePi();

    await expect(run(bridge, pi)).resolves.toEqual({ content: [{ type: "text", text: "Script failed" }] });
    await run(bridge, pi);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("keeps a concurrent run's result when another run trips the shim", async () => {
    let shim: any;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async (toolCallId: unknown) => {
      if (toolCallId === "st-1") {
        await released;
        return { content: [{ type: "text", text: "first done" }] };
      }
      try {
        void shim.getActiveTools;
      } catch {
        // Codemode handled it.
      }
      release();
      return { content: [{ type: "text", text: "second done" }] };
    });
    const bridge = await loadBridge(() => ({ createCodemodeExtension: registeringFactory(execute as Execute, (pi) => { shim = pi; }) }));
    const pi = livePi();

    const results = await Promise.all([run(bridge, pi, "st-1"), run(bridge, pi, "st-2")]);

    expect(results).toEqual([
      { content: [{ type: "text", text: "first done" }] },
      { content: [{ type: "text", text: "second done" }] },
    ]);
  });

  it("passes on an error codemode throws for its own reasons", async () => {
    const execute = vi.fn(async () => { throw new Error("worker crashed"); });
    const bridge = await loadBridge(() => ({ createCodemodeExtension: registeringFactory(execute) }));

    await expect(run(bridge, livePi())).rejects.toThrow("worker crashed");
  });
});
