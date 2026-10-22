import type { McpExtensionState } from "./state.ts";
import { type JevCredentialResolution } from "./jev-key-store.ts";
import type { JevEvaluateInput, JevEvaluationEnvelope, ResolvedJevSettings } from "./jev-contracts.ts";
export type { ResolvedJevSettings } from "./jev-contracts.ts";
/** Settings for the removed `jev.evaluate()`. A config that still sets them loads, and they do nothing. */
export declare const REMOVED_JEV_KEYS: ReadonlySet<string>;
export declare function areJevSourcesAllowed(state: McpExtensionState, settings: ResolvedJevSettings, sources: Iterable<string>): boolean;
export declare function validateJevSettings(value: unknown): ResolvedJevSettings;
export declare function resolveSemanticJevSettings(state: McpExtensionState, credentialResolver?: () => JevCredentialResolution): ResolvedJevSettings;
export declare function validateJevEvaluateInput(value: unknown, limits: ResolvedJevSettings): JevEvaluateInput;
export declare function evaluateJev(state: McpExtensionState, value: JevEvaluateInput, options?: {
    signal?: AbortSignal;
    observedSources?: readonly string[];
}): Promise<JevEvaluationEnvelope>;
