# OAuth 2.1 Authentication for MCP

This document describes the OAuth 2.1 + PKCE authentication implementation for the Pi MCP Adapter using the official MCP SDK.

## Overview

The Pi MCP Adapter uses the official MCP SDK's built-in OAuth implementation, which provides:

- **Automatic OAuth endpoint discovery** (RFC 9728) - No manual configuration needed
- **Dynamic client registration** (RFC 7591) - No clientId needed for most servers
- **Automatic callback handling** - Built-in HTTP server handles callbacks automatically
- **Automatic token refresh** - SDK handles token refresh transparently

## Features

- ✅ **PKCE (S256)** - Mandatory code challenge method for OAuth 2.1
- ✅ **Automatic Callback Server** - No URL copying needed, browser redirects automatically
- ✅ **Dynamic Client Registration** - Automatically registers with OAuth servers
- ✅ **Auto-Discovery** - Discovers OAuth endpoints from server metadata
- ✅ **Automatic Token Refresh** - SDK handles expired tokens automatically
- ✅ **State Parameter Validation** - CSRF protection
- ✅ **Secure Token Storage** - Stored in `~/.pi/agent/mcp-oauth/<server>/tokens.json`

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
- Register a dynamic client (if supported by the server)
- Handle the entire OAuth flow including callback

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
        "scope": "read write"
      }
    }
  }
}
```



### Configuration Options

- `url` - The MCP server URL (required)
- `auth` - Set to `"oauth"` to force OAuth, `false` to disable, or omit to auto-detect
- `oauth.clientId` - Pre-registered client ID (optional, SDK tries dynamic registration if not provided)
- `oauth.clientSecret` - Client secret for confidential clients (optional)
- `oauth.scope` - Requested OAuth scopes (optional)

## Usage

### Step 1: Authenticate

Run the `/mcp-auth` command with the server name:

```
/mcp-auth my-oauth-server
```

This will:
1. Start the callback server (port 19876)
2. Discover OAuth endpoints automatically
3. Register a dynamic client (if no clientId provided)
4. Open your browser for authentication
5. Wait for the automatic callback
6. Complete the OAuth flow
7. Store tokens securely

### Step 2: Use the Server

Once authenticated, use the server normally:

```
mcp({ server: "my-oauth-server" })
mcp({ tool: "my-tool", args: '{"key": "value"}' })
```

The SDK automatically:
- Adds the access token to requests
- Refreshes expired tokens automatically
- Re-authenticates if tokens are invalid

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

### Dynamic Client Registration

If no `clientId` is provided, the SDK:

1. Discovers the registration endpoint from OAuth metadata
2. Registers a new client with:
   - `client_name`: "Pi Coding Agent"
   - `redirect_uris`: `["http://127.0.0.1:19876/mcp/oauth/callback"]`
   - `grant_types`: `["authorization_code", "refresh_token"]`
3. Stores the registered client credentials

### Callback Server

A Node.js HTTP server runs on port 19876 at path `/mcp/oauth/callback`:

- Handles `code`, `state`, and `error` parameters
- Displays success/error HTML pages
- Validates state parameter for CSRF protection
- Has a 5-minute timeout for pending authorizations

## Token Storage

Tokens are stored per-server in `~/.pi/agent/mcp-oauth/<server>/tokens.json`:

```json
{
  "tokens": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
    "expiresAt": 1709769600,
    "scope": "read write"
  },
  "clientInfo": {
    "clientId": "auto-registered-client-id",
    "clientSecret": "auto-generated-secret"
  },
  "serverUrl": "https://api.example.com/mcp"
}
```

Example directory structure:
```
~/.pi/agent/mcp-oauth/
├── linear/
│   └── tokens.json
├── github/
│   └── tokens.json
└── ...
```

The `serverUrl` field ensures credentials are invalidated if the server URL changes.

## Security Considerations

### PKCE

All OAuth flows use PKCE with the S256 method, preventing authorization code interception attacks.

### State Parameter

A cryptographically secure random state parameter is generated for each flow and validated on callback.

### File Permissions

Token files (`tokens.json`) are created with `0o600` permissions and stored in per-server directories with `0o700` permissions (readable only by owner).

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

If port 19876 is already in use, the adapter will use the existing server instance. This is normal if you have multiple Pi sessions.

### Browser doesn't open

If the browser fails to open (e.g., in SSH sessions), the authorization URL will be displayed. Copy it manually to your browser.

## Architecture

The OAuth implementation uses the following modules:

- `mcp-auth.ts` - Auth storage and retrieval (per-server `tokens.json` files)
- `mcp-oauth-provider.ts` - SDK OAuthClientProvider implementation
- `mcp-callback-server.ts` - Node.js HTTP callback server
- `mcp-auth-flow.ts` - High-level auth flow using SDK transport

## SDK Integration

The implementation uses these SDK exports:

```typescript
import {
  auth,
  UnauthorizedError,
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js"

import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
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
- [Dynamic Client Registration (RFC 7591)](https://datatracker.ietf.org/doc/html/rfc7591)
- [OAuth Protected Resource Metadata (RFC 9728)](https://datatracker.ietf.org/doc/html/rfc9728)
