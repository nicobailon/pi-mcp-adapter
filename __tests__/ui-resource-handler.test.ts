import { describe, it, expect, vi, beforeEach } from "vitest";
import { UiResourceHandler } from "../ui-resource-handler.ts";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerManager } from "../server-manager.ts";

// Mock the manager
function createMockManager(overrides: Partial<McpServerManager> = {}): McpServerManager {
  return {
    readResource: vi.fn(),
    getConnection: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as McpServerManager;
}

describe("UiResourceHandler", () => {
  describe("readUiResource", () => {
    it("throws for non-ui:// URIs", async () => {
      const manager = createMockManager();
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "https://example.com")).rejects.toThrow(
        /URI must start with ui:\/\//
      );
    });

    it("preserves URL-required errors for the outer tool adapter", async () => {
      const error = new UrlElicitationRequiredError([{
        mode: "url",
        message: "Connect",
        elicitationId: "connect-1",
        url: "https://example.com/connect",
      }]);
      const manager = createMockManager({ readResource: vi.fn().mockRejectedValue(error) });
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "ui://test/widget")).rejects.toBe(error);
    });

    it("reads and returns HTML from text content", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Hello</h1>",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.uri).toBe("ui://test/widget");
      expect(result.html).toBe("<h1>Hello</h1>");
      expect(result.mimeType).toBe("text/html");
    });

    it("reads and decodes blob content", async () => {
      const htmlContent = "<div>Blob content</div>";
      const base64Content = Buffer.from(htmlContent).toString("base64");

      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              blob: base64Content,
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.html).toBe(htmlContent);
    });

    it("throws for empty content", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "   ",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "ui://test/widget")).rejects.toThrow(
        /content is empty/
      );
    });

    it("throws for unsupported MIME type", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "application/json",
              text: '{"key": "value"}',
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "ui://test/widget")).rejects.toThrow(
        /unsupported MIME type/
      );
    });

    it("accepts text/html;profile=mcp-app MIME type", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html;profile=mcp-app",
              text: "<app>content</app>",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.html).toBe("<app>content</app>");
    });

    it("throws when no contents returned", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [],
        }),
      });
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "ui://test/widget")).rejects.toThrow(
        "No contents returned for UI resource: ui://test/widget"
      );
    });

    it("prefers content with matching URI", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://other/widget",
              mimeType: "text/html",
              text: "<h1>Wrong</h1>",
            },
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Correct</h1>",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.html).toBe("<h1>Correct</h1>");
    });

    it("falls back to first HTML content if no URI match", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              mimeType: "application/json",
              text: "{}",
            },
            {
              mimeType: "text/html",
              text: "<h1>HTML</h1>",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.html).toBe("<h1>HTML</h1>");
    });

    it("extracts CSP meta from content _meta", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  csp: {
                    scriptDomains: ["'self'", "cdn.example.com"],
                    styleDomains: ["'self'"],
                  },
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        scriptDomains: ["'self'", "cdn.example.com"],
        styleDomains: ["'self'"],
      });
    });

    it("extracts standard resourceDomains CSP metadata", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  csp: {
                    resourceDomains: ["https://esm.sh"],
                    connectDomains: ["https://esm.sh"],
                  },
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://esm.sh"],
      });
    });

    it("normalizes OpenAI widget CSP metadata from resource content", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [{
            uri: "ui://test/widget",
            mimeType: "text/html",
            text: "<h1>Content</h1>",
            _meta: {
              "openai/widgetCSP": {
                resource_domains: ["https://cdn.example.com"],
                connect_domains: ["https://api.example.com"],
                frame_domains: ["https://frames.example.com"],
              },
            },
          }],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://cdn.example.com"],
        connectDomains: ["https://api.example.com"],
        frameDomains: ["https://frames.example.com"],
      });
    });

    it("normalizes OpenAI widget CSP metadata from resources/list", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [{
            uri: "ui://test/widget",
            mimeType: "text/html",
            text: "<h1>Content</h1>",
          }],
        }),
        getConnection: vi.fn().mockReturnValue({
          resources: [{
            uri: "ui://test/widget",
            _meta: {
              "openai/widgetCSP": {
                resource_domains: ["https://cdn.example.com"],
                connect_domains: ["https://api.example.com"],
              },
            },
          }],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://cdn.example.com"],
        connectDomains: ["https://api.example.com"],
      });
    });

    it("lets standard CSP fields override equivalent OpenAI compatibility fields", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [{
            uri: "ui://test/widget",
            mimeType: "text/html",
            text: "<h1>Content</h1>",
            _meta: {
              ui: {
                csp: {
                  resourceDomains: ["https://standard.example.com"],
                  scriptDomains: ["https://scripts.example.com"],
                },
              },
              "openai/widgetCSP": {
                resource_domains: ["https://openai.example.com"],
                connect_domains: ["https://api.example.com"],
              },
            },
          }],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://standard.example.com"],
        connectDomains: ["https://api.example.com"],
        scriptDomains: ["https://scripts.example.com"],
      });
    });

    it("copies only string arrays from standard and OpenAI CSP metadata", async () => {
      const standardResourceDomains = ["https://standard.example.com"];
      const standardBaseUriDomains = ["https://base.example.com"];
      const standardScriptDomains = ["https://scripts.example.com"];
      const openAiConnectDomains = ["https://api.example.com"];
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [{
            uri: "ui://test/widget",
            mimeType: "text/html",
            text: "<h1>Content</h1>",
            _meta: {
              ui: {
                csp: {
                  resourceDomains: standardResourceDomains,
                  connectDomains: ["https://mixed.example.com", 42],
                  frameDomains: "https://scalar.example.com",
                  baseUriDomains: standardBaseUriDomains,
                  scriptDomains: standardScriptDomains,
                  styleDomains: ["https://mixed-style.example.com", false],
                },
              },
              "openai/widgetCSP": {
                resource_domains: ["https://mixed-openai.example.com", null],
                connect_domains: openAiConnectDomains,
                frame_domains: null,
              },
            },
          }],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: standardResourceDomains,
        connectDomains: openAiConnectDomains,
        baseUriDomains: standardBaseUriDomains,
        scriptDomains: standardScriptDomains,
      });
      expect(result.meta.csp?.resourceDomains).not.toBe(standardResourceDomains);
      expect(result.meta.csp?.connectDomains).not.toBe(openAiConnectDomains);
    });

    it("prefers conflicting content CSP over resource-list CSP", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [{
            uri: "ui://test/widget",
            mimeType: "text/html",
            text: "<h1>Content</h1>",
            _meta: {
              ui: {
                csp: {
                  resourceDomains: ["https://content.example.com"],
                },
              },
            },
          }],
        }),
        getConnection: vi.fn().mockReturnValue({
          resources: [{
            uri: "ui://test/widget",
            _meta: {
              "openai/widgetCSP": {
                resource_domains: ["https://list.example.com"],
              },
            },
          }],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://content.example.com"],
      });
    });

    it("extracts permissions meta", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  permissions: {
                    camera: {},
                    microphone: {},
                  },
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.permissions).toEqual({
        camera: {},
        microphone: {},
      });
    });

    it("extracts domain and prefersBorder meta", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  domain: "example.com",
                  prefersBorder: true,
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.domain).toBe("example.com");
      expect(result.meta.prefersBorder).toBe(true);
    });

    it("throws when content has no text or blob", async () => {
      const manager = createMockManager({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              // No text or blob
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "ui://test/widget")).rejects.toThrow(
        "did not include text or blob content"
      );
    });
  });
});
