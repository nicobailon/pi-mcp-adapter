import type { Theme } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export function createTheme() {
  const colors: Record<string, number> = {
    accent: 31,
    border: 32,
    success: 33,
    warning: 34,
    muted: 35,
    dim: 36,
    error: 37,
  };
  const fg = vi.fn((color: string, text: string) => `\x1b[38;5;${colors[color] ?? 38}m${text}\x1b[39m`);
  const theme = {
    fg,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
    inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
  } as unknown as Theme;
  return { fg, theme };
}
