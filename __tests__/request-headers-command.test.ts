import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createRequestHeadersCommandFetch } from "../request-headers-command.ts";

function commandScript(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-"));
  const path = join(dir, "command.mjs");
  writeFileSync(path, source);
  return path;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const readEnvelope = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const body = Buffer.from(request.bodyBase64, "base64").toString("utf8");
  process.stdout.write(JSON.stringify({
    "x-derived-method": request.method,
    "x-derived-body": body,
    "x-derived-actor": process.env.TEST_ACTOR,
  }));
});
`;

describe("per-request HTTP header commands", () => {
  it("derives headers from the exact request and preserves existing headers", async () => {
    const script = commandScript(readEnvelope);
    let forwarded: Request | undefined;
    const fetch = createRequestHeadersCommandFetch({
      command: process.execPath,
      args: [script],
      env: { TEST_ACTOR: "actor-123" },
    }, async (input, init) => {
      forwarded = new Request(input, init);
      return new Response("ok");
    });

    await fetch("https://mcp.example.test/mcp", {
      method: "POST",
      headers: { "x-existing": "kept" },
      body: "exact MCP bytes",
    });

    expect(forwarded?.headers.get("x-existing")).toBe("kept");
    expect(forwarded?.headers.get("x-derived-method")).toBe("POST");
    expect(forwarded?.headers.get("x-derived-body")).toBe("exact MCP bytes");
    expect(forwarded?.headers.get("x-derived-actor")).toBe("actor-123");
  });

  it("runs for every request instead of caching derived headers", async () => {
    const script = commandScript(readEnvelope);
    const bodies: string[] = [];
    const fetch = createRequestHeadersCommandFetch({
      command: process.execPath,
      args: [script],
    }, async (input, init) => {
      bodies.push(new Request(input, init).headers.get("x-derived-body") ?? "");
      return new Response("ok");
    });

    await fetch("https://mcp.example.test/mcp", { method: "POST", body: "one" });
    await fetch("https://mcp.example.test/mcp", { method: "POST", body: "two" });
    expect(bodies).toEqual(["one", "two"]);
  });

  it("fails closed when the command exits unsuccessfully", async () => {
    const script = commandScript("process.exit(7);\n");
    const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script] });
    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
      "HTTP request headers command exited with code 7",
    );
  });

  it.skipIf(process.platform === "win32")("kills helpers when the command exits unsuccessfully", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const helper = commandScript(`
import { writeFileSync } from "node:fs";
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 150);
setInterval(() => {}, 1000);
`);
    const script = commandScript(`
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: "ignore" }).unref();
setTimeout(() => {
  process.exit(7);
}, 75);
`);
    const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script] });

    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
      "HTTP request headers command exited with code 7",
    );
    await delay(220);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed on malformed command output", async () => {
    const script = commandScript('process.stdout.write("not-json");\n');
    const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script] });
    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
      "HTTP request headers command returned invalid JSON",
    );
  });

  it.skipIf(process.platform === "win32")("kills helpers when the command returns valid output", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const helper = commandScript(`
import { writeFileSync } from "node:fs";
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 150);
setInterval(() => {}, 1000);
`);
    const script = commandScript(`
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: "ignore" }).unref();
setTimeout(() => {
  process.stdout.write(JSON.stringify({ "x-derived": "ok" }));
}, 75);
`);
    const fetch = createRequestHeadersCommandFetch(
      { command: process.execPath, args: [script] },
      async () => new Response("ok"),
    );

    const response = await fetch("https://mcp.example.test/mcp");
    expect(response.status).toBe(200);
    await delay(220);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("kills helpers when the command returns malformed output", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const helper = commandScript(`
import { writeFileSync } from "node:fs";
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 150);
setInterval(() => {}, 1000);
`);
    const script = commandScript(`
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: "ignore" }).unref();
setTimeout(() => {
  process.stdout.write("not-json");
}, 75);
`);
    const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script] });

    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
      "HTTP request headers command returned invalid JSON",
    );
    await delay(220);
    expect(existsSync(marker)).toBe(false);
  });

  it("kills a command that keeps running after timeout", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const script = commandScript(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 100);
setInterval(() => {}, 1000);
`);
    const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script], timeoutMs: 25 });

    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
      "HTTP request headers command timed out after 25ms",
    );
    await delay(200);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("kills descendant commands after timeout", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const descendant = commandScript(`
import { writeFileSync } from "node:fs";
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 100);
setInterval(() => {}, 1000);
`);
    const script = commandScript(`
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`);
    const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script], timeoutMs: 25 });

    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
      "HTTP request headers command timed out after 25ms",
    );
    await delay(200);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("kills descendants that move into another process group", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const descendant = commandScript(`
import { writeFileSync } from "node:fs";
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 100);
setInterval(() => {}, 1000);
`);
    const script = commandScript(`
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: "ignore" });
setInterval(() => {}, 1000);
`);
    const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script], timeoutMs: 25 });

    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
      "HTTP request headers command timed out after 25ms",
    );
    await delay(200);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("kills descendants that reparent before timeout", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const descendant = commandScript(`
import { writeFileSync } from "node:fs";
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 150);
setInterval(() => {}, 1000);
`);
    const spawner = commandScript(`
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: "ignore" }).unref();
`);
    const script = commandScript(`
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(spawner)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`);
    const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script], timeoutMs: 75 });

    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
      "HTTP request headers command timed out after 75ms",
    );
    await delay(220);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("fails closed before running the command when process discovery fails", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const script = commandScript(`
import { writeFileSync } from "node:fs";
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 100);
setInterval(() => {}, 1000);
`);
    process.env.PI_MCP_ADAPTER_TEST_FAIL_PS = "1";
    try {
      const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script], timeoutMs: 25 });

      await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
        "HTTP request headers command cleanup failed: ps exited with code 1",
      );
      await delay(200);
      expect(existsSync(marker)).toBe(false);
    } finally {
      delete process.env.PI_MCP_ADAPTER_TEST_FAIL_PS;
    }
  });

  it.skipIf(process.platform === "win32")("fails closed before running helpers when process discovery fails before successful output", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const helper = commandScript(`
import { writeFileSync } from "node:fs";
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 150);
setInterval(() => {}, 1000);
`);
    const script = commandScript(`
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: "ignore" }).unref();
setTimeout(() => {
  process.stdout.write(JSON.stringify({ "x-derived": "ok" }));
}, 75);
`);
    process.env.PI_MCP_ADAPTER_TEST_FAIL_PS = "1";
    try {
      const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script] });

      await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
        "HTTP request headers command cleanup failed: ps exited with code 1",
      );
      await delay(220);
      expect(existsSync(marker)).toBe(false);
    } finally {
      delete process.env.PI_MCP_ADAPTER_TEST_FAIL_PS;
    }
  });

  it.skipIf(process.platform === "win32")("fails closed before running helpers when process discovery fails before unsuccessful output", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "pi-mcp-request-headers-")), "marker");
    const helper = commandScript(`
import { writeFileSync } from "node:fs";
setTimeout(() => {
  writeFileSync(${JSON.stringify(marker)}, "alive");
}, 150);
setInterval(() => {}, 1000);
`);
    const script = commandScript(`
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: "ignore" }).unref();
setTimeout(() => {
  process.exit(1);
}, 75);
`);
    process.env.PI_MCP_ADAPTER_TEST_FAIL_PS = "1";
    try {
      const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script] });

      await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
        "HTTP request headers command cleanup failed: ps exited with code 1",
      );
      await delay(220);
      expect(existsSync(marker)).toBe(false);
    } finally {
      delete process.env.PI_MCP_ADAPTER_TEST_FAIL_PS;
    }
  });

  it("validates configuration before issuing a request", () => {
    expect(() => createRequestHeadersCommandFetch({ command: "" })).toThrow(
      "requires a non-empty command",
    );
    expect(() => createRequestHeadersCommandFetch({ command: "node", timeoutMs: 0 })).toThrow(
      "timeoutMs must be an integer between 1 and 60000",
    );
  });
});
