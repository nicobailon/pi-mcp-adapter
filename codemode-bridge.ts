import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * The one place that knows how the adapter reaches Pi's codemode.
 *
 * Pi registers codemode as `exposure: "model-only"`, so `ctx.executeTool("codemode", …)` always
 * returns "Tool codemode not found". Instead, the adapter runs Pi's public `createCodemodeExtension()`
 * factory against a shim `pi` that captures the definition it registers, and calls that definition's
 * `execute` with the calling tool's own context. Inner `tools.*` calls are then ordinary nested calls of
 * the calling tool. The adapter never evaluates script source itself.
 */

export const CODEMODE_UNAVAILABLE = "codemode_unavailable";

/** The members Pi's codemode factory reads from `pi`. Reading any other member means Pi changed. */
type ShimMembers = Pick<ExtensionAPI, "registerTool" | "getSettings" | "getAllTools" | "appendEntry">;

interface Capture {
  definition: ToolDefinition | undefined;
  /** Set when codemode reads a `pi` member the shim does not provide, at capture or at run time. */
  violation: boolean;
}

const OPTIONS_PREFIX = "// @options:";

// One capture per adapter install (per `pi`). A failed capture is never kept.
const captures = new WeakMap<object, Promise<Capture | undefined>>();

/**
 * Put the validated arguments in front of a script as `const input = …;`. The arguments are
 * stringified twice, so they reach the sandbox as one escaped string literal that `JSON.parse` turns
 * back into the same value. A leading `// @options:` line stays first, where codemode reads it.
 */
export function buildCodemodeSource(input: Record<string, unknown>, source: string): string {
  const inputLine = `const input = JSON.parse(${JSON.stringify(JSON.stringify(input))});`;
  // Detects the options line the way codemode does: the first line, ignoring leading whitespace.
  const newline = source.indexOf("\n");
  const firstLine = newline === -1 ? source : source.slice(0, newline);
  if (!firstLine.trimStart().startsWith(OPTIONS_PREFIX)) return `${inputLine}\n${source}`;
  const rest = newline === -1 ? "" : source.slice(newline + 1);
  // An options line with no script after it: leave it to codemode to report.
  if (rest.trim() === "") return source;
  return `${firstLine}\n${inputLine}\n${rest}`;
}

export interface RunCodemodeScriptOptions {
  pi: ExtensionAPI;
  ctx: ExtensionToolContext;
  toolCallId: string;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  /** The script tool's name, used in the error message. */
  tool: string;
  source: string;
  input: Record<string, unknown>;
}

/**
 * Run `source` in Pi's codemode sandbox as a nested run of the calling tool, with `input` defined.
 * Returns codemode's own result, or a `codemode_unavailable` result when this Pi does not expose
 * codemode to extensions.
 */
export async function runCodemodeScript(options: RunCodemodeScriptOptions): Promise<AgentToolResult<unknown>> {
  const { pi, ctx, toolCallId, signal, onUpdate, tool, source, input } = options;
  let pending = captures.get(pi);
  if (!pending) {
    pending = captureCodemode(pi);
    captures.set(pi, pending);
  }
  const capture = await pending;
  if (!capture?.definition) {
    if (captures.get(pi) === pending) captures.delete(pi);
    return codemodeUnavailable(tool);
  }
  // Once the script has started, its own result or error is what happened, so it is returned as is.
  try {
    return await capture.definition.execute(toolCallId, { code: buildCodemodeSource(input, source) }, signal, onUpdate, ctx);
  } finally {
    // Codemode read a member the shim does not provide: the definition is stale, re-capture next call.
    if (capture.violation && captures.get(pi) === pending) captures.delete(pi);
  }
}

function codemodeUnavailable(tool: string): AgentToolResult<unknown> {
  const message = `Script tool "${tool}" cannot run: this Pi build does not expose codemode to extensions. Update Pi to 0.99.0 or later.`;
  return {
    content: [{ type: "text", text: message }],
    details: { mode: "script_tool", tool, error: CODEMODE_UNAVAILABLE },
  };
}

function warnUnavailable(error: unknown): void {
  console.warn(`MCP: codemode is unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

async function captureCodemode(pi: ExtensionAPI): Promise<Capture | undefined> {
  // Loaded on the first script run, never at adapter startup.
  let factory: unknown;
  try {
    factory = (await import("@earendil-works/pi-coding-agent") as { createCodemodeExtension?: unknown }).createCodemodeExtension;
  } catch (error) {
    warnUnavailable(error);
    return undefined;
  }
  if (typeof factory !== "function") return undefined;

  const capture: Capture = { definition: undefined, violation: false };
  let open = true;
  const members: ShimMembers = {
    registerTool: (tool) => {
      if (open && !capture.definition && tool.name === "codemode") capture.definition = tool as unknown as ToolDefinition;
    },
    getSettings: () => pi.getSettings(),
    getAllTools: () => pi.getAllTools(),
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
  };
  const shim = new Proxy(members, {
    get(target, key) {
      if (typeof key === "string" && Object.hasOwn(target, key)) return target[key as keyof ShimMembers];
      capture.violation = true;
      throw new Error(`Pi's codemode read pi.${String(key)}, which the adapter does not provide`);
    },
  });
  try {
    (factory as () => (pi: unknown) => unknown)()(shim);
  } catch (error) {
    warnUnavailable(error);
    return undefined;
  } finally {
    open = false;
  }
  if (capture.violation || typeof capture.definition?.execute !== "function") return undefined;
  return capture;
}
