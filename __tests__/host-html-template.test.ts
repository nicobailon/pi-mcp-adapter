import { describe, it, expect } from "vitest";
import {
  applyCspMeta,
  buildCspMetaContent,
  buildHostHtmlTemplate,
  type HostHtmlTemplateInput,
} from "../host-html-template.js";

function createMinimalInput(overrides: Partial<HostHtmlTemplateInput> = {}): HostHtmlTemplateInput {
  return {
    sessionToken: "test-token-123",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: { arg1: "value1" },
    allowAttribute: "",
    requireToolConsent: false,
    cacheToolConsent: true,
    ...overrides,
  };
}

describe("buildHostHtmlTemplate", () => {
  describe("structure", () => {
    it("generates valid HTML document", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain("<!doctype html>");
      expect(html).toContain("<html lang=\"en\">");
      expect(html).toContain("</html>");
    });

    it("includes title with server and tool name", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ serverName: "my-server", toolName: "my-tool" })
      );

      expect(html).toContain("<title>MCP UI - my-server / my-tool</title>");
    });

    it("includes header with server and tool info", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ serverName: "demo-server", toolName: "widget-tool" })
      );

      expect(html).toContain('id="server-name"');
      expect(html).toContain('id="tool-name"');
      expect(html).toContain("Hosted");
    });

    it("includes iframe for app content", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain('<iframe id="mcp-app"');
      expect(html).toContain('referrerpolicy="no-referrer"');
    });

    it("includes control buttons", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain('id="done-btn"');
      expect(html).toContain('id="cancel-btn"');
    });
  });

  describe("data injection", () => {
    it("injects session token", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ sessionToken: "secret-token-xyz" })
      );

      expect(html).toContain('"secret-token-xyz"');
    });

    it("injects tool arguments", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ toolArgs: { location: "NYC", units: "metric" } })
      );

      expect(html).toContain('"location"');
      expect(html).toContain('"NYC"');
      expect(html).toContain('"units"');
      expect(html).toContain('"metric"');
    });

    it("injects host context", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          hostContext: {
            displayMode: "fullscreen",
            theme: "dark",
          },
        })
      );

      expect(html).toContain('"displayMode"');
      expect(html).toContain('"fullscreen"');
      expect(html).toContain('"theme"');
      expect(html).toContain('"dark"');
    });

    it("escapes HTML in injected values", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          toolArgs: { script: "<script>alert('xss')</script>" },
        })
      );

      // Should be escaped
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("\\u003cscript\\u003e");
    });
  });

  describe("consent handling", () => {
    it("injects requireToolConsent=false", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ requireToolConsent: false })
      );

      expect(html).toContain("const REQUIRE_TOOL_CONSENT = false");
    });

    it("injects requireToolConsent=true", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ requireToolConsent: true })
      );

      expect(html).toContain("const REQUIRE_TOOL_CONSENT = true");
    });

    it("injects cacheToolConsent", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ cacheToolConsent: false })
      );

      expect(html).toContain("const CACHE_TOOL_CONSENT = false");
    });

    it("records explicit consent denials", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ requireToolConsent: true })
      );

      expect(html).toContain('await post("/proxy/ui/consent", { approved: false }).catch(() => {});');
      expect(html).toContain("Tool call denied by user.");
    });
  });

  describe("iframe permissions", () => {
    it("sets allow attribute when provided", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ allowAttribute: "camera; microphone" })
      );

      expect(html).toContain('const ALLOW_ATTRIBUTE = "camera; microphone"');
    });
  });

  describe("CSP handling", () => {
    it("buildCspMetaContent generates restrictive default CSP when csp is omitted", () => {
      const csp = buildCspMetaContent(undefined);

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("media-src 'self' data:");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
    });

    it("buildCspMetaContent maps resourceDomains to all static-asset directives", () => {
      const csp = buildCspMetaContent({
        resourceDomains: ["cdn.example.com"],
        connectDomains: ["https://api.example.com"],
      });

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self' 'unsafe-inline' cdn.example.com");
      expect(csp).toContain("style-src 'self' 'unsafe-inline' cdn.example.com");
      expect(csp).toContain("img-src 'self' data: cdn.example.com");
      expect(csp).toContain("font-src 'self' cdn.example.com");
      expect(csp).toContain("media-src 'self' data: cdn.example.com");
      expect(csp).toContain("connect-src 'self' https://api.example.com");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain("base-uri 'self'");
    });

    it("buildCspMetaContent respects frameDomains and baseUriDomains", () => {
      const csp = buildCspMetaContent({
        frameDomains: ["https://embed.example.com"],
        baseUriDomains: ["https://base.example.com"],
      });

      expect(csp).toContain("frame-src https://embed.example.com");
      expect(csp).toContain("base-uri https://base.example.com");
    });

    it("buildCspMetaContent rejects malformed domain fields", () => {
      expect(() => buildCspMetaContent({
        resourceDomains: "cdn.example.com" as unknown as string[],
      })).toThrow("ui.csp.resourceDomains must be an array of strings");
    });

    it("buildCspMetaContent rejects CSP source tokens with directive separators", () => {
      expect(() => buildCspMetaContent({
        connectDomains: ["https://api.example.com; frame-src *"],
      })).toThrow("ui.csp.connectDomains[0] must be a domain/source token");
    });

    it("buildCspMetaContent uses safe defaults for frame-src and base-uri when omitted", () => {
      const csp = buildCspMetaContent({});

      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain("base-uri 'self'");
    });

    it("applyCspMeta injects CSP meta into HTML head", () => {
      const html = applyCspMeta(
        "<html><head></head><body>Content</body></html>",
        "default-src 'none'; script-src 'self'"
      );

      expect(html).toContain("Content-Security-Policy");
      expect(html).toContain("script-src");
    });

    it("applyCspMeta replaces existing resource CSP with the host policy", () => {
      const resourceWithCsp = `<html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
        </head>
        <body>Content</body>
      </html>`;

      const html = applyCspMeta(resourceWithCsp, "default-src 'none'; script-src 'self'");

      const cspMatches = html.match(/Content-Security-Policy/g) ?? [];
      expect(cspMatches.length).toBe(1);
      expect(html).toContain("default-src 'none'; script-src 'self'");
      expect(html).not.toContain("default-src 'self'");
    });

    it("applyCspMeta replaces unquoted resource CSP meta tags", () => {
      const html = applyCspMeta(
        `<html><head><meta content="default-src 'self'" http-equiv=Content-Security-Policy></head><body>Content</body></html>`,
        "default-src 'none'; script-src 'self'"
      );

      const cspMatches = html.match(/Content-Security-Policy/g) ?? [];
      expect(cspMatches.length).toBe(1);
      expect(html).toContain("default-src 'none'; script-src 'self'");
      expect(html).not.toContain("default-src 'self'");
    });

    it("applyCspMeta does not strip CSP-like text inside scripts", () => {
      const html = applyCspMeta(
        `<html><head><script>const tpl = \`<meta http-equiv="Content-Security-Policy" content="default-src 'self'">\`;</script></head><body>Content</body></html>`,
        "default-src 'none'"
      );

      expect(html).toContain(
        `<script>const tpl = \`<meta http-equiv="Content-Security-Policy" content="default-src 'self'">\`;</script>`
      );
      expect(html).toContain("default-src 'none'");
    });
  });

  describe("module loading", () => {
    it("uses default AppBridge module URL", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain("/app-bridge.bundle.js");
    });

    it("uses custom AppBridge module URL when provided", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          appBridgeModuleUrl: "https://cdn.example.com/app-bridge.js",
        })
      );

      expect(html).toContain("https://cdn.example.com/app-bridge.js");
    });
  });

  describe("stream mode", () => {
    it("registers the stream patch notification method", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain('const STREAM_PATCH_METHOD = "notifications/pi-mcp-adapter/ui-result-patch"');
      expect(html).toContain('eventSource.addEventListener("result-patch"');
      expect(html).toContain("bridge.notification({");
    });

    it("skips initial tool input in stream-first mode", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          hostContext: {
            "pi-mcp-adapter/stream": {
              mode: "stream-first",
              streamId: "stream-1",
              intermediateResultPatches: true,
              partialInput: false,
            },
          },
        }),
      );

      expect(html).toContain('const streamMode = initialStreamContext?.mode === "stream-first" ? "stream-first" : "eager";');
      expect(html).toContain('if (streamMode !== "stream-first") {');
      expect(html).toContain('bridge.sendToolInput({ arguments: TOOL_ARGS });');
    });
  });

  describe("XSS prevention", () => {
    it("escapes server name in title", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ serverName: "<script>evil</script>" })
      );

      expect(html).toContain("&lt;script&gt;evil&lt;/script&gt;");
      expect(html).not.toContain("<script>evil</script>");
    });

    it("escapes tool name in title", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ toolName: '<img onerror="alert(1)">' })
      );

      expect(html).toContain("&lt;img onerror=");
    });

    it("escapes unicode line/paragraph separators", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          toolArgs: { text: "line\u2028separator\u2029here" },
        })
      );

      // Should be escaped to prevent JS parsing issues
      expect(html).toContain("\\u2028");
      expect(html).toContain("\\u2029");
    });
  });
});
