import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { Agent, Request as UndiciRequest, fetch as undiciFetch } from "undici";
import { getMissingEnvVars, resolveConfigPath, resolveServerUrl } from "./utils.js";
/** Validate at the connection boundary, including callers that bypass JSON config. */
export function validateCaFile(definition) {
    if (definition.caFile === undefined)
        return;
    if (typeof definition.caFile !== "string" || !definition.caFile.trim()) {
        throw new Error("MCP caFile must be a non-empty path string");
    }
    if (definition.command !== undefined || definition.socket !== undefined
        || !definition.url || new URL(resolveServerUrl(definition)).protocol !== "https:") {
        throw new Error("MCP caFile is only supported for HTTPS HTTP servers");
    }
}
/** One connection owner, shared across transport/auth retries; never process-wide. */
export function createCaFetch(definition) {
    validateCaFile(definition);
    if (definition.caFile === undefined)
        return undefined;
    const origin = new URL(resolveServerUrl(definition)).origin;
    if (getMissingEnvVars(definition.caFile).length)
        throw new Error("Missing environment variable in MCP caFile");
    let ca;
    try {
        ca = readFileSync(resolveConfigPath(definition.caFile), "utf8");
        const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
        if (!certificates?.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) {
            throw new Error("expected a PEM certificate bundle");
        }
        for (const certificate of certificates)
            new X509Certificate(certificate);
    }
    catch (cause) {
        throw new Error("Failed to load MCP caFile PEM certificate bundle", { cause });
    }
    const dispatcher = new Agent({ connect: { ca } });
    let closed;
    return {
        fetch: (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input.toString());
            if (url.origin !== origin)
                return globalThis.fetch(input, init);
            // The Agent comes from the bundled undici copy, whose internals do not
            // match the global fetch dispatcher contract on newer Node releases
            // (Node 26 ships undici v8; the dependency pins undici v6). Route
            // same-origin requests through the bundled fetch so dispatcher and
            // Agent share an implementation. Never follow a redirect with this
            // dispatcher, even to the same origin (no trust-bearing redirect hops).
            // Attach after header-command Request reconstruction.
            try {
                const bundledInput = input instanceof Request
                    ? new UndiciRequest(input.url, {
                        method: input.method,
                        headers: [...input.headers],
                        // Defer acquiring the source stream until bundled Request validation
                        // succeeds. An overriding body never consumes the original body.
                        ...(init?.body == null && input.body ? { body: (async function* () {
                                yield* input.body;
                            })(), duplex: "half" } : {}),
                        cache: input.cache,
                        credentials: input.credentials,
                        integrity: input.integrity,
                        keepalive: input.keepalive,
                        mode: input.mode,
                        redirect: input.redirect,
                        referrer: input.referrer,
                        referrerPolicy: input.referrerPolicy,
                        signal: input.signal,
                    })
                    : input;
                const options = {
                    ...init,
                    ...(init?.headers !== undefined ? { headers: [...new Headers(init.headers)] } : {}),
                    dispatcher,
                    redirect: "error",
                };
                return undiciFetch(bundledInput, options);
            }
            catch (error) {
                return Promise.reject(error);
            }
        },
        close: () => closed ??= dispatcher.destroy(),
    };
}
//# sourceMappingURL=http-ca.js.map