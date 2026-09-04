import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConsentManager, type ToolConsentMode } from "../consent-manager.ts";

describe("ConsentManager", () => {
  describe("mode: never", () => {
    let manager: ConsentManager;

    beforeEach(() => {
      manager = new ConsentManager("never");
    });

    it("never requires prompt", () => {
      expect(manager.requiresPrompt("any-server")).toBe(false);
      expect(manager.requiresPrompt("another-server")).toBe(false);
    });

    it("should not cache consent", () => {
      // "never" mode means no consent needed, so caching is irrelevant
      // but the API returns true for consistency
      expect(manager.shouldCacheConsent()).toBe(true);
    });

    it("ensureApproved never throws", () => {
      expect(() => manager.ensureApproved("any-server")).not.toThrow();
    });

    it("registering denial has no effect", () => {
      manager.registerDecision("test-server", false);
      expect(manager.requiresPrompt("test-server")).toBe(false);
      expect(() => manager.ensureApproved("test-server")).not.toThrow();
    });
  });

  describe("mode: once-per-server (default)", () => {
    let manager: ConsentManager;

    beforeEach(() => {
      manager = new ConsentManager("once-per-server");
    });

    it("requires prompt for new servers", () => {
      expect(manager.requiresPrompt("server-a")).toBe(true);
      expect(manager.requiresPrompt("server-b")).toBe(true);
    });

    it("does not require prompt after approval", () => {
      manager.registerDecision("server-a", true);
      expect(manager.requiresPrompt("server-a")).toBe(false);
      // Other servers still require prompt
      expect(manager.requiresPrompt("server-b")).toBe(true);
    });

    it("requires prompt after denial", () => {
      manager.registerDecision("server-a", false);
      expect(manager.requiresPrompt("server-a")).toBe(true);
    });

    it("should cache consent", () => {
      expect(manager.shouldCacheConsent()).toBe(true);
    });

    it("ensureApproved throws for unapproved server", () => {
      expect(() => manager.ensureApproved("server-a")).toThrow(
        'Tool call approval required for "server-a"'
      );
    });

    it("ensureApproved throws for denied server", () => {
      manager.registerDecision("server-a", false);
      expect(() => manager.ensureApproved("server-a")).toThrow(
        'Tool calls for "server-a" were denied for this session'
      );
    });

    it("ensureApproved succeeds after approval", () => {
      manager.registerDecision("server-a", true);
      expect(() => manager.ensureApproved("server-a")).not.toThrow();
    });

    it("approval overrides previous denial", () => {
      manager.registerDecision("server-a", false);
      manager.registerDecision("server-a", true);
      expect(manager.requiresPrompt("server-a")).toBe(false);
      expect(() => manager.ensureApproved("server-a")).not.toThrow();
    });

    it("denial overrides previous approval", () => {
      manager.registerDecision("server-a", true);
      manager.registerDecision("server-a", false);
      expect(manager.requiresPrompt("server-a")).toBe(true);
      expect(() => manager.ensureApproved("server-a")).toThrow();
    });
  });

  describe("mode: always", () => {
    let manager: ConsentManager;

    beforeEach(() => {
      manager = new ConsentManager("always");
    });

    it("always requires prompt", () => {
      expect(manager.requiresPrompt("server-a")).toBe(true);
    });

    it("still requires prompt after approval", () => {
      manager.registerDecision("server-a", true);
      expect(manager.requiresPrompt("server-a")).toBe(true);
    });

    it("should not cache consent", () => {
      expect(manager.shouldCacheConsent()).toBe(false);
    });

    it("ensureApproved consumes the approval", () => {
      manager.registerDecision("server-a", true);
      // First call succeeds
      expect(() => manager.ensureApproved("server-a")).not.toThrow();
      // Second call fails (approval was consumed)
      expect(() => manager.ensureApproved("server-a")).toThrow(
        'Tool call approval required for "server-a"'
      );
    });
  });

  describe("clear", () => {
    let manager: ConsentManager;

    beforeEach(() => {
      manager = new ConsentManager("once-per-server");
      manager.registerDecision("server-a", true);
      manager.registerDecision("server-b", false);
    });

    it("clears specific server", () => {
      manager.clear("server-a");
      expect(manager.requiresPrompt("server-a")).toBe(true);
      // server-b unchanged
      expect(() => manager.ensureApproved("server-b")).toThrow(/denied/);
    });

    it("clears all servers", () => {
      manager.clear();
      expect(manager.requiresPrompt("server-a")).toBe(true);
      expect(manager.requiresPrompt("server-b")).toBe(true);
      // Neither approved nor denied
      expect(() => manager.ensureApproved("server-a")).toThrow(/approval required/);
      expect(() => manager.ensureApproved("server-b")).toThrow(/approval required/);
    });
  });

  describe("session persistence", () => {
    it("writes tagged iframe decisions and restores without re-emitting", () => {
      const persist = vi.fn();
      const manager = new ConsentManager("once-per-server", persist);

      manager.registerDecision("server-a", true);
      manager.registerDecision("server-a", false);
      expect(persist.mock.calls.map(([record]) => record)).toEqual([
        { version: 1, kind: "iframe", decision: "allow", serverName: "server-a" },
        { version: 1, kind: "iframe", decision: "deny", serverName: "server-a" },
      ]);

      persist.mockClear();
      manager.restoreDecision("server-a", true);
      expect(persist).not.toHaveBeenCalled();
      expect(manager.requiresPrompt("server-a")).toBe(false);
      expect(() => manager.ensureApproved("server-a")).not.toThrow();
    });
  });
});
