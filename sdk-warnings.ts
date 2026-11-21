import { format } from "node:util";
import { getAgentPath } from "./agent-dir.ts";
import { appendServerLogMessage } from "./server-log.ts";

const PREFIX = "[mcp-sdk] ";
// A global key, not module state: each Pi session can load its own copy of this module.
const ROUTE = Symbol.for("pi-mcp-adapter.sdkWarnings");

type Route = { sessions: number; previous: typeof console.warn; wrapper: typeof console.warn };
const holder = globalThis as { [ROUTE]?: Route };

/**
 * Sends the MCP SDK's `console.warn` lines to `<agent dir>/mcp.log` instead of the terminal, where they
 * would draw over Pi's TUI. The SDK has no logger option, so `console.warn` itself is wrapped.
 * The wrapper stays while any session that asked for it is alive; call the returned function once when
 * that session ends.
 */
export function routeSdkWarningsToLog(): () => void {
  let route = holder[ROUTE];
  if (!route) {
    const previous = console.warn;
    const wrapper = (...args: unknown[]) => {
      if (typeof args[0] !== "string" || !args[0].startsWith(PREFIX)) return previous(...args);
      appendServerLogMessage(getAgentPath("mcp.log"), "mcp-sdk", { level: "warning", data: format(...args).slice(PREFIX.length) });
    };
    route = holder[ROUTE] = { sessions: 0, previous, wrapper };
    console.warn = wrapper;
  }
  route.sessions++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--route.sessions > 0) return;
    delete holder[ROUTE];
    // Leave a wrapper someone else installed on top of ours in place.
    if (console.warn === route.wrapper) console.warn = route.previous;
  };
}
