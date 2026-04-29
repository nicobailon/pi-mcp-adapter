import { describe, it, expect, vi, beforeEach } from "vitest";
import { UiResourceHandler } from "../ui-resource-handler.js";
import type { McpServerManager } from "../server-manager.js";

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
                    resourceDomains: ["cdn.example.com"],
                    connectDomains: ["https://api.example.com"],
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
        resourceDomains: ["cdn.example.com"],
        connectDomains: ["https://api.example.com"],
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
