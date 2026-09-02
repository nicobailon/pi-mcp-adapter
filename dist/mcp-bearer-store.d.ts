export declare class BearerCredentialStoreError extends Error {
    readonly code = "BEARER_CREDENTIAL_STORE_UNAVAILABLE";
    readonly operation: "read" | "write" | "remove";
    constructor(message: string, operation: "read" | "write" | "remove", cause: unknown);
}
export type BearerCredentialStatus = {
    status: "present";
} | {
    status: "missing";
} | {
    status: "url-mismatch";
} | {
    status: "unavailable";
    message: string;
};
export declare function getBearerTokenForUrl(serverName: string, serverUrl: string): string | undefined;
export declare function saveBearerTokenForUrl(serverName: string, token: string, serverUrl: string): void;
export declare function removeBearerToken(serverName: string): void;
export declare function inspectBearerTokenForUrl(serverName: string, serverUrl: string): BearerCredentialStatus;
export declare function resetTestBearerTokenStore(): void;
export declare function getTestBearerTokenStoreEntries(): [string, string][];
export declare function removeTestBearerTokenStoreEntry(account: string): void;
export declare function setTestBearerTokenStoreEntry(account: string, payload: string): void;
export declare function getTestBearerTokenStoreReadCount(): number;
