import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureCallbackServer,
  getPendingAuthCount,
  releaseCallbackServer,
  stopCallbackServer,
} from "../mcp-callback-server.ts";
import { getOAuthCallbackPath, getOAuthCallbackPort } from "../mcp-oauth-provider.ts";

describe("manual OAuth callback reservations", () => {
  beforeEach(async () => {
    await stopCallbackServer().catch(() => undefined);
  });

  afterEach(async () => {
    await stopCallbackServer().catch(() => undefined);
  });

  it("accepts successful callbacks for reserved manual auth states", async () => {
    await ensureCallbackServer({ oauthState: "manual-state", reserveState: true });

    const response = await fetch(
      `http://127.0.0.1:${getOAuthCallbackPort()}${getOAuthCallbackPath()}?code=manual-code&state=manual-state`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Authorization Received");
    expect(getPendingAuthCount()).toBe(0);

    await expect(ensureCallbackServer({ callbackPath: "/other/callback" })).rejects.toThrow(
      /cannot be switched while authorizations are pending/,
    );
    releaseCallbackServer("manual-state");
  });

  it("keeps reserved manual auth states after provider error callbacks", async () => {
    await ensureCallbackServer({ oauthState: "manual-error-retry", reserveState: true });

    const errorResponse = await fetch(
      `http://127.0.0.1:${getOAuthCallbackPort()}${getOAuthCallbackPath()}?error=access_denied&state=manual-error-retry`,
    );
    expect(errorResponse.status).toBe(200);
    expect(await errorResponse.text()).toContain("Authorization Failed");

    const successResponse = await fetch(
      `http://127.0.0.1:${getOAuthCallbackPort()}${getOAuthCallbackPath()}?code=manual-code&state=manual-error-retry`,
    );
    expect(successResponse.status).toBe(200);
    expect(await successResponse.text()).toContain("Authorization Received");

    releaseCallbackServer("manual-error-retry");
  });
});
