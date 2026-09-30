import { ConsentError } from "./errors.js";
import { logger } from "./logger.js";
export class ConsentManager {
    mode;
    persistDecision;
    approvedServers = new Set();
    deniedServers = new Set();
    log = logger.child({ component: "ConsentManager" });
    constructor(mode = "once-per-server", persistDecision) {
        this.mode = mode;
        this.persistDecision = persistDecision;
        this.log.debug("Initialized", { mode });
    }
    requiresPrompt(serverName) {
        if (this.mode === "never")
            return false;
        if (this.deniedServers.has(serverName))
            return true;
        if (this.mode === "always")
            return true;
        return !this.approvedServers.has(serverName);
    }
    shouldCacheConsent() {
        return this.mode !== "always";
    }
    registerDecision(serverName, approved) {
        this.applyDecision(serverName, approved);
        try {
            this.persistDecision?.({
                version: 1,
                kind: "iframe",
                decision: approved ? "allow" : "deny",
                serverName,
            });
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log.debug("Failed to persist consent decision", { server: serverName, error: detail });
        }
    }
    /** Apply a persisted decision without writing it back to the session. */
    restoreDecision(serverName, approved) {
        if (this.mode === "always" && approved) {
            // Restored "always" grants cannot be reused. A later grant still
            // overrides an earlier denial.
            this.approvedServers.delete(serverName);
            this.deniedServers.delete(serverName);
            return;
        }
        this.applyDecision(serverName, approved);
    }
    ensureApproved(serverName) {
        if (this.mode === "never")
            return;
        if (this.deniedServers.has(serverName)) {
            throw new ConsentError(serverName, { denied: true });
        }
        if (!this.approvedServers.has(serverName)) {
            throw new ConsentError(serverName, { requiresApproval: true });
        }
        if (this.mode === "always") {
            this.approvedServers.delete(serverName);
        }
    }
    clear(serverName) {
        if (serverName) {
            this.approvedServers.delete(serverName);
            this.deniedServers.delete(serverName);
            this.log.debug("Cleared consent for server", { server: serverName });
            return;
        }
        this.approvedServers.clear();
        this.deniedServers.clear();
        this.log.debug("Cleared all consent records");
    }
    applyDecision(serverName, approved) {
        this.deniedServers.delete(serverName);
        this.approvedServers.delete(serverName);
        if (approved) {
            this.approvedServers.add(serverName);
            this.log.debug("Consent granted", { server: serverName });
            return;
        }
        this.deniedServers.add(serverName);
        this.log.debug("Consent denied", { server: serverName });
    }
}
//# sourceMappingURL=consent-manager.js.map