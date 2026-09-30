import { formatTerminalError } from "./utils.js";
export function createMcpRuntimeOwner() {
    const controller = new AbortController();
    const cleanups = [];
    let stopPromise;
    const reportCleanupFailure = (error, late) => {
        console.error(`MCP: ${late ? "late " : ""}runtime cleanup failed: ${formatTerminalError(error)}`);
    };
    return {
        signal: controller.signal,
        isActive: () => !controller.signal.aborted,
        addCleanup: cleanup => {
            if (controller.signal.aborted) {
                void Promise.resolve().then(cleanup).catch(error => reportCleanupFailure(error, true));
                return;
            }
            cleanups.push(cleanup);
        },
        stop: (reason = "MCP extension runtime stopped") => {
            if (stopPromise)
                return stopPromise;
            controller.abort(new Error(reason));
            const pendingCleanups = cleanups.splice(0).reverse().map(cleanup => Promise.resolve().then(cleanup));
            stopPromise = Promise.allSettled(pendingCleanups).then(results => {
                const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
                if (failures.length > 0) {
                    const aggregate = new AggregateError(failures, "MCP runtime cleanup failed");
                    console.error(`MCP: runtime cleanup failed: ${formatTerminalError(aggregate)}`);
                    throw aggregate;
                }
            });
            return stopPromise;
        },
        throwIfInactive: () => controller.signal.throwIfAborted(),
    };
}
export function combineAbortSignals(...signals) {
    const active = signals.filter((signal) => signal !== undefined);
    if (active.length === 0)
        return undefined;
    if (active.length === 1)
        return active[0];
    if (typeof AbortSignal.any === "function")
        return AbortSignal.any(active);
    // AbortSignal.any was added after Node 20.0.0, our minimum supported version.
    const controller = new AbortController();
    const alreadyAborted = active.find(signal => signal.aborted);
    if (alreadyAborted) {
        controller.abort(alreadyAborted.reason);
        return controller.signal;
    }
    const onAbort = (event) => {
        for (const signal of active)
            signal.removeEventListener("abort", onAbort);
        controller.abort(event.target.reason);
    };
    for (const signal of active)
        signal.addEventListener("abort", onAbort, { once: true });
    return controller.signal;
}
/** Fence session-bound UI calls after the owning extension runtime stops. */
export function createOwnedUi(ui, owner) {
    const proxies = new WeakMap();
    const wrap = (value) => {
        if ((typeof value !== "object" || value === null) && typeof value !== "function") {
            return value;
        }
        const object = value;
        const existing = proxies.get(object);
        if (existing)
            return existing;
        const proxy = new Proxy(object, {
            get(target, property, receiver) {
                if (!owner.isActive())
                    return undefined;
                const member = Reflect.get(target, property, receiver);
                if (typeof member === "function") {
                    return (...args) => {
                        if (!owner.isActive())
                            return undefined;
                        return Reflect.apply(member, target, args);
                    };
                }
                return owner.isActive() ? wrap(member) : undefined;
            },
        });
        proxies.set(object, proxy);
        return proxy;
    };
    return wrap(ui);
}
export function isAbortError(error, signal) {
    if (signal?.aborted)
        return true;
    return error instanceof Error && (error.name === "AbortError" || error.message === "MCP extension runtime stopped");
}
//# sourceMappingURL=runtime-owner.js.map