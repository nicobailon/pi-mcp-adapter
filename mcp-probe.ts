const PROBE_TIMEOUT_MS = 5_000;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const JSON_ACCEPT = "application/json, text/event-stream";
const SSE_ACCEPT = "text/event-stream";
const MODERN_FALLBACK_STATUSES = new Set([400, 401, 404, 405, 406, 415]);
const POST_ENDPOINT_MISMATCH_STATUSES = new Set([404, 405, 406, 415]);

export interface McpProbeResult {
  isMcp: boolean;
  classification: string;
}

const DISCOVER_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: {},
};

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "pi-mcp-probe", version: "2.1.2" },
  },
};

type ProbeStrategy =
  | { kind: "modern"; request: RequestInit; allowJson: true }
  | { kind: "legacy-post"; request: RequestInit; allowJson: true }
  | { kind: "legacy-sse"; request: RequestInit; allowJson: false };

const MODERN_STRATEGY: ProbeStrategy = {
  kind: "modern",
  request: {
    method: "POST",
    headers: {
      Accept: JSON_ACCEPT,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      "Mcp-Method": "server/discover",
    },
    body: JSON.stringify(DISCOVER_REQUEST),
  },
  allowJson: true,
};

const LEGACY_POST_STRATEGY: ProbeStrategy = {
  kind: "legacy-post",
  request: {
    method: "POST",
    headers: {
      Accept: JSON_ACCEPT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(INITIALIZE_REQUEST),
  },
  allowJson: true,
};

const LEGACY_SSE_STRATEGY: ProbeStrategy = {
  kind: "legacy-sse",
  request: { headers: { Accept: SSE_ACCEPT } },
  allowJson: false,
};

type JsonRpcEnvelopeInfo =
  | { kind: "result"; protocolVersion: unknown }
  | { kind: "error" };

type ProbeOutcome =
  | { kind: "mcp"; result: McpProbeResult }
  | { kind: "unsupported-modern" }
  | { kind: "unrecognized" };

interface ProbeResult {
  response: Response;
  outcome: ProbeOutcome;
}

function jsonRpcEnvelopeInfo(value: unknown): JsonRpcEnvelopeInfo | null {
  if (typeof value !== "object" || value === null || (value as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    return null;
  }
  if ("result" in value) {
    const result = (value as { result?: unknown }).result;
    return {
      kind: "result",
      protocolVersion: typeof result === "object" && result !== null
        ? (result as { protocolVersion?: unknown }).protocolVersion
        : undefined,
    };
  }
  if ("error" in value) return { kind: "error" };
  return null;
}

function isBearerChallenge(response: Response): boolean {
  return /(?:^|,)\s*Bearer\b/i.test(response.headers.get("www-authenticate") ?? "");
}

function responseKind(response: Response): string {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "text/html") return "HTML";
  if (contentType) return contentType;
  return "an untyped response";
}

async function getJsonRpcEnvelopeInfo(response: Response): Promise<JsonRpcEnvelopeInfo | null> {
  try {
    return jsonRpcEnvelopeInfo(JSON.parse(await response.text()));
  } catch {
    return null;
  }
}

async function classifyResponse(response: Response, strategy: ProbeStrategy): Promise<ProbeOutcome> {
  const isSse = response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
  if (response.ok && isSse) {
    return { kind: "mcp", result: { isMcp: true, classification: "endpoint responded with an MCP event stream" } };
  }

  const envelope = (strategy.allowJson || response.status === 401) ? await getJsonRpcEnvelopeInfo(response) : null;
  if (response.ok && strategy.allowJson && envelope) {
    if (strategy.kind === "modern" && (envelope.kind === "error" || envelope.protocolVersion !== MODERN_PROTOCOL_VERSION)) {
      return { kind: "unsupported-modern" };
    }
    return {
      kind: "mcp",
      result: {
        isMcp: true,
        classification: strategy.kind === "modern"
          ? `endpoint supports stateless MCP ${MODERN_PROTOCOL_VERSION} server/discover`
          : "endpoint responded with a JSON-RPC 2.0 envelope",
      },
    };
  }
  if (response.status === 401 && isBearerChallenge(response) && envelope) {
    return {
      kind: "mcp",
      result: {
        isMcp: true,
        classification: strategy.kind === "modern"
          ? `endpoint requires Bearer authentication during MCP ${MODERN_PROTOCOL_VERSION} server/discover probing`
          : "endpoint requires Bearer authentication and responded with a JSON-RPC 2.0 error",
      },
    };
  }

  return { kind: "unrecognized" };
}

async function probe(url: string | URL, strategy: ProbeStrategy): Promise<ProbeResult> {
  const response = await fetch(url, {
    ...strategy.request,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return { response, outcome: await classifyResponse(response, strategy) };
}

function notMcp(response: Response): McpProbeResult {
  return {
    isMcp: false,
    classification: `endpoint returned ${responseKind(response)} (${response.status}) — this URL does not appear to speak MCP`,
  };
}

/** Makes one unauthenticated metadata-only request to identify an HTTP endpoint's protocol shape. */
export async function probeMcpEndpoint(url: string | URL): Promise<McpProbeResult> {
  const { response: modernResponse, outcome: modernOutcome } = await probe(url, MODERN_STRATEGY);
  if (modernOutcome.kind === "mcp") return modernOutcome.result;

  if (modernOutcome.kind !== "unsupported-modern" && !MODERN_FALLBACK_STATUSES.has(modernResponse.status)) {
    return notMcp(modernResponse);
  }

  const { response: postResponse, outcome: postOutcome } = await probe(url, LEGACY_POST_STRATEGY);
  if (postOutcome.kind === "mcp") return postOutcome.result;
  if (!POST_ENDPOINT_MISMATCH_STATUSES.has(postResponse.status)) return notMcp(postResponse);

  const { response: getResponse, outcome: getOutcome } = await probe(url, LEGACY_SSE_STRATEGY);
  return getOutcome.kind === "mcp" ? getOutcome.result : notMcp(getResponse);
}
