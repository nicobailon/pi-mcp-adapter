const PROBE_TIMEOUT_MS = 5_000;

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
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pi-mcp-probe", version: "2.1.2" },
  },
};

interface JsonRpcEnvelopeInfo {
  kind: "result" | "error";
  protocolVersion?: unknown;
}

type ProbeClassification = McpProbeResult | { unsupportedModern: true } | null;

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

async function classifyResponse(
  response: Response,
  allowJson: boolean,
  isModernProbe = false,
): Promise<ProbeClassification> {
  const isSse = response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
  if (response.ok && isSse) {
    return { isMcp: true, classification: "endpoint responded with an MCP event stream" };
  }

  const envelope = (allowJson || response.status === 401) ? await getJsonRpcEnvelopeInfo(response) : null;
  if (response.ok && allowJson && envelope) {
    if (isModernProbe && (envelope.kind === "error" || envelope.protocolVersion !== "2026-07-28")) {
      return { unsupportedModern: true };
    }
    return {
      isMcp: true,
      classification: isModernProbe
        ? "endpoint supports stateless MCP 2026-07-28 server/discover"
        : "endpoint responded with a JSON-RPC 2.0 envelope",
    };
  }
  if (response.status === 401 && isBearerChallenge(response) && envelope) {
    return {
      isMcp: true,
      classification: isModernProbe
        ? "endpoint requires Bearer authentication during MCP 2026-07-28 server/discover probing"
        : "endpoint requires Bearer authentication and responded with a JSON-RPC 2.0 error",
    };
  }

  return null;
}

function isMcpProbeResult(classification: ProbeClassification): classification is McpProbeResult {
  return classification !== null && !("unsupportedModern" in classification);
}

function notMcp(response: Response): McpProbeResult {
  return {
    isMcp: false,
    classification: `endpoint returned ${responseKind(response)} (${response.status}) — this URL does not appear to speak MCP`,
  };
}

/** Makes one unauthenticated metadata-only request to identify an HTTP endpoint's protocol shape. */
export async function probeMcpEndpoint(url: string | URL): Promise<McpProbeResult> {
  const modernResponse = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "server/discover",
    },
    body: JSON.stringify(DISCOVER_REQUEST),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const modernClassification = await classifyResponse(modernResponse, true, true);
  if (isMcpProbeResult(modernClassification)) return modernClassification;

  if (!modernClassification && ![400, 401, 404, 405, 406, 415].includes(modernResponse.status)) return notMcp(modernResponse);

  const postResponse = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(INITIALIZE_REQUEST),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const postClassification = await classifyResponse(postResponse, true);
  if (isMcpProbeResult(postClassification)) return postClassification;

  if (![404, 405, 406, 415].includes(postResponse.status)) return notMcp(postResponse);

  const getResponse = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const getClassification = await classifyResponse(getResponse, false);
  return isMcpProbeResult(getClassification) ? getClassification : notMcp(getResponse);
}
