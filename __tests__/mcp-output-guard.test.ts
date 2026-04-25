import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardMcpOutput } from "../mcp-output-guard.ts";

const maxOutputBytes = 50 * 1024;
const maxOutputLines = 2000;

describe("mcp output guard", () => {
  it("keeps the final text response within Pi byte and line limits", async () => {
    const result = await guardMcpOutput([{ type: "text", text: "x".repeat(60000) }]);
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(maxOutputBytes);
      expect(text.split("\n").length).toBeLessThanOrEqual(maxOutputLines);
      expect(fullOutputPath).toBeTruthy();
      expect(text).toContain(`bash head -c 51200 ${fullOutputPath}`);
      expect(existsSync(fullOutputPath!)).toBe(true);
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("keeps the final multiline response within Pi line limits", async () => {
    const result = await guardMcpOutput([{ type: "text", text: Array.from({ length: 2500 }, (_, index) => `line-${index}`).join("\n") }]);
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(text.split("\n").length).toBeLessThanOrEqual(maxOutputLines);
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(maxOutputBytes);
      expect(fullOutputPath).toBeTruthy();
      expect(text).not.toContain("bash head -c");
      expect(existsSync(fullOutputPath!)).toBe(true);
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("replaces oversized image payloads with text metadata before returning model-facing content", async () => {
    const payload = "a".repeat(60000);
    const result = await guardMcpOutput([{ type: "image", data: payload, mimeType: "image/png" }]);
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(result.content[0].type).toBe("text");
      expect(text).toContain("[Image content: image/png");
      expect(text).not.toContain(payload);
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(maxOutputBytes);
      expect(fullOutputPath).toBeTruthy();
      expect(existsSync(fullOutputPath!)).toBe(true);
      expect(readFileSync(fullOutputPath!, "utf-8")).not.toContain(payload);
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });
});
