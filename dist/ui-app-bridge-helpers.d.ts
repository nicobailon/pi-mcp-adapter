import type { UiResourcePermissions } from "./types.ts";
export declare const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
export declare function getToolUiResourceUri(tool: {
    _meta?: Record<string, unknown> | undefined;
}): string | undefined;
export declare function buildAllowAttribute(permissions: UiResourcePermissions | undefined): string;
