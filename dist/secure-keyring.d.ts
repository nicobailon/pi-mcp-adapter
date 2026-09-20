export interface SecureKeyringStore {
    read(account: string): string | undefined;
    write(account: string, payload: string): void;
    remove(account: string): void;
}
export declare function createSecureKeyringStore(service: string): SecureKeyringStore;
export declare function resetTestSecureKeyring(): void;
export declare function getTestSecureKeyringReadCount(): number;
export declare function getTestSecureKeyringEntries(): [string, string][];
export declare function setTestSecureKeyringEntry(service: string, account: string, payload: string): void;
export declare function removeTestSecureKeyringEntry(service: string, account: string): void;
