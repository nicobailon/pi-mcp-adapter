import type { ServerEntry } from "./types.ts";
/** Validate at the connection boundary, including callers that bypass JSON config. */
export declare function validateCaFile(definition: ServerEntry): void;
/** One connection owner, shared across transport/auth retries; never process-wide. */
export declare function createCaFetch(definition: ServerEntry): {
    fetch: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
    close: () => Promise<void>;
} | undefined;
