import { describe, it, expect } from "vitest";
import { buildHostHtmlTemplate, type HostHtmlTemplateInput } from "../host-html-template.ts";

function createMinimalInput(overrides: Partial<HostHtmlTemplateInput> = {}): HostHtmlTemplateInput {
  return {
    sessionToken: "test-token-123",
    uiResourceToken: "resource-token-456",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: { arg1: "value1" },
    resource: {
      uri: "ui://test/widget",
      html: "<h1>Test Widget</h1>",
      mimeType: "text/html",
      meta: {},
    },
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
      expect(html).toContain("Sandboxed");
    });

    it("includes iframe for app content", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain('<iframe id="mcp-app"');
      expect(html).toContain('sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"');
      expect(html).not.toContain("allow-popups-to-escape-sandbox");
      expect(html).not.toContain("allow-same-origin");
      expect(html).toContain('referrerpolicy="no-referrer"');
    });

    it("rejects nested-frame protocol and raw messages by binding to the sandboxed app frame", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain("new PostMessageTransport(iframe.contentWindow, iframe.contentWindow)");
      expect(html).toContain("if (event.source !== iframe.contentWindow) return;");
      expect(html).not.toContain("new PostMessageTransport(iframe.contentWindow, null)");
    });

    it("includes control buttons", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain('id="done-btn"');
      expect(html).toContain('id="cancel-btn"');
    });

    it("includes mobile and in-app-browser host shell affordances", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain("min-height: 100dvh");
      expect(html).toContain("env(safe-area-inset-top");
      expect(html).toContain("@media (max-width: 640px)");
      expect(html).toContain('id="completion-overlay"');
      expect(html).toContain("closeOrShowDone");
      expect(html).toContain("visibilitychange");
    });

    it("sends generated tool-call intents through a host-only endpoint", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain('await post("/proxy/ui/generated-tool-call-intent", {');
      expect(html).toContain("tool: params.name");
      expect(html).not.toContain("_piGeneratedToolCallIntent");
    });
  });

  describe("data injection", () => {
    it("keeps the session token out of the sandboxed app URL", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          sessionToken: "secret-session-token",
          uiResourceToken: "app-resource-token",
        })
      );

      expect(html).toContain('const SESSION_TOKEN = "secret-session-token"');
      expect(html).toContain('const UI_RESOURCE_TOKEN = "app-resource-token"');
      expect(html).toContain('iframe.src = "/ui-app?resource=" + encodeURIComponent(UI_RESOURCE_TOKEN)');
      expect(html).not.toContain('iframe.src = "/ui-app?session="');
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
    it("maps standard resourceDomains to static resource directives", async () => {
      const { buildCspMetaContent } = await import("../host-html-template.ts");

      const csp = buildCspMetaContent({
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://api.example.com"],
      });

      expect(csp).toBe([
        "default-src 'none'",
        "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
        "script-src 'self' 'unsafe-inline' https://esm.sh",
        "style-src 'self' 'unsafe-inline' https://esm.sh",
        "font-src 'self' https://esm.sh",
        "img-src 'self' data: https://esm.sh",
        "media-src 'self' data: https://esm.sh",
        "connect-src https://api.example.com",
        "frame-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
      ].join("; "));
      expect(csp).not.toContain("'unsafe-eval'");
    });

    it("rejects CSP source expressions that can inject directives", async () => {
      const { buildCspMetaContent } = await import("../host-html-template.ts");

      const csp = buildCspMetaContent({
        resourceDomains: [
          "https://safe.example.com",
          "https://safe.example.com",
          "https://evil.example.com; script-src *",
          "https://evil.example.com\nimg-src",
          "https://evil.example.com\rimg-src",
          "https://evil.example.com\timg-src",
          "https://evil.example.com\fimg-src",
          "https://nul-evil.example.com\0img-src",
          "https://del-evil.example.com\x7Fimg-src",
          "https://two sources.example.com",
          "https://evil.example.com\"img-src",
          "'unsafe-eval'",
          42 as unknown as string,
        ],
      });

      expect(csp).toContain("https://safe.example.com");
      expect(csp?.match(/https:\/\/safe\.example\.com/g)).toHaveLength(5);
      expect(csp).not.toContain("evil.example.com");
      expect(csp).not.toContain("nul-evil.example.com");
      expect(csp).not.toContain("del-evil.example.com");
      expect(csp).not.toContain("https://two sources.example.com");
      expect(csp).not.toContain("'unsafe-eval'");
    });

    it("rejects all control characters and non-ASCII CSP sources before serialization", async () => {
      const { buildCspMetaContent } = await import("../host-html-template.ts");
      const rejectedSources = [
        "https://vertical-tab.example.com\vimg-src",
        "https://unit-separator.example.com\x1Fimg-src",
        "https://c1-low.example.com\x80img-src",
        "https://c1-high.example.com\x9Fimg-src",
        "https://emoji.example.com/😀",
        "https://accent.example.com/café",
      ];

      const csp = buildCspMetaContent({
        resourceDomains: ["https://safe.example.com", ...rejectedSources],
      });

      expect(csp?.match(/https:\/\/safe\.example\.com/g)).toHaveLength(5);
      for (const source of rejectedSources) {
        expect(csp).not.toContain(source);
      }
    });

    it("fails closed for malformed CSP domain containers", async () => {
      const { buildCspMetaContent } = await import("../host-html-template.ts");

      const csp = buildCspMetaContent({
        resourceDomains: {} as unknown as string[],
        connectDomains: "https://api.example.com" as unknown as string[],
      });

      expect(csp).toBe([
        "default-src 'none'",
        "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data:",
        "media-src 'self' data:",
        "connect-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
      ].join("; "));
    });

    it("deduplicates frame and base URI domains", async () => {
      const { buildCspMetaContent } = await import("../host-html-template.ts");

      const csp = buildCspMetaContent({
        frameDomains: ["https://frames.example.com", "https://frames.example.com"],
        baseUriDomains: ["https://base.example.com", "https://base.example.com"],
      });

      expect(csp).toContain("frame-src https://frames.example.com");
      expect(csp).toContain("base-uri https://base.example.com");
      expect(csp?.match(/https:\/\/frames\.example\.com/g)).toHaveLength(1);
      expect(csp?.match(/https:\/\/base\.example\.com/g)).toHaveLength(1);
    });

    it("returns a restrictive default when the app declares no CSP metadata", async () => {
      const { buildCspMetaContent } = await import("../host-html-template.ts");

      expect(buildCspMetaContent(undefined)).toBe([
        "default-src 'none'",
        "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data:",
        "media-src 'self' data:",
        "connect-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
      ].join("; "));
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
