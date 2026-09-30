import type { Transport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
/** MCP JSONL transport for an explicitly configured Unix-domain socket. */
export declare class UnixSocketClientTransport implements Transport {
    private readonly socketPath;
    private socket;
    private readonly readBuffer;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    constructor(socketPath: string);
    start(): Promise<void>;
    close(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
}
