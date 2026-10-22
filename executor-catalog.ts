import type { Client } from "@modelcontextprotocol/client";
import { throwIfAborted } from "./abort.ts";
import { canonicalPath } from "./executor-accounts.ts";
import { hasExecutorModelTools, isExecutorConnection } from "./executor-pauses.ts";
import type { ServerConnection } from "./server-manager.ts";
import { EXECUTOR_APP_TOOL_CAP, type CachedExecutorAppTool, type ServerCacheEntry } from "./types.ts";

// Paging stops at the cap, which also bounds the number of `search` calls.
export { EXECUTOR_APP_TOOL_CAP };
/** How long a cached Executor app catalog is used before a connect pages it again in the background. */
export const EXECUTOR_CATALOG_TTL_MS = 3_600_000;
// Executor also ends a page at a byte budget (25,000 bytes by default), so a page usually holds fewer.
const SEARCH_PAGE_LIMIT = 200;

export type ExecutorCatalog = NonNullable<ServerCacheEntry["executorApps"]>;
type UnavailableApp = NonNullable<ExecutorCatalog["unavailableApps"]>[number];

interface SearchPage {
  items: CachedExecutorAppTool[];
  remaining: number;
  nextOffset: number | null;
  unavailableApps: UnavailableApp[];
}

/** A model-mode Executor connection that also lists its app catalog with `search`. */
export function isExecutorCatalogConnection(conn: Pick<ServerConnection, "client" | "tools">): boolean {
  return isExecutorConnection(conn) && conn.tools.some(tool => tool.name === "search");
}

/** A cached listing with the tools of a model-mode Executor that lists its app catalog with `search`. */
export function isExecutorCatalogEntry(entry: Pick<ServerCacheEntry, "tools">): boolean {
  const tools = entry.tools ?? [];
  return hasExecutorModelTools(tools) && tools.some(tool => tool.name === "search");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(detail: string): never {
  throw new Error(`Executor returned a malformed search page: ${detail}`);
}

// The text of an error tool result, as `: <text>`, or "".
function errorText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map(block => isRecord(block) && typeof block.text === "string" ? block.text : "").join(" ").trim();
  return text ? `: ${text.slice(0, 300)}` : "";
}

function parseItem(item: unknown): CachedExecutorAppTool {
  if (!isRecord(item) || typeof item.path !== "string" || item.path.trim() === "") malformed("an item has no path");
  if (typeof item.description !== "string" || typeof item.input !== "string") malformed(`item "${item.path}" has no description or input type`);
  if (item.inputTruncated !== undefined && item.inputTruncated !== true) malformed(`item "${item.path}" has an invalid inputTruncated`);
  const canonical = canonicalPath(item.path);
  if (canonical === "") malformed(`item "${item.path}" names no tool`);
  return {
    path: item.path,
    canonicalPath: canonical,
    description: item.description,
    inputType: item.input,
    ...(item.inputTruncated === true ? { inputTruncated: true as const } : {}),
  };
}

// Executor's SearchToolResult (contracts/execute.ts). `namespaces` is checked but not kept: its
// `accounts` labels name the caller's linked accounts.
function parseSearchPage(result: unknown, offset: number): SearchPage {
  if (!isRecord(result)) malformed("not a tool result");
  if (result.isError === true) throw new Error(`Executor search failed${errorText(result)}`);
  const page = result.structuredContent;
  if (!isRecord(page)) malformed("no structuredContent");
  if (!Array.isArray(page.items)) malformed("items is not an array");
  if (!Array.isArray(page.namespaces)) malformed("namespaces is not an array");
  if (!Number.isSafeInteger(page.remaining) || (page.remaining as number) < 0) malformed("remaining is not a non-negative integer");
  let nextOffset: number | null = null;
  if (page.next !== null) {
    const next = page.next;
    if (!isRecord(next) || !Number.isSafeInteger(next.offset)) malformed("next is neither null nor a later page");
    // Executor repeats the offset with no items when it lost a listing mid-search; that ends the catalog.
    if (next.offset === offset && page.items.length === 0) nextOffset = null;
    else if ((next.offset as number) <= offset) malformed("next is neither null nor a later page");
    else nextOffset = next.offset as number;
  }
  if (!Array.isArray(page.unavailableApps)) malformed("unavailableApps is not an array");
  const unavailableApps = page.unavailableApps.map(app => {
    if (!isRecord(app) || typeof app.name !== "string" || (app.router !== undefined && typeof app.router !== "string")
      || (app.reason !== undefined && typeof app.reason !== "string")) {
      malformed("an unavailable app has no name");
    }
    const name = app.router === undefined ? app.name : `${app.name} (${app.router})`;
    const reason = app.reason === undefined ? undefined : unavailableReason(app.reason);
    return reason ? { name, reason } : { name };
  });
  return { items: page.items.map(parseItem), remaining: page.remaining as number, nextOffset, unavailableApps };
}

// Executor sends the reason as its error response in JSON; its `message` is the readable part.
function unavailableReason(reason: string): string {
  try {
    const parsed: unknown = JSON.parse(reason);
    if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message.slice(0, 300);
  } catch {
    // Not JSON: the reason is already text.
  }
  return reason.slice(0, 300);
}

/**
 * Pages an Executor server's whole app catalog with `search` (empty query, which lists every tool
 * in app and name order) until the last page or `EXECUTOR_APP_TOOL_CAP` app tools. Only tools
 * `isAppTool` accepts are kept and take a cap slot. `total` counts the catalog's tools minus the
 * ones skipped on the pages read. Any malformed page throws, so the caller never gets part of a
 * catalog.
 */
export async function fetchExecutorCatalog({ client, signal, timeout, isAppTool }: {
  client: Pick<Client, "callTool">;
  signal?: AbortSignal;
  /** The per-request timeout, in milliseconds. */
  timeout?: number;
  isAppTool: (tool: CachedExecutorAppTool) => boolean;
}): Promise<ExecutorCatalog> {
  const tools: CachedExecutorAppTool[] = [];
  const paths = new Set<string>();
  const unavailableApps = new Map<string, UnavailableApp>();
  let skipped = 0;
  for (let offset = 0, pages = 0; ;) {
    throwIfAborted(signal);
    if (++pages > EXECUTOR_APP_TOOL_CAP) malformed("more pages than the cap allows");
    const limit = Math.min(SEARCH_PAGE_LIMIT, EXECUTOR_APP_TOOL_CAP - tools.length);
    // Straight to the client, not through withSessionRecovery or a task session: `search` needs no server-to-client leg.
    const result = await client.callTool({ name: "search", arguments: { query: "", limit, offset } }, { ...(signal ? { signal } : {}), ...(timeout ? { timeout } : {}) });
    const page = parseSearchPage(result, offset);
    for (const item of page.items) {
      if (tools.length === EXECUTOR_APP_TOOL_CAP) break;
      // A catalog that changes between pages can repeat a tool; the first listing wins.
      if (paths.has(item.path) || !isAppTool(item)) {
        skipped++;
        continue;
      }
      paths.add(item.path);
      tools.push(item);
    }
    for (const app of page.unavailableApps) if (!unavailableApps.has(app.name)) unavailableApps.set(app.name, app);
    if (page.nextOffset === null || tools.length === EXECUTOR_APP_TOOL_CAP) {
      return {
        tools,
        total: offset + page.items.length + page.remaining - skipped,
        cap: EXECUTOR_APP_TOOL_CAP,
        fetchedAt: Date.now(),
        ...(unavailableApps.size > 0 ? { unavailableApps: [...unavailableApps.values()] } : {}),
      };
    }
    // Executor ends a page at its byte budget, so only its own next offset is right.
    offset = page.nextOffset;
  }
}

export type ExecutorDescribeAnswer = { signature: string } | { missing: true; matches: string[] };

/**
 * One Executor `describe` for one app tool: its full TypeScript signature, or Executor's word that
 * it has no such tool, with the paths it suggests instead. Any other shape throws.
 */
export async function describeExecutorAppTool({ client, path, signal, timeout }: {
  client: Pick<Client, "callTool">;
  path: string;
  signal?: AbortSignal;
  timeout?: number;
}): Promise<ExecutorDescribeAnswer> {
  const result: unknown = await client.callTool({ name: "describe", arguments: { paths: [path] } }, { ...(signal ? { signal } : {}), ...(timeout ? { timeout } : {}) });
  const fail: (detail: string) => never = detail => {
    throw new Error(`Executor returned a malformed describe answer for ${path}: ${detail}`);
  };
  if (!isRecord(result)) fail("not a tool result");
  if (result.isError === true) throw new Error(`Executor describe failed for ${path}${errorText(result)}`);
  const answer = result.structuredContent;
  if (!isRecord(answer) || !Array.isArray(answer.items) || !Array.isArray(answer.missing)) fail("no items or missing list");
  const wanted = canonicalPath(path);
  for (const item of answer.items as unknown[]) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.signature !== "string") fail("an item has no path or signature");
    if (canonicalPath(item.path) === wanted) return { signature: item.signature };
  }
  for (const entry of answer.missing as unknown[]) {
    if (!isRecord(entry) || typeof entry.path !== "string") fail("a missing entry has no path");
    const matches = entry.matches ?? [];
    if (!Array.isArray(matches) || matches.some(match => typeof match !== "string")) fail("matches is not a list of paths");
    if (canonicalPath(entry.path) === wanted) return { missing: true, matches: (matches as string[]).map(canonicalPath) };
  }
  return fail("the tool is neither described nor missing");
}
