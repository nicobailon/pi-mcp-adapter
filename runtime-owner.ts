import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface McpRuntimeOwner {
  readonly signal: AbortSignal;
  isActive(): boolean;
  addCleanup(cleanup: () => void | Promise<void>): void;
  stop(reason?: string): Promise<void>;
  throwIfInactive(): void;
}

export function createMcpRuntimeOwner(): McpRuntimeOwner {
  const controller = new AbortController();
  const cleanups: Array<() => void | Promise<void>> = [];
  let stopPromise: Promise<void> | undefined;
  return {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    addCleanup: (cleanup) => {
      if (controller.signal.aborted) {
        void Promise.resolve(cleanup()).catch(() => {});
        return;
      }
      cleanups.push(cleanup);
    },
    stop: (reason = "MCP extension runtime stopped") => {
      if (stopPromise) return stopPromise;
      controller.abort(new Error(reason));
      stopPromise = Promise.allSettled(cleanups.reverse().map(cleanup => cleanup())).then(() => undefined);
      return stopPromise;
    },
    throwIfInactive: () => controller.signal.throwIfAborted(),
  };
}

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

/**
 * Fence all session-bound UI calls behind the extension runtime owner.
 * Calls started by the old runtime may settle later, but they cannot begin a
 * new UI mutation once session_shutdown has aborted the owner.
 */
export function createOwnedUi(
  ui: ExtensionUIContext,
  owner: McpRuntimeOwner,
): ExtensionUIContext {
  const methodCache = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(ui, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return owner.isActive() ? value : undefined;
      let wrapped = methodCache.get(property);
      if (!wrapped) {
        wrapped = (...args: unknown[]) => {
          if (!owner.isActive()) return undefined;
          return Reflect.apply(value, target, args);
        };
        methodCache.set(property, wrapped);
      }
      return wrapped;
    },
  });
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && (error.name === "AbortError" || error.message === "MCP extension runtime stopped");
}
