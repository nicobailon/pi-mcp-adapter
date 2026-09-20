import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createRequestHeadersCommandFetch } from "../../request-headers-command.ts";

const mode = process.argv[2];
assert(mode === "init" || mode === "Request");
const collect = globalThis.gc;
assert(collect);
const fetchWithHeaders = createRequestHeadersCommandFetch({
  command: process.execPath,
  args: ["-e", "process.stdin.resume(); process.stdout.write('{}')"],
});
const streams = new Set<ServerResponse>();
const server = createServer((_request, response) => {
  streams.add(response);
  response.on("close", () => streams.delete(response));
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(": connected\n\n");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const controller = new AbortController();
  const input = mode === "init" ? url : new Request(url, { signal: controller.signal });
  const response = await fetchWithHeaders(
    input,
    mode === "init" ? { signal: controller.signal } : undefined,
  );
  assert(response.body);
  const reader = response.body.getReader();
  await reader.read();
  const cancelled = reader.read().then(() => "closed", () => "aborted");
  for (let iteration = 0; iteration < 10; iteration++) {
    await delay(10);
    collect();
  }
  controller.abort();
  assert.equal(
    await Promise.race([cancelled, delay(1000).then(() => "open")]),
    "aborted",
    `${mode} signal did not cancel the response stream after garbage collection`,
  );
  assert.equal(input instanceof Request ? input.url : input, url);
  for (let attempt = 0; attempt < 100 && streams.size > 0; attempt++) await delay(10);
  assert.equal(streams.size, 0, `${mode} signal left the HTTP connection open`);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
