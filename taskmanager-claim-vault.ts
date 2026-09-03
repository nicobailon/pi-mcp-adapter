import { randomUUID } from "node:crypto";

type Receipt = {
  handle: string;
  taskId: string;
  token: string;
  claimedUntil: string;
  capturedAt: string;
  uncertain: boolean;
  timestampValid: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

type ReceiptRegistry = WeakMap<object, Map<string, Receipt>>;

const vaults = new WeakMap<object, TaskManagerClaimVault>();
const MAX_RECOVERY_RECEIPTS = 100;
const MAX_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const INVALID_TIMESTAMP_RETENTION_MS = 60 * 60 * 1000;
const RECEIPT_REGISTRY_KEY = Symbol.for("pi-mcp-adapter.taskmanager-claim-receipts");
// Keep this list aligned with TaskManager's claim-producing and claim-fenced
// lifecycle operations. Every operation that can mint or consume a capability
// must pass through the same vault, including atomic claim variants.
const CLAIM_TOOLS = /^(claim_task|resolve_and_claim_task|resolve_blocker_and_claim_task|renew_task_claim|release_task_claim|complete_task(?:_from_pr)?|set_agent_status|add_task_comment|update_task|create_task_blocker)$/;

function processReceiptRegistry(): ReceiptRegistry {
  const processState = globalThis as Record<PropertyKey, unknown>;
  const existing = processState[RECEIPT_REGISTRY_KEY];
  if (existing instanceof WeakMap) return existing as ReceiptRegistry;
  const registry: ReceiptRegistry = new WeakMap();
  Object.defineProperty(processState, RECEIPT_REGISTRY_KEY, { value: registry, configurable: true });
  return registry;
}

function scopeReceipts(scope: object): Map<string, Receipt> {
  const registry = processReceiptRegistry();
  let receipts = registry.get(scope);
  if (!receipts) {
    receipts = new Map<string, Receipt>();
    registry.set(scope, receipts);
  }
  return receipts;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return recordObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function resultData(result: unknown): Record<string, unknown> | undefined {
  const object = recordObject(result);
  if (!object) return undefined;

  const structured = recordObject(object.structuredContent);
  const structuredResult = parseJsonRecord(structured?.result);
  if (structuredResult) return structuredResult;
  if (structured) return structured;

  const data = recordObject(object.data);
  const dataResult = parseJsonRecord(data?.result);
  if (dataResult) return dataResult;
  if (data) return data;

  if (Array.isArray(object.content)) {
    for (const item of object.content) {
      const parsed = parseJsonRecord(recordObject(item)?.text);
      if (parsed) return parsed;
    }
  }
  return object;
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
  private readonly receipts: Map<string, Receipt>;

  constructor(private readonly sessionId = randomUUID(), receipts?: Map<string, Receipt>) {
    this.receipts = receipts ?? new Map<string, Receipt>();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  captureClaim(result: unknown, fallbackTaskId?: string): unknown {
    this.purgeExpiredReceipts();
    const data = resultData(result);
    if (!data || data.claimed !== true || typeof data.claim_token !== "string" || typeof data.claimed_until !== "string") {
      return result;
    }
    const token = data.claim_token;
    const taskId = typeof data.task_id === "string" ? data.task_id : fallbackTaskId;
    if (!taskId) return result;
    const handle = `claim_${randomUUID()}`;
    const receipt: Receipt = {
      handle,
      taskId,
      token,
      claimedUntil: data.claimed_until,
      capturedAt: new Date().toISOString(),
      uncertain: !isValidTimestamp(data.claimed_until),
      timestampValid: isValidTimestamp(data.claimed_until),
    };
    this.receipts.set(handle, receipt);
    this.scheduleExpiry(receipt);
    this.enforceReceiptLimit();
    return this.sanitizeResult(result, token, { claim_handle: handle });
  }

  validateArgs(args: Record<string, unknown> | undefined): void {
    if (typeof args?.claim_token === "string") {
      throw new Error("Raw TaskManager claim_token must not be supplied; use claim_handle");
    }
    this.resolveArgs(args);
  }

  resolveArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    this.purgeExpiredReceipts();
    if (!args || typeof args.claim_handle !== "string") return args;
    const receipt = this.receipts.get(args.claim_handle);
    if (!receipt) throw new Error("Unknown or expired TaskManager claim handle");
    if (Object.hasOwn(args, "task_id")) {
      throw new Error("TaskManager claim handle already binds task_id; do not supply task_id");
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
      this.scheduleExpiry(receipt);
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
      this.deleteReceipt(receipt.handle);
    } else {
      receipt.uncertain = true;
    }
    return this.sanitizeResult(result, receipt.token);
  }

  listMetadata(): Array<Omit<Receipt, "token" | "expiryTimer">> {
    this.purgeExpiredReceipts();
    return [...this.receipts.values()].slice(0, MAX_RECOVERY_RECEIPTS).map(({ token: _token, expiryTimer: _timer, ...metadata }) => ({ ...metadata }));
  }

  destroy(): void {
    for (const handle of this.receipts.keys()) this.deleteReceipt(handle);
  }

  private expiryTime(receipt: Receipt): number {
    const capturedAt = Date.parse(receipt.capturedAt);
    const fallbackBase = Number.isFinite(capturedAt) ? capturedAt : Date.now();
    const claimedUntil = Date.parse(receipt.claimedUntil);
    return Number.isFinite(claimedUntil)
      ? Math.min(claimedUntil, fallbackBase + MAX_RECEIPT_RETENTION_MS)
      : fallbackBase + INVALID_TIMESTAMP_RETENTION_MS;
  }

  private purgeExpiredReceipts(now = Date.now()): void {
    for (const [handle, receipt] of this.receipts) {
      if (this.expiryTime(receipt) <= now) this.deleteReceipt(handle);
    }
  }

  private scheduleExpiry(receipt: Receipt): void {
    if (receipt.expiryTimer) clearTimeout(receipt.expiryTimer);
    const delay = Math.max(0, this.expiryTime(receipt) - Date.now());
    receipt.expiryTimer = setTimeout(() => this.deleteReceipt(receipt.handle), delay);
    receipt.expiryTimer.unref?.();
  }

  private enforceReceiptLimit(): void {
    while (this.receipts.size > MAX_RECOVERY_RECEIPTS) {
      const oldestHandle = this.receipts.keys().next().value as string | undefined;
      if (!oldestHandle) return;
      this.deleteReceipt(oldestHandle);
    }
  }

  private deleteReceipt(handle: string): void {
    const receipt = this.receipts.get(handle);
    if (receipt?.expiryTimer) clearTimeout(receipt.expiryTimer);
    this.receipts.delete(handle);
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
    if (structured) {
      const projectedStructured = { ...structured, ...additions };
      sanitized.structuredContent = projectedStructured;
      if (typeof structured.result === "string" && Object.keys(additions).length > 0) {
        const parsedResult = this.addJsonFields(structured.result, additions);
        if (parsedResult !== structured.result) {
          projectedStructured.result = parsedResult;
        }
      }
    } else if (Object.keys(additions).length > 0) sanitized.structuredContent = additions;

    // FastMCP can put the authoritative result in a JSON text block while also
    // returning structuredContent. Keep the vaulted handle model-visible in
    // that path too, without ever copying the raw token into the text.
    if (Object.keys(additions).length > 0 && Array.isArray(sanitized.content)) {
      sanitized.content = sanitized.content.map(item => {
        const content = recordObject(item);
        if (typeof content?.text !== "string") return item;
        const text = this.addJsonFields(content.text, additions);
        return text === content.text ? item : { ...content, text };
      });
    }
    return sanitized;
  }

  private addJsonFields(value: string, additions: Record<string, unknown>): string {
    try {
      const parsed = JSON.parse(value);
      if (!recordObject(parsed)) return value;
      return JSON.stringify({ ...parsed, ...additions });
    } catch {
      return value;
    }
  }
}

export function getTaskManagerClaimVault(
  scope: object,
  _cleanupOwner?: { addCleanup(cleanup: () => void | Promise<void>): void },
): TaskManagerClaimVault {
  let vault = vaults.get(scope);
  if (!vault) {
    // Extension hot reload creates a new state object and module instance while
    // TaskManager keeps the backend lease alive. Keep the opaque-token map on a
    // process-local weak registry keyed by Pi's stable event bus so a reloaded
    // adapter can still renew or release that lease without crossing sessions.
    vault = new TaskManagerClaimVault(randomUUID(), scopeReceipts(scope));
    vaults.set(scope, vault);
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
  if (toolName === "claim_task" || toolName === "resolve_and_claim_task" || toolName === "resolve_blocker_and_claim_task") {
    return vault.captureClaim(result, typeof args?.task_id === "string" ? args.task_id : undefined);
  }
  if (toolName === "renew_task_claim") return vault.updateRenewal(result, args);
  return vault.finish(result, toolName, args);
}
