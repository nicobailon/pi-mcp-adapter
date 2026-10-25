import type { McpExtensionState } from "./state.ts";
export interface ResolvedJevSettings {
    semanticSearch: boolean;
    allowedServers: string[];
    /** Pi classifier model as "provider/id". Unset: the first default model Pi has a credential for. */
    model?: string;
    semanticCandidateLimit: number;
    semanticMinProbability: number;
}
/** Settings for the removed `jev.evaluate()`. A config that still sets them loads, and they do nothing. */
export declare const REMOVED_JEV_KEYS: ReadonlySet<string>;
export declare function validateJevSettings(value: unknown): ResolvedJevSettings;
/** Without an explicit `allowedServers`, every enabled server may share its tool metadata. */
export declare function resolveSemanticJevSettings(state: McpExtensionState): ResolvedJevSettings;
