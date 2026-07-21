import { describe, it, expect } from "vitest";
import { buildHostHtmlTemplate, type HostHtmlTemplateInput } from "../host-html-template.ts";

function createMinimalInput(overrides: Partial<HostHtmlTemplateInput> = {}): HostHtmlTemplateInput {
  return {
    sessionToken: "test-token-123",
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
    it("maps standard resourceDomains to static resource directives", async () => {
      const { buildCspMetaContent } = await import("../host-html-template.ts");

      const csp = buildCspMetaContent({
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://api.example.com"],
      });

      expect(csp).toBe([
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline' https://esm.sh",
        "style-src 'self' 'unsafe-inline' https://esm.sh",
        "font-src 'self' https://esm.sh",
        "img-src 'self' data: https://esm.sh",
        "media-src 'self' data: https://esm.sh",
        "connect-src 'self' https://api.example.com",
        "frame-src 'none'",
        "worker-src 'self' blob: https://esm.sh",
        "object-src 'none'",
        "base-uri 'self'",
      ].join("; "));
      expect(csp).not.toContain("'unsafe-eval'");
    });

    it("merges legacy granular fields with resourceDomains", async () => {
      const { buildCspMetaContent } = await import("../host-html-template.ts");

      const csp = buildCspMetaContent({
        resourceDomains: ["https://shared.example.com"],
        scriptDomains: ["https://scripts.example.com"],
        styleDomains: ["https://styles.example.com"],
        fontDomains: ["https://fonts.example.com"],
        imgDomains: ["https://images.example.com"],
        mediaDomains: ["https://media.example.com"],
        workerDomains: ["https://workers.example.com"],
      });

      expect(csp).toContain(
        "script-src 'self' 'unsafe-inline' https://shared.example.com https://scripts.example.com",
      );
      expect(csp).toContain(
        "style-src 'self' 'unsafe-inline' https://shared.example.com https://styles.example.com",
      );
      expect(csp).toContain(
        "font-src 'self' https://shared.example.com https://fonts.example.com",
      );
      expect(csp).toContain(
        "img-src 'self' data: https://shared.example.com https://images.example.com",
      );
      expect(csp).toContain(
        "media-src 'self' data: https://shared.example.com https://media.example.com",
      );
      expect(csp).toContain(
        "worker-src 'self' blob: https://shared.example.com https://workers.example.com",
      );
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
      expect(csp?.match(/https:\/\/safe\.example\.com/g)).toHaveLength(6);
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

      expect(csp?.match(/https:\/\/safe\.example\.com/g)).toHaveLength(6);
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
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data:",
        "media-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'none'",
        "worker-src 'self' blob:",
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

    it("returns undefined when the app declares no CSP metadata", async () => {
      const { buildCspMetaContent } = await import("../host-html-template.ts");

      expect(buildCspMetaContent(undefined)).toBeUndefined();
    });

    it("applyCspMeta injects an escaped CSP meta tag into the HTML head", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");

      const html = applyCspMeta(
        "<html><head></head><body>Content</body></html>",
        `default-src 'none'; script-src https://cdn.example.com?a=1&b=2`,
      );

      expect(html).toContain(
        `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://cdn.example.com?a=1&amp;b=2">`,
      );
      expect(html).toContain("<body>Content</body>");
    });

    it("applyCspMeta preserves an existing app-authored CSP", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head><meta http-equiv="Content-Security-Policy" content="img-src https://images.example.com"></head></html>`;

      const html = applyCspMeta(resourceHtml, "default-src 'none'");

      expect(html).toBe(resourceHtml);
      expect(html.match(/Content-Security-Policy/g)).toHaveLength(1);
    });

    it.each([
      ["whitespace around equals", `<meta http-equiv = "Content-Security-Policy" content="img-src https://images.example.com">`],
      ["an unquoted value", `<meta http-equiv = Content-Security-Policy content="img-src https://images.example.com">`],
    ])("applyCspMeta preserves an existing CSP meta tag with %s", async (_description, cspMeta) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head>${cspMeta}</head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(resourceHtml);
    });

    it("applyCspMeta preserves a CSP meta after a quote in an unquoted preceding value", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head><meta x=a"><meta http-equiv=Content-Security-Policy></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(resourceHtml);
    });

    it("applyCspMeta inserts into a real head after a quote in an unquoted preceding value", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><meta x=a"><head data-real></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<html><meta x=a"><head data-real>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head></html>`,
      );
    });

    it("applyCspMeta injects when a valueless http-equiv precedes a CSP duplicate", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head><meta http-equiv http-equiv=Content-Security-Policy></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<html><head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"><meta http-equiv http-equiv=Content-Security-Policy></head></html>`,
      );
    });

    it.each([
      ["an HTML comment", `<!-- <meta http-equiv=Content-Security-Policy> -->`],
      ["script content", `<script>const csp = "<meta http-equiv=Content-Security-Policy>";</script>`],
    ])("applyCspMeta injects when matching text appears only in %s", async (_description, inertContent) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head>${inertContent}</head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toContain(
        `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'">${inertContent}`,
      );
    });

    it.each([
      ["an HTML comment", "<!-- <head data-decoy> -->"],
      ["script content", `<script>const head = "<head data-decoy>";</script>`],
    ])("applyCspMeta inserts into the real head after a %s decoy", async (_description, inertContent) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `${inertContent}<html><head data-real="true"></head><body>Content</body></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `${inertContent}<html><head data-real="true">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head><body>Content</body></html>`,
      );
    });

    it.each([
      ["an abrupt empty comment", "<!-->"],
      ["an abrupt empty comment after a hyphen", "<!--->"],
      ["a comment-end-bang terminator", "<!-- --!>"],
    ])("applyCspMeta preserves an app-authored CSP after %s", async (_description, comment) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `${comment}<html><head><meta http-equiv=Content-Security-Policy></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(resourceHtml);
    });

    it("applyCspMeta finds the actual head after an abrupt empty comment in a template", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<template><!--><head data-decoy></head></template><html><head data-real="true"></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<template><!--><head data-decoy></head></template><html><head data-real="true">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head></html>`,
      );
    });

    it("applyCspMeta ignores a CSP meta in a double-escaped script", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head><script><!--<script></script><meta http-equiv=Content-Security-Policy></script></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<html><head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"><script><!--<script></script><meta http-equiv=Content-Security-Policy></script></head></html>`,
      );
    });

    it("applyCspMeta preserves a CSP meta after escaped script text returns to data", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head><script><!-- --> <script></script><meta http-equiv=Content-Security-Policy></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(resourceHtml);
    });

    it.each([
      ["NBSP", "\u00a0"],
      ["vertical tab", "\v"],
    ])("applyCspMeta injects when %s makes a pseudo-meta tag", async (_description, whitespace) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head><meta${whitespace}http-equiv=Content-Security-Policy></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<html><head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"><meta${whitespace}http-equiv=Content-Security-Policy></head></html>`,
      );
    });

    it.each([
      ["NBSP", "\u00a0"],
      ["vertical tab", "\v"],
    ])("applyCspMeta ignores a %s pseudo-head tag", async (_description, whitespace) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head${whitespace} data-decoy></head${whitespace}><head data-real></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<html><head${whitespace} data-decoy></head${whitespace}><head data-real>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head></html>`,
      );
    });

    it("applyCspMeta preserves a real CSP meta after stray less-than text", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head>1 < 2 <meta http-equiv=Content-Security-Policy></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(resourceHtml);
    });

    it("applyCspMeta finds a real head after stray less-than text", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html>1 < 2 <head data-real></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<html>1 < 2 <head data-real>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head></html>`,
      );
    });

    it.each([
      ["bogus markup declaration", `<!bogus <meta http-equiv=Content-Security-Policy>`],
      ["bogus processing instruction", `<?bogus <meta http-equiv=Content-Security-Policy>`],
    ])("applyCspMeta ignores CSP-meta text in a %s", async (_description, bogusComment) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head>${bogusComment}</head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<html><head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'">${bogusComment}</head></html>`,
      );
    });

    it("applyCspMeta ignores a CSP meta inside a quoted doctype identifier", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<!DOCTYPE html PUBLIC "a><meta http-equiv=Content-Security-Policy>"><html><head></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<!DOCTYPE html PUBLIC "a><meta http-equiv=Content-Security-Policy>"><html><head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head></html>`,
      );
    });

    it("applyCspMeta ignores a head inside a quoted doctype identifier", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<!DOCTYPE html PUBLIC "a><head data-decoy>"><html><head data-real></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `<!DOCTYPE html PUBLIC "a><head data-decoy>"><html><head data-real>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head></html>`,
      );
    });

    it.each([
      ["style raw-text content", `<style>/* <meta http-equiv=Content-Security-Policy> */</style>`],
      ["title RCDATA content", `<title><meta http-equiv=Content-Security-Policy></title>`],
      ["textarea RCDATA content", `<textarea><meta http-equiv=Content-Security-Policy></textarea>`],
      ["template content", `<template><meta http-equiv=Content-Security-Policy></template>`],
      ["nested template content", `<template><template></template><meta http-equiv=Content-Security-Policy></template>`],
      ["xmp raw-text content", `<xmp><meta http-equiv=Content-Security-Policy></xmp>`],
      ["iframe raw-text content", `<iframe><meta http-equiv=Content-Security-Policy></iframe>`],
      ["noembed raw-text content", `<noembed><meta http-equiv=Content-Security-Policy></noembed>`],
      ["noframes raw-text content", `<noframes><meta http-equiv=Content-Security-Policy></noframes>`],
      ["noscript raw-text content", `<noscript><meta http-equiv=Content-Security-Policy></noscript>`],
      ["plaintext content", `<plaintext><meta http-equiv=Content-Security-Policy>`],
    ])("applyCspMeta injects when a CSP-meta decoy appears only in %s", async (_description, inertContent) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head>${inertContent}</head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toContain(
        `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'">${inertContent}`,
      );
    });

    it.each([
      ["style raw-text content", `<style>/* <head data-decoy> */</style>`],
      ["title RCDATA content", `<title><head data-decoy></title>`],
      ["textarea RCDATA content", `<textarea><head data-decoy></textarea>`],
      ["nested template content", `<template><template></template><head data-decoy></head></template>`],
    ])("applyCspMeta inserts into the real head after a %s", async (_description, inertContent) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `${inertContent}<html><head data-real="true"></head><body>Content</body></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(
        `${inertContent}<html><head data-real="true">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head><body>Content</body></html>`,
      );
    });

    it.each([
      ["decimal numeric references", `&#67;ontent&#45;Security&#45;Policy`],
      ["hexadecimal numeric references", `&#x43;ontent&#x2d;Security&#X2D;Policy`],
    ])("applyCspMeta preserves an existing CSP meta tag with %s in http-equiv", async (_description, httpEquiv) => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = `<html><head><meta http-equiv="${httpEquiv}" content="img-src https://images.example.com"></head></html>`;

      expect(applyCspMeta(resourceHtml, "default-src 'none'")).toBe(resourceHtml);
    });

    it("applyCspMeta leaves HTML unchanged when metadata is absent", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = "<main>Content</main>";

      expect(applyCspMeta(resourceHtml, undefined)).toBe(resourceHtml);
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
