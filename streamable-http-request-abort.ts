import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";

type SendOptions = Parameters<Transport["send"]>[1];
type RequestId = string | number;

function requestId(message: JSONRPCMessage): RequestId | undefined {
  return "method" in message && "id" in message ? message.id : undefined;
}

function responseId(message: JSONRPCMessage): RequestId | undefined {
  return !("method" in message) && "id" in message ? message.id : undefined;
}

function cancelledRequestId(message: JSONRPCMessage): RequestId | undefined {
  if (!("method" in message) || message.method !== "notifications/cancelled") return undefined;
  const params = message.params as { requestId?: unknown } | undefined;
  return typeof params?.requestId === "string" || typeof params?.requestId === "number"
    ? params.requestId
    : undefined;
}

/** Adds legacy per-request cancellation without changing modern SDK signals. */
export class StreamableHttpRequestAbortTransport implements Transport {
  readonly hasPerRequestStream = true;
  private readonly activeRequests = new Map<RequestId, AbortController>();
  private messageHandler: Transport["onmessage"];
  private errorHandler: Transport["onerror"];
  private closeHandler: Transport["onclose"];

  constructor(private readonly base: Transport) {
    if (base.hasPerRequestStream !== true) {
      throw new TypeError("StreamableHttpRequestAbortTransport requires a per-request stream transport");
    }
    base.onmessage = (message, extra) => {
      const id = responseId(message);
      if (id !== undefined) this.activeRequests.delete(id);
      this.onmessage?.(message, extra);
    };
    base.onerror = error => this.onerror?.(error);
    base.onclose = () => {
      this.abortActiveRequests();
      this.onclose?.();
    };
  }

  get onmessage(): Transport["onmessage"] { return this.messageHandler; }
  set onmessage(handler: Transport["onmessage"]) { this.messageHandler = handler; }
  get onerror(): Transport["onerror"] { return this.errorHandler; }
  set onerror(handler: Transport["onerror"]) { this.errorHandler = handler; }
  get onclose(): Transport["onclose"] { return this.closeHandler; }
  set onclose(handler: Transport["onclose"]) { this.closeHandler = handler; }
  get sessionId(): string | undefined { return this.base.sessionId; }

  start(): Promise<void> {
    return this.base.start();
  }

  async send(message: JSONRPCMessage, options?: SendOptions): Promise<void> {
    const cancelledId = cancelledRequestId(message);
    if (cancelledId !== undefined) {
      this.activeRequests.get(cancelledId)?.abort();
      this.activeRequests.delete(cancelledId);
    }

    const id = options?.requestSignal ? undefined : requestId(message);
    if (id === undefined) {
      await this.base.send(message, options);
      return;
    }

    const controller = new AbortController();
    this.activeRequests.set(id, controller);
    const onRequestStreamEnd = options?.onRequestStreamEnd;
    try {
      await this.base.send(message, {
        ...options,
        requestSignal: controller.signal,
        onRequestStreamEnd: () => {
          this.activeRequests.delete(id);
          onRequestStreamEnd?.();
        },
      });
    } catch (error) {
      this.activeRequests.delete(id);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.abortActiveRequests();
    await this.base.close();
  }

  setProtocolVersion(version: string): void {
    this.base.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.base.setSupportedProtocolVersions?.(versions);
  }

  private abortActiveRequests(): void {
    for (const controller of this.activeRequests.values()) controller.abort();
    this.activeRequests.clear();
  }
}
