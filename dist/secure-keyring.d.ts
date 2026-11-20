export interface SecureKeyringStore {
    read(account: string): string | undefined;
    write(account: string, payload: string): void;
    remove(account: string): void;
}
/**
 * The macOS login keychain lets only the exact Node binary that saved an item read it back.
 * Homebrew deletes the old binary when it upgrades Node, so a Pi started before the upgrade
 * is refused even though the stored items are intact.
 */
export declare function removedNodeBinaryKeychainHint(): string | undefined;
export declare function createSecureKeyringStore(service: string): SecureKeyringStore;
export declare function resetTestSecureKeyring(): void;
export declare function getTestSecureKeyringReadCount(): number;
export declare function getTestSecureKeyringEntries(): [string, string][];
export declare function setTestSecureKeyringEntry(service: string, account: string, payload: string): void;
export declare function removeTestSecureKeyringEntry(service: string, account: string): void;
