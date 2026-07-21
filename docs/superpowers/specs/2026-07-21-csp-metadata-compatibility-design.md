# CSP Metadata Compatibility Design

## Goal

Support CSP declarations from standard MCP Apps, legacy pi-mcp-adapter resources, and OpenAI-compatible resources without removing existing CSP handling APIs or app-authored CSP policies.

## Supported inputs

The adapter will normalize these resource metadata dialects into `UiResourceCsp`:

1. Standard MCP Apps `_meta.ui.csp`, using camelCase `resourceDomains`, `connectDomains`, `frameDomains`, and `baseUriDomains`.
2. Legacy pi-mcp-adapter fields under `_meta.ui.csp`, including `scriptDomains`, `styleDomains`, `fontDomains`, `imgDomains`, `mediaDomains`, and `workerDomains`.
3. OpenAI-compatible `_meta["openai/widgetCSP"]`, mapping `resource_domains`, `connect_domains`, and `frame_domains` to the standard internal fields.

Metadata remains readable from both resource content returned by `resources/read` and the matching resource entry from `resources/list`. Content metadata retains its existing precedence over list metadata.

## Enforcement

`buildCspMetaContent` will continue producing one sanitized browser CSP from the normalized metadata. Standard `resourceDomains` apply to scripts, styles, images, fonts, media, and workers; granular legacy fields augment their corresponding directives.

The `/ui-app` response will enforce normalized metadata with the HTTP `Content-Security-Policy` header. This is independent of document markup and combines restrictively with any CSP `<meta>` already authored by the app.

The adapter will restore and retain `applyCspMeta` as a backward-compatible HTML-injection utility, including its behavior of preserving an existing app-authored CSP meta tag. `/ui-app` will not call it because doing so would duplicate the same host policy already sent in the response header.

## Security and malformed input

Only arrays of safe, non-empty CSP source strings are accepted. Values containing whitespace, control characters, semicolons, or quotes are rejected so metadata cannot inject additional directives. Malformed containers fail closed to the adapter's trusted defaults.

## Alternatives considered

- **Meta injection only:** preserves the old implementation but can miss malformed documents and skips provider metadata whenever the app already contains a CSP tag.
- **Header only and remove the helper:** provides reliable enforcement but creates an unnecessary compatibility break for consumers of `applyCspMeta`.
- **Selected — header enforcement plus retained helper:** reliably enforces metadata, preserves app-authored policies, and avoids removing the established API.

## Testing

Tests will cover:

- Standard, granular legacy, and OpenAI-compatible metadata normalization.
- Metadata extraction from content and list responses.
- `resourceDomains` directive mapping and sanitization.
- Response-header enforcement while preserving app HTML unchanged.
- Restored `applyCspMeta` injection, existing-tag preservation, and attribute escaping.
