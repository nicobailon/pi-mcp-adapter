import { createConnection, Socket } from "node:net";
import { UnixSocketClientTransport } from "../unix-socket-transport.ts";

vi.mock(import("node:net"), async original => ({
  ...await original(),
  createConnection: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

describe("UnixSocketClientTransport", () => {
  it.each(["buffer", "text"])("decodes fragmented %s messages", async encoding => {
    const socket = new Socket();
    vi.mocked(createConnection).mockReturnValue(socket);
    const transport = new UnixSocketClientTransport("/unused-test-socket");
    const messages = vi.fn();
    const errors = vi.fn();
    transport.onmessage = messages;
    transport.onerror = errors;
    try {
      const started = transport.start();
      socket.emit("connect");
      await started;
      const message = { jsonrpc: "2.0", id: 1, result: { text: "été" } };
      const wire = JSON.stringify(message) + "\n";
      const bytes = Buffer.from(wire);
      // Split the binary stream inside the first multibyte character.
      const boundary = bytes.indexOf(Buffer.from("é")) + 1;
      socket.emit("data", encoding === "buffer" ? bytes.subarray(0, boundary) : wire.slice(0, boundary));
      expect(messages).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      socket.emit("data", encoding === "buffer" ? bytes.subarray(boundary) : wire.slice(boundary));
      expect(errors).not.toHaveBeenCalled();
      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages).toHaveBeenCalledWith(message);
    } finally {
      socket.destroy();
      await transport.close();
    }
  });
});
