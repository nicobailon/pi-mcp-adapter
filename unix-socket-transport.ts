import { createConnection, type Socket } from "node:net";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";

/** MCP JSONL transport for an explicitly configured Unix-domain socket. */
export class UnixSocketClientTransport implements Transport {
  private socket: Socket | undefined;
  private readonly readBuffer = new ReadBuffer();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socketPath: string) {}

  async start(): Promise<void> {
    if (this.socket) {
      throw new Error("UnixSocketClientTransport already started");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      this.socket = socket;
      let connected = false;

      socket.once("connect", () => {
        connected = true;
        resolve();
      });
      socket.on("data", chunk => {
        try {
          this.readBuffer.append(chunk);
          while (true) {
            const message = this.readBuffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message);
          }
        } catch (error) {
          const cause = error instanceof Error ? error : new Error(String(error));
          this.onerror?.(cause);
          void this.close();
        }
      });
      socket.on("error", error => {
        if (!connected) reject(error);
        this.onerror?.(error);
      });
      socket.on("close", () => {
        if (this.socket === socket) this.socket = undefined;
        this.readBuffer.clear();
        this.onclose?.();
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.readBuffer.clear();
    if (!socket || socket.destroyed) return;

    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => socket.destroy(), 2_000);
      timeout.unref();
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.end();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Unix socket is not connected");

    await new Promise<void>((resolve, reject) => {
      socket.write(serializeMessage(message), error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
