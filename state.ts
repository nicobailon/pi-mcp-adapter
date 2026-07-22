import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConsentManager } from "./consent-manager.ts";
import type { McpLifecycleManager } from "./lifecycle.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { ToolMetadata, PromptMetadata, McpConfig, UiSessionMessages, UiStreamSummary } from "./types.ts";
import type { UiResourceHandler } from "./ui-resource-handler.ts";
import type { UiServerHandle } from "./ui-server.ts";

export interface CompletedUiSession {
  serverName: string;
  toolName: string;
  completedAt: Date;
  reason: string;
  messages: UiSessionMessages;
  stream?: UiStreamSummary;
}

export type SendMessageFn = (
  message: {
    customType: string;
    content: Array<{ type: "text"; text: string }>;
    display?: string;
    details?: unknown;
  },
  options?: { triggerTurn?: boolean }
) => void;

export interface McpExtensionState {
  manager: McpServerManager;
  lifecycle: McpLifecycleManager;
  toolMetadata: Map<string, ToolMetadata[]>;
  /**
   * Per-server prompt metadata reconstructed from live discovery or the
   * persistent metadata cache. Empty when a server does not advertise the
   * `prompts` capability. Optional so external callers building a partial
   * state (for testing) do not need to include it.
   */
  promptMetadata?: Map<string, PromptMetadata[]>;
  config: McpConfig;
  failureTracker: Map<string, number>;
  uiResourceHandler: UiResourceHandler;
  consentManager: ConsentManager;
  uiServer: UiServerHandle | null;
  completedUiSessions: CompletedUiSession[];
  openBrowser: (url: string) => Promise<void>;
  ui?: ExtensionContext["ui"];
  sendMessage?: SendMessageFn;
}
