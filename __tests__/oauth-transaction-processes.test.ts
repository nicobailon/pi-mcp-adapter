import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

function event(child: ReturnType<typeof fork>, names: string[]) {
  return new Promise<{ event: string; result?: string; name?: string }>(resolve => {
    const listener = (message: { event: string; result?: string; name?: string }) => {
      if (!names.includes(message.event)) return;
      child.off("message", listener);
      resolve(message);
    };
    child.on("message", listener);
  });
}

it.each(["rotate", "invalid-grant", "server-error"])("serializes SDK auth with an inherited provider transaction and file-backed fixture on %s", async mode => {
  let generation = 0;
  let active = 0;
  let maximumActive = 0;
  let rejected = 0;
  let origin = "";
  let requests = 0;
  let firstRequest!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { firstRequest = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/.well-known/oauth-protected-resource")) {
      response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
    } else if (request.url?.startsWith("/.well-known/oauth-authorization-server")) {
      response.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] }));
    } else if (request.url === "/token") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const params = new URLSearchParams(body);
      if (++requests === 1) { firstRequest(); await firstGate; }
      maximumActive = Math.max(maximumActive, ++active);
      if (mode !== "rotate") {
        await delay(80);
        active--;
        rejected++;
        response.statusCode = mode === "invalid-grant" ? 400 : 500;
        response.end(JSON.stringify({ error: mode === "invalid-grant" ? "invalid_grant" : "server_error", error_description: null }));
        return;
      }
      if (params.get("refresh_token") !== `fake-refresh-${generation}`) {
        rejected++;
        active--;
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "invalid_grant", error_description: null }));
        return;
      }
      const issued = ++generation;
      await delay(80);
      active--;
      response.end(JSON.stringify({ access_token: `fake-access-${issued}`, refresh_token: `fake-refresh-${issued}`, token_type: "Bearer", expires_in: 3600 }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = await mkdtemp(join(tmpdir(), "oauth-process-transaction-"));
  const store = join(dir, "tokens.json");
  const name = `test-${randomUUID()}`;
  await writeFile(store, JSON.stringify({ access_token: "fake-access-0", refresh_token: "fake-refresh-0", token_type: "Bearer", issuer: origin }));
  const children = Array.from({ length: 6 }, () => fork(new URL("./fixtures/oauth-transaction-worker.mjs", import.meta.url), [name, `${origin}/mcp`, store], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  try {
    await Promise.all(children.map(async child => { const [result] = await once(child, "message"); expect(result.event).toBe("ready"); }));
    const results = children.map(child => event(child, ["result", "error"]));
    const entered = children.map(child => event(child, ["transaction-entered"]));
    children[0]!.send("auth");
    await firstStarted;
    for (const child of children.slice(1)) child.send("auth");
    await Promise.all(entered);
    expect(requests).toBe(1);
    releaseFirst();
    expect(await Promise.all(results)).toEqual(Array.from({ length: 6 }, () => mode === "rotate" ? { event: "result", result: "AUTHORIZED" } : { event: "error", name: "UnauthorizedError" }));
    expect(rejected).toBe(mode === "rotate" ? 0 : 6);
    expect(maximumActive).toBe(1);
    expect(generation).toBe(mode === "rotate" ? 6 : 0);
    expect(JSON.parse(await readFile(store, "utf8")).refresh_token).toBe(mode === "rotate" ? "fake-refresh-6" : "fake-refresh-0");
  } finally {
    releaseFirst();
    await Promise.all(children.map(async child => { const ended = once(child, "exit"); child.kill(); await ended; }));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
