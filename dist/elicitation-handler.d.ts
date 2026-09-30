import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/client";
import { type ElicitRequest, type ElicitRequestFormParams, type ElicitRequestURLParams, type ElicitResult, type RequestOptions } from "@modelcontextprotocol/client";
export type ElicitationValue = string | number | boolean | string[] | undefined;
export type ElicitationUIContext = Pick<ExtensionUIContext, "select" | "input" | "notify">;
export interface ElicitationHandlerOptions {
    serverName: string;
    ui: ElicitationUIContext;
    allowUrl: boolean;
    onUrlAccepted?: (elicitationId: string) => void;
}
export type ServerElicitationConfig = Omit<ElicitationHandlerOptions, "serverName" | "onUrlAccepted">;
export declare function registerElicitationHandler(client: Client, options: ElicitationHandlerOptions): void;
/**
 * Calls a tool with the request timeout counting only time the user is not
 * answering an elicitation prompt from the same server. The SDK's own timer
 * cannot be paused, so it is pushed out of the way and the deadline aborts the
 * request with the same timeout error the SDK would raise. A client without an
 * elicitation handler cannot prompt, so it keeps the SDK's timer.
 *
 * Every call requests progress, and each progress notification restarts the
 * timeout, as in Pi's built-in MCP. The SDK only sends a progress token when
 * `onprogress` is set, so a caller without one gets a no-op handler.
 */
export declare function callToolPausingForElicitation(client: Client, params: Parameters<Client["callTool"]>[0], options?: RequestOptions): ReturnType<Client["callTool"]>;
export declare function handleElicitationRequest(options: ElicitationHandlerOptions, request: ElicitRequest, signal?: AbortSignal): Promise<ElicitResult>;
export declare function handleFormElicitation(options: ElicitationHandlerOptions, params: ElicitRequestFormParams, signal?: AbortSignal): Promise<ElicitResult>;
export declare function coerceAndValidateFormValues(params: ElicitRequestFormParams, values: Record<string, ElicitationValue>): Record<string, string | number | boolean | string[]>;
export declare function handleUrlElicitation(options: ElicitationHandlerOptions, params: ElicitRequestURLParams, signal?: AbortSignal): Promise<ElicitResult>;
