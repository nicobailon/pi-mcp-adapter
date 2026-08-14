import { mkdtempSync, writeFileSync } from "node:fs";
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

  it("fails closed on malformed command output", async () => {
    const script = commandScript('process.stdout.write("not-json");\n');
    const fetch = createRequestHeadersCommandFetch({ command: process.execPath, args: [script] });
    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow(
      "HTTP request headers command returned invalid JSON",
    );
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
