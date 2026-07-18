import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  McpConfigSource,
  McpLaunchValueProvider,
  McpRuntimeLease,
  McpRuntimeLeaseProvider,
  McpSourceIdentity,
} from "../programmatic-types.ts";

const managerMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  closeAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: class {
    setSamplingConfig() {}
    setElicitationConfig() {}
    getConnection() { return undefined; }
    connect(...args: unknown[]) { return managerMocks.connect(...args); }
    close(...args: unknown[]) { return managerMocks.close(...args); }
    closeAll(...args: unknown[]) { return managerMocks.closeAll(...args); }
  },
}));

import { ProgrammaticMcpRuntime } from "../programmatic-runtime.ts";

const serverKey = (token: string) => `server-${token}`;

function identity(token: string, id = `example.extension:${token}`): McpSourceIdentity {
  return { id, revision: `revision-${token}` };
}

function source(sourceIdentity: McpSourceIdentity, keys = [serverKey("a")]): McpConfigSource {
  return {
    identity: sourceIdentity,
    servers: Object.fromEntries(keys.map((key) => [key, {
      transport: "stdio" as const,
      requestTimeoutMs: 500,
      deniedTools: ["hidden"],
    }])),
  };
}

function providers(options: {
  values?: Awaited<ReturnType<McpLaunchValueProvider["resolve"]>>;
  abort?: AbortController;
  failDrain?: boolean;
} = {}) {
  const counters = { resolved: 0, disposed: 0, acquired: 0, released: 0, drained: 0 };
  const active = new WeakSet<object>();
  const launchValues: McpLaunchValueProvider = {
    async resolve() {
      counters.resolved += 1;
      options.abort?.abort(new Error("cancelled at launch"));
      return options.values ?? {
        transport: "stdio",
        command: "CANARY_COMMAND",
        args: ["CANARY_ARG"],
        env: { TOKEN: "CANARY_SECRET" },
      };
    },
    async dispose() { counters.disposed += 1; },
  };
  const runtimeLeases: McpRuntimeLeaseProvider = {
    async acquire() {
      counters.acquired += 1;
      const lease = Object.freeze({}) as McpRuntimeLease;
      active.add(lease);
      return lease;
    },
    async release(lease) {
      if (!active.has(lease)) throw new Error("lease ownership mismatch");
      active.delete(lease);
      counters.released += 1;
    },
    async drain() {
      counters.drained += 1;
      if (options.failDrain) throw new Error("drain failed");
    },
  };
  return { counters, launchValues, runtimeLeases };
}

function runtime() {
  return new ProgrammaticMcpRuntime({ fileDiscovery: "disabled" });
}

beforeEach(() => {
  managerMocks.connect.mockReset();
  managerMocks.connect.mockResolvedValue({
    status: "connected",
    tools: [
      { name: "echo", description: "Echo" },
      { name: "hidden", description: "Hidden" },
    ],
    resources: [],
    client: {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      readResource: vi.fn(),
    },
  });
  managerMocks.close.mockClear();
  managerMocks.closeAll.mockClear();
});

describe("programmatic source lifecycle", () => {
  it("installs initial sources synchronously and isolates colliding server keys", async () => {
    const subject = runtime();
    const first = providers();
    const second = providers();
    const firstSource = source(identity("1"));
    const secondSource = source(identity("2"));
    subject.installInitialSources([
      { source: firstSource, ...first },
      { source: secondSource, ...second },
    ]);

    const statuses = await subject.inspectSources(new AbortController().signal);
    expect(statuses.map((status) => status.identity.id)).toEqual([
      "example.extension:1",
      "example.extension:2",
    ]);
    expect(statuses.every((status) => status.servers[0]?.key === "server-a")).toBe(true);
    expect(first.counters.resolved).toBe(0);
    expect(second.counters.resolved).toBe(0);
  });

  it("validates and copies the complete secret-free source locally", async () => {
    const subject = runtime();
    const input = source(identity("1"), ["zulu", "alpha"]);
    const validated = await subject.validateSource(input, new AbortController().signal);
    expect(validated).toEqual({ ok: true, value: input, diagnostics: [] });
    if (!validated.ok) throw new Error("valid source rejected");
    expect(validated.value).not.toBe(input);

    await expect(subject.validateSource({
      ...input,
      servers: {},
    }, new AbortController().signal)).resolves.toMatchObject({ ok: false });
  });

  it("uses exact compare-and-replace and preserves the old source when cleanup rejects", async () => {
    const subject = runtime();
    const oldProviders = providers({ failDrain: true });
    const oldIdentity = identity("1", "example.extension:shared");
    subject.installInitialSources([{ source: source(oldIdentity), ...oldProviders }]);

    const nextIdentity = identity("2", "example.extension:shared");
    const nextProviders = providers();
    const rejected = await subject.replaceSource({
      source: source(nextIdentity),
      expected: { kind: "exact", identity: oldIdentity },
      ...nextProviders,
    }, new AbortController().signal);

    expect(rejected.kind).toBe("rejected");
    expect(await subject.inspectSource(oldIdentity, new AbortController().signal)).toBeDefined();
    expect(await subject.inspectSource(nextIdentity, new AbortController().signal)).toBeUndefined();
  });

  it("removes only the exact current identity", async () => {
    const subject = runtime();
    const current = identity("1", "example.extension:shared");
    const stale = identity("2", "example.extension:shared");
    subject.installInitialSources([{ source: source(current), ...providers() }]);

    expect(await subject.removeSource(stale, new AbortController().signal)).toEqual({
      kind: "ownership-mismatch",
      requestedIdentity: stale,
      currentIdentity: current,
    });
    expect(await subject.removeSource(current, new AbortController().signal)).toEqual({ kind: "removed" });
    expect(await subject.removeSource(current, new AbortController().signal)).toEqual({ kind: "absent" });
  });

  it("resolves launch values only at connect, disposes them, and never retains them in inspection", async () => {
    const subject = runtime();
    const sourceIdentity = identity("1");
    const sourceProviders = providers();
    subject.installInitialSources([{ source: source(sourceIdentity), ...sourceProviders }]);
    await subject.attachSession({ cwd: process.cwd(), hasUI: false } as any);

    const execution = await subject.openExecution(sourceIdentity, serverKey("a"), new AbortController().signal);
    expect(sourceProviders.counters).toMatchObject({ resolved: 1, disposed: 1, acquired: 1, released: 0 });
    expect(managerMocks.connect).toHaveBeenCalledWith(
      expect.stringMatching(/^programmatic:[0-9a-f]{64}$/),
      expect.objectContaining({ command: "CANARY_COMMAND", env: { TOKEN: "CANARY_SECRET" } }),
      expect.any(AbortSignal),
      expect.objectContaining({
        allowLegacySseFallback: false,
        values: "resolved",
        retainedDefinition: expect.not.objectContaining({ command: "CANARY_COMMAND" }),
      }),
    );
    const statusJson = JSON.stringify(await subject.inspectSources(new AbortController().signal));
    expect(statusJson).not.toMatch(/CANARY_COMMAND|CANARY_ARG|CANARY_SECRET/);

    await execution.close();
    expect(sourceProviders.counters.released).toBe(1);
  });

  it("supports optional runtime leases for simple extensions", async () => {
    const subject = runtime();
    const sourceIdentity = identity("1");
    const sourceProviders = providers();
    subject.installInitialSources([{
      source: source(sourceIdentity),
      launchValues: sourceProviders.launchValues,
    }]);
    await subject.attachSession({ cwd: process.cwd(), hasUI: false } as any);

    const execution = await subject.openExecution(sourceIdentity, serverKey("a"), new AbortController().signal);
    await expect(execution.close()).resolves.toBeUndefined();
  });

  it("redacts provider failures from errors and status", async () => {
    const subject = runtime();
    const sourceIdentity = identity("1");
    const sourceProviders = providers();
    sourceProviders.launchValues.resolve = async () => {
      throw new Error("CANARY_NATIVE_CAUSE");
    };
    subject.installInitialSources([{ source: source(sourceIdentity), ...sourceProviders }]);
    await subject.attachSession({ cwd: process.cwd(), hasUI: false } as any);

    await expect(subject.openExecution(sourceIdentity, serverKey("a"), new AbortController().signal))
      .rejects.toThrow("MCP programmatic runtime operation failed");
    const status = JSON.stringify(await subject.inspectSources(new AbortController().signal));
    expect(status).not.toContain("CANARY_NATIVE_CAUSE");
    expect(status).toContain("ADAPTER_FAILED");
    expect(sourceProviders.counters).toMatchObject({ acquired: 1, released: 1, disposed: 0 });
  });

  it("disposes values and releases authority when cancellation happens after resolve", async () => {
    const subject = runtime();
    const controller = new AbortController();
    const sourceIdentity = identity("1");
    const sourceProviders = providers({ abort: controller });
    subject.installInitialSources([{ source: source(sourceIdentity), ...sourceProviders }]);
    await subject.attachSession({ cwd: process.cwd(), hasUI: false } as any);

    await expect(subject.openExecution(sourceIdentity, serverKey("a"), controller.signal))
      .rejects.toThrow("cancelled at launch");
    expect(sourceProviders.counters).toMatchObject({ resolved: 1, disposed: 1, acquired: 1, released: 1 });
    expect(managerMocks.connect).not.toHaveBeenCalled();
  });

  it("rejects unsafe launch values after disposal without reaching the transport", async () => {
    const subject = runtime();
    const sourceIdentity = identity("1");
    const sourceProviders = providers({
      values: { transport: "stdio", command: "unsafe\0command", args: [] },
    });
    subject.installInitialSources([{ source: source(sourceIdentity), ...sourceProviders }]);
    await subject.attachSession({ cwd: process.cwd(), hasUI: false } as any);

    await expect(subject.openExecution(sourceIdentity, serverKey("a"), new AbortController().signal))
      .rejects.toThrow("MCP programmatic runtime operation failed");
    expect(sourceProviders.counters).toMatchObject({ resolved: 1, disposed: 1, acquired: 1, released: 1 });
    expect(managerMocks.connect).not.toHaveBeenCalled();
  });

  it("releases a cancelled queue slot without deadlocking later lifecycle work", async () => {
    const subject = runtime();
    const oldIdentity = identity("1", "example.extension:shared");
    const oldProviders = providers();
    let startDrain!: () => void;
    const drainStarted = new Promise<void>((resolve) => { startDrain = resolve; });
    let unblockDrain!: () => void;
    const drainBlocked = new Promise<void>((resolve) => { unblockDrain = resolve; });
    oldProviders.runtimeLeases.drain = async () => {
      startDrain();
      await drainBlocked;
    };
    subject.installInitialSources([{ source: source(oldIdentity), ...oldProviders }]);

    const nextIdentity = identity("2", "example.extension:shared");
    const nextProviders = providers();
    const first = subject.replaceSource({
      source: source(nextIdentity),
      expected: { kind: "exact", identity: oldIdentity },
      ...nextProviders,
    }, new AbortController().signal);
    await drainStarted;

    const queuedController = new AbortController();
    const queued = subject.removeSource(nextIdentity, queuedController.signal);
    const reason = new Error("cancelled while queued");
    queuedController.abort(reason);
    await expect(queued).rejects.toBe(reason);

    unblockDrain();
    expect((await first).kind).toBe("applied");
    await expect(subject.removeSource(nextIdentity, new AbortController().signal))
      .resolves.toEqual({ kind: "removed" });
  });

  it("reports complete explicit capabilities and honors pre-aborted operations", async () => {
    const subject = runtime();
    const signal = new AbortController().signal;
    const capabilities = await subject.capabilities(signal);
    expect(Object.values(capabilities.sourceLifecycle).every((value) => typeof value === "boolean")).toBe(true);
    expect(Object.values(capabilities.transports).every((value) => typeof value === "boolean")).toBe(true);
    expect(Object.values(capabilities.oauth).every((value) => typeof value === "boolean")).toBe(true);
    expect(Object.values(capabilities.features).every((value) => typeof value === "boolean")).toBe(true);
    expect(capabilities.transports).toEqual({
      stdio: true,
      streamableHttp: true,
      legacySse: false,
      websocket: false,
    });
    expect(capabilities.features).toMatchObject({ resources: false, directTools: false });

    const controller = new AbortController();
    const reason = new Error("pre-aborted");
    controller.abort(reason);
    await expect(subject.inspectSources(controller.signal)).rejects.toBe(reason);
  });
});
