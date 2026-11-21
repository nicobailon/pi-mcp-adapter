import { format } from "node:util";
import { getAgentPath } from "./agent-dir.ts";
import { appendServerLogMessage } from "./server-log.ts";

const PREFIX = "[mcp-sdk] ";
// A global key, not module state: each Pi session can load its own copy of this module.
const PREVIOUS = Symbol.for("pi-mcp-adapter.sdkWarnings.previous");

type Warn = typeof console.warn & { [PREVIOUS]?: typeof console.warn };

/**
 * Sends the MCP SDK's `console.warn` lines to `<agent dir>/mcp.log` instead of the terminal, where they
 * would draw over Pi's TUI. The SDK has no logger option, so `console.warn` itself is wrapped.
 */
export function routeSdkWarningsToLog(): void {
  if ((console.warn as Warn)[PREVIOUS]) return;
  const previous = console.warn;
  const wrapper: Warn = (...args: unknown[]) => {
    if (typeof args[0] !== "string" || !args[0].startsWith(PREFIX)) return previous(...args);
    appendServerLogMessage(getAgentPath("mcp.log"), "mcp-sdk", { level: "warning", data: format(...args).slice(PREFIX.length) });
  };
  wrapper[PREVIOUS] = previous;
  console.warn = wrapper;
}

/** Undoes `routeSdkWarningsToLog`, unless something else has wrapped `console.warn` since. */
export function restoreSdkWarnings(): void {
  const previous = (console.warn as Warn)[PREVIOUS];
  if (previous) console.warn = previous;
}
