import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { startUiServer, type UiServerHandle, type UiServerOptions } from "../ui-server.ts";
import type { ConsentManager } from "../consent-manager.ts";
import type { McpServerManager } from "../server-manager.ts";

function resolveChrome(): string | undefined {
  for (const candidate of ["google-chrome", "google-chrome-stable"]) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) return candidate;
  }
  return undefined;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function stopChrome(chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode !== null) return;
  chrome.kill("SIGKILL");
  await Promise.race([
    once(chrome, "exit").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function waitForRequests(requests: Set<string>, expected: string[], chrome: ChildProcess): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (expected.every((path) => requests.has(path))) return;
    if (chrome.exitCode !== null) throw new Error(`Chrome exited before navigation completed (${chrome.exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for observer requests: ${[...requests].join(", ")}`);
}

const chromePath = resolveChrome();
const chromeRequired = process.platform === "linux" && !!process.env.CI;
const browserIt = chromePath || chromeRequired ? it : it.skip;

describe("UiServer browser CSP", () => {
  browserIt("allows declared nested resources and blocks equivalent undeclared origins", async () => {
    if (!chromePath) {
      throw new Error("google-chrome or google-chrome-stable is required on Linux CI");
    }

    const requests = new Set<string>();
    const observer = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://observer").pathname;
      requests.add(pathname);
      if (pathname.endsWith("script.js")) {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end(`fetch(DECLARED + "/declared/fetch"); fetch(UNDECLARED + "/undeclared/fetch").catch(() => {});`);
        return;
      }
      if (pathname.endsWith("style.css")) {
        res.writeHead(200, { "Content-Type": "text/css" });
        res.end("body { color: rgb(1, 2, 3); }");
        return;
      }
      if (pathname.endsWith("fetch")) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>observed frame</title>");
    });

    let handle: UiServerHandle | undefined;
    let chrome: ChildProcess | undefined;
    let profileDir: string | undefined;
    try {
      await new Promise<void>((resolve) => observer.listen(0, "127.0.0.1", resolve));
      const observerPort = (observer.address() as { port: number }).port;
      const declaredOrigin = `http://127.0.0.1:${observerPort}`;
      const undeclaredOrigin = `http://localhost:${observerPort}`;
      const appHtml = `<!doctype html>
<html><head>
<script>const DECLARED = ${JSON.stringify(declaredOrigin)}; const UNDECLARED = ${JSON.stringify(undeclaredOrigin)};</script>
<link rel="stylesheet" href="${declaredOrigin}/declared/style.css">
<link rel="stylesheet" href="${undeclaredOrigin}/undeclared/style.css">
</head><body>
<script src="${declaredOrigin}/declared/script.js"></script>
<script src="${undeclaredOrigin}/undeclared/script.js"></script>
<iframe src="${declaredOrigin}/declared/frame"></iframe>
<iframe src="${undeclaredOrigin}/undeclared/frame"></iframe>
</body></html>`;

      const manager = {
        getConnection: () => undefined,
        touch: () => undefined,
        incrementInFlight: () => undefined,
        decrementInFlight: () => undefined,
      } as unknown as McpServerManager;
      const consentManager = {
        requiresPrompt: () => false,
        shouldCacheConsent: () => true,
      } as unknown as ConsentManager;
      const options: UiServerOptions = {
        serverName: "browser-csp",
        toolName: "browser_csp",
        toolArgs: {},
        resource: {
          uri: "ui://test/browser-csp",
          html: appHtml,
          mimeType: "text/html",
          meta: {
            permissions: [],
            csp: {
              resourceDomains: [declaredOrigin],
              connectDomains: [declaredOrigin],
              frameDomains: [declaredOrigin],
            },
          },
        },
        manager,
        consentManager,
      };
      handle = await startUiServer(options);
      profileDir = await mkdtemp(path.join(tmpdir(), "pi-mcp-chrome-"));
      chrome = spawn(chromePath, [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
        handle.url,
      ], { stdio: "ignore" });

      const declaredPaths = [
        "/declared/script.js",
        "/declared/style.css",
        "/declared/fetch",
        "/declared/frame",
      ];
      await waitForRequests(requests, declaredPaths, chrome);
      await new Promise((resolve) => setTimeout(resolve, 750));

      expect([...requests].filter((requestPath) => requestPath.startsWith("/undeclared/"))).toEqual([]);
    } finally {
      if (chrome) await stopChrome(chrome);
      if (handle) handle.close("browser-test-cleanup");
      if (observer.listening) await closeServer(observer);
      if (profileDir) await rm(profileDir, { recursive: true, force: true });
    }
  }, 20_000);
});
