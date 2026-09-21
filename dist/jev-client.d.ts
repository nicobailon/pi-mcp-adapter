import type { McpExtensionState } from "./state.ts";
import { TYPESAFE_API_ORIGIN, type JevCredentialResolution } from "./jev-key-store.ts";
import type { JevBudget, JevEvaluateInput, JevEvaluationEnvelope, ResolvedJevSettings } from "./jev-contracts.ts";
export { TYPESAFE_API_ORIGIN };
export type { ResolvedJevSettings } from "./jev-contracts.ts";
export declare function areJevSourcesAllowed(state: McpExtensionState, settings: ResolvedJevSettings, sources: Iterable<string>): boolean;
export declare function validateJevSettings(value: unknown): ResolvedJevSettings;
export declare function resolveSemanticJevSettings(state: McpExtensionState, credentialResolver?: () => JevCredentialResolution): ResolvedJevSettings;
export declare function validateJevEvaluateInput(value: unknown, limits: ResolvedJevSettings): JevEvaluateInput;
export declare function evaluateJev(state: McpExtensionState, value: JevEvaluateInput, options: {
    purpose: "script" | "semantic-search";
    signal?: AbortSignal;
    budget?: JevBudget;
    observedSources?: readonly string[];
}): Promise<JevEvaluationEnvelope>;
