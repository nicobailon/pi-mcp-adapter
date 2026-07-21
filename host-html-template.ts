import type { UiHostContext, UiResourceContent, UiResourceCsp } from "./types.ts";

// Use locally bundled AppBridge to avoid CDN Zod bundling issues
const DEFAULT_APP_BRIDGE_MODULE_URL = "/app-bridge.bundle.js";

export interface HostHtmlTemplateInput {
  sessionToken: string;
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resource: UiResourceContent;
  allowAttribute: string;
  requireToolConsent: boolean;
  cacheToolConsent: boolean;
  hostContext?: UiHostContext;
  appBridgeModuleUrl?: string;
}

export function buildHostHtmlTemplate(input: HostHtmlTemplateInput): string {
  const hostContext = input.hostContext ?? {};

  const sessionToken = safeInlineJSON(input.sessionToken);
  const toolArgs = safeInlineJSON(input.toolArgs);
  const serverName = safeInlineJSON(input.serverName);
  const toolName = safeInlineJSON(input.toolName);
  const hostContextJson = safeInlineJSON(hostContext);
  const allowAttribute = safeInlineJSON(input.allowAttribute);
  const requireToolConsent = safeInlineJSON(input.requireToolConsent);
  const cacheToolConsent = safeInlineJSON(input.cacheToolConsent);
  const moduleUrl = safeInlineJSON(input.appBridgeModuleUrl ?? DEFAULT_APP_BRIDGE_MODULE_URL);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MCP UI - ${escapeHtml(input.serverName)} / ${escapeHtml(input.toolName)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1115;
      --surface: #181c22;
      --text: #ecf0f5;
      --muted: #a9b2bf;
      --accent: #43c0ff;
      --border: rgba(255, 255, 255, 0.12);
      --good: #34d399;
      --warn: #fbbf24;
      --bad: #f87171;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f7fb;
        --surface: #ffffff;
        --text: #1d2939;
        --muted: #667085;
        --accent: #0ea5e9;
        --border: rgba(15, 23, 42, 0.14);
        --good: #059669;
        --warn: #b45309;
        --bad: #b91c1c;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    body { display: flex; flex-direction: column; min-height: 100vh; }
    header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .title { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
    .server { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap; }
    .tool { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-size: 11px; color: var(--muted); white-space: nowrap; }
    .controls { display: flex; gap: 8px; align-items: center; }
    .status { font-size: 12px; color: var(--muted); white-space: nowrap; }
    button { border: 1px solid var(--border); background: transparent; color: var(--text); border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
    button.primary { border-color: color-mix(in srgb, var(--good) 40%, var(--border) 60%); color: var(--good); }
    button.danger { border-color: color-mix(in srgb, var(--bad) 40%, var(--border) 60%); color: var(--bad); }
    button:hover { background: color-mix(in srgb, var(--surface) 75%, var(--accent) 25%); }
    main { flex: 1; min-height: 0; padding: 10px; display: flex; }
    iframe { width: 100%; height: 100%; border: 1px solid var(--border); border-radius: 10px; background: white; }
    .overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--bg) 90%, black 10%); display: none; align-items: center; justify-content: center; z-index: 2; }
    .overlay.visible { display: flex; }
    .panel { width: min(680px, calc(100vw - 40px)); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
    .panel h2 { margin: 0 0 8px; font-size: 16px; }
    .panel p { margin: 0; color: var(--muted); line-height: 1.4; font-size: 14px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <div class="title">
      <span class="server">MCP · <span id="server-name"></span></span>
      <span class="tool" id="tool-name"></span>
      <span class="badge">Sandboxed</span>
    </div>
    <div class="controls">
      <span class="status" id="status">Loading UI...</span>
      <button class="primary" id="done-btn" title="Cmd/Ctrl+Enter">Done</button>
      <button class="danger" id="cancel-btn" title="Escape">Cancel</button>
    </div>
  </header>
  <main>
    <iframe id="mcp-app" referrerpolicy="no-referrer"></iframe>
  </main>
  <div class="overlay" id="error-overlay">
    <div class="panel">
      <h2>UI Error</h2>
      <p id="error-message"></p>
    </div>
  </div>
  <script type="module">
    import { AppBridge, PostMessageTransport } from ${moduleUrl};

    const SESSION_TOKEN = ${sessionToken};
    const SERVER_NAME = ${serverName};
    const TOOL_NAME = ${toolName};
    const TOOL_ARGS = ${toolArgs};
    const HOST_CONTEXT = ${hostContextJson};
    const ALLOW_ATTRIBUTE = ${allowAttribute};
    const REQUIRE_TOOL_CONSENT = ${requireToolConsent};
    const CACHE_TOOL_CONSENT = ${cacheToolConsent};
    const STREAM_CONTEXT_KEY = "pi-mcp-adapter/stream";
    const STREAM_PATCH_METHOD = "notifications/pi-mcp-adapter/ui-result-patch";

    const iframe = document.getElementById("mcp-app");
    const statusNode = document.getElementById("status");
    const doneBtn = document.getElementById("done-btn");
    const cancelBtn = document.getElementById("cancel-btn");
    const errorOverlay = document.getElementById("error-overlay");
    const errorMessage = document.getElementById("error-message");

    document.getElementById("server-name").textContent = SERVER_NAME;
    document.getElementById("tool-name").textContent = TOOL_NAME;

    const setStatus = (text, isError = false) => {
      statusNode.textContent = text;
      statusNode.style.color = isError ? "var(--bad)" : "var(--muted)";
    };

    const showError = (message) => {
      errorMessage.textContent = message;
      errorOverlay.classList.add("visible");
      setStatus("Error", true);
    };

    const post = async (endpoint, params) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: SESSION_TOKEN, params }),
      });

      const body = await response.json().catch(() => ({ ok: false, error: "Invalid JSON response" }));
      if (!response.ok || !body.ok) {
        const message = body.error || ("HTTP " + response.status);
        throw new Error(message);
      }
      return body.result ?? {};
    };

    let consentGranted = !REQUIRE_TOOL_CONSENT;
    const initialStreamContext = HOST_CONTEXT?.[STREAM_CONTEXT_KEY];
    const streamMode = initialStreamContext?.mode === "stream-first" ? "stream-first" : "eager";

    const bridge = new AppBridge(
      null,
      { name: "pi", version: "1.0.0" },
      { serverTools: {}, openLinks: {}, logging: {}, updateModelContext: {}, message: {} },
      { hostContext: HOST_CONTEXT }
    );

    bridge.oncalltool = async (params) => {
      if (!consentGranted) {
        const accepted = window.confirm("Allow this UI to call server tools for this session?");
        if (!accepted) {
          await post("/proxy/ui/consent", { approved: false }).catch(() => {});
          return {
            isError: true,
            content: [{ type: "text", text: "Tool call denied by user." }],
          };
        }
        await post("/proxy/ui/consent", { approved: true });
        if (CACHE_TOOL_CONSENT) {
          consentGranted = true;
        }
      }
      const result = await post("/proxy/tools/call", params);
      // Notify agent about the tool call
      await post("/proxy/ui/message", {
        type: "intent",
        intent: "call_tool",
        params: { tool: params.name, arguments: params.arguments, isError: result.isError }
      }).catch(() => {});
      return result;
    };

    bridge.onmessage = async (params) => post("/proxy/ui/message", params);
    bridge.onupdatemodelcontext = async (params) => post("/proxy/ui/context", params);
    
    // Also listen for raw postMessage events with custom types (notify, prompt, intent, etc.)
    // These bypass the AppBridge protocol but are used by some MCP UI implementations
    window.addEventListener("message", async (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      
      // Skip AppBridge protocol messages (handled by bridge)
      if (data.jsonrpc || (typeof data.method === "string" && (data.method.startsWith("app/") || data.method.startsWith("host/")))) return;
      
      // Handle raw UI action messages
      const msgType = data.type;
      if (typeof msgType !== "string") return;
      
      if (msgType === "notify" || msgType === "prompt" || msgType === "intent" || msgType === "message") {
        // Standard MCP-UI types - preserve their semantics
        // Support both { type, payload: {...} } and { type, field: value } formats
        const { type: _, payload, ...directFields } = data;
        await post("/proxy/ui/message", { type: msgType, ...directFields, ...(payload || {}) }).catch(() => {});
      } else if (!msgType.startsWith("ui-lifecycle-") && !msgType.startsWith("ui-message-")) {
        // Any other custom type - forward as intent with type as intent name
        // (Skip internal lifecycle/ack messages)
        const payload = data.payload || {};
        await post("/proxy/ui/message", {
          type: "intent",
          intent: msgType,
          params: payload,
        }).catch(() => {});
      }
    });
    bridge.ondownloadfile = async (params) => post("/proxy/ui/download-file", params);
    bridge.onrequestdisplaymode = async (params) => post("/proxy/ui/request-display-mode", params);
    bridge.onopenlink = async (params) => {
      const result = await post("/proxy/ui/open-link", params);
      if (!result.isError) {
        window.open(params.url, "_blank", "noopener,noreferrer");
        // Notify agent about the link open
        await post("/proxy/ui/message", {
          type: "intent",
          intent: "open_link",
          params: { url: params.url }
        }).catch(() => {});
      }
      return result;
    };

    bridge.oninitialized = () => {
      if (streamMode !== "stream-first") {
        bridge.sendToolInput({ arguments: TOOL_ARGS });
      }
      setStatus(streamMode === "stream-first" ? "Streaming…" : "Connected");
    };

    bridge.onsizechange = ({ width, height }) => {
      if (typeof width === "number" && width > 0) {
        iframe.style.minWidth = Math.min(width, window.innerWidth - 24) + "px";
      }
      if (typeof height === "number" && height > 0) {
        iframe.style.height = Math.max(height, 320) + "px";
      }
    };

    if (ALLOW_ATTRIBUTE) {
      iframe.setAttribute("allow", ALLOW_ATTRIBUTE);
    }

    // Connect bridge BEFORE loading iframe to ensure we're listening when the app sends ui/initialize
    try {
      const transport = new PostMessageTransport(iframe.contentWindow, null);
      await bridge.connect(transport);
    } catch (error) {
      console.error("[host] Bridge connection failed:", error);
      showError("Failed to initialize AppBridge: " + String(error));
    }

    const iframeLoaded = new Promise((resolve) => {
      iframe.onload = resolve;
    });
    iframe.src = "/ui-app?session=" + encodeURIComponent(SESSION_TOKEN);
    await iframeLoaded;

    const eventSource = new EventSource("/events?session=" + encodeURIComponent(SESSION_TOKEN));
    eventSource.addEventListener("tool-input", (event) => {
      try {
        bridge.sendToolInput(JSON.parse(event.data));
      } catch (error) {
        showError("Failed to forward tool input: " + String(error));
      }
    });
    eventSource.addEventListener("tool-result", (event) => {
      try {
        bridge.sendToolResult(JSON.parse(event.data));
      } catch (error) {
        showError("Failed to forward tool result: " + String(error));
      }
    });
    eventSource.addEventListener("tool-cancelled", (event) => {
      try {
        bridge.sendToolCancelled(JSON.parse(event.data));
      } catch (error) {
        showError("Failed to forward cancellation: " + String(error));
      }
    });
    eventSource.addEventListener("result-patch", async (event) => {
      try {
        await bridge.notification({
          method: STREAM_PATCH_METHOD,
          params: JSON.parse(event.data),
        });
      } catch (error) {
        showError("Failed to forward stream patch: " + String(error));
      }
    });
    eventSource.addEventListener("host-context", (event) => {
      try {
        bridge.setHostContext(JSON.parse(event.data));
      } catch {}
    });
    eventSource.addEventListener("session-complete", async () => {
      await bridge.teardownResource({}).catch(() => {});
      eventSource.close();
      window.close();
    });
    eventSource.onerror = () => {
      setStatus("Connection lost", true);
    };

    const heartbeat = setInterval(() => {
      post("/proxy/ui/heartbeat", {}).catch(() => {});
    }, 10000);

    const complete = async (reason) => {
      try {
        await post("/proxy/ui/complete", { reason });
      } catch {}
      try {
        await bridge.teardownResource({});
      } catch {}
      clearInterval(heartbeat);
      eventSource.close();
      window.close();
    };

    doneBtn.addEventListener("click", () => complete("done"));
    cancelBtn.addEventListener("click", () => complete("cancel"));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        complete("cancel");
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        complete("done");
      }
    });
  </script>
</body>
</html>`;
}

export function buildCspMetaContent(csp: UiResourceCsp | undefined): string | undefined {
  if (!csp) return undefined;

  const resourceDomains = sanitizeCspDomains(csp.resourceDomains);
  const connectDomains = sanitizeCspDomains(csp.connectDomains);
  const frameDomains = sanitizeCspDomains(csp.frameDomains);
  const baseUriDomains = sanitizeCspDomains(csp.baseUriDomains);

  return [
    "default-src 'none'",
    toDirective(
      "script-src",
      ["'self'", "'unsafe-inline'"],
      resourceDomains,
      csp.scriptDomains,
    ),
    toDirective(
      "style-src",
      ["'self'", "'unsafe-inline'"],
      resourceDomains,
      csp.styleDomains,
    ),
    toDirective("font-src", ["'self'"], resourceDomains, csp.fontDomains),
    toDirective("img-src", ["'self'", "data:"], resourceDomains, csp.imgDomains),
    toDirective("media-src", ["'self'", "data:"], resourceDomains, csp.mediaDomains),
    toDirective("connect-src", ["'self'"], connectDomains),
    frameDomains.length > 0
      ? `frame-src ${frameDomains.join(" ")}`
      : "frame-src 'none'",
    toDirective("worker-src", ["'self'", "blob:"], resourceDomains, csp.workerDomains),
    "object-src 'none'",
    baseUriDomains.length > 0
      ? `base-uri ${baseUriDomains.join(" ")}`
      : "base-uri 'self'",
  ].join("; ");
}

function toDirective(
  name: string,
  trustedSources: string[],
  ...domainGroups: Array<string[] | undefined>
): string {
  const domains = domainGroups.flatMap(sanitizeCspDomains);
  const sources = [...new Set([...trustedSources, ...domains])];
  return `${name} ${sources.join(" ")}`;
}

function sanitizeCspDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) return [];

  return [...new Set(domains.filter(
    (domain): domain is string =>
      typeof domain === "string" &&
      domain.length > 0 &&
      // HTTP headers must be printable ASCII; rejecting all other code points also
      // excludes every C0/C1 control character before Node serializes the policy.
      /^[\x21-\x7E]+$/.test(domain) &&
      !/[;'"]/.test(domain),
  ))];
}

export function applyCspMeta(html: string, cspContent: string | undefined): string {
  if (!cspContent) return html;
  if (hasCspMetaTag(html)) return html;

  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(cspContent)}">`;
  const headTag = findHtmlTag(html, (tag) => isHtmlTagNamed(tag, "head"));
  if (headTag) {
    return `${html.slice(0, headTag.end + 1)}\n${metaTag}${html.slice(headTag.end + 1)}`;
  }
  return `${metaTag}\n${html}`;
}

const HTML_TEXT_ELEMENT_NAMES = [
  // Raw-text elements.
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  // RCDATA elements.
  "title",
  "textarea",
  // Browsers parse noscript as raw text when scripting is enabled.
  "noscript",
] as const;

function hasCspMetaTag(html: string): boolean {
  return !!findHtmlTag(
    html,
    (tag) =>
      isHtmlTagNamed(tag, "meta") &&
      decodeCspHttpEquivCharacterReferences(getHtmlAttribute(tag, "http-equiv") ?? "").toLowerCase() ===
        "content-security-policy",
  );
}

function findHtmlTag(
  html: string,
  predicate: (tag: string) => boolean,
): { end: number } | undefined {
  let index = 0;

  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart === -1) return undefined;

    if (html.startsWith("<!--", tagStart)) {
      index = skipHtmlComment(html, tagStart);
      continue;
    }
    if (html[tagStart + 1] === "!" || html[tagStart + 1] === "?") {
      index = skipHtmlMarkupDeclarationOrBogusComment(html, tagStart);
      continue;
    }
    if (!isHtmlTagOpenAt(html, tagStart)) {
      index = tagStart + 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(html, tagStart);
    if (tagEnd === -1) return undefined;

    const tag = html.slice(tagStart, tagEnd + 1);
    if (predicate(tag)) return { end: tagEnd };

    if (isHtmlTagNamed(tag, "template")) {
      index = skipHtmlTemplateContent(html, tagEnd + 1);
      continue;
    }
    if (isHtmlTagNamed(tag, "plaintext")) return undefined;

    const textElementName = findHtmlTextElementName(tag);
    if (textElementName) {
      index = skipHtmlTextElement(html, tagEnd + 1, textElementName);
      continue;
    }

    index = tagEnd + 1;
  }

  return undefined;
}

function skipHtmlTemplateContent(html: string, index: number): number {
  let templateDepth = 1;

  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart === -1) return html.length;

    if (html.startsWith("<!--", tagStart)) {
      index = skipHtmlComment(html, tagStart);
      continue;
    }
    if (html[tagStart + 1] === "!" || html[tagStart + 1] === "?") {
      index = skipHtmlMarkupDeclarationOrBogusComment(html, tagStart);
      continue;
    }
    if (!isHtmlTagOpenAt(html, tagStart)) {
      index = tagStart + 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(html, tagStart);
    if (tagEnd === -1) return html.length;

    const tag = html.slice(tagStart, tagEnd + 1);
    if (isHtmlTagNamed(tag, "plaintext")) return html.length;

    const textElementName = findHtmlTextElementName(tag);
    if (textElementName) {
      index = skipHtmlTextElement(html, tagEnd + 1, textElementName);
      continue;
    }

    if (isHtmlTagNamed(tag, "template")) {
      templateDepth++;
    } else if (isClosingHtmlTagNamed(tag, "template")) {
      templateDepth--;
      if (templateDepth === 0) return tagEnd + 1;
    }

    index = tagEnd + 1;
  }

  return html.length;
}

function skipHtmlComment(html: string, index: number): number {
  // The tokenizer abruptly closes empty comments for both <!--> and <!--->.
  if (html[index + 4] === ">") return index + 5;
  if (html[index + 4] === "-" && html[index + 5] === ">") return index + 6;

  for (let cursor = index + 4; cursor < html.length; cursor++) {
    if (html[cursor] !== "-" || html[cursor + 1] !== "-") continue;
    if (html[cursor + 2] === ">") return cursor + 3;
    // The comment-end-bang state also closes on >.
    if (html[cursor + 2] === "!" && html[cursor + 3] === ">") return cursor + 4;
  }

  return html.length;
}

function skipHtmlMarkupDeclarationOrBogusComment(html: string, index: number): number {
  if (html.slice(index + 2, index + 9).toLowerCase() === "doctype") {
    const declarationEnd = findHtmlDoctypeEnd(html, index);
    return declarationEnd === -1 ? html.length : declarationEnd + 1;
  }

  const commentEnd = html.indexOf(">", index + 2);
  return commentEnd === -1 ? html.length : commentEnd + 1;
}

function findHtmlDoctypeEnd(html: string, declarationStart: number): number {
  let state:
    | "before-name"
    | "name"
    | "after-name"
    | "before-public-identifier"
    | "public-identifier"
    | "after-public-identifier"
    | "before-system-identifier"
    | "system-identifier"
    | "after-system-identifier"
    | "bogus" = "before-name";
  let quote: string | undefined;

  for (let index = declarationStart + "<!DOCTYPE".length; index < html.length; index++) {
    const character = html[index];

    if (state === "public-identifier" || state === "system-identifier") {
      if (character === quote) {
        state = state === "public-identifier"
          ? "after-public-identifier"
          : "after-system-identifier";
      }
      continue;
    }
    if (state === "bogus") {
      if (character === ">") return index;
      continue;
    }
    if (state === "before-name") {
      if (isHtmlAsciiWhitespace(character)) continue;
      if (character === ">") return index;
      state = "name";
      continue;
    }
    if (state === "name") {
      if (character === ">") return index;
      if (isHtmlAsciiWhitespace(character)) state = "after-name";
      continue;
    }
    if (state === "after-name") {
      if (isHtmlAsciiWhitespace(character)) continue;
      if (character === ">") return index;

      const keywordStart = index;
      while (isHtmlAsciiLetter(html[index])) index++;
      const keyword = html.slice(keywordStart, index).toLowerCase();
      if (keyword === "public" && isHtmlAsciiWhitespace(html[index])) {
        state = "before-public-identifier";
      } else if (keyword === "system" && isHtmlAsciiWhitespace(html[index])) {
        state = "before-system-identifier";
      } else if (html[index] === ">") {
        return index;
      } else {
        state = "bogus";
      }
      index--;
      continue;
    }
    if (state === "before-public-identifier" || state === "before-system-identifier") {
      if (isHtmlAsciiWhitespace(character)) continue;
      if (character === ">") return index;
      if (character === '"' || character === "'") {
        quote = character;
        state = state === "before-public-identifier"
          ? "public-identifier"
          : "system-identifier";
      } else {
        state = "bogus";
      }
      continue;
    }
    if (state === "after-public-identifier") {
      if (isHtmlAsciiWhitespace(character)) {
        state = "before-system-identifier";
      } else if (character === ">") {
        return index;
      } else {
        state = "bogus";
      }
      continue;
    }

    if (character === ">") return index;
    if (!isHtmlAsciiWhitespace(character)) state = "bogus";
  }

  return -1;
}

function isHtmlTagOpenAt(html: string, index: number): boolean {
  return isHtmlAsciiLetter(html[index + 1]) || (
    html[index + 1] === "/" && isHtmlAsciiLetter(html[index + 2])
  );
}

function isHtmlAsciiLetter(character: string | undefined): boolean {
  return !!character && /[A-Za-z]/.test(character);
}

function skipHtmlTextElement(html: string, index: number, name: string): number {
  if (name === "script") return skipHtmlScriptContent(html, index);

  const closingTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
  closingTag.lastIndex = index;
  const match = closingTag.exec(html);
  if (!match) return html.length;

  const closingTagEnd = findHtmlTagEnd(html, match.index);
  return closingTagEnd === -1 ? html.length : closingTagEnd + 1;
}

function skipHtmlScriptContent(html: string, index: number): number {
  let state: "data" | "escaped" | "double-escaped" = "data";

  for (let cursor = index; cursor < html.length; cursor++) {
    if (state === "data") {
      if (html.startsWith("<!--", cursor)) {
        state = "escaped";
        cursor += 3;
      } else if (isHtmlScriptEndTagAt(html, cursor)) {
        const closingTagEnd = findHtmlTagEnd(html, cursor);
        return closingTagEnd === -1 ? html.length : closingTagEnd + 1;
      }
      continue;
    }

    if (state === "escaped") {
      if (html.startsWith("-->", cursor)) {
        state = "data";
        cursor += 2;
        continue;
      }
      if (isHtmlScriptEndTagAt(html, cursor)) {
        const closingTagEnd = findHtmlTagEnd(html, cursor);
        return closingTagEnd === -1 ? html.length : closingTagEnd + 1;
      }
      if (isHtmlScriptStartTagAt(html, cursor)) {
        state = "double-escaped";
        cursor += "<script".length - 1;
      }
      continue;
    }

    if (isHtmlScriptEndTagAt(html, cursor)) {
      // In double-escaped state, </script> only returns to escaped state.
      state = "escaped";
      cursor += "</script".length - 1;
    }
  }

  return html.length;
}

function isHtmlScriptStartTagAt(html: string, index: number): boolean {
  return isHtmlTagNameAt(html, index, "<script");
}

function isHtmlScriptEndTagAt(html: string, index: number): boolean {
  return isHtmlTagNameAt(html, index, "</script");
}

function isHtmlTagNameAt(html: string, index: number, name: string): boolean {
  return (
    html.slice(index, index + name.length).toLowerCase() === name &&
    isHtmlTagNameBoundary(html[index + name.length])
  );
}

function isHtmlAsciiWhitespace(character: string | undefined): boolean {
  return character === "\t" || character === "\n" || character === "\f" || character === "\r" || character === " ";
}

function isHtmlTagNameBoundary(character: string | undefined): boolean {
  return isHtmlAsciiWhitespace(character) || character === "/" || character === ">";
}

function isHtmlAttributeNameBoundary(character: string | undefined): boolean {
  return isHtmlTagNameBoundary(character) || character === "=";
}

function findHtmlTextElementName(tag: string): string | undefined {
  return HTML_TEXT_ELEMENT_NAMES.find((name) => isHtmlTagNamed(tag, name));
}

function decodeCspHttpEquivCharacterReferences(value: string): string {
  return value.replace(
    /&#(?:(?:x|X)([0-9a-fA-F]+)|([0-9]+));?/g,
    (reference, hexadecimal: string | undefined, decimal: string | undefined) => {
      const source = hexadecimal ?? decimal;
      if (!source) return reference;

      const codePoint = Number.parseInt(source, hexadecimal ? 16 : 10);
      // Only ASCII letters and hyphens can make up this comparison target, so
      // decoding other references cannot change whether it is a CSP meta tag.
      if (
        (codePoint >= 0x41 && codePoint <= 0x5A) ||
        (codePoint >= 0x61 && codePoint <= 0x7A) ||
        codePoint === 0x2D
      ) {
        return String.fromCharCode(codePoint);
      }
      return reference;
    },
  );
}

function findHtmlTagEnd(html: string, tagStart: number): number {
  let state:
    | "tag-name"
    | "before-attribute-name"
    | "attribute-name"
    | "after-attribute-name"
    | "before-attribute-value"
    | "unquoted-attribute-value"
    | "quoted-attribute-value"
    | "after-quoted-attribute-value" = "tag-name";
  let quote: string | undefined;

  for (let index = tagStart + 1; index < html.length; index++) {
    const character = html[index];

    if (state === "quoted-attribute-value") {
      if (character === quote) state = "after-quoted-attribute-value";
      continue;
    }
    if (state === "unquoted-attribute-value") {
      if (character === ">") return index;
      if (isHtmlAsciiWhitespace(character)) state = "before-attribute-name";
      continue;
    }
    if (state === "before-attribute-value") {
      if (isHtmlAsciiWhitespace(character)) continue;
      if (character === ">") return index;
      if (character === '"' || character === "'") {
        quote = character;
        state = "quoted-attribute-value";
      } else {
        state = "unquoted-attribute-value";
      }
      continue;
    }
    if (state === "after-quoted-attribute-value") {
      if (character === ">") return index;
      state = isHtmlAsciiWhitespace(character) ? "before-attribute-name" : "attribute-name";
      continue;
    }
    if (state === "tag-name") {
      if (character === ">") return index;
      if (isHtmlAsciiWhitespace(character) || character === "/") {
        state = "before-attribute-name";
      }
      continue;
    }
    if (state === "attribute-name") {
      if (character === ">") return index;
      if (character === "=") {
        state = "before-attribute-value";
      } else if (isHtmlAsciiWhitespace(character) || character === "/") {
        state = "after-attribute-name";
      }
      continue;
    }
    if (state === "after-attribute-name") {
      if (character === ">") return index;
      if (character === "=") {
        state = "before-attribute-value";
      } else if (!isHtmlAsciiWhitespace(character)) {
        state = "attribute-name";
      }
      continue;
    }

    if (character === ">") return index;
    if (!isHtmlAsciiWhitespace(character)) state = "attribute-name";
  }

  return -1;
}

function isHtmlTagNamed(tag: string, name: string): boolean {
  return (
    tag.slice(1, name.length + 1).toLowerCase() === name &&
    isHtmlTagNameBoundary(tag[name.length + 1])
  );
}

function isClosingHtmlTagNamed(tag: string, name: string): boolean {
  return (
    tag.slice(2, name.length + 2).toLowerCase() === name &&
    isHtmlTagNameBoundary(tag[name.length + 2])
  );
}

function getHtmlAttribute(tag: string, attributeName: string): string | undefined {
  let index = 1;
  while (!isHtmlTagNameBoundary(tag[index])) index++;

  while (index < tag.length) {
    while (isHtmlAsciiWhitespace(tag[index])) index++;
    if (tag[index] === ">" || index >= tag.length) return undefined;
    if (tag[index] === "/") {
      // A solidus begins self-closing syntax only when it is immediately followed
      // by the tag end. Otherwise, HTML reconsumes after the unexpected solidus.
      if (tag[index + 1] === ">") return undefined;
      index++;
      continue;
    }

    const nameStart = index;
    while (!isHtmlAttributeNameBoundary(tag[index])) index++;
    const name = tag.slice(nameStart, index);

    const isMatchingAttribute = name.toLowerCase() === attributeName;
    while (isHtmlAsciiWhitespace(tag[index])) index++;
    if (tag[index] !== "=") {
      if (isMatchingAttribute) return "";
      continue;
    }
    index++;

    while (isHtmlAsciiWhitespace(tag[index])) index++;
    const quote = tag[index];
    const valueStart = quote === '"' || quote === "'" ? ++index : index;
    if (quote === '"' || quote === "'") {
      while (tag[index] !== quote && index < tag.length) index++;
    } else {
      while (!isHtmlAsciiWhitespace(tag[index]) && tag[index] !== ">") index++;
    }
    const value = tag.slice(valueStart, index);
    if (quote === '"' || quote === "'") index++;

    if (isMatchingAttribute) return value;
  }

  return undefined;
}

function safeInlineJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
