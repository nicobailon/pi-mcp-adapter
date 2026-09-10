import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { logOAuthDiagnostic } from "../oauth-diagnostics.ts";

afterEach(() => vi.unstubAllEnvs());

it("records process and transaction identity without copying extra credential fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-diagnostics-"));
  const path = join(dir, "events.jsonl");
  vi.stubEnv("PI_MCP_OAUTH_LOG", path);
  try {
    const details = { serverName: "test-server", transactionId: "test-transaction", refreshToken: "fake-secret", serverUrl: "https://fake.test/?token=fake-secret" };
    await logOAuthDiagnostic("oauth_transaction_acquired", details);
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toMatchObject({ pid: process.pid, transactionId: "test-transaction", event: "oauth_transaction_acquired" });
    expect(text).not.toContain("fake-secret");
    expect(text).not.toContain("serverUrl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not propagate a log write failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-diagnostics-unwritable-"));
  vi.stubEnv("PI_MCP_OAUTH_LOG", dir);
  try {
    await expect(logOAuthDiagnostic("oauth_transaction_failed", { serverName: "test-server", transactionId: "test" })).resolves.toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
