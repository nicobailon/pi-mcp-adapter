import type { McpConfig } from "./types.ts";
export interface PackageServerSource {
    scope: "project" | "user";
    settingsPath: string;
    packageRoot: string;
}
export interface LoadedPackageMcpConfig extends McpConfig {
    /** `configPath` is the package's MCP config file that defines the server. */
    serverSources: Map<string, PackageServerSource & {
        configPath: string;
    }>;
}
export declare function loadPackageMcpConfigs(cwd?: string): LoadedPackageMcpConfig;
