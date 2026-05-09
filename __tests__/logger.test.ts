import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logger, type LogEntry, type LogLevel } from "../logger.js";

describe("Logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.clearHandlers();
    logger.setLevel("debug"); // Enable all levels for testing
    logger.setDefaultContext({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("log levels", () => {
    it("respects minimum log level", () => {
      const entries: LogEntry[] = [];
      logger.addHandler((entry) => entries.push(entry));

      logger.setLevel("warn");
      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(entries).toHaveLength(2);
      expect(entries[0].level).toBe("warn");
      expect(entries[1].level).toBe("error");
    });

    it("logs all levels when set to debug", () => {
      const entries: LogEntry[] = [];
      logger.addHandler((entry) => entries.push(entry));

      logger.setLevel("debug");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(entries).toHaveLength(4);
    });
  });

  describe("context", () => {
    it("includes context in log entries", () => {
      const entries: LogEntry[] = [];
      logger.addHandler((entry) => entries.push(entry));

      logger.info("test", { server: "test-server", tool: "test-tool" });

      expect(entries[0].context).toEqual({
        server: "test-server",
        tool: "test-tool",
      });
    });

    it("merges default context with call context", () => {
      const entries: LogEntry[] = [];
      logger.addHandler((entry) => entries.push(entry));
      logger.setDefaultContext({ server: "default-server" });

      logger.info("test", { tool: "my-tool" });

      expect(entries[0].context).toEqual({
        server: "default-server",
        tool: "my-tool",
      });
    });

    it("call context overrides default context", () => {
      const entries: LogEntry[] = [];
      logger.addHandler((entry) => entries.push(entry));
      logger.setDefaultContext({ server: "default-server" });

      logger.info("test", { server: "override-server" });

      expect(entries[0].context?.server).toBe("override-server");
    });
  });

  describe("child logger", () => {
    it("inherits parent context", () => {
      const entries: LogEntry[] = [];
      logger.addHandler((entry) => entries.push(entry));

      const child = logger.child({ server: "child-server" });
      child.info("child message");

      expect(entries[0].context?.server).toBe("child-server");
    });

    it("can add additional context", () => {
      const entries: LogEntry[] = [];
      logger.addHandler((entry) => entries.push(entry));

      const child = logger.child({ server: "child-server" });
      child.info("message", { tool: "child-tool" });

      expect(entries[0].context).toEqual({
        server: "child-server",
        tool: "child-tool",
      });
    });

    it("can create nested children", () => {
      const entries: LogEntry[] = [];
      logger.addHandler((entry) => entries.push(entry));

      const child1 = logger.child({ server: "server" });
      const child2 = child1.child({ session: "session123" });
      child2.info("nested message");

      expect(entries[0].context).toEqual({
        server: "server",
        session: "session123",
      });
    });
  });

  describe("error logging", () => {
    it("includes error object", () => {
      const entries: LogEntry[] = [];
      logger.addHandler((entry) => entries.push(entry));

      const error = new Error("test error");
      logger.error("something failed", error, { server: "test" });

      expect(entries[0].error).toBe(error);
      expect(entries[0].message).toBe("something failed");
    });
  });

  describe("handlers", () => {
    it("calls all registered handlers", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      logger.addHandler(handler1);
      logger.addHandler(handler2);

      logger.info("test");

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("ignores handler errors", () => {
      const badHandler = vi.fn().mockImplementation(() => {
        throw new Error("handler error");
      });
      const goodHandler = vi.fn();
      logger.addHandler(badHandler);
      logger.addHandler(goodHandler);

      // Should not throw
      expect(() => logger.info("test")).not.toThrow();
      expect(goodHandler).toHaveBeenCalled();
    });

    it("clearHandlers removes all handlers", () => {
      const handler = vi.fn();
      logger.addHandler(handler);
      logger.clearHandlers();

      logger.info("test");

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
