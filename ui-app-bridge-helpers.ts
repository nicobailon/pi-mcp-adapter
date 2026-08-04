import type { UiResourcePermissions } from "./types.ts";

export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

const RESOURCE_URI_META_KEY = "ui/resourceUri";

export function getToolUiResourceUri(tool: { _meta?: Record<string, unknown> | undefined }): string | undefined {
  const meta = tool._meta;
  let resourceUri = getNestedResourceUri(meta);
  if (resourceUri === undefined) {
    resourceUri = meta?.[RESOURCE_URI_META_KEY];
  }

  if (typeof resourceUri === "string" && resourceUri.startsWith("ui://")) {
    return resourceUri;
  }

  if (resourceUri !== undefined) {
    throw new Error(`Invalid UI resource URI: ${JSON.stringify(resourceUri)}`);
  }

  return undefined;
}

export function buildAllowAttribute(permissions: UiResourcePermissions | undefined): string {
  if (!permissions) return "";

  const allowed: string[] = [];
  if (permissions.camera) allowed.push("camera");
  if (permissions.microphone) allowed.push("microphone");
  if (permissions.geolocation) allowed.push("geolocation");
  if (permissions.clipboardWrite) allowed.push("clipboard-write");
  return allowed.join("; ");
}

function getNestedResourceUri(meta: Record<string, unknown> | undefined): unknown {
  const ui = meta?.ui;
  if (!ui || typeof ui !== "object") return undefined;
  return (ui as Record<string, unknown>).resourceUri;
}
