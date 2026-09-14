# OAuth 2.1 Authentication for MCP

This document describes the OAuth 2.1 + PKCE authentication implementation for the Pi MCP Adapter using the official MCP SDK.

## Overview

The Pi MCP Adapter uses the official MCP SDK's built-in OAuth implementation, which provides:

- **Automatic OAuth endpoint discovery** (RFC 9728) - No manual configuration needed
- **Dynamic Client Registration** (RFC 7591) - The default for URL-only servers when no pre-registered `clientId` is configured and the server supports registration
- **Client ID Metadata Documents** (SEP-991) - An advanced opt-in that uses an operator-supplied public HTTPS metadata URL as `client_id` when the authorization server opts in
- **Automatic callback handling** - Built-in HTTP server handles callbacks automatically
- **Automatic token refresh** - SDK handles token refresh transparently

## Features

- **PKCE (S256)** - Mandatory code challenge method for OAuth 2.1
- **Automatic Callback Server** - Local browser redirects automatically when available
- **Manual Remote Flow** - Copy auth URLs and pasted redirect URLs/codes for headless SSH sessions
- **Dynamic Client Registration** - Registers by default when no pre-registered client is configured and the server supports registration
- **Client ID Metadata Documents** - Opts into a configured, operator-hosted URL-based client ID when the authorization server advertises support
- **Auto-Discovery** - Discovers OAuth endpoints from server metadata
- **Automatic Token Refresh** - SDK handles expired tokens automatically
- **State Parameter Validation** - CSRF protection
- **Secure Token Storage** - Persistent OAuth entries are stored in the operating system credential store

## Configuration

### Minimal Configuration (Recommended)

For most MCP servers, you only need the URL:

```json
{
  "mcpServers": {
    "my-oauth-server": {
      "url": "https://api.example.com/mcp"
    }
  }
}
```

OAuth is automatically enabled for HTTP servers. The SDK will:
- Auto-detect if the server requires OAuth
- Discover OAuth endpoints from the server
- Use Dynamic Client Registration when no pre-registered client is configured and the server supports it
- Handle the entire OAuth flow including callback

Pi does not configure or host a Client ID Metadata Document by default. URL-only configurations continue to use Dynamic Client Registration. CIMD is available only through the advanced, operator-supplied `oauth.clientMetadataUrl` option below.

### Optional Configuration

You can optionally provide a pre-registered client:

```json
{
  "mcpServers": {
    "my-oauth-server": {
      "url": "https://api.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "scope": "read write",
        "authorizationParams": { "access_type": "offline", "prompt": "consent" },
        "redirectUri": "http://localhost:3118/callback"
      }
    }
  }
}
```



### Configuration Options

- `url` - The MCP server URL (required)
- `auth` - Set to `"oauth"` to force OAuth, `false` to disable, or omit to auto-detect
- `oauth.grantType` - `"authorization_code"` (default, browser flow) or `"client_credentials"` (non-interactive)
- `oauth.clientId` - Pre-registered client ID. Takes precedence over `oauth.clientMetadataUrl` when both are configured.
- `oauth.clientSecret` - Client secret for confidential clients (optional). When `oauth.clientMetadataUrl` is also set, an explicit `oauth.clientId` is required; the explicit client takes precedence.
- `oauth.clientMetadataUrl` - Advanced opt-in for an operator-supplied public HTTPS Client ID Metadata Document URL with a non-root path. The URL is used as `client_id` when the authorization server advertises `client_id_metadata_document_supported: true`; otherwise Dynamic Client Registration remains the fallback. The document must be publicly fetchable and match this client's metadata, especially `redirect_uris`. The adapter does not provide a default URL or host this document.
- `oauth.scope` - Requested OAuth scopes (optional)
- `oauth.authorizationParams` - Extra authorization URL parameters for provider-specific extensions, such as Google's `{ "access_type": "offline", "prompt": "consent" }`. Flow-owned parameters like `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `response_type`, and `resource` cannot be overridden.
- `oauth.redirectUri` - Browser callback URI to advertise and bind, such as `http://localhost:3118/callback`. Use `{port}` in a loopback URI when the provider permits an OS-assigned RFC 8252 port, for example `http://127.0.0.1:{port}/callback` (optional)
- `oauth.clientName` - Client display name used for Dynamic Client Registration fallback (optional, defaults to `Pi Coding Agent`)
- `oauth.clientUri` - Client homepage URI used for Dynamic Client Registration fallback (optional)
- `oauth.authServerMetadataUrl` - HTTPS OAuth/OIDC authorization-server metadata document to use authoritatively when MCP protected-resource discovery is unavailable (optional; issuer validation remains enabled)
- `oauth.skipIssuerMetadataValidation` - Set `true` only for a known-misconfigured authorization server whose metadata issuer cannot be fixed immediately. This weakens OAuth issuer validation.

Dynamic fallback clients normally omit `oauth.redirectUri`; the adapter starts the callback server lazily on the default loopback host (`localhost`) and asks the OS for an available local port when auth begins. Use `oauth.redirectUri` when the provider requires a pre-registered callback, such as Slack MCP's Claude-compatible `http://localhost:3118/callback`. A loopback URI must use `http://` with `localhost`, `127.0.0.1`, or `[::1]`. It may contain an explicit port, which is bound exactly, or `{port}`, which is replaced with the OS-assigned port in the authorization and token requests.

### Non-Interactive `client_credentials`

For machine-to-machine OAuth, configure `grantType: "client_credentials"`.

```json
{
  "mcpServers": {
    "my-service": {
      "url": "https://api.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "grantType": "client_credentials",
        "clientId": "service-client-id",
        "clientSecret": "service-client-secret",
        "scope": "read write"
      }
    }
  }
}
```

This flow does not open a browser or use callback handling. `oauth.redirectUri` is ignored for `client_credentials`; `oauth.clientName` and `oauth.clientUri` still apply to dynamic client registration metadata.

## Usage

### Step 1: Authenticate

Run the `/mcp-auth` command with the server name:

```
/mcp-auth my-oauth-server
```

Manual `/mcp-auth` is the default flow. If you set `settings.autoAuth: true`, proxy/direct tool execution will trigger OAuth automatically when a server returns `needs-auth`, then retry the original operation once.

This will:
1. Start the callback server lazily on an OS-assigned local port, on an OS-assigned host-specific `{port}` callback, or on the exact `oauth.redirectUri` port for fixed callbacks
2. Discover OAuth endpoints automatically
3. Use Dynamic Client Registration by default, or the explicitly configured Client ID Metadata Document when supported
4. Open your browser for authentication
5. Wait for the automatic callback
6. Complete the OAuth flow
7. Store tokens securely

### Remote/headless authentication

When Pi runs over SSH or in a headless environment, use the proxy tool to retrieve the authorization URL instead of relying on OS browser launch:

```
mcp({ action: "auth-start", server: "my-oauth-server" })
```

Open the returned URL in your local browser. After approval, copy the full redirected localhost URL from the browser address bar (the page may fail to load locally) and complete the same pending auth flow:

```
mcp({
  action: "auth-complete",
  server: "my-oauth-server",
  args: { redirectUrl: "http://localhost:19876/callback?code=...&state=..." }
})
```

You can also pass only the `code` query parameter with `args: { code: "..." }`. JSON-string args remain supported. Redirect URL completion validates the saved OAuth state; raw code completion is available for providers that display a code directly.

### Step 2: Use the Server

Once authenticated, use the server normally:

```
mcp({ server: "my-oauth-server" })
mcp({ tool: "my-tool", args: { key: "value" } })
```

The SDK automatically:
- Adds the access token to requests
- Refreshes expired tokens automatically
- Re-authenticates if tokens are invalid

To clear stored OAuth credentials and force a fresh authorization:

```
/mcp logout my-oauth-server
```

Within one Pi process, logout is a linearizable boundary: OAuth work that began
before logout cannot recreate credentials after they are cleared, and new OAuth
work is admitted after logout finishes. Explicit token updates made through the
public API retain last-writer semantics. Separate Pi processes are intentionally
not coordinated, so concurrent cross-process credential operations can still race.

## How It Works

### Authentication Flow

```
┌─────────┐     ┌──────────────┐     ┌─────────────────┐
│   Pi    │────▶│  MCP Server  │────▶│  OAuth Server   │
│         │     │              │     │                 │
│ 1. Init │     │ 2. Discovery │     │ 3. Register     │
│         │     │              │     │                 │
│         │◀────│              │◀────│ 4. Auth URL     │
│         │     │              │     │                 │
│         │────▶│  Callback    │◀────│ 5. Browser      │
│         │     │  Server      │     │    Redirect     │
│         │     │              │     │                 │
│         │◀────│              │◀────│ 6. Code         │
│         │     │              │     │                 │
│         │────▶│              │────▶│ 7. Exchange     │
│         │     │              │     │                 │
│         │◀────│              │◀────│ 8. Tokens       │
└─────────┘     └──────────────┘     └─────────────────┘
```

### Auto-Discovery

The SDK attempts to discover OAuth endpoints using:

1. **RFC 9728 Metadata** - Fetches `/.well-known/oauth-protected-resource`
2. **WWW-Authenticate Header** - Parses `resource_metadata` from 401 responses

### Client ID Metadata Documents and Dynamic Registration

CIMD is an advanced, explicit opt-in. Set `oauth.clientMetadataUrl` to a stable, operator-supplied public HTTPS URL that serves this client's OAuth metadata. When authorization-server discovery advertises `client_id_metadata_document_supported: true`, the adapter and SDK use that URL directly as `client_id` and skip Dynamic Client Registration. The URL must have a non-root path. An explicit `oauth.clientId` takes precedence. Combining `oauth.clientMetadataUrl` with `oauth.clientSecret` without an explicit `oauth.clientId` is rejected.

The adapter does not provide a default URL or host the public document: operators must publish it and keep fields such as `redirect_uris`, `grant_types`, `response_types`, and `token_endpoint_auth_method` consistent with the configured flow. URL-only/default Pi configurations therefore continue to use Dynamic Client Registration. When the server does not advertise CIMD support, or no metadata URL is configured, the SDK uses Dynamic Client Registration if the server supports it:

1. Discovers the registration endpoint from OAuth metadata
2. Registers a new client with:
   - `client_name`: configured `oauth.clientName` or "Pi Coding Agent"
   - `client_uri`: configured `oauth.clientUri` or the adapter repository URL
   - `redirect_uris`: `["http://localhost:<active-callback-port>/callback"]`, or the configured `oauth.redirectUri`
   - `grant_types`: `["authorization_code", "refresh_token"]`
3. Stores the registered client credentials and the redirect URIs returned by the authorization server

When a fresh browser auth starts, cached dynamic fallback client info with tokens is re-registered if its stored redirect URIs are missing or do not include the current redirect URI. Token refresh does not perform this redirect check, so existing refresh-token grants keep working even after a callback setting changes.

### Callback Server

A Node.js HTTP server runs on a loopback callback endpoint and handles the active callback path:

- Dynamic registration starts the callback server only when auth begins, binds the default host `localhost`, and asks the OS for an available local port
- Pre-registered clients (`oauth.clientId`) without `oauth.redirectUri` require the exact configured callback port from `MCP_OAUTH_CALLBACK_PORT` or the default `19876` on `localhost`
- `oauth.redirectUri` binds the exact loopback host and path. An explicit port is bound exactly; `{port}` asks the OS for a port and is replaced with that assigned value before the URI is advertised to the provider

- Handles `code`, `state`, and `error` parameters
- Displays success/error HTML pages
- Validates state parameter for CSRF protection
- Has a 5-minute timeout for pending authorizations

## Token Storage

Persistent OAuth entries are stored per configured server name in the operating system credential store, using macOS Keychain, Windows Credential Manager, or Linux Secret Service/libsecret through `@napi-rs/keyring`. The stored entry contains tokens, dynamic client information, legacy verifier/state fields when present, and the server URL binding.

Windows Credential Manager cannot hold a typical large OAuth JSON blob in one value, so payloads over 1,000 UTF-16 code units are stored as a manifest plus chunks; the size-limited test store uses the same representation. macOS Keychain and Linux Secret Service keep each record in one item, including ordinary 8–10 KiB records; if an unusually large record exceeds the native store's actual limit, that store error is surfaced. This avoids separate prompts for digest-addressed Keychain chunks. On macOS and Linux, the first ordinary read of a previously chunked record validates and rewrites it as one item before cleaning up its old chunks. Windows and the size-limited test store retain the chunked representation. Status inspection reads the existing representation but does not compact it; existing secure-record and legacy-plaintext cleanup semantics still apply.

The adapter fails closed when the OS credential store is unavailable. On headless Linux, configure an unlocked Secret Service-compatible keyring before using persistent OAuth; the adapter does not silently fall back to plaintext token files. Windows OpenSSH network logons may report `ERROR_NO_SUCH_LOGON_SESSION` (1312) because Credential Manager has no credential set for that logon.

For Windows OpenSSH/headless use, `settings.oauthCredentialStore: "encrypted-file"` explicitly selects an AES-256-GCM file store. It requires `PI_MCP_ADAPTER_OAUTH_FILE_KEY` to contain canonical base64 for exactly 32 random bytes; generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and inject it through an external secret mechanism. Never place the key in config or beside the ciphertext. One authenticated, versioned envelope is stored per hashed server account at `<Pi agent directory>/mcp-oauth-encrypted/sha256-<server-hash>/credentials.json`. The server URL and secrets appear only inside ciphertext, and account-bound authenticated data prevents copying an envelope to another account.

Encrypted-file writes use private directory/file modes where supported and same-directory atomic replacement. POSIX modes are checked on reads, but they do not establish a Windows ACL; encryption with the external key is the confidentiality boundary. This backend never falls back to the OS store, reads `oauthDir` / `MCP_OAUTH_DIR`, or imports legacy plaintext. Reauthenticate after opting in. Key loss or rotation makes existing envelopes unreadable; remove them and reauthenticate with the new key.

On Linux, if credential access fails because Pi inherited a revoked session keyring, the adapter makes one best-effort retry through `keyctl session - node <packaged helper>`. This lets explicit re-authentication write fresh credentials from a new session keyring without restarting a long-lived tmux or server process. The recovery path requires `keyctl` and `node` on `PATH`; missing, locked, or otherwise unavailable credential stores still fail closed.

Complete credential entries are held in memory for the lifetime of the Pi process on every supported credential-store platform. The MCP SDK reads the access token before every outbound request, so caching avoids a credential-store lookup on each tool call; on Linux this specifically avoids overloading the Secret Service daemon. The cache is filled on the first read for a server and covers both present and absent entries. Authenticating, refreshing, and logging out all update it immediately, so credential changes made through Pi take effect at once. Status-panel inspection deliberately bypasses it and still reads the store directly.

A credential changed or deleted by another process while Pi is running is not observed immediately. The affected server picks it up after the first credential-backed authentication failure in that `needs-auth` episode: Pi discards the cached entry, and the following read reloads from the credential store. Restarting Pi also clears the cache. Set `PI_MCP_ADAPTER_DISABLE_AUTH_CACHE=1` to turn the cache off entirely and restore a credential-store read per request.

Older versions stored plaintext entries at `~/.pi/agent/mcp-oauth/sha256-<server-hash>/tokens.json`, or under `settings.oauthDir` / `MCP_OAUTH_DIR`. With the default OS backend, the first read after upgrade imports a valid legacy entry and removes the plaintext `tokens.json`. The encrypted-file backend leaves legacy files untouched. These directories are legacy import locations, not persistent credential stores or isolation namespaces.

The stored `serverUrl` field ensures credentials are invalidated if the server URL changes.

## Security Considerations

### PKCE

All OAuth flows use PKCE with the S256 method, preventing authorization code interception attacks.

### State Parameter

A cryptographically secure random state parameter is generated for each flow and validated on callback.

### Issuer Metadata Validation

OAuth authorization-server metadata normally must echo the expected issuer. This protects against authorization-server mix-up. The adapter keeps this check on by default.

For private servers with known-broken metadata, `oauth.skipIssuerMetadataValidation: true` forwards the SDK's issuer-validation opt-out for that server only. Use it only as a temporary workaround while the server metadata is fixed. Do not use it for public or untrusted servers.

When an MCP server does not publish usable protected-resource metadata, configure `oauth.authServerMetadataUrl` with the HTTPS URL of its OAuth/OIDC authorization-server metadata document. That document is authoritative instead of MCP protected-resource discovery, and its issuer is still checked by default. Treat this as trusted configuration and point it only at a metadata endpoint you explicitly trust.

### Credential Stores

Persistent OAuth credentials are written to the OS credential store by default, or only to the encrypted file store when explicitly selected. Legacy plaintext files are read only for one-way migration to the default OS store and are removed after successful import. On Linux, revoked session-keyring errors can be retried once through a fresh `keyctl session` helper during explicit re-authentication.

Credential entries reside in process memory for the lifetime of the Pi process rather than being re-read per request, and the process-memory copy is discarded on exit.

### URL Validation

Credentials are tied to a specific server URL. If the URL changes, the credentials are invalidated and re-authentication is required.

## Troubleshooting

### "No OAuth tokens found"

Run `/mcp-auth <server>` to authenticate.

### "Failed to discover OAuth endpoints"

The SDK automatically discovers OAuth endpoints from the MCP server. If discovery fails, the server may require a pre-registered client ID:

```json
{
  "mcpServers": {
    "server": {
      "url": "https://api.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "clientId": "your-client-id",
        "scope": "read"
      }
    }
  }
}
```

### "Dynamic client registration not supported"

Some servers require pre-registered clients. Obtain a client ID from your OAuth provider and add it to the config.

### Callback server already in use

Dynamic fallback browser OAuth uses a lazy OS-assigned port on the default loopback host (`localhost`), so the configured default port being busy should not block fallback registration.

For pre-registered OAuth clients (`oauth.clientId`), the callback redirect URI must match the provider registration policy. Set `oauth.redirectUri` to the full fixed callback, such as Slack MCP's Claude-compatible `http://localhost:3118/callback`, use a loopback `{port}` URI when the provider explicitly permits dynamic RFC 8252 ports, or free/set `MCP_OAUTH_CALLBACK_PORT` when you rely on the default `/callback` path without an explicit redirect URI.

### Browser doesn't open

If the browser fails to open (e.g., in SSH sessions), the authorization URL will be displayed. Copy it manually to your browser.

## Architecture

The OAuth implementation uses the following modules:

- `mcp-auth.ts` - Auth storage and retrieval through the OS credential store, with one-way legacy `tokens.json` import
- `mcp-oauth-provider.ts` - SDK OAuthClientProvider implementation
- `mcp-callback-server.ts` - Node.js HTTP callback server
- `mcp-auth-flow.ts` - High-level auth flow using SDK transport

## SDK Integration

The implementation uses the stable modular MCP client and OAuth APIs:

```typescript
import {
  auth,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client"
```

The `McpOAuthProvider` class implements `OAuthClientProvider` and is passed to `StreamableHTTPClientTransport`:

```typescript
const transport = new StreamableHTTPClientTransport(url, {
  authProvider: new McpOAuthProvider(serverName, serverUrl, config, callbacks),
})
```

## References

- [MCP SDK Documentation](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-11)
- [PKCE (RFC 7636)](https://datatracker.ietf.org/doc/html/rfc7636)
- [OAuth Client ID Metadata Document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)
- [Dynamic Client Registration (RFC 7591)](https://datatracker.ietf.org/doc/html/rfc7591)
- [OAuth Protected Resource Metadata (RFC 9728)](https://datatracker.ietf.org/doc/html/rfc9728)
