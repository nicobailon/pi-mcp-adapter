import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/client";
import { type CreateMessageRequest, type CreateMessageResult } from "@modelcontextprotocol/client";
export type SamplingUIContext = Pick<ExtensionUIContext, "confirm">;
export type SamplingModelRegistry = Pick<ModelRegistry, "getAvailable" | "complete"> & Partial<Pick<ModelRegistry, "streamSimple">>;
export interface SamplingHandlerOptions {
    serverName: string;
    autoApprove: boolean;
    ui?: SamplingUIContext;
    modelRegistry: SamplingModelRegistry;
    getCurrentModel: () => Model<Api> | undefined;
    getThinkingLevel: () => ModelThinkingLevel;
    getSignal: () => AbortSignal | undefined;
}
export interface ServerSamplingConfig extends Omit<SamplingHandlerOptions, "serverName"> {
    /**
     * Bounds sampling a task asks for. A background task runs outside any turn, so `getSignal`'s
     * current-turn signal would let an Esc on an unrelated later turn abort it.
     */
    ownerSignal: AbortSignal;
}
export declare function registerSamplingHandler(client: Client, options: SamplingHandlerOptions): void;
export declare function handleSamplingRequest(options: SamplingHandlerOptions, request: CreateMessageRequest): Promise<CreateMessageResult>;
