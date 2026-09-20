import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";

type TransportOptions = {
  requestInit?: { headers?: Record<string, string> };
};

type HttpTransportMock = {
  url: URL;
  options: TransportOptions;
  close: () => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  httpTransports: [] as HttpTransportMock[],
  connectImplementations: [] as Array<() => Promise<void>>,
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation((info: unknown, options: unknown) => {
    const client: any = {
      info,
      options,
      onclose: undefined,
      setRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      connect: vi.fn(() => mocks.connectImplementations.shift()?.() ?? Promise.resolve()),
      listTools: vi.fn(async () => ({ tools: [] })),
      listResources: vi.fn(async () => ({ resources: [] })),
      close: vi.fn(async () => undefined),
    };
    mocks.clients.push(client);
    return client;
  }),
  StreamableHTTPClientTransport: vi.fn().mockImplementation((url: URL, options: TransportOptions) => {
    const transport = { url, options, close: vi.fn(async () => undefined) };
    mocks.httpTransports.push(transport);
    return transport;
  }),
  SSEClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager.reconnect", () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;
    mocks.connectImplementations.length = 0;
  });

  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // Each HTTP connection uses one client and one Streamable HTTP transport.
  const def = { url: "https://example.test/mcp" };

  it("is single-flight: concurrent reconnects for the same server share one underlying reconnect", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;

    const [c1, c2] = await Promise.all([
      manager.reconnect("remote", def, stale),
      manager.reconnect("remote", def, stale),
    ]);

    expect(c1).toBe(c2);
    // Exactly one new connection was established, not one per caller.
    expect(mocks.clients.length).toBe(1);
    expect(manager.getConnection("remote")).toBe(c1);
  });

  it("identity guard: never tears down a connection it did not prove stale", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    await manager.close("remote");
    const fresh = await manager.connect("remote", def);

    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;

    // A caller that captured `stale` before the close/reconnect cycle above
    // (e.g. a concurrent tool call that lost the race) asks to reconnect
    // from that now-superseded connection.
    const result = await manager.reconnect("remote", def, stale);

    expect(result).toBe(fresh);
    expect(fresh.client.close).not.toHaveBeenCalled();
    expect(mocks.clients.length).toBe(0); // no new connection attempted
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("retires each remote connection once without letting stale or failing publications escape", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const changes: Array<[string, string]> = [];
    manager.setMetadataListChangedListener((name, reason) => changes.push([name, reason]));

    const stale = await manager.connect("remote", def);
    const staleOnClose = stale.client.onclose!;
    await manager.close("remote");
    const fresh = await manager.connect("remote", def);

    staleOnClose();
    expect(fresh.status).toBe("connected");
    expect(changes).toEqual([]);

    fresh.client.onclose!();
    fresh.client.onclose!();
    expect(fresh.status).toBe("closed");
    expect(changes).toEqual([["remote", "remote-close"]]);

  });

  it("rejects a candidate that closes during discovery before map installation", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const changes: Array<[string, string]> = [];
    manager.setMetadataListChangedListener((name, reason) => changes.push([name, reason]));
    let finishDiscovery!: () => void;
    const discovery = new Promise<void>((resolve) => { finishDiscovery = resolve; });

    const connecting = manager.connect("candidate", def);
    const client = mocks.clients.at(-1)!;
    client.listTools.mockImplementation(async () => {
      await discovery;
      return { tools: [{ name: "stale" }] };
    });
    await vi.waitFor(() => expect(client.listTools).toHaveBeenCalled());

    client.onclose!();
    finishDiscovery();

    await expect(connecting).rejects.toThrow("closed during metadata discovery");
    expect(manager.getConnection("candidate")).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it("keeps a shared reconnect alive when one caller aborts waiting", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    const staleClose = vi.spyOn(stale.client, "close");
    const reason = new Error("stop waiting");
    const controller = new AbortController();

    const first = manager.reconnect("remote", def, stale, controller.signal);
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);

    const second = manager.reconnect("remote", def, stale);
    await expect(second).rejects.toBe(reason);
    expect(manager.getConnection("remote")).toBe(stale);
    expect(staleClose).not.toHaveBeenCalled();

    const fresh = await manager.reconnect("remote", def, stale);
    expect(fresh).not.toBe(stale);
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("keeps the old route live until a replacement is ready, then publishes before cleanup", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    const staleClose = vi.spyOn(stale.client, "close");
    const candidateStart = deferred();
    mocks.connectImplementations.push(() => candidateStart.promise);

    const reconnecting = manager.reconnect("remote", def, stale);
    await Promise.resolve();

    expect(manager.getConnection("remote")).toBe(stale);
    expect(staleClose).not.toHaveBeenCalled();

    candidateStart.resolve();
    const fresh = await reconnecting;

    expect(manager.getConnection("remote")).toBe(fresh);
    expect(fresh).not.toBe(stale);
    expect(staleClose).toHaveBeenCalledTimes(1);
  });

  it("aborts and awaits replacement startup during shutdown", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    const candidateStart = deferred();
    mocks.connectImplementations.push(() => candidateStart.promise);

    const reconnecting = manager.reconnect("remote", def, stale);
    await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));
    let reconnectSettled = false;
    void reconnecting.then(
      () => { reconnectSettled = true; },
      () => { reconnectSettled = true; },
    );

    await manager.closeAll();
    await Promise.resolve();
    const settledBeforeCandidateRelease = reconnectSettled;

    // Release the deliberately non-cooperative mock so the RED implementation
    // cannot leave work behind after the assertion is recorded.
    candidateStart.resolve();
    await expect(reconnecting).rejects.toThrow("closed while reconnecting");

    expect(settledBeforeCandidateRelease).toBe(true);
    expect(mocks.clients[1].close).toHaveBeenCalledTimes(1);
    expect(manager.getConnection("remote")).toBeUndefined();
  });

  it("does not return a published replacement disposed by a concurrent close", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    const staleCleanup = deferred();
    stale.client.close.mockImplementation(() => staleCleanup.promise);

    const reconnecting = manager.reconnect("remote", def, stale);
    await vi.waitFor(() => expect(stale.client.close).toHaveBeenCalledTimes(1));
    const fresh = manager.getConnection("remote")!;
    expect(fresh).not.toBe(stale);

    await manager.close("remote");
    staleCleanup.resolve();

    await expect(reconnecting).rejects.toThrow("closed while reconnecting");
    expect(fresh.client.close).toHaveBeenCalledTimes(1);
    expect(manager.getConnection("remote")).toBeUndefined();
  });

  it("keeps a published replacement successful while reporting stale cleanup failure", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);

    const stale = await manager.connect("remote", def);
    const cleanupFailure = new Error("stale cleanup failed");
    stale.client.close.mockRejectedValueOnce(cleanupFailure);

    const fresh = await manager.reconnect("remote", def, stale);

    expect(manager.getConnection("remote")).toBe(fresh);
    expect(fresh.status).toBe("connected");
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("stale cleanup failed"));
    debug.mockRestore();
  });

  it("retains the old route when replacement startup fails", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    const staleClose = vi.spyOn(stale.client, "close");
    const failure = new Error("replacement failed");
    mocks.connectImplementations.push(() => Promise.reject(failure));

    await expect(manager.reconnect("remote", def, stale)).rejects.toThrow("replacement failed");

    expect(manager.getConnection("remote")).toBe(stale);
    expect(stale.status).toBe("connected");
    expect(staleClose).not.toHaveBeenCalled();
  });

  it("does not close a different configured server while swapping one route", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("repo", def);
    const other = await manager.connect("nais", { url: "https://nais.example.test/mcp" });
    const otherClose = vi.spyOn(other.client, "close");

    const fresh = await manager.reconnect("repo", def, stale);

    expect(manager.getConnection("repo")).toBe(fresh);
    expect(manager.getConnection("nais")).toBe(other);
    expect(otherClose).not.toHaveBeenCalled();
  });

  it("carries in-flight work from the stale connection to the fresh connection", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    stale.inFlight = 2;

    const fresh = await manager.reconnect("remote", def, stale);

    expect(fresh).not.toBe(stale);
    expect(fresh.inFlight).toBe(2);
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("identity guard: a stale connection's late onclose does not clobber the fresh connection's status", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    const staleClient = mocks.clients[0];

    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;

    const fresh = await manager.reconnect("remote", def, stale);
    const freshClient = mocks.clients[0];

    expect(fresh).not.toBe(stale);
    expect(manager.getConnection("remote")).toBe(fresh);

    // Late close event from the old (already-replaced) client/transport.
    staleClient.onclose?.();
    expect(fresh.status).toBe("connected");
    expect(manager.getConnection("remote")).toBe(fresh);

    // A close on the current connection's own client still works normally.
    freshClient.onclose?.();
    expect(fresh.status).toBe("closed");
  });
});
