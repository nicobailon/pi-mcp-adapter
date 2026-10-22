import type { Client } from "@modelcontextprotocol/client";
import { throwIfAborted } from "./abort.ts";
import { canonicalPath } from "./executor-accounts.ts";
import { isExecutorConnection } from "./executor-pauses.ts";
import type { ServerConnection } from "./server-manager.ts";
import type { CachedExecutorAppTool, ServerCacheEntry } from "./types.ts";

/**
 * Most Executor app tools kept per server. Pi rebuilds its whole tool registry on every
 * registration, so registering N tools costs O(N²); paging stops here, which also bounds the
 * number of `search` calls.
 */
export const EXECUTOR_APP_TOOL_CAP = 1_000;
// Executor also ends a page at a byte budget (25,000 bytes by default), so a page usually holds fewer.
const SEARCH_PAGE_LIMIT = 200;

export type ExecutorCatalog = NonNullable<ServerCacheEntry["executorApps"]>;

interface SearchPage {
  items: CachedExecutorAppTool[];
  remaining: number;
  nextOffset: number | null;
  unavailableApps: string[];
}

/** An Executor path without its `tools.` prefix: `tools.github.issues.list` and `tools["github"].issues.list` both give `github.issues.list`. */
export function canonicalExecutorPath(path: string): string {
  return canonicalPath(path);
}

/** A model-mode Executor connection that also lists its app catalog with `search`. */
export function isExecutorCatalogConnection(conn: Pick<ServerConnection, "client" | "tools">): boolean {
  return isExecutorConnection(conn) && conn.tools.some(tool => tool.name === "search");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(detail: string): never {
  throw new Error(`Executor returned a malformed search page: ${detail}`);
}

function parseItem(item: unknown): CachedExecutorAppTool {
  if (!isRecord(item) || typeof item.path !== "string" || item.path.trim() === "") malformed("an item has no path");
  if (typeof item.description !== "string" || typeof item.input !== "string") malformed(`item "${item.path}" has no description or input type`);
  if (item.inputTruncated !== undefined && item.inputTruncated !== true) malformed(`item "${item.path}" has an invalid inputTruncated`);
  return {
    path: item.path,
    canonicalPath: canonicalPath(item.path),
    description: item.description,
    inputType: item.input,
    ...(item.inputTruncated === true ? { inputTruncated: true as const } : {}),
  };
}

// Executor's SearchToolResult (contracts/execute.ts). `namespaces` is checked but not kept: its
// `accounts` labels name the caller's linked accounts.
function parseSearchPage(result: unknown, offset: number): SearchPage {
  if (!isRecord(result)) malformed("not a tool result");
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.map(block => isRecord(block) && typeof block.text === "string" ? block.text : "").join(" ").trim();
    throw new Error(`Executor search failed${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  const page = result.structuredContent;
  if (!isRecord(page)) malformed("no structuredContent");
  if (!Array.isArray(page.items)) malformed("items is not an array");
  if (!Array.isArray(page.namespaces)) malformed("namespaces is not an array");
  if (!Number.isSafeInteger(page.remaining) || (page.remaining as number) < 0) malformed("remaining is not a non-negative integer");
  let nextOffset: number | null = null;
  if (page.next !== null) {
    const next = page.next;
    if (!isRecord(next) || !Number.isSafeInteger(next.offset) || (next.offset as number) <= offset) {
      malformed("next is neither null nor a later page");
    }
    nextOffset = next.offset as number;
  }
  if (!Array.isArray(page.unavailableApps)) malformed("unavailableApps is not an array");
  const unavailableApps = page.unavailableApps.map(app => {
    if (!isRecord(app) || typeof app.name !== "string" || (app.router !== undefined && typeof app.router !== "string")) {
      malformed("an unavailable app has no name");
    }
    return app.router === undefined ? app.name : `${app.name} (${app.router})`;
  });
  return { items: page.items.map(parseItem), remaining: page.remaining as number, nextOffset, unavailableApps };
}

/**
 * Pages an Executor server's whole app catalog with `search` (empty query, which lists every tool
 * in app and name order) until the last page or `EXECUTOR_APP_TOOL_CAP`. Any malformed page
 * throws, so the caller never gets part of a catalog.
 */
export async function fetchExecutorCatalog({ client, signal }: {
  client: Pick<Client, "callTool">;
  signal?: AbortSignal;
}): Promise<ExecutorCatalog> {
  const tools: CachedExecutorAppTool[] = [];
  const paths = new Set<string>();
  const unavailableApps = new Set<string>();
  for (let offset = 0; ;) {
    throwIfAborted(signal);
    const limit = Math.min(SEARCH_PAGE_LIMIT, EXECUTOR_APP_TOOL_CAP - tools.length);
    const result = await client.callTool({ name: "search", arguments: { query: "", limit, offset } }, signal ? { signal } : undefined);
    const page = parseSearchPage(result, offset);
    for (const item of page.items) {
      if (tools.length === EXECUTOR_APP_TOOL_CAP) break;
      // A catalog that changes between pages can repeat a tool; the first listing wins.
      if (paths.has(item.path)) continue;
      paths.add(item.path);
      tools.push(item);
    }
    for (const app of page.unavailableApps) unavailableApps.add(app);
    if (page.nextOffset === null || tools.length === EXECUTOR_APP_TOOL_CAP) {
      return {
        tools,
        total: offset + page.items.length + page.remaining,
        cap: EXECUTOR_APP_TOOL_CAP,
        fetchedAt: Date.now(),
        ...(unavailableApps.size > 0 ? { unavailableApps: [...unavailableApps] } : {}),
      };
    }
    // Executor ends a page at its byte budget, so only its own next offset is right.
    offset = page.nextOffset;
  }
}
