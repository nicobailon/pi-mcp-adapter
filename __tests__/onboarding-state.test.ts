import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("onboarding state", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("returns the default state when no file exists", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-onboarding-home-"));
    const { loadOnboardingState, getOnboardingStatePath } = await import("../onboarding-state.ts");

    expect(loadOnboardingState()).toEqual({
      version: 1,
      sharedConfigHintShown: false,
      setupCompleted: false,
    });
    expect(existsSync(getOnboardingStatePath())).toBe(false);
  });

  it("persists hint and setup completion state", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-onboarding-home-"));
    const {
      markSharedConfigHintShown,
      markSetupCompleted,
      loadOnboardingState,
      getOnboardingStatePath,
    } = await import("../onboarding-state.ts");

    markSharedConfigHintShown("first");
    markSetupCompleted("second");

    expect(loadOnboardingState()).toEqual({
      version: 1,
      sharedConfigHintShown: true,
      setupCompleted: true,
      lastDiscoveryFingerprint: "second",
    });

    const raw = JSON.parse(readFileSync(getOnboardingStatePath(), "utf-8"));
    expect(raw.sharedConfigHintShown).toBe(true);
    expect(raw.setupCompleted).toBe(true);
  });
});
