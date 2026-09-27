import type { McpConfig } from "./types.ts";
export interface PackageServerSource {
    scope: "project" | "user";
    settingsPath: string;
    packageRoot: string;
}
export interface LoadedPackageMcpConfig extends McpConfig {
    serverSources: Map<string, PackageServerSource>;
}
export declare function loadPackageMcpConfigs(cwd?: string): LoadedPackageMcpConfig;
