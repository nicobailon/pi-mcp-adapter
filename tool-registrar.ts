// tool-registrar.ts - MCP content transformation
// NOTE: Tools are NOT registered with Pi - only the unified `mcp` proxy tool is registered.
// This keeps the LLM context small (1 tool instead of 100s).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpContent, ContentBlock } from "./types.ts";

const MAX_BINARY_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_RESOURCE_BYTES = 100 * 1024 * 1024;
const MAX_SESSION_RESOURCE_FILES = 10_000; // Bounds metadata from empty or tiny resources.
const CLEANUP_RETRY_DELAY_MS = 30_000;
const MAX_CLEANUP_RETRY_ATTEMPTS = 3;
type MaterializedResourceSession = {
  directory: string | undefined;
  bytes: number;
  files: number;
  sequence: number;
};

function createMaterializedResourceSession(): MaterializedResourceSession {
  return {
    directory: undefined,
    bytes: 0,
    files: 0,
    sequence: 0,
  };
}

const defaultMaterializedResourceSession = createMaterializedResourceSession();
const scopedMaterializedResourceSessions = new WeakMap<object, MaterializedResourceSession>();
const pendingCleanupDirectories = new Set<string>();
const cleanupRetryAttempts = new Map<string, number>();
let pendingCleanupRetry: ReturnType<typeof setTimeout> | undefined;

function isAbortedScope(scope: object | undefined): boolean {
  return !!scope && "aborted" in scope && (scope as { aborted?: unknown }).aborted === true;
}

function getMaterializedResourceSession(scope?: object): MaterializedResourceSession | undefined {
  if (isAbortedScope(scope)) return undefined;
  if (!scope) return defaultMaterializedResourceSession;
  let session = scopedMaterializedResourceSessions.get(scope);
  if (!session) {
    session = createMaterializedResourceSession();
    scopedMaterializedResourceSessions.set(scope, session);
  }
  return session;
}

type BinaryResource = { uri?: string | undefined; text?: string | undefined; mimeType?: string | undefined; blob: string };
type McpResourceContent = {
  uri: string;
  text?: string | undefined;
  blob?: string | undefined;
  mimeType?: string | undefined;
  [key: string]: unknown;
};

function hasRetryableCleanupDirectory(): boolean {
  for (const directory of pendingCleanupDirectories) {
    if ((cleanupRetryAttempts.get(directory) ?? 0) < MAX_CLEANUP_RETRY_ATTEMPTS) return true;
  }
  return false;
}

function schedulePendingCleanupRetry(): void {
  if (pendingCleanupRetry || !hasRetryableCleanupDirectory()) return;
  for (const directory of pendingCleanupDirectories) {
    const attempts = cleanupRetryAttempts.get(directory) ?? 0;
    if (attempts < MAX_CLEANUP_RETRY_ATTEMPTS) cleanupRetryAttempts.set(directory, attempts + 1);
  }
  pendingCleanupRetry = setTimeout(() => {
    pendingCleanupRetry = undefined;
    try {
      drainPendingCleanupDirectories();
    } catch {
      // drainPendingCleanupDirectories already retained the paths and rescheduled another retry.
    }
  }, CLEANUP_RETRY_DELAY_MS);
}

function drainPendingCleanupDirectories(): void {
  const failures: unknown[] = [];
  for (const directory of Array.from(pendingCleanupDirectories)) {
    try {
      rmSync(directory, { recursive: true, force: true });
      pendingCleanupDirectories.delete(directory);
      cleanupRetryAttempts.delete(directory);
    } catch (error) {
      failures.push(error);
    }
  }
  if (pendingCleanupDirectories.size === 0 && pendingCleanupRetry) {
    clearTimeout(pendingCleanupRetry);
    pendingCleanupRetry = undefined;
  }
  if (failures.length > 0) {
    schedulePendingCleanupRetry();
    throw new AggregateError(failures, "Failed to clean materialized MCP resources");
  }
}

export function cleanupMaterializedBinaryResources(scope?: object): void {
  const session = scope ? scopedMaterializedResourceSessions.get(scope) : defaultMaterializedResourceSession;
  if (session?.directory) pendingCleanupDirectories.add(session.directory);
  if (session) {
    session.directory = undefined;
    session.bytes = 0;
    session.files = 0;
    session.sequence = 0;
    if (scope) scopedMaterializedResourceSessions.delete(scope);
  }

  drainPendingCleanupDirectories();
}

function replaceBlob(resource: BinaryResource, text: string): string {
  delete (resource as Partial<BinaryResource>).blob;
  resource.text = text;
  return text;
}

function omitBinaryResource(resource: BinaryResource, reason: string): string {
  return replaceBlob(resource, [
    `[Resource: ${resource.uri ?? "(no URI)"}]`,
    `Binary content omitted: ${reason}`,
    `MIME type: ${resource.mimeType ?? "application/octet-stream"}`,
  ].join("\n"));
}

function materializeBinaryResource(resource: BinaryResource, scope?: object): string {
  const session = getMaterializedResourceSession(scope);
  if (!session) return omitBinaryResource(resource, "runtime stopped");
  const decodedBytes = Buffer.byteLength(resource.blob, "base64");
  if (decodedBytes > MAX_BINARY_RESOURCE_BYTES) {
    return omitBinaryResource(resource, "decoded size exceeds 10 MiB");
  }
  if (
    session.bytes + decodedBytes > MAX_SESSION_RESOURCE_BYTES ||
    session.files >= MAX_SESSION_RESOURCE_FILES
  ) {
    return omitBinaryResource(resource, "session resource limit reached");
  }

  try {
    session.directory ??= mkdtempSync(join(tmpdir(), "pi-mcp-resource-"));
  } catch {
    return omitBinaryResource(resource, "could not be saved");
  }

  const filePath = join(session.directory, `resource-${++session.sequence}.bin`);
  session.bytes += decodedBytes;
  session.files += 1;
  try {
    writeFileSync(filePath, Buffer.from(resource.blob, "base64"), { flag: "wx", mode: 0o600 });
  } catch {
    try {
      rmSync(filePath, { force: true });
      session.bytes -= decodedBytes;
      session.files -= 1;
    } catch {
      // Keep the reservation when a partial file cannot be removed.
    }
    return omitBinaryResource(resource, "could not be saved");
  }

  return replaceBlob(resource, [
    `[Resource: ${resource.uri ?? "(no URI)"}]`,
    `Binary content saved to ${filePath}`,
    `MIME type: ${resource.mimeType ?? "application/octet-stream"}`,
  ].join("\n"));
}

/**
 * Transform MCP content types to Pi content blocks.
 */
export function transformMcpResourceContents(contents: McpResourceContent[], scope?: object): ContentBlock[] {
  return contents.map(resource => {
    if (typeof resource.text === "string") return { type: "text" as const, text: resource.text };
    if (typeof resource.blob === "string") return { type: "text" as const, text: materializeBinaryResource(resource as BinaryResource, scope) };
    return { type: "text" as const, text: JSON.stringify(resource) };
  });
}

export function transformMcpContent(content: McpContent[], scope?: object): ContentBlock[] {
  return content.map(c => {
    if (c.type === "text") {
      return { type: "text" as const, text: c.text ?? "" };
    }
    if (c.type === "image") {
      return {
        type: "image" as const,
        data: c.data ?? "",
        mimeType: c.mimeType ?? "image/png",
      };
    }
    if (c.type === "resource") {
      const resourceUri = c.resource?.uri ?? "(no URI)";
      if (c.resource && "blob" in c.resource && typeof c.resource.blob === "string") {
        const binaryResource = c.resource as typeof c.resource & { mimeType?: string; blob: string };
        return {
          type: "text" as const,
          text: materializeBinaryResource(binaryResource, scope),
        };
      }
      const resourceContent = c.resource?.text ?? (c.resource ? JSON.stringify(c.resource) : "(no content)");
      return {
        type: "text" as const,
        text: `[Resource: ${resourceUri}]\n${resourceContent}`,
      };
    }
    if (c.type === "resource_link") {
      const linkName = c.name ?? c.uri ?? "unknown";
      const linkUri = c.uri ?? "(no URI)";
      return {
        type: "text" as const,
        text: `[Resource Link: ${linkName}]\nURI: ${linkUri}`,
      };
    }
    if (c.type === "audio") {
      return {
        type: "text" as const,
        text: `[Audio content: ${c.mimeType ?? "audio/*"}]`,
      };
    }
    return { type: "text" as const, text: JSON.stringify(c) };
  });
}

/**
 * Resolve a tool result's content blocks, falling back to structuredContent
 * when content is empty.
 */
export function resolveMcpResultContent(result: Record<string, unknown>, scope?: object): ContentBlock[] {
  const blocks = transformMcpContent((Array.isArray(result.content) ? result.content : []) as McpContent[], scope);
  if (blocks.length > 0) return blocks;

  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return [{ type: "text" as const, text: stringifyStructuredContent(result.structuredContent) }];
  }

  return [];
}

function stringifyStructuredContent(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
