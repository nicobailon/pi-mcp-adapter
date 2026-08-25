export declare function getConfigDirName(): string;
export declare function getAgentDir(): string;
export declare function getAgentPath(...segments: string[]): string;
export declare function getAppName(): string;
/**
 * Home page the host declares for itself, via `piConfig.clientUri` in the same
 * manifest that carries `piConfig.name`. Only the distribution knows its own
 * URL, so this is the one place it can come from without guessing.
 */
export declare function getAppClientUri(): string | undefined;
