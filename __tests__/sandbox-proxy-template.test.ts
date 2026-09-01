import { describe, expect, it } from "vitest";
import {
  buildSandboxProxyCsp,
  buildSandboxProxyHtml,
  SANDBOX_INNER_SANDBOX,
  SANDBOX_PROXY_SANDBOX,
} from "../sandbox-proxy-template.ts";

describe("sandbox proxy template", () => {
  it("uses a safe sandbox policy with a distinct parent origin", () => {
    const html = buildSandboxProxyHtml({ parentOrigin: "http://localhost:8377" });

    expect(html).toContain('<iframe id="mcp-app"');
    expect(html).toContain(`sandbox="${SANDBOX_INNER_SANDBOX}"`);
    expect(html).toContain('const EXPECTED_PARENT_ORIGIN = "http://localhost:8377"');
    expect(html).toContain("event.source === window.parent && event.origin === EXPECTED_PARENT_ORIGIN");
    expect(html).toContain("event.source === innerFrame.contentWindow && event.origin === window.location.origin");
    expect(html).toContain("document.write(injectCsp(params.html, buildResourceCsp(params.csp)))");
    expect(html).not.toContain("allow-popups-to-escape-sandbox");
    expect(html).not.toContain("SESSION_TOKEN");
    expect(html).not.toContain("UI_RESOURCE_TOKEN");
  });

  it("relays only validated parent/inner messages and reserves sandbox messages", () => {
    const html = buildSandboxProxyHtml({ parentOrigin: "http://localhost:8377" });

    expect(html).toContain("data.method === SANDBOX_RESOURCE_READY_METHOD");
    expect(html).toContain("data.method === SANDBOX_PROXY_READY_METHOD");
    expect(html).toContain('data.method.startsWith("ui/notifications/sandbox-")');
    expect(html).toContain("postToInner(data)");
    expect(html).toContain("postToParent(data)");
    expect(html).toContain("window.parent.postMessage(data, EXPECTED_PARENT_ORIGIN)");
    expect(html).toContain("innerFrame.contentWindow.postMessage(data, window.location.origin)");
  });

  it("keeps proxy and inner CSP sandboxing distinct from raw resource policy", () => {
    expect(SANDBOX_PROXY_SANDBOX).toContain("allow-same-origin");
    expect(buildSandboxProxyCsp()).toContain(`sandbox ${SANDBOX_PROXY_SANDBOX}`);
    expect(buildSandboxProxyCsp()).toContain("script-src 'unsafe-inline'");
    expect(buildSandboxProxyCsp()).toContain("frame-src 'self'");
    expect(buildSandboxProxyCsp()).not.toContain("allow-popups-to-escape-sandbox");
    expect(buildSandboxProxyCsp()).not.toContain("connect-src *");
  });

  it("escapes the injected parent origin as JavaScript data", () => {
    const html = buildSandboxProxyHtml({ parentOrigin: "http://localhost:8377/<script>\u2028" });

    expect(html).not.toContain("<script>\u2028");
    expect(html).toContain("\\u003cscript\\u003e");
    expect(html).toContain("\\u2028");
  });
});
