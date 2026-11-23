import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { abortable, throwIfAborted } from "./abort.js";
import { combineAbortSignals } from "./runtime-owner.js";
const PROBE_TIMEOUT_MS = 5_000;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const JSON_ACCEPT = "application/json, text/event-stream";
const SSE_ACCEPT = "text/event-stream";
const MODERN_FALLBACK_STATUSES = new Set([400, 401, 404, 405, 406, 415]);
const POST_ENDPOINT_MISMATCH_STATUSES = new Set([404, 405, 406, 415]);
const AMBIGUOUS_STATUSES = new Set([202, 401, 503]);
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
const LEGACY_POST_STRATEGY = {
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
const LEGACY_SSE_STRATEGY = {
    kind: "legacy-sse",
    request: { headers: { Accept: SSE_ACCEPT } },
    allowJson: false,
};
function jsonRpcEnvelopeInfo(value) {
    if (typeof value !== "object" || value === null || value.jsonrpc !== "2.0") {
        return null;
    }
    if ("result" in value) {
        return { kind: "result" };
    }
    if ("error" in value)
        return { kind: "error" };
    return null;
}
function isBearerChallenge(response) {
    return /(?:^|,)\s*Bearer\b/i.test(response.headers.get("www-authenticate") ?? "");
}
function responseKind(response) {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType === "text/html")
        return "HTML";
    if (contentType)
        return contentType;
    return "an untyped response";
}
async function getJsonRpcEnvelopeInfo(response) {
    try {
        return jsonRpcEnvelopeInfo(JSON.parse(await response.text()));
    }
    catch {
        return null;
    }
}
async function classifyResponse(response, strategy) {
    const isSse = response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
    if (response.ok && isSse) {
        return { kind: "mcp", result: { isMcp: true, classification: "endpoint responded with an MCP event stream" } };
    }
    const envelope = (strategy.allowJson || response.status === 401) ? await getJsonRpcEnvelopeInfo(response) : null;
    if (response.ok && strategy.allowJson && envelope) {
        return {
            kind: "mcp",
            result: {
                isMcp: true,
                classification: "endpoint responded with a JSON-RPC 2.0 envelope",
            },
        };
    }
    if (response.status === 401 && isBearerChallenge(response) && envelope) {
        return {
            kind: "mcp",
            result: {
                isMcp: true,
                classification: "endpoint requires Bearer authentication and responded with a JSON-RPC 2.0 error",
            },
        };
    }
    return { kind: "unrecognized" };
}
async function probe(url, strategy, signal) {
    throwIfAborted(signal);
    const response = await fetch(url, {
        ...strategy.request,
        signal: combineAbortSignals(signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)),
        credentials: "omit",
        redirect: "error",
    });
    return { response, outcome: await classifyResponse(response, strategy) };
}
function notMcp(response) {
    const responseDescription = `endpoint returned ${responseKind(response)} (${response.status})`;
    return {
        isMcp: false,
        classification: response.status === 503
            ? `${responseDescription} — server is temporarily unavailable; MCP endpoint shape could not be determined`
            : response.status === 202
                ? `${responseDescription} — MCP endpoint shape could not be determined`
                : response.status === 401
                    ? `${responseDescription} — authentication may be required; MCP endpoint shape could not be determined`
                    : `${responseDescription} — this URL does not appear to speak MCP`,
    };
}
function ambiguousNotMcp(response) {
    return AMBIGUOUS_STATUSES.has(response.status) ? notMcp(response) : undefined;
}
// Use the same pinned SDK negotiation as a real connection. The SDK owns the
// request envelope and discovery validation (including supportedVersions and
// resultType); a diagnostic must not implement a second modern wire protocol.
async function probeModern(url, signal) {
    throwIfAborted(signal);
    const ownedSignal = combineAbortSignals(signal, AbortSignal.timeout(PROBE_TIMEOUT_MS));
    let response;
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        fetch: async (input, init) => {
            const result = await fetch(input, {
                ...init,
                signal: combineAbortSignals(ownedSignal, init?.signal ?? undefined),
                credentials: "omit",
                redirect: "error",
            });
            // Retain status/headers only, without cloning or buffering a stream.
            response = new Response(null, { status: result.status, headers: result.headers });
            return result;
        },
    });
    const client = new Client({ name: "pi-mcp-probe", version: "2.1.2" }, {
        capabilities: {},
        versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
    });
    try {
        await abortable(client.connect(transport, { timeout: PROBE_TIMEOUT_MS }), ownedSignal);
        return { response: response, outcome: { kind: "mcp", result: {
                    isMcp: true,
                    classification: `endpoint supports stateless MCP ${MODERN_PROTOCOL_VERSION} server/discover`,
                } } };
    }
    catch (error) {
        throwIfAborted(signal);
        if (!response)
            throw error;
        if (response.status === 401 && isBearerChallenge(response)) {
            return { response, outcome: { kind: "mcp", result: {
                        isMcp: true,
                        classification: `endpoint requires Bearer authentication during MCP ${MODERN_PROTOCOL_VERSION} server/discover probing`,
                    } } };
        }
        return { response, outcome: { kind: response.status === 200 &&
                    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
                    ? "unsupported-modern" : "unrecognized" } };
    }
    finally {
        await transport.close();
    }
}
/** Unauthenticated, metadata-only diagnostics; never forwards configured credentials. */
export async function probeMcpEndpoint(url, options = {}) {
    let ambiguousResult;
    if (options.protocolVersion !== "legacy") {
        const { response, outcome } = await probeModern(url, options.signal);
        if (outcome.kind === "mcp")
            return outcome.result;
        ambiguousResult = ambiguousNotMcp(response);
        if (options.protocolVersion === MODERN_PROTOCOL_VERSION) {
            return ambiguousResult ?? { isMcp: false, classification: `endpoint did not provide a valid MCP ${MODERN_PROTOCOL_VERSION} server/discover response (${response.status}); protocol pin forbids legacy probing` };
        }
        if (outcome.kind !== "unsupported-modern" && !MODERN_FALLBACK_STATUSES.has(response.status)) {
            return ambiguousResult ?? notMcp(response);
        }
    }
    const { response: postResponse, outcome: postOutcome } = await probe(url, LEGACY_POST_STRATEGY, options.signal);
    if (postOutcome.kind === "mcp")
        return postOutcome.result;
    ambiguousResult ??= ambiguousNotMcp(postResponse);
    if (!POST_ENDPOINT_MISMATCH_STATUSES.has(postResponse.status))
        return ambiguousNotMcp(postResponse) ?? ambiguousResult ?? notMcp(postResponse);
    const { response: getResponse, outcome: getOutcome } = await probe(url, LEGACY_SSE_STRATEGY, options.signal);
    return getOutcome.kind === "mcp" ? getOutcome.result : ambiguousNotMcp(getResponse) ?? ambiguousResult ?? notMcp(getResponse);
}
//# sourceMappingURL=mcp-probe.js.map