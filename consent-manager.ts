import { ConsentError } from "./errors.ts";
import { logger } from "./logger.ts";
import type { SessionApprovalWriter } from "./session-approvals.ts";

export type ToolConsentMode = "never" | "once-per-server" | "always";

export class ConsentManager {
  private approvedServers = new Set<string>();
  private deniedServers = new Set<string>();
  private log = logger.child({ component: "ConsentManager" });

  constructor(
    private mode: ToolConsentMode = "once-per-server",
    private persistDecision?: SessionApprovalWriter,
  ) {
    this.log.debug("Initialized", { mode });
  }

  requiresPrompt(serverName: string): boolean {
    if (this.mode === "never") return false;
    if (this.deniedServers.has(serverName)) return true;
    if (this.mode === "always") return true;
    return !this.approvedServers.has(serverName);
  }

  shouldCacheConsent(): boolean {
    return this.mode !== "always";
  }

  registerDecision(serverName: string, approved: boolean): void {
    this.applyDecision(serverName, approved);
    try {
      this.persistDecision?.({
        version: 1,
        kind: "iframe",
        decision: approved ? "allow" : "deny",
        serverName,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.debug("Failed to persist consent decision", { server: serverName, error: detail });
    }
  }

  /** Apply a persisted decision without writing it back to the session. */
  restoreDecision(serverName: string, approved: boolean): void {
    if (this.mode === "always" && approved) {
      // Restored "always" grants cannot be reused. A later grant still
      // overrides an earlier denial.
      this.approvedServers.delete(serverName);
      this.deniedServers.delete(serverName);
      return;
    }
    this.applyDecision(serverName, approved);
  }

  ensureApproved(serverName: string): void {
    if (this.mode === "never") return;
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

  clear(serverName?: string): void {
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

  private applyDecision(serverName: string, approved: boolean): void {
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
