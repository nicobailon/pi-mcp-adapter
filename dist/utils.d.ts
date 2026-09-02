import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpConfig, ServerEntry } from "./types.ts";
export declare function openUrl(pi: ExtensionAPI, url: string, browser?: string, signal?: AbortSignal): Promise<void>;
export declare function openPath(pi: ExtensionAPI, targetPath: string): Promise<void>;
export declare function parallelLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>;
export declare function getConfigPathFromArgv(): string | undefined;
export declare function interpolateEnvVars(value: string): string;
export declare function interpolateEnvVars(value: string, environment: NodeJS.ProcessEnv): string;
export declare function toStringRecord(value: unknown): Record<string, string> | undefined;
export declare function interpolateEnvRecord(values: Record<string, string> | undefined, environment?: NodeJS.ProcessEnv): Record<string, string> | undefined;
/** Resolve a secret value, executing only a single leading `!` command marker. */
export declare function resolveCommandSecret(value: string, context: string): string;
export declare function resolveCommandSecret(value: undefined, context: string): undefined;
export declare function resolveCommandSecret(value: string | undefined, context: string): string | undefined;
/** Resolve command markers in a configured record without mutating the input. */
export declare function resolveCommandSecretsRecord(values: Record<string, string> | undefined, context: (key: string) => string): Record<string, string> | undefined;
export declare function resolveServerUrl(definition: Pick<ServerEntry, "url">, environment?: NodeJS.ProcessEnv): string | undefined;
export declare function resolveConfigPath(value: string | undefined, environment?: NodeJS.ProcessEnv): string | undefined;
export declare function resolveBearerToken(definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">, environment?: NodeJS.ProcessEnv): string | undefined;
/** Remove OSC control strings, including payloads that have no terminator. */
export declare function stripOscSequences(text: string): string;
export declare function sanitizeTerminalText(text: string): string;
export declare function formatTerminalError(error: unknown): string;
export declare function truncateAtWord(text: string, target: number): string;
export declare function normalizeDirectToolInputSchema(schema: unknown): Record<string, unknown>;
export declare function normalizeToolArguments(value: unknown, context?: string): Record<string, unknown>;
export declare function formatAuthRequiredMessage(config: Pick<McpConfig, "settings">, serverName: string, defaultMessage: string): string;
export declare function formatMcpStatus(config: Pick<McpConfig, "settings">, message: string): string | undefined;
/**
 * Extract the adapter-owned UI stream mode from tool metadata.
 */
export declare function extractToolUiStreamMode(toolMeta: Record<string, unknown> | undefined): "eager" | "stream-first" | undefined;
