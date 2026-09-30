export declare function throwIfAborted(signal?: AbortSignal): void;
export declare function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T>;
