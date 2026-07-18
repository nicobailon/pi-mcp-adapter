import mcpAdapter from "./index.ts";
import { registerProgrammaticExtension } from "./programmatic-extension.ts";
import { ProgrammaticMcpRuntime } from "./programmatic-runtime.ts";
import type { McpAdapterInstance, McpAdapterOptions } from "./programmatic-types.ts";

/**
 * Create an MCP adapter with an exported, source-qualified lifecycle.
 *
 * Initial sources are synchronously validated and installed before the returned
 * extension can register any Pi tool. `fileDiscovery: "disabled"` is the
 * isolated composition mode: it never invokes the standalone file extension,
 * reads MCP files/imports, or loads the shared metadata cache. The default
 * remains `"enabled"`, preserving the ordinary extension and CLI behavior.
 */
export function createMcpAdapter(options: McpAdapterOptions = {}): McpAdapterInstance {
  const fileDiscovery = options.fileDiscovery ?? "enabled";
  if (fileDiscovery !== "enabled" && fileDiscovery !== "disabled") {
    throw new TypeError("fileDiscovery must be enabled or disabled");
  }

  const runtime = new ProgrammaticMcpRuntime({ fileDiscovery });
  runtime.installInitialSources(options.initialSources ?? []);

  return Object.freeze({
    runtime,
    extension(pi) {
      if (fileDiscovery === "enabled") {
        mcpAdapter(pi);
        registerProgrammaticExtension(pi, runtime, "mcp_sources");
      } else {
        registerProgrammaticExtension(pi, runtime, "mcp");
      }
    },
  });
}

export type {
  JsonValue,
  McpAdapterInstance,
  McpAdapterOptions,
  McpConfigSource,
  McpDiagnostic,
  McpInitialSource,
  McpLaunchValueProvider,
  McpLaunchValueRequest,
  McpLaunchValues,
  McpProgrammaticRuntime,
  McpRuntimeCapabilities,
  McpRuntimeLease,
  McpRuntimeLeaseProvider,
  McpRuntimeServerBinding,
  McpSourceIdentity,
  McpSourcePrecondition,
  McpSourceRemoveResult,
  McpSourceReplaceRequest,
  McpSourceReplaceResult,
  McpSourceServer,
  McpSourceTransport,
  McpSourceServerStatus,
  McpSourceStatus,
  McpSourceValidationResult,
} from "./programmatic-types.ts";
