/**
 * The proxy is served from a different loopback origin than the trusted host.
 * `allow-same-origin` is safe here because this document never contains the
 * host's session capability; provider HTML is loaded into the nested frame.
 */
export const SANDBOX_PROXY_SANDBOX =
  "allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin";
export const SANDBOX_INNER_SANDBOX = SANDBOX_PROXY_SANDBOX;
export const SANDBOX_PROXY_PATH = "/sandbox";
export const SANDBOX_RESOURCE_PATH_PREFIX = "/resource/";

export interface SandboxProxyTemplateInput {
  parentOrigin: string;
  resourcePath: string;
}

/**
 * Build the static document used by the trusted, second-origin sandbox proxy.
 * The per-session values are the exact parent host origin and opaque resource path.
 */
export function buildSandboxProxyHtml(input: SandboxProxyTemplateInput): string {
  const parentOrigin = safeInlineJSON(input.parentOrigin);
  const resourcePath = safeInlineJSON(input.resourcePath);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MCP App Sandbox</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <iframe id="mcp-app" title="MCP App" sandbox="${SANDBOX_INNER_SANDBOX}" referrerpolicy="no-referrer"></iframe>
  <script>
    const EXPECTED_PARENT_ORIGIN = ${parentOrigin};
    const RESOURCE_PATH = ${resourcePath};
    const SANDBOX_PROXY_READY_METHOD = "ui/notifications/sandbox-proxy-ready";
    const SANDBOX_RESOURCE_READY_METHOD = "ui/notifications/sandbox-resource-ready";
    const INNER_SANDBOX = ${safeInlineJSON(SANDBOX_INNER_SANDBOX)};
    const MAX_PENDING_MESSAGES = 64;
    const innerFrame = document.getElementById("mcp-app");
    const pendingToInner = [];
    let innerReady = false;

    innerFrame.addEventListener("load", () => {
      if (innerFrame.getAttribute("src") === RESOURCE_PATH) flushPendingMessages();
    });

    const isObject = (value) => value !== null && typeof value === "object";
    const isMessageFromParent = (event) =>
      event.source === window.parent && event.origin === EXPECTED_PARENT_ORIGIN;
    const isMessageFromInner = (event) =>
      event.source === innerFrame.contentWindow && event.origin === window.location.origin;

    const postToParent = (data) => {
      window.parent.postMessage(data, EXPECTED_PARENT_ORIGIN);
    };

    const postToInner = (data) => {
      if (!innerReady || !innerFrame.contentWindow) {
        if (pendingToInner.length < MAX_PENDING_MESSAGES) pendingToInner.push(data);
        return;
      }
      innerFrame.contentWindow.postMessage(data, window.location.origin);
    };

    const flushPendingMessages = () => {
      if (!innerFrame.contentWindow) return;
      innerReady = true;
      for (const data of pendingToInner.splice(0)) {
        innerFrame.contentWindow.postMessage(data, window.location.origin);
      }
    };

    const safeSandbox = (requested) => {
      const requestedTokens = typeof requested === "string" ? requested.split(/\\s+/) : [];
      const allowedTokens = new Set(INNER_SANDBOX.split(" "));
      const tokens = requestedTokens.filter((token) => allowedTokens.has(token));
      // Provider HTML needs both script execution and a real proxy-origin
      // storage context. Never accept popup escape or top-navigation tokens.
      return [...new Set([
        "allow-scripts",
        "allow-same-origin",
        ...tokens,
      ])].filter((token) => allowedTokens.has(token)).join(" ");
    };

    const buildAllowAttribute = (permissions) => {
      if (!isObject(permissions) || Array.isArray(permissions)) return "";
      const allowed = [];
      if (permissions.camera) allowed.push("camera");
      if (permissions.microphone) allowed.push("microphone");
      if (permissions.geolocation) allowed.push("geolocation");
      if (permissions.clipboardWrite) allowed.push("clipboard-write");
      return allowed.join("; ");
    };

    const loadResource = (params) => {
      if (!isObject(params)) return;
      innerFrame.setAttribute("sandbox", safeSandbox(params.sandbox));
      const allow = buildAllowAttribute(params.permissions);
      if (allow) innerFrame.setAttribute("allow", allow);
      else innerFrame.removeAttribute("allow");
      innerReady = false;
      innerFrame.setAttribute("src", RESOURCE_PATH);
    };

    window.addEventListener("message", (event) => {
      if (isMessageFromParent(event)) {
        const data = event.data;
        if (!isObject(data)) return;
        if (data.method === SANDBOX_RESOURCE_READY_METHOD) {
          loadResource(data.params);
          return;
        }
        if (data.method === SANDBOX_PROXY_READY_METHOD) return;
        if (typeof data.method === "string" && data.method.startsWith("ui/notifications/sandbox-")) return;
        postToInner(data);
        return;
      }

      if (!isMessageFromInner(event)) return;
      const data = event.data;
      if (!isObject(data)) return;
      if (typeof data.method === "string" && data.method.startsWith("ui/notifications/sandbox-")) return;
      postToParent(data);
    });

    postToParent({
      jsonrpc: "2.0",
      method: SANDBOX_PROXY_READY_METHOD,
      params: {},
    });
  </script>
</body>
</html>`;
}

/**
 * CSP for the proxy document itself. It contains only the inline relay script
 * and a same-origin nested frame. Provider policy is applied on the resource
 * navigation response, not inherited from this relay document.
 */
export function buildSandboxProxyCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "frame-src 'self'",
    "connect-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `sandbox ${SANDBOX_PROXY_SANDBOX}`,
  ].join("; ");
}

function safeInlineJSON(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "undefined";
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
