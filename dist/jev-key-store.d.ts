import { type SecureKeyringStore } from "./secure-keyring.ts";
/** The Jev decisions endpoint used when `SYSTEMONE_ENDPOINT` is not set. */
export declare const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Origin recorded in version 1 credential records. */
export declare const TYPESAFE_API_ORIGIN = "https://api.typesafe.ai";
/** Version 1 credential account, still read for the default endpoint. */
export declare const JEV_KEYRING_ACCOUNT = "typesafe@sha256(https://api.typesafe.ai)";
export declare const JEV_KEYRING_SERVICE = "pi-mcp-adapter.service-key";
/** The path `@typesafe-ai/sdk` appends to whatever base URL it is given. */
export declare const JEV_SDK_PATH = "/v1/systemone";
export interface ResolvedJevEndpoint {
    /** Canonical absolute URL sent to the provider, for example `https://opencode.ai/zen/v1/systemone`. */
    readonly href: string;
    /** URL origin, used as the SDK base URL. */
    readonly origin: string;
    /** URL path, rewritten onto the SDK's fixed path by the pinned fetch. */
    readonly path: string;
}
export type JevEndpointResolution = {
    status: "resolved";
    source: "environment" | "default";
    endpoint: ResolvedJevEndpoint;
} | {
    status: "unavailable";
    message: string;
};
export declare class JevCredentialStoreError extends Error {
    readonly operation: "read" | "write" | "remove";
    readonly code = "JEV_CREDENTIAL_STORE_UNAVAILABLE";
    constructor(operation: "read" | "write" | "remove", cause: unknown);
}
export type JevCredentialResolution = {
    status: "present";
    source: "environment" | "keyring";
    apiKey: string;
} | {
    status: "missing";
} | {
    status: "unavailable";
    message: string;
};
/**
 * Resolves the Jev endpoint. An invalid `SYSTEMONE_ENDPOINT` resolves to `unavailable` instead of silently falling
 * back to the default: sending an operator's judgment payload to a provider they did not ask for would be a data leak.
 */
export declare function resolveJevEndpoint(env?: NodeJS.ProcessEnv): JevEndpointResolution;
/** Keyring account for an endpoint, so keys for different providers coexist instead of overwriting each other. */
export declare function jevKeyringAccount(endpoint: ResolvedJevEndpoint): string;
export declare function resolveJevCredential(env?: NodeJS.ProcessEnv, endpoint?: ResolvedJevEndpoint, secretStore?: SecureKeyringStore): JevCredentialResolution;
export declare function saveJevApiKey(apiKey: string, endpoint?: ResolvedJevEndpoint, secretStore?: SecureKeyringStore): void;
export declare function removeJevApiKey(endpoint?: ResolvedJevEndpoint, secretStore?: SecureKeyringStore): void;
