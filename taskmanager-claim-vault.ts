import { randomUUID } from "node:crypto";

type Receipt = {
  handle: string;
  taskId: string;
  token: string;
  claimedUntil: string;
  capturedAt: string;
  uncertain: boolean;
  timestampValid: boolean;
};

const vaults = new WeakMap<object, TaskManagerClaimVault>();
const cleanupRegistered = new WeakSet<object>();
const MAX_RECOVERY_RECEIPTS = 100;
const CLAIM_TOOLS = /^(claim_task|renew_task_claim|release_task_claim|complete_task(?:_from_pr)?|set_agent_status|add_task_comment|update_task)$/;

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function resultData(result: unknown): Record<string, unknown> | undefined {
  const object = recordObject(result);
  return recordObject(object?.structuredContent) ?? recordObject(object?.data) ?? object;
}

function cloneWithoutToken(value: unknown, token: string): unknown {
  if (typeof value === "string") return value.replaceAll(token, "[redacted claim capability]");
  if (Array.isArray(value)) return value.map(item => cloneWithoutToken(item, token));
  const object = recordObject(value);
  if (!object) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (key === "claim_token" && entry === token) continue;
    copy[key] = cloneWithoutToken(entry, token);
  }
  return copy;
}

export class TaskManagerClaimVault {
  private readonly receipts = new Map<string, Receipt>();

  constructor(private readonly sessionId = randomUUID()) {}

  getSessionId(): string {
    return this.sessionId;
  }

  captureClaim(result: unknown, fallbackTaskId?: string): unknown {
    const data = resultData(result);
    if (!data || data.claimed !== true || typeof data.claim_token !== "string" || typeof data.claimed_until !== "string") {
      return result;
    }
    const token = data.claim_token;
    const taskId = typeof data.task_id === "string" ? data.task_id : fallbackTaskId;
    if (!taskId) return result;
    const handle = `claim_${randomUUID()}`;
    this.receipts.set(handle, {
      handle,
      taskId,
      token,
      claimedUntil: data.claimed_until,
      capturedAt: new Date().toISOString(),
      uncertain: !isValidTimestamp(data.claimed_until),
      timestampValid: isValidTimestamp(data.claimed_until),
    });
    return this.sanitizeResult(result, token, { claim_handle: handle });
  }

  validateArgs(args: Record<string, unknown> | undefined): void {
    if (typeof args?.claim_token === "string") {
      throw new Error("Raw TaskManager claim_token must not be supplied; use claim_handle");
    }
    this.resolveArgs(args);
  }

  resolveArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!args || typeof args.claim_handle !== "string") return args;
    const receipt = this.receipts.get(args.claim_handle);
    if (!receipt) throw new Error("Unknown or expired TaskManager claim handle");
    if (typeof args.task_id === "string" && args.task_id !== receipt.taskId) {
      throw new Error("TaskManager claim handle does not match task_id");
    }
    const { claim_handle: _handle, ...rest } = args;
    return { ...rest, claim_token: receipt.token, task_id: receipt.taskId };
  }

  updateRenewal(result: unknown, args: Record<string, unknown> | undefined): unknown {
    const receipt = this.receiptForArgs(args);
    if (!receipt) return result;
    const data = resultData(result);
    if (data?.renewed === true && typeof data.claimed_until === "string") {
      receipt.claimedUntil = data.claimed_until;
      receipt.timestampValid = isValidTimestamp(data.claimed_until);
      receipt.uncertain = !receipt.timestampValid;
    } else if (data?.renewed === false || recordObject(result)?.isError === true || data?.renewed !== true) {
      receipt.uncertain = true;
    }
    return this.sanitizeResult(result, receipt.token);
  }

  finish(result: unknown, toolName: string, args: Record<string, unknown> | undefined): unknown {
    const receipt = this.receiptForArgs(args);
    if (!receipt) return result;
    const object = recordObject(result);
    const data = resultData(result);
    const successful = object?.isError !== true && data?.error === undefined;
    const terminalConfirmed = toolName === "release_task_claim"
      ? data?.released === true || data?.status === "released"
      : data?.completed === true || data?.status === "completed";
    if (successful && terminalConfirmed) {
      this.receipts.delete(receipt.handle);
    } else {
      receipt.uncertain = true;
    }
    return this.sanitizeResult(result, receipt.token);
  }

  listMetadata(): Array<Omit<Receipt, "token">> {
    return [...this.receipts.values()].slice(0, MAX_RECOVERY_RECEIPTS).map(({ token: _token, ...metadata }) => ({ ...metadata }));
  }

  destroy(): void {
    this.receipts.clear();
  }

  private receiptForArgs(args: Record<string, unknown> | undefined): Receipt | undefined {
    if (typeof args?.claim_handle === "string") return this.receipts.get(args.claim_handle);
    if (typeof args?.claim_token === "string") {
      return [...this.receipts.values()].find(receipt => receipt.token === args.claim_token);
    }
    return undefined;
  }

  private sanitizeResult(result: unknown, token: string, additions: Record<string, unknown> = {}): unknown {
    const object = recordObject(result);
    if (!object) return result;
    const sanitized = cloneWithoutToken(result, token) as Record<string, unknown>;
    const structured = recordObject(sanitized.structuredContent);
    if (structured) sanitized.structuredContent = { ...structured, ...additions };
    else if (Object.keys(additions).length > 0) sanitized.structuredContent = additions;
    return sanitized;
  }
}

export function getTaskManagerClaimVault(
  scope: object,
  cleanupOwner?: { addCleanup(cleanup: () => void | Promise<void>): void },
): TaskManagerClaimVault {
  let vault = vaults.get(scope);
  if (!vault) {
    vault = new TaskManagerClaimVault();
    vaults.set(scope, vault);
  }
  if (cleanupOwner && typeof cleanupOwner.addCleanup === "function" && !cleanupRegistered.has(scope)) {
    cleanupRegistered.add(scope);
    cleanupOwner.addCleanup(() => vault!.destroy());
  }
  return vault;
}

export function isTaskManagerClaimTool(serverName: string, toolName: string): boolean {
  return /taskmanager|nexus/i.test(serverName) && CLAIM_TOOLS.test(toolName);
}

export function validateTaskManagerArgs(vault: TaskManagerClaimVault, serverName: string, toolName: string, args: Record<string, unknown> | undefined): void {
  if (isTaskManagerClaimTool(serverName, toolName)) vault.validateArgs(args);
}

export function prepareTaskManagerArgs(vault: TaskManagerClaimVault, serverName: string, toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return isTaskManagerClaimTool(serverName, toolName) ? vault.resolveArgs(args) : args;
}

export function captureTaskManagerResult(vault: TaskManagerClaimVault, serverName: string, toolName: string, result: unknown, args: Record<string, unknown> | undefined): unknown {
  if (!isTaskManagerClaimTool(serverName, toolName)) return result;
  if (toolName === "claim_task") return vault.captureClaim(result, typeof args?.task_id === "string" ? args.task_id : undefined);
  if (toolName === "renew_task_claim") return vault.updateRenewal(result, args);
  return vault.finish(result, toolName, args);
}
