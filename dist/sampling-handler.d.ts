import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/client";
import { type CreateMessageRequest, type CreateMessageResult } from "@modelcontextprotocol/client";
export type SamplingUIContext = Pick<ExtensionUIContext, "confirm">;
export type SamplingModelRegistry = Pick<ModelRegistry, "getAvailable" | "complete">;
export interface SamplingHandlerOptions {
    serverName: string;
    autoApprove: boolean;
    ui?: SamplingUIContext;
    modelRegistry: SamplingModelRegistry;
    getCurrentModel: () => Model<Api> | undefined;
    getSignal: () => AbortSignal | undefined;
}
export type ServerSamplingConfig = Omit<SamplingHandlerOptions, "serverName">;
export declare function registerSamplingHandler(client: Client, options: SamplingHandlerOptions): void;
export declare function handleSamplingRequest(options: SamplingHandlerOptions, request: CreateMessageRequest): Promise<CreateMessageResult>;
