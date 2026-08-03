import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.ts";

export interface McpOnboardingState {
  version: 1;
  sharedConfigHintShown: boolean;
  setupCompleted: boolean;
  lastDiscoveryFingerprint?: string;
}

const DEFAULT_STATE: McpOnboardingState = {
  version: 1,
  sharedConfigHintShown: false,
  setupCompleted: false,
};

export function getOnboardingStatePath(): string {
  return getAgentPath("mcp-onboarding.json");
}

export function loadOnboardingState(): McpOnboardingState {
  const path = getOnboardingStatePath();
  if (!existsSync(path)) return { ...DEFAULT_STATE };

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<McpOnboardingState>;
    if (!raw || typeof raw !== "object") return { ...DEFAULT_STATE };
    return {
      version: 1,
      sharedConfigHintShown: raw.sharedConfigHintShown === true,
      setupCompleted: raw.setupCompleted === true,
      ...(typeof raw.lastDiscoveryFingerprint === "string"
        ? { lastDiscoveryFingerprint: raw.lastDiscoveryFingerprint }
        : {}),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveOnboardingState(state: McpOnboardingState): void {
  const path = getOnboardingStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
}

export function updateOnboardingState(updater: (state: McpOnboardingState) => McpOnboardingState): McpOnboardingState {
  const next = updater(loadOnboardingState());
  saveOnboardingState(next);
  return next;
}

export function markSharedConfigHintShown(fingerprint?: string): McpOnboardingState {
  return updateOnboardingState((state) => {
    const lastDiscoveryFingerprint = fingerprint ?? state.lastDiscoveryFingerprint;
    return {
      ...state,
      sharedConfigHintShown: true,
      ...(lastDiscoveryFingerprint !== undefined ? { lastDiscoveryFingerprint } : {}),
    };
  });
}

export function markSetupCompleted(fingerprint?: string): McpOnboardingState {
  return updateOnboardingState((state) => {
    const lastDiscoveryFingerprint = fingerprint ?? state.lastDiscoveryFingerprint;
    return {
      ...state,
      setupCompleted: true,
      ...(lastDiscoveryFingerprint !== undefined ? { lastDiscoveryFingerprint } : {}),
    };
  });
}
