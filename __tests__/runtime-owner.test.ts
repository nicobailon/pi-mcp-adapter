import { describe, expect, it, vi } from "vitest";
import { combineAbortSignals, createMcpRuntimeOwner, createOwnedUi } from "../runtime-owner.ts";

describe("MCP runtime ownership", () => {
  it("contains synchronous and asynchronous cleanup failures and is idempotent", async () => {
    const owner = createMcpRuntimeOwner();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = vi.fn(() => { throw new Error("cleanup failed \u001b]52;c;secret\u0007"); });
    owner.addCleanup(cleanup);
    const first = owner.stop("reload");
    const second = owner.stop("shutdown");

    await expect(first).rejects.toThrow(AggregateError);
    await expect(second).rejects.toThrow(AggregateError);
    expect(first).toBe(second);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("MCP: runtime cleanup failed: cleanup failed");
    consoleError.mockRestore();
  });

  it("does not invoke nested UI methods after the owner stops", async () => {
    const owner = createMcpRuntimeOwner();
    const ui = { notify: vi.fn(), theme: { fg: vi.fn((_color: string, text: string) => text) } } as any;
    const owned = createOwnedUi(ui, owner);
    const theme = owned.theme;

    theme.fg("accent", "before");
    await owner.stop("reload");
    expect((owned as any).notify).toBeUndefined();
    expect((owned as any).theme).toBeUndefined();

    expect(ui.notify).not.toHaveBeenCalled();
    expect(ui.theme.fg).toHaveBeenCalledTimes(1);
  });

  it("works with a frozen UI and theme, and still fences them after the owner stops", async () => {
    const owner = createMcpRuntimeOwner();
    const notify = vi.fn();
    const ui = Object.freeze({ notify, theme: Object.freeze({ fg: (_color: string, text: string) => `<${text}>` }) }) as any;
    const owned = createOwnedUi(ui, owner) as any;

    expect(owned.theme.fg("accent", "MCP")).toBe("<MCP>");
    expect("notify" in owned).toBe(true);
    const send = owned.notify;
    await owner.stop("reload");
    send("late");
    expect(owned.notify).toBeUndefined();
    expect(owned.theme).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not read stale UI getters after the owner stops", async () => {
    const owner = createMcpRuntimeOwner();
    const ui = {} as any;
    Object.defineProperty(ui, "notify", {
      get: () => {
        throw new Error("stale getter");
      },
    });
    const owned = createOwnedUi(ui, owner);
    await owner.stop("reload");
    expect(() => (owned as any).notify).not.toThrow();
    expect((owned as any).notify).toBeUndefined();
  });

  it("combines owner and context cancellation", async () => {
    const owner = createMcpRuntimeOwner();
    const context = new AbortController();
    const signal = combineAbortSignals(owner.signal, context.signal)!;
    expect(signal.aborted).toBe(false);
    context.abort(new Error("context ended"));
    expect(signal.aborted).toBe(true);
    await owner.stop("reload");
  });

  it("runs cleanup only after a late registration has been fenced", async () => {
    const owner = createMcpRuntimeOwner();
    await owner.stop("reload");
    const cleanup = vi.fn();
    owner.addCleanup(cleanup);
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
