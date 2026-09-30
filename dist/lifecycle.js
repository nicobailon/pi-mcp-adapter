import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { isServerDisabled } from "./types.js";
import { isTransientHttpConnectError, isUnauthorizedHttpError, } from "./server-manager.js";
import { hasPendingAuth } from "./mcp-auth-flow.js";
import { logger } from "./logger.js";
import { formatTerminalError, parallelLimit, sanitizeTerminalText } from "./utils.js";
import { isTerminatedSession } from "./session-recovery.js";
const KEEP_ALIVE_RETRY_BASE_MS = 30_000;
const KEEP_ALIVE_RETRY_MAX_MS = 5 * 60_000;
const KEEP_ALIVE_CHECK_CONCURRENCY = 10;
export class McpLifecycleManager {
    manager;
    hasPendingAuthForServer;
    keepAliveServers = new Map();
    allServers = new Map();
    serverSettings = new Map();
    globalIdleTimeout = 10 * 60 * 1000;
    healthCheckInterval;
    onReconnect;
    onReconnectFailure;
    onHealthRestored;
    onAuthRequired;
    onIdleShutdown;
    activeHealthCheck;
    activeConvergence;
    shutdownPromise;
    retryStates = new Map();
    pendingMetadataPublications = new Set();
    stopped = false;
    removeHealthAbortListener;
    constructor(manager, hasPendingAuthForServer = hasPendingAuth) {
        this.manager = manager;
        this.hasPendingAuthForServer = hasPendingAuthForServer;
    }
    setReconnectCallback(callback) {
        this.onReconnect = callback;
    }
    setReconnectFailureCallback(callback) {
        this.onReconnectFailure = callback;
    }
    setHealthRestoredCallback(callback) {
        this.onHealthRestored = callback;
    }
    setAuthRequiredCallback(callback) {
        this.onAuthRequired = callback;
    }
    markKeepAlive(name, definition) {
        if (isServerDisabled(definition))
            return;
        this.keepAliveServers.set(name, definition);
    }
    registerServer(name, definition, settings) {
        if (isServerDisabled(definition))
            return;
        this.allServers.set(name, definition);
        if (settings?.idleTimeout !== undefined)
            this.serverSettings.set(name, settings);
    }
    unregisterServer(name) {
        this.allServers.delete(name);
        this.keepAliveServers.delete(name);
        this.serverSettings.delete(name);
        this.retryStates.delete(name);
        this.pendingMetadataPublications.delete(name);
    }
    setGlobalIdleTimeout(minutes) {
        this.globalIdleTimeout = minutes * 60 * 1000;
    }
    setIdleShutdownCallback(callback) {
        this.onIdleShutdown = callback;
    }
    startHealthChecks(signalOrInterval, maybeIntervalMs = 30000) {
        const signal = typeof signalOrInterval === "number" ? undefined : signalOrInterval;
        const intervalMs = typeof signalOrInterval === "number" ? signalOrInterval : maybeIntervalMs;
        this.stopped = false;
        if (signal?.aborted) {
            this.stopped = true;
            return;
        }
        const stop = () => {
            this.stopped = true;
            if (this.healthCheckInterval)
                clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = undefined;
        };
        signal?.addEventListener("abort", stop, { once: true });
        this.removeHealthAbortListener = () => signal?.removeEventListener("abort", stop);
        this.healthCheckInterval = setInterval(() => {
            if (this.stopped || signal?.aborted || this.activeHealthCheck)
                return;
            const check = this.checkConnections(signal)
                .catch(error => {
                console.error(`MCP: Health check failed: ${formatTerminalError(error)}`);
            })
                .finally(() => {
                if (this.activeHealthCheck === check)
                    this.activeHealthCheck = undefined;
            });
            this.activeHealthCheck = check;
        }, intervalMs);
        this.healthCheckInterval.unref();
    }
    async ensureConverged(signal) {
        if (this.stopped || signal?.aborted)
            return;
        if (this.activeConvergence)
            return this.activeConvergence;
        const check = this.checkKeepAliveConnections(signal);
        this.activeConvergence = check;
        try {
            await check;
        }
        finally {
            if (this.activeConvergence === check)
                this.activeConvergence = undefined;
        }
    }
    async checkConnections(signal) {
        if (this.stopped || signal?.aborted)
            return;
        await this.ensureConverged(signal);
        if (this.stopped || signal?.aborted)
            return;
        for (const [name] of this.allServers) {
            if (this.keepAliveServers.has(name))
                continue;
            const timeout = this.getIdleTimeout(name);
            if (timeout > 0 && this.manager.isIdle(name, timeout)) {
                await this.manager.close(name);
                if (this.stopped || signal?.aborted)
                    return;
                this.onIdleShutdown?.(name);
            }
        }
    }
    async checkKeepAliveConnections(signal) {
        if (this.stopped || signal?.aborted)
            return;
        await parallelLimit([...this.keepAliveServers], KEEP_ALIVE_CHECK_CONCURRENCY, ([name, definition]) => this.checkKeepAliveConnection(name, definition, signal));
    }
    async checkKeepAliveConnection(name, definition, signal, retrySuperseded = true) {
        if (isServerDisabled(definition) || this.stopped || signal?.aborted)
            return;
        // Fence against unregisterServer racing an in-flight convergence pass.
        // Identity comparison also rejects stale passes after a same-name
        // replacement registration, which a name check would wrongly accept.
        if (this.keepAliveServers.get(name) !== definition)
            return;
        const connection = this.manager.getConnection(name);
        if (connection?.status === "needs-auth") {
            this.pendingMetadataPublications.delete(name);
            return;
        }
        if (!this.shouldAttemptConnection(name, connection))
            return;
        if (!connection || connection.status !== "connected") {
            if (this.hasPendingAuthForServer(name)) {
                logger.debug(`Skipping reconnect for ${name} while OAuth authorization is pending`);
                return;
            }
            let freshConnection;
            try {
                freshConnection = await this.manager.connect(name, definition, signal);
            }
            catch (error) {
                if (this.stopped || signal?.aborted)
                    return;
                this.reportConnectionFailure(name, definition, error, "reconnect", this.manager.getConnection(name));
                return;
            }
            if (this.stopped || signal?.aborted)
                return;
            if (freshConnection.status === "needs-auth") {
                await this.notifyAuthRequired(name, definition, freshConnection);
                return;
            }
            if (freshConnection.status !== "connected") {
                this.reportConnectionFailure(name, definition, new Error(`MCP server ${name} did not return a connected session`), "reconnect", freshConnection);
                return;
            }
            logger.debug(`Reconnected to ${name}`);
            await this.publishConnectedMetadata(name, definition, freshConnection);
            return;
        }
        if (this.pendingMetadataPublications.has(name)) {
            await this.publishConnectedMetadata(name, definition, connection);
            return;
        }
        if (!definition.url)
            return;
        const hadSessionId = connection.transport?.sessionId != null;
        let refreshResult;
        try {
            refreshResult = await this.manager.refreshTools(name, connection, signal);
        }
        catch (error) {
            if (this.stopped || signal?.aborted)
                return;
            const current = this.manager.getConnection(name);
            if (current !== connection || connection.status !== "connected") {
                await this.handleSupersededConnection(name, definition, connection, signal, retrySuperseded);
                return;
            }
            if (!shouldReconnectAfterRefresh(error, hadSessionId, definition)) {
                this.reportConnectionFailure(name, definition, error, "refresh", connection);
                return;
            }
            if (this.hasPendingAuthForServer(name)) {
                logger.debug(`Skipping reconnect for ${name} while OAuth authorization is pending`);
                return;
            }
            let freshConnection;
            try {
                freshConnection = await this.manager.reconnect(name, definition, connection, signal);
            }
            catch (reconnectError) {
                if (this.stopped || signal?.aborted)
                    return;
                this.reportConnectionFailure(name, definition, reconnectError, "reconnect", this.manager.getConnection(name));
                return;
            }
            if (this.stopped || signal?.aborted)
                return;
            if (freshConnection.status === "needs-auth") {
                await this.notifyAuthRequired(name, definition, freshConnection);
                return;
            }
            if (freshConnection.status !== "connected") {
                this.reportConnectionFailure(name, definition, new Error(`MCP server ${name} did not return a connected session`), "reconnect", freshConnection);
                return;
            }
            logger.debug(`Reconnected stale MCP session for ${name}`);
            await this.publishConnectedMetadata(name, definition, freshConnection);
            return;
        }
        if (refreshResult === "superseded") {
            await this.handleSupersededConnection(name, definition, connection, signal, retrySuperseded);
            return;
        }
        if (refreshResult === "refresh-timeout") {
            this.deferRefreshTimeout(name, definition, connection);
            return;
        }
        if (this.keepAliveServers.get(name) !== definition)
            return;
        if (this.retryStates.delete(name)) {
            await this.onHealthRestored?.(name);
        }
    }
    async handleSupersededConnection(name, definition, staleConnection, signal, retrySuperseded) {
        const current = this.manager.getConnection(name);
        if (this.keepAliveServers.get(name) !== definition)
            return;
        if (current === staleConnection && current.status === "connected") {
            if (this.retryStates.delete(name))
                await this.onHealthRestored?.(name);
            return;
        }
        if (current?.status === "connected") {
            await this.publishConnectedMetadata(name, definition, current);
            return;
        }
        if (current?.status === "needs-auth") {
            await this.notifyAuthRequired(name, definition, current);
            return;
        }
        if (retrySuperseded) {
            await this.checkKeepAliveConnection(name, definition, signal, false);
        }
    }
    async publishConnectedMetadata(name, definition, connection) {
        // Fence stale convergence passes by definition identity so disposal, and
        // disposal followed by a same-name replacement, never re-track this
        // server. Close the pass's own connection only when it is still current,
        // so a replacement's connection is never touched.
        if (this.keepAliveServers.get(name) !== definition) {
            if (this.manager.getConnection(name) === connection)
                await this.manager.close(name);
            return;
        }
        this.pendingMetadataPublications.add(name);
        try {
            await this.onReconnect?.(name);
            this.pendingMetadataPublications.delete(name);
            this.retryStates.delete(name);
        }
        catch (error) {
            if (this.stopped)
                return;
            this.reportConnectionFailure(name, definition, error, "publish", connection);
        }
    }
    async notifyAuthRequired(name, definition, connection) {
        // Fence stale convergence passes by definition identity. Close the
        // leftover needs-auth connection only while it is still the manager's
        // current entry, so a replacement's connection is never touched and the
        // stale client/transport cannot leak when a replacement connects later.
        if (this.keepAliveServers.get(name) !== definition) {
            if (this.manager.getConnection(name) === connection)
                await this.manager.close(name);
            return;
        }
        this.pendingMetadataPublications.delete(name);
        this.retryStates.delete(name);
        try {
            await this.onAuthRequired?.(name);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(`MCP: auth-required callback failed for ${name}: ${sanitizeTerminalText(message)}`);
        }
    }
    shouldAttemptConnection(name, connection) {
        const retry = this.retryStates.get(name);
        if (!retry)
            return true;
        if (retry.connection !== connection || retry.status !== connection?.status) {
            this.retryStates.delete(name);
            return true;
        }
        return Date.now() >= retry.nextAttemptAt;
    }
    connectionFailureTarget(action, name) {
        if (action === "reconnect")
            return `reconnect to ${name}`;
        if (action === "publish")
            return `publish metadata for ${name}`;
        return `refresh ${name}`;
    }
    reportConnectionFailure(name, definition, error, action, connection) {
        if (!this.recordRetry(name, definition, connection))
            return;
        this.onReconnectFailure?.(name, error);
        if (isTransientHttpConnectError(error))
            return;
        const retry = this.retryStates.get(name);
        if (retry?.warningReported)
            return;
        if (retry)
            retry.warningReported = true;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`MCP: Failed to ${this.connectionFailureTarget(action, name)}: ${sanitizeTerminalText(message)}`);
    }
    deferRefreshTimeout(name, definition, connection) {
        if (!this.recordRetry(name, definition, connection))
            return;
        logger.debug(`MCP: keep-alive tools/list refresh timed out for ${name}; retrying after backoff`);
    }
    recordRetry(name, definition, connection) {
        // Do not recreate retry/failure state from a stale convergence pass after
        // disposal or a same-name replacement registration.
        if (this.keepAliveServers.get(name) !== definition)
            return false;
        const previous = this.retryStates.get(name);
        const attempts = (previous?.attempts ?? 0) + 1;
        const delay = Math.min(KEEP_ALIVE_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10), KEEP_ALIVE_RETRY_MAX_MS);
        this.retryStates.set(name, {
            attempts,
            nextAttemptAt: Date.now() + delay,
            connection,
            status: connection?.status,
            warningReported: previous?.warningReported ?? false,
        });
        return true;
    }
    getIdleTimeout(name) {
        const perServer = this.serverSettings.get(name)?.idleTimeout;
        if (perServer !== undefined)
            return perServer * 60 * 1000;
        return this.globalIdleTimeout;
    }
    async gracefulShutdown() {
        if (this.shutdownPromise)
            return this.shutdownPromise;
        this.shutdownPromise = this.shutdownOnce();
        return this.shutdownPromise;
    }
    async shutdownOnce() {
        this.stopped = true;
        if (this.healthCheckInterval)
            clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = undefined;
        this.removeHealthAbortListener?.();
        this.removeHealthAbortListener = undefined;
        await this.activeHealthCheck;
        this.activeHealthCheck = undefined;
        await this.activeConvergence;
        this.activeConvergence = undefined;
        this.onReconnect = undefined;
        this.onReconnectFailure = undefined;
        this.onHealthRestored = undefined;
        this.onAuthRequired = undefined;
        this.onIdleShutdown = undefined;
        this.retryStates.clear();
        this.pendingMetadataPublications.clear();
        if (typeof this.manager.closeAll === "function") {
            await this.manager.closeAll();
        }
    }
}
function shouldReconnectAfterRefresh(error, hadSessionId, definition) {
    if (isTerminatedSession(error, hadSessionId))
        return true;
    // Reconnect baked bearer sources so connect-time resolution runs again.
    if (definition.auth === "bearer" && isUnauthorizedHttpError(error))
        return true;
    return error instanceof SdkError
        && (error.code === SdkErrorCode.NotConnected || error.code === SdkErrorCode.ConnectionClosed);
}
//# sourceMappingURL=lifecycle.js.map