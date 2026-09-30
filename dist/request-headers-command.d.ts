import type { FetchLike } from "@modelcontextprotocol/client";
import type { HttpRequestHeadersCommand } from "./types.ts";
export interface HttpRequestCommandEnvelope {
    version: 1;
    method: string;
    url: string;
    bodyBase64: string;
}
/** Wrap fetch so a trusted command can derive headers from the exact request. */
export declare function createRequestHeadersCommandFetch(config: HttpRequestHeadersCommand, delegate?: FetchLike): (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
