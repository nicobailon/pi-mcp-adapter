import type { ClientOptions } from "@modelcontextprotocol/client";
import type { ProtocolMode, ServerDefinition } from "./types.ts";

export const MCP_2026_PROTOCOL_VERSION = "2026-07-28" as const;
export const DEFAULT_MCP_LIST_MAX_PAGES = 64;
export const DEFAULT_MCP_INPUT_REQUIRED_MAX_ROUNDS = 5;

const PROTOCOL_MODES = new Set<ProtocolMode>([
  "auto",
  "legacy",
  MCP_2026_PROTOCOL_VERSION,
]);

type ManagedClientOptions = Pick<
  ClientOptions,
  "capabilities" | "jsonSchemaValidator" | "listChanged"
>;

/** Build protocol-sensitive SDK options in one place for every managed client. */
export function buildManagedClientOptions(
  definition: ServerDefinition,
  requestTimeoutMs: number | undefined,
  options: ManagedClientOptions,
): ClientOptions {
  const protocolMode = resolveProtocolMode(definition);
  const mode = protocolMode === MCP_2026_PROTOCOL_VERSION
    ? { pin: MCP_2026_PROTOCOL_VERSION } as const
    : protocolMode;

  return {
    ...options,
    versionNegotiation: {
      mode,
      probe: {
        ...(requestTimeoutMs !== undefined ? { timeoutMs: requestTimeoutMs } : {}),
        maxRetries: 0,
      },
    },
    inputRequired: {
      autoFulfill: true,
      maxRounds: DEFAULT_MCP_INPUT_REQUIRED_MAX_ROUNDS,
    },
    listMaxPages: DEFAULT_MCP_LIST_MAX_PAGES,
  };
}

export function resolveProtocolMode(definition: ServerDefinition): ProtocolMode {
  const configuredMode = definition.protocolMode;
  if (configuredMode === undefined) {
    return definition.socket ? "legacy" : "auto";
  }
  if (!PROTOCOL_MODES.has(configuredMode)) {
    throw new Error(
      `Invalid protocolMode "${String(configuredMode)}"; expected auto, legacy, or ${MCP_2026_PROTOCOL_VERSION}`,
    );
  }
  if (definition.socket && configuredMode !== "legacy") {
    throw new Error('Unix socket servers are legacy-only; protocolMode must be "legacy"');
  }
  return configuredMode;
}
