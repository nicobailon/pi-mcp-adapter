# CSP Metadata Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept CSP metadata from standard MCP Apps, legacy pi-mcp-adapter resources, and OpenAI-compatible resources while retaining both reliable response-header enforcement and the existing HTML-injection utility.

**Architecture:** `UiResourceHandler` normalizes provider-specific metadata into `UiResourceCsp`. `buildCspMetaContent` remains the single serializer and sanitizer, `/ui-app` continues enforcing its output as an HTTP header, and `applyCspMeta` is restored as a compatibility utility without duplicating the server policy.

**Tech Stack:** TypeScript, Node.js HTTP server, Vitest, MCP SDK resource metadata.

## Global Constraints

- Preserve CSP tags already authored inside provider HTML.
- Preserve content-resource metadata precedence over matching `resources/list` metadata.
- Do not add dependencies or restructure unrelated UI code.
- Reject CSP source values containing whitespace, control characters, semicolons, or quotes.
- `/ui-app` must return provider HTML unchanged while enforcing normalized metadata through the response header.

---

### Task 1: Restore the CSP HTML-Injection Compatibility Utility

**Files:**
- Modify: `host-html-template.ts:400-440`
- Test: `__tests__/host-html-template.test.ts:280-300`

**Interfaces:**
- Consumes: `html: string` and serialized `cspContent: string | undefined`.
- Produces: exported `applyCspMeta(html: string, cspContent: string | undefined): string`.

- [ ] **Step 1: Add failing compatibility tests**

Add these tests at the end of the `CSP handling` describe block in `__tests__/host-html-template.test.ts`:

```ts
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

    it("applyCspMeta leaves HTML unchanged when metadata is absent", async () => {
      const { applyCspMeta } = await import("../host-html-template.ts");
      const resourceHtml = "<main>Content</main>";

      expect(applyCspMeta(resourceHtml, undefined)).toBe(resourceHtml);
    });
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npx vitest run __tests__/host-html-template.test.ts
```

Expected: FAIL because `applyCspMeta` is not exported.

- [ ] **Step 3: Restore the utility and attribute escaping**

Add this after `sanitizeCspDomains` in `host-html-template.ts`:

```ts
export function applyCspMeta(html: string, cspContent: string | undefined): string {
  if (!cspContent) return html;
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html;

  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(cspContent)}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${metaTag}`);
  }
  return `${metaTag}\n${html}`;
}
```

Add this after `escapeHtml`:

```ts
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
```

Do not call `applyCspMeta` from `/ui-app`; the response header already enforces the normalized policy.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
npx vitest run __tests__/host-html-template.test.ts
```

Expected: all `host-html-template` tests PASS.

- [ ] **Step 5: Commit the restored compatibility API**

```bash
git add host-html-template.ts __tests__/host-html-template.test.ts
git commit -m "fix: retain CSP metadata injection utility"
```

---

### Task 2: Normalize OpenAI-Compatible CSP Metadata

**Files:**
- Modify: `ui-resource-handler.ts:120-150`
- Test: `__tests__/ui-resource-handler.test.ts:225-285`

**Interfaces:**
- Consumes: standard `_meta.ui.csp`, legacy granular fields in `_meta.ui.csp`, and `_meta["openai/widgetCSP"]` with snake_case domain arrays.
- Produces: normalized `UiResourceMeta.csp` using `resourceDomains`, `connectDomains`, and `frameDomains` while retaining any standard or granular fields.

- [ ] **Step 1: Add failing content and list metadata tests**

Add these tests after `extracts standard resourceDomains CSP metadata` in `__tests__/ui-resource-handler.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npx vitest run __tests__/ui-resource-handler.test.ts
```

Expected: the OpenAI compatibility tests FAIL because top-level `openai/widgetCSP` is ignored.

- [ ] **Step 3: Implement provider metadata normalization**

Import `UiResourceCsp` alongside the existing resource types:

```ts
import type { UiResourceContent, UiResourceCsp, UiResourceMeta } from "./types.ts";
```

Replace `extractUiMeta` with the following implementation and helpers:

```ts
function extractUiMeta(meta: Record<string, unknown> | undefined): UiResourceMeta {
  if (!meta || typeof meta !== "object") return {};

  const ui = isRecord(meta.ui) ? meta.ui : undefined;
  const out: UiResourceMeta = {};
  const openAiCsp = normalizeOpenAiWidgetCsp(meta["openai/widgetCSP"]);
  const standardCsp = ui && isRecord(ui.csp)
    ? ui.csp as UiResourceCsp
    : undefined;

  if (openAiCsp || standardCsp) {
    out.csp = { ...openAiCsp, ...standardCsp };
  }
  if (ui && isRecord(ui.permissions)) {
    out.permissions = ui.permissions as UiResourceMeta["permissions"];
  }
  if (ui && typeof ui.domain === "string") {
    out.domain = ui.domain;
  }
  if (ui && typeof ui.prefersBorder === "boolean") {
    out.prefersBorder = ui.prefersBorder;
  }

  return out;
}

function normalizeOpenAiWidgetCsp(value: unknown): UiResourceCsp | undefined {
  if (!isRecord(value)) return undefined;

  const csp: UiResourceCsp = {};
  if (value.resource_domains !== undefined) {
    csp.resourceDomains = value.resource_domains as string[];
  }
  if (value.connect_domains !== undefined) {
    csp.connectDomains = value.connect_domains as string[];
  }
  if (value.frame_domains !== undefined) {
    csp.frameDomains = value.frame_domains as string[];
  }
  return csp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

This keeps content-vs-list precedence unchanged because `readUiResource` still uses `contentMeta.csp ?? listMeta.csp`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
npx vitest run __tests__/ui-resource-handler.test.ts
```

Expected: all `ui-resource-handler` tests PASS.

- [ ] **Step 5: Run the serializer and server CSP tests**

Run:

```bash
npx vitest run __tests__/host-html-template.test.ts __tests__/ui-server.test.ts
```

Expected: all tests PASS, including header enforcement and unchanged provider HTML.

- [ ] **Step 6: Commit provider normalization**

```bash
git add ui-resource-handler.ts __tests__/ui-resource-handler.test.ts
git commit -m "feat: normalize OpenAI widget CSP metadata"
```

---

### Task 3: Document Compatibility and Verify the Complete Change

**Files:**
- Modify: `README.md:346-355`
- Modify: `CHANGELOG.md:7-13`
- Test: all test files through the project test script

**Interfaces:**
- Consumes: the supported metadata and enforcement behavior from Tasks 1 and 2.
- Produces: user-facing compatibility documentation and final verification evidence.

- [ ] **Step 1: Update the README compatibility statement**

Replace the existing CSP bullet in `README.md` with:

```md
- Enforces CSP from standard `_meta.ui.csp`, OpenAI-compatible `_meta["openai/widgetCSP"]`, and granular legacy domain fields. Provider metadata is normalized into an HTTP response policy while app-authored CSP meta tags remain intact.
```

- [ ] **Step 2: Update the changelog entry**

Replace the current unreleased CSP bullet in `CHANGELOG.md` with:

```md
- Rendered MCP Apps from multiple providers by supporting standard `_meta.ui.csp`, OpenAI-compatible `_meta["openai/widgetCSP"]`, and granular legacy CSP domain fields without removing existing HTML metadata handling.
```

- [ ] **Step 3: Run formatting and whitespace validation**

Run:

```bash
git diff --check
```

Expected: no output and exit status 0.

- [ ] **Step 4: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all Vitest test files and tests PASS.

- [ ] **Step 5: Review the final scoped diff**

Run:

```bash
git diff origin/main...HEAD -- host-html-template.ts ui-resource-handler.ts ui-server.ts types.ts README.md CHANGELOG.md __tests__/host-html-template.test.ts __tests__/ui-resource-handler.test.ts __tests__/ui-server.test.ts
```

Expected: `resourceDomains` support and OpenAI normalization are present; `applyCspMeta` is restored; `/ui-app` retains header enforcement and returns original HTML; no unrelated files changed.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe CSP metadata compatibility"
```
