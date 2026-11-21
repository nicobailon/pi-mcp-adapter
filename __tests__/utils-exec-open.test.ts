import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPathFromArgv, openUrl } from "../utils.ts";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: vi.fn() };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const launcher = { stdio: "ignore", detached: true };

function fakeSpawn(): void {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child as unknown as ChildProcess;
  });
}

beforeEach(() => {
  vi.mocked(spawn).mockClear();
});

describe("getConfigPathFromArgv", () => {
  it.each([
    ["split form", ["--mcp-config", "/ambient.json"], "/ambient.json"],
    ["equals form", ["--mcp-config=/override.json"], "/override.json"],
    ["equals-containing path", ["--mcp-config=/override=mcp.json"], "/override=mcp.json"],
    ["last occurrence", ["--mcp-config", "/ambient.json", "--mcp-config=/override.json"], "/override.json"],
    ["end of options", ["--mcp-config", "/ambient.json", "--", "--mcp-config=/ignored.json"], "/ambient.json"],
    ["split flag-like value", ["--mcp-config", "@ambient.json"], undefined],
  ] as const)("matches Pi's %s argv result", (_name, args, expected) => {
    const originalArgv = process.argv;
    try {
      process.argv = ["node", "script", ...args];
      expect(getConfigPathFromArgv()).toBe(expected);
    } finally {
      process.argv = originalArgv;
    }
  });
});

describe("openUrl on darwin", () => {
  beforeEach(() => {
    vi.mocked(platform).mockReturnValue("darwin");
    fakeSpawn();
  });

  it("execs an absolute-path browser override directly", async () => {
    await openUrl("https://example.com", "/usr/bin/open");

    expect(spawn).toHaveBeenCalledWith("/usr/bin/open", ["https://example.com"], launcher);
  });

  it("still uses `open -a <name>` for a non-path browser override", async () => {
    await openUrl("https://example.com", "Google Chrome");

    expect(spawn).toHaveBeenCalledWith("open", ["-a", "Google Chrome", "https://example.com"], launcher);
  });

  it("still uses `open -a <path>` for an absolute app bundle override", async () => {
    await openUrl("https://example.com", "/Applications/Google Chrome.app");

    expect(spawn).toHaveBeenCalledWith("open", ["-a", "/Applications/Google Chrome.app", "https://example.com"], launcher);
  });

  it("treats app bundle extensions case-insensitively", async () => {
    await openUrl("https://example.com", "/Applications/Custom Browser.APP");

    expect(spawn).toHaveBeenCalledWith("open", ["-a", "/Applications/Custom Browser.APP", "https://example.com"], launcher);
  });

  it("falls back to bare `open` with no browser override", async () => {
    await openUrl("https://example.com");

    expect(spawn).toHaveBeenCalledWith("open", ["https://example.com"], launcher);
  });
});

describe("openUrl on win32", () => {
  beforeEach(() => {
    vi.mocked(platform).mockReturnValue("win32");
  });

  const url = "https://mcp.evil.example/a&notepad&b/$(notepad)/authorize";

  it("hands the URL to the protocol handler without cmd.exe", async () => {
    fakeSpawn();

    await openUrl(url);

    expect(spawn).toHaveBeenCalledExactlyOnceWith("rundll32", ["url.dll,FileProtocolHandler", url], launcher);
  });

  it("runs a browser override directly", async () => {
    fakeSpawn();

    await openUrl(url, "C:\\Browsers\\firefox.exe");

    expect(spawn).toHaveBeenCalledExactlyOnceWith("C:\\Browsers\\firefox.exe", [url], launcher);
  });

  it.each(["file:///C:/Windows/System32/calc.exe", "ms-settings:privacy"])("refuses %s", async (target) => {
    await expect(openUrl(target)).rejects.toThrow("only http and https URLs are opened");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("openUrl with a real launcher", () => {
  async function withBrowser(script: string, run: (browser: string) => Promise<void>): Promise<void> {
    vi.mocked(platform).mockReturnValue("linux");
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-open-"));
    const browser = join(dir, "browser");
    await writeFile(browser, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    try {
      await run(browser);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("returns while a browser launcher is still running", async () => {
    await withBrowser('echo $$ > "$0.pid"\nexec sleep 30', async (browser) => {
      let pid = 0;
      try {
        const started = Date.now();
        await openUrl("https://example.com/authorize", browser);
        expect(Date.now() - started).toBeLessThan(3000);
        pid = await vi.waitFor(async () => {
          const value = Number(await readFile(`${browser}.pid`, "utf8"));
          if (!(value > 0)) throw new Error("pid not written yet");
          return value;
        });
        expect(() => process.kill(pid, 0)).not.toThrow();
      } finally {
        if (pid > 0) process.kill(pid);
      }
    });
  });

  it("rejects with the exit code of a launcher that fails at once", async () => {
    await withBrowser("exit 3", async (browser) => {
      await expect(openUrl("https://example.com/authorize", browser)).rejects.toThrow("Failed to open browser (exit code 3)");
    });
  });
});
