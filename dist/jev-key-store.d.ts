import { type SecureKeyringStore } from "./secure-keyring.ts";
export declare const TYPESAFE_API_ORIGIN = "https://api.typesafe.ai";
export declare const JEV_KEYRING_SERVICE = "pi-mcp-adapter.service-key";
export declare const JEV_KEYRING_ACCOUNT = "typesafe@sha256(https://api.typesafe.ai)";
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
export declare function resolveJevCredential(env?: NodeJS.ProcessEnv, secretStore?: SecureKeyringStore): JevCredentialResolution;
export declare function saveJevApiKey(apiKey: string, secretStore?: SecureKeyringStore): void;
export declare function removeJevApiKey(secretStore?: SecureKeyringStore): void;
