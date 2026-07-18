import {
  createMcpAdapter,
  type McpLaunchValues,
} from "pi-mcp-adapter/programmatic";

export interface SessionMcpContext {
  readonly id: string;
  readonly revision: string;
  resolveConnection(signal: AbortSignal): Promise<McpLaunchValues>;
  disposeConnection(values: McpLaunchValues): void | Promise<void>;
}

/** Create one isolated adapter instance for an SDK-managed Pi session. */
export function createSessionMcpAdapter(session: SessionMcpContext) {
  return createMcpAdapter({
    fileDiscovery: "disabled",
    initialSources: [{
      source: {
        identity: {
          id: `com.example.audit:${session.id}`,
          revision: session.revision,
        },
        servers: {
          audit: {
            transport: "streamable-http",
            requestTimeoutMs: 30_000,
          },
        },
      },
      launchValues: {
        resolve: (_request, signal) => session.resolveConnection(signal),
        dispose: (values) => session.disposeConnection(values),
      },
    }],
  });
}
