export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "MCP request aborted"));
}

export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "MCP request aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
