import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpLifecycleManager } from "../lifecycle.ts";
import type { ServerDefinition } from "../types.ts";

interface FakeConnection {
  status: "connected" | "closed" | "needs-auth";
}

class FakeManager {
  connections = new Map<string, FakeConnection>();
  connectCalls: string[] = [];
  closeCalls: string[] = [];
  idleResponses = new Map<string, boolean>();

  setConnection(name: string, status: FakeConnection["status"] | null): void {
    if (status === null) {
      this.connections.delete(name);
    } else {
      this.connections.set(name, { status });
    }
  }

  getConnection(name: string): FakeConnection | undefined {
    return this.connections.get(name);
  }

  async connect(name: string): Promise<FakeConnection> {
    this.connectCalls.push(name);
    const connection: FakeConnection = { status: "connected" };
    this.connections.set(name, connection);
    return connection;
  }

  async close(name: string): Promise<void> {
    this.closeCalls.push(name);
    this.connections.delete(name);
  }

  isIdle(name: string): boolean {
    return this.idleResponses.get(name) ?? false;
  }
}

function makeDefinition(lifecycle: ServerDefinition["lifecycle"]): ServerDefinition {
  return { command: "echo", args: [], lifecycle };
}

describe("lazy-keep-alive lifecycle", () => {
  let fake: FakeManager;
  let lifecycle: McpLifecycleManager;

  beforeEach(() => {
    fake = new FakeManager();
    lifecycle = new McpLifecycleManager(fake as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects after first spawn when the process dies", async () => {
    const def = makeDefinition("lazy-keep-alive");
    lifecycle.registerServer("srv", def, { idleTimeout: 0 });

    lifecycle.startHealthChecks(1000);
    await Promise.resolve();
    expect(fake.connectCalls).not.toContain("srv");

    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected");

    fake.setConnection("srv", null);
    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.connectCalls).toContain("srv");
  });

  it("never idle-shuts a server registered with idleTimeout 0", async () => {
    const def = makeDefinition("lazy-keep-alive");
    lifecycle.registerServer("srv", def, { idleTimeout: 0 });
    fake.setConnection("srv", "connected");
    fake.idleResponses.set("srv", true);

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.closeCalls).not.toContain("srv");
  });

  it("idle-shuts a plain lazy server past its timeout", async () => {
    const def = makeDefinition("lazy");
    lifecycle.registerServer("srv", def, { idleTimeout: 1 });
    fake.setConnection("srv", "connected");
    fake.idleResponses.set("srv", true);

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.closeCalls).toContain("srv");
  });
});
