import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BearerCommandResolver } from "../bearer-command-resolver.ts";

function shellArg(value: string): string {
  return process.platform === "win32"
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("BearerCommandResolver", () => {
  let directory: string;
  let fixture: string;

  beforeEach(() => {
    delete process.env.PI_MCP_ADAPTER_BEARER_COMMAND_TTL_MS;
    directory = mkdtempSync(join(tmpdir(), "pi-mcp-bearer-"));
    fixture = join(directory, "command.cjs");
    writeFileSync(fixture, `
const fs = require("node:fs");
const [counter, failMarker, started, completed, delay = "0"] = process.argv.slice(2);
if (started !== "-") fs.writeFileSync(started, "started");
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
fs.writeFileSync(counter, String(count));
if (failMarker !== "-" && fs.existsSync(failMarker)) process.exit(2);
setTimeout(() => {
  if (completed !== "-") fs.writeFileSync(completed, "completed");
  process.stdout.write("jwt-" + count + "\\n");
}, Number(delay));
`);
  });

  afterEach(() => {
    delete process.env.PI_MCP_ADAPTER_BEARER_COMMAND_TTL_MS;
    rmSync(directory, { recursive: true, force: true });
  });

  function command(options: { fail?: string; started?: string; completed?: string; delay?: number } = {}): string {
    const counter = join(directory, "counter");
    const args = [
      process.execPath,
      fixture,
      counter,
      options.fail ?? "-",
      options.started ?? "-",
      options.completed ?? "-",
      String(options.delay ?? 0),
    ];
    return `!${args.map(shellArg).join(" ")}`;
  }

  it("returns and caches the resolved token for the TTL window", async () => {
    const resolver = new BearerCommandResolver(command(), "test", 60_000);
    expect(await resolver.resolve()).toBe("jwt-1");
    expect(await resolver.resolve()).toBe("jwt-1");
    expect(await resolver.resolve()).toBe("jwt-1");
  });

  it("re-runs the command after the TTL expires", async () => {
    const resolver = new BearerCommandResolver(command(), "test", 5);
    expect(await resolver.resolve()).toBe("jwt-1");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await resolver.resolve()).toBe("jwt-2");
  });

  it("coalesces concurrent calls into one asynchronous execution", async () => {
    const resolver = new BearerCommandResolver(command({ delay: 50 }), "test", 60_000);
    const results = await Promise.all([resolver.resolve(), resolver.resolve(), resolver.resolve()]);
    expect(results).toEqual(["jwt-1", "jwt-1", "jwt-1"]);
  });

  it("keeps a shared execution alive while another request still waits", async () => {
    const controller = new AbortController();
    const resolver = new BearerCommandResolver(command({ delay: 50 }), "test", 60_000);
    const cancelled = resolver.resolve(controller.signal);
    const remaining = resolver.resolve();
    controller.abort(new Error("cancel one waiter"));

    await expect(cancelled).rejects.toThrow("cancel one waiter");
    await expect(remaining).resolves.toBe("jwt-1");
  });

  it("falls back to the last good token and throttles failed refresh retries", async () => {
    const fail = join(directory, "fail");
    const resolver = new BearerCommandResolver(command({ fail }), "test", 20);
    expect(await resolver.resolve()).toBe("jwt-1");
    await new Promise(resolve => setTimeout(resolve, 25));
    writeFileSync(fail, "fail");
    expect(await resolver.resolve()).toBe("jwt-1");
    expect(await resolver.resolve()).toBe("jwt-1");
    expect(await resolver.resolve()).toBe("jwt-1");
    expect(Number(readFileSync(join(directory, "counter"), "utf8"))).toBe(2);
  });

  it("surfaces an initial command failure", async () => {
    const fail = join(directory, "fail");
    writeFileSync(fail, "fail");
    const resolver = new BearerCommandResolver(command({ fail }), "test", 60_000);
    await expect(resolver.resolve()).rejects.toThrow("command exited with code 2");
    await expect(resolver.resolve()).rejects.toThrow("command exited with code 2");
    const counter = readFileSync(join(directory, "counter"), "utf8");
    expect(counter).toBe("1");
  });

  it("does not start a command for an already-aborted request", async () => {
    const started = join(directory, "started");
    const controller = new AbortController();
    controller.abort(new Error("cancelled before refresh"));
    const resolver = new BearerCommandResolver(command({ started }), "test", 60_000);
    await expect(resolver.resolve(controller.signal)).rejects.toThrow("cancelled before refresh");
    expect(existsSync(started)).toBe(false);
  });

  it("cancels an in-progress command when its request aborts", async () => {
    const started = join(directory, "started");
    const completed = join(directory, "completed");
    const controller = new AbortController();
    const resolver = new BearerCommandResolver(command({ started, completed, delay: 2_000 }), "test", 60_000);
    const pending = resolver.resolve(controller.signal);
    while (!existsSync(started)) await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort(new Error("cancelled during refresh"));
    await expect(pending).rejects.toThrow("cancelled during refresh");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(existsSync(completed)).toBe(false);
    expect(await resolver.resolve()).toBe("jwt-2");
  });

  it("accepts empty and invalid TTL environment values", async () => {
    process.env.PI_MCP_ADAPTER_BEARER_COMMAND_TTL_MS = "";
    expect(await new BearerCommandResolver(command(), "test").resolve()).toBe("jwt-1");
    process.env.PI_MCP_ADAPTER_BEARER_COMMAND_TTL_MS = "invalid";
    const invalid = new BearerCommandResolver(command(), "test");
    expect(await invalid.resolve()).toBe("jwt-2");
    process.env.PI_MCP_ADAPTER_BEARER_COMMAND_TTL_MS = "10ms";
    const ambiguous = new BearerCommandResolver(command(), "test");
    expect(await ambiguous.resolve()).toBe("jwt-3");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await ambiguous.resolve()).toBe("jwt-3");
  });
});
