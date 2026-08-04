import { describe, it, expect, vi, beforeEach } from "vitest";
import { platform } from "node:os";
import { openUrl } from "../utils.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: vi.fn() };
});

function fakePi(): { pi: ExtensionAPI; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  return { pi: { exec } as unknown as ExtensionAPI, exec };
}

describe("openUrl on darwin", () => {
  beforeEach(() => {
    vi.mocked(platform).mockReturnValue("darwin");
  });

  it("execs an absolute-path browser override directly", async () => {
    const { pi, exec } = fakePi();

    await openUrl(pi, "https://example.com", "/usr/bin/open");

    expect(exec).toHaveBeenCalledWith("/usr/bin/open", ["https://example.com"], {});
  });

  it("still uses `open -a <name>` for a non-path browser override", async () => {
    const { pi, exec } = fakePi();

    await openUrl(pi, "https://example.com", "Google Chrome");

    expect(exec).toHaveBeenCalledWith("open", ["-a", "Google Chrome", "https://example.com"], {});
  });

  it("still uses `open -a <path>` for an absolute app bundle override", async () => {
    const { pi, exec } = fakePi();

    await openUrl(pi, "https://example.com", "/Applications/Google Chrome.app");

    expect(exec).toHaveBeenCalledWith("open", ["-a", "/Applications/Google Chrome.app", "https://example.com"], {});
  });

  it("treats app bundle extensions case-insensitively", async () => {
    const { pi, exec } = fakePi();

    await openUrl(pi, "https://example.com", "/Applications/Custom Browser.APP");

    expect(exec).toHaveBeenCalledWith("open", ["-a", "/Applications/Custom Browser.APP", "https://example.com"], {});
  });

  it("falls back to bare `open` with no browser override", async () => {
    const { pi, exec } = fakePi();

    await openUrl(pi, "https://example.com");

    expect(exec).toHaveBeenCalledWith("open", ["https://example.com"], {});
  });

  it("forwards an AbortSignal for an absolute-path browser override", async () => {
    const { pi, exec } = fakePi();
    const controller = new AbortController();

    await openUrl(pi, "https://example.com", "/usr/bin/open", controller.signal);

    expect(exec).toHaveBeenCalledWith("/usr/bin/open", ["https://example.com"], { signal: controller.signal });
  });
});
