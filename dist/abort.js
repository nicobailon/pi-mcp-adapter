export function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "MCP request aborted"));
}
export async function abortable(promise, signal) {
    if (!signal)
        return promise;
    throwIfAborted(signal);
    return await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "MCP request aborted")));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(value => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(value);
        }, error => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        });
    });
}
//# sourceMappingURL=abort.js.map