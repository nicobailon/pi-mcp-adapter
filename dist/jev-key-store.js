import { createSecureKeyringStore } from "./secure-keyring.js";
export const TYPESAFE_API_ORIGIN = "https://api.typesafe.ai";
export const JEV_KEYRING_SERVICE = "pi-mcp-adapter.service-key";
export const JEV_KEYRING_ACCOUNT = "typesafe@sha256(https://api.typesafe.ai)";
export class JevCredentialStoreError extends Error {
    operation;
    code = "JEV_CREDENTIAL_STORE_UNAVAILABLE";
    constructor(operation, cause) {
        super(`TypeSafe API key secure credential store unavailable during ${operation}. Configure or unlock the OS credential store and retry.`, { cause });
        this.operation = operation;
        this.name = "JevCredentialStoreError";
    }
}
function validateApiKey(value) {
    if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error("TypeSafe API key must be a non-empty string without control characters");
    }
    return value;
}
function store() {
    return createSecureKeyringStore(JEV_KEYRING_SERVICE);
}
function readStoredKey(secretStore = store()) {
    let payload;
    try {
        payload = secretStore.read(JEV_KEYRING_ACCOUNT);
    }
    catch (error) {
        throw new JevCredentialStoreError("read", error);
    }
    if (payload === undefined)
        return undefined;
    try {
        const value = JSON.parse(payload);
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("invalid record");
        const record = value;
        const keys = Object.keys(record);
        if (keys.length !== 4 || !["version", "provider", "origin", "apiKey"].every(key => Object.hasOwn(record, key)))
            throw new Error("invalid record fields");
        if (record.version !== 1 || record.provider !== "typesafe" || record.origin !== TYPESAFE_API_ORIGIN)
            throw new Error("invalid or mismatched record");
        return validateApiKey(record.apiKey);
    }
    catch (error) {
        throw new JevCredentialStoreError("read", error);
    }
}
export function resolveJevCredential(env = process.env, secretStore) {
    if (Object.hasOwn(env, "TYPESAFE_API_KEY")) {
        try {
            return { status: "present", source: "environment", apiKey: validateApiKey(env.TYPESAFE_API_KEY) };
        }
        catch {
            return { status: "unavailable", message: "TYPESAFE_API_KEY is present but invalid." };
        }
    }
    try {
        const apiKey = readStoredKey(secretStore ?? store());
        return apiKey === undefined ? { status: "missing" } : { status: "present", source: "keyring", apiKey };
    }
    catch (error) {
        if (!(error instanceof JevCredentialStoreError))
            throw error;
        return { status: "unavailable", message: error.message };
    }
}
export function saveJevApiKey(apiKey, secretStore = store()) {
    const record = { version: 1, provider: "typesafe", origin: TYPESAFE_API_ORIGIN, apiKey: validateApiKey(apiKey) };
    try {
        secretStore.write(JEV_KEYRING_ACCOUNT, JSON.stringify(record));
    }
    catch (error) {
        throw new JevCredentialStoreError("write", error);
    }
}
export function removeJevApiKey(secretStore = store()) {
    try {
        secretStore.remove(JEV_KEYRING_ACCOUNT);
    }
    catch (error) {
        throw new JevCredentialStoreError("remove", error);
    }
}
//# sourceMappingURL=jev-key-store.js.map