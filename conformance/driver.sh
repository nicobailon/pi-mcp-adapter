#!/usr/bin/env bash
# Per-scenario wrapper spawned by the conformance CLI. Each process gets an
# isolated OAuth store and callback port, then launches the TypeScript driver.
set -euo pipefail

cd "$(dirname "$0")/.."

AUTH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-mcp-conformance-auth.XXXXXX")"
cleanup() {
  rm -rf "$AUTH_DIR"
}
trap cleanup EXIT HUP INT TERM

export MCP_OAUTH_DIR="$AUTH_DIR"
export PI_MCP_ADAPTER_TEST_AUTH_STORE=memory

# Pre-registered browser clients require an exact callback port. Allocate one
# per process. The full runner is sequential, avoiding the race between probing
# a free port and binding it.
export MCP_OAUTH_CALLBACK_PORT="$(
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})'
)"

node --import tsx conformance/driver.ts "$@"
